import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { build, stop } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";

const secret = "SYNTHETIC_PRIVATE_ERROR_BODY";
const now = new Date("2026-10-21T12:00:00.000Z");
const scan = { id: "scan1", status: "PAUSED", productsProcessed: 4, productsIndexable: 3, productsNonIndexable: 1,
  productsChanged: 2, queueItemsCreated: 2, errorsCount: 1, lastProgressAt: now, errorMessage: secret, batchToken: secret };
let state;
const record = (name, result) => async (args) => {
  state.calls.push({ name, args });
  if (state.dbError) throw new Error(secret);
  return typeof result === "function" ? result() : result;
};
const client = {
  shop: { findUnique: record("shop", () => state.hasShop ? { id: "shop1" } : null) },
  indexQueueItem: {
    groupBy: record("queue-count", []),
    findMany: record("queue-list", () => state.queues ?? (state.queue ? [state.queue] : [])),
    findFirst: record("queue-detail", () => state.queue),
  },
  indexAttempt: { findMany: record("attempts", () => state.attempts) },
  webhookReceipt: { groupBy: record("webhook-count", []), findMany: record("webhook-events", () => state.webhooks ?? []) },
  shopProviderConfig: { findUnique: record("provider-metadata", { indexNowEnabled: true, indexNowOwnershipVerifiedAt: now }) },
  productIndexState: { count: record("product-count", 4) },
  indexEvent: { count: record("event-count", 3), findMany: record("events", []) },
  scanRun: { findFirst: record("scan", scan) },
};
globalThis.indexingRouteFixture = {
  client,
  auth: async () => {
    state.authCalls++;
    if (state.authError) throw new Response("SYNTHETIC_AUTH_DETAIL", { status: 401 });
    return { session: { shop: "owned.myshopify.com" }, admin: {} };
  },
  scan: async () => { if (state.scanError) throw new Error(secret); return scan; },
};
function reset() {
  state = { calls: [], authCalls: 0, dbError: false, authError: false, scanError: false, hasShop: true, attempts: [],
    queue: { id: "queue1", shopId: "shop1", shopifyProductGid: "gid://shopify/Product/12", provider: "INDEXNOW", action: "INDEX", status: "COMPLETED",
      retryCount: 0, maxRetries: 5, nextAttemptAt: now, claimedAt: null, completedAt: now, createdAt: now, updatedAt: now, attempts: [] },
  };
}
mkdirSync(new URL("../build-tests/", import.meta.url), { recursive: true });
const plugins = [{ name: "read-only-indexing-fixture", setup(b) {
  b.onResolve({ filter: /db\.server$/ }, () => ({ path: "db", namespace: "fixture" }));
  b.onResolve({ filter: /shopify\.server$/ }, () => ({ path: "auth", namespace: "fixture" }));
  b.onResolve({ filter: /initial-scan\.server$/ }, () => ({ path: "scan", namespace: "fixture" }));
  b.onResolve({ filter: /^@shopify\/shopify-app-react-router\/server$/ }, () => ({ path: "boundary", namespace: "fixture" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: path === "db"
    ? "export default globalThis.indexingRouteFixture.client;"
    : path === "auth" ? "export const authenticate = { admin: (...args) => globalThis.indexingRouteFixture.auth(...args) };"
    : path === "scan" ? "export const startInitialScan = globalThis.indexingRouteFixture.scan; export const pauseInitialScan=startInitialScan; export const cancelInitialScan=startInitialScan; export const resumeInitialScan=startInitialScan; export const runNextBatch=startInitialScan;"
    : "export const boundary = { headers: () => ({'X-Boundary-Fixture':'preserved'}), error: () => 'Authentication required' };" }));
} }];
for (const [entry, output] of [["app/routes/app.indexing.tsx", "indexing-list-route.mjs"], ["app/routes/app.indexing_.$queueId.tsx", "indexing-detail-route.mjs"], ["app/routes/app._index.tsx", "indexing-home-route.mjs"]]) {
  await build({ entryPoints: [entry], outfile: `build-tests/${output}`, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", plugins });
}
stop();
const list = await import("../build-tests/indexing-list-route.mjs");
const detail = await import("../build-tests/indexing-detail-route.mjs");
const home = await import("../build-tests/indexing-home-route.mjs");
const request = (path, init) => new Request(`https://app.example${path}`, init);
const args = (path, params = {}) => ({ request: request(path), params });
async function render(route, path, pattern) {
  const handler = createStaticHandler([{ id: "test", path: pattern, loader: route.loader, Component: route.default, ErrorBoundary: route.ErrorBoundary }]);
  const context = await handler.query(request(path));
  assert.equal(context instanceof Response, false);
  return renderToStaticMarkup(React.createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false }));
}

test("actual list loader authenticates and scopes every DB read to the session shop", async () => {
  reset();
  const r = await list.loader(args("/app/indexing?provider=INDEXNOW&status=COMPLETED"));
  assert.equal(state.authCalls, 1); assert.equal(state.calls[0].args.where.domain, "owned.myshopify.com");
  for (const call of state.calls.slice(1)) assert.equal(call.args.where.shopId, "shop1");
  assert.equal(r.data.items.length, 1); assert.equal(r.init.headers["Cache-Control"], "private, no-store");
  assert.equal(list.action, undefined); assert.equal(detail.action, undefined);
});
test("new routes reject POST without running auth/DB/jobs", async () => {
  reset();
  for (const route of [list, detail]) await assert.rejects(route.loader({ request: request("/app/indexing", { method: "POST" }), params: {} }), (e) => e.status === 405);
  assert.equal(state.calls.length, 0); assert.equal(state.authCalls, 0);
});
test("invalid filters are400 before DB access; authenticated path remains mandatory", async () => {
  reset();
  await assert.rejects(list.loader(args("/app/indexing?status=FOREIGN")), (e) => e.status === 400);
  assert.equal(state.authCalls, 1); assert.equal(state.calls.length, 0);
});
test("invalid attempt page is400 and unknown owned queue is404", async () => {
  reset(); await assert.rejects(detail.loader(args("/app/indexing/queue1?before=-1", { queueId: "queue1" })), (e) => e.status === 400);
  assert.equal(state.calls.length, 0);
  state.queue = null;
  await assert.rejects(detail.loader(args("/app/indexing/foreign", { queueId: "foreign" })), (e) => e.status === 404);
  assert.equal(state.calls.find((c) => c.name === "queue-detail").args.where.shopId, "shop1");
  assert.equal(state.calls.some((c) => c.name === "attempts"), false);
});
test("SSR list displays actual metadata and never claims search engine indexing", async () => {
  reset();
  const html = await render(list, "/app/indexing", "/app/indexing");
  assert.match(html, /Indexing jobs/); assert.match(html, /IndexNow setting: Enabled/); assert.match(html, /search engine inclusion is unverified/);
  assert.match(html, /queue1/); assert.doesNotMatch(html, /Phase 1|SYNTHETIC_PRIVATE_ERROR_BODY/);
});
test("SSR detail displays safe attempt diagnostic, not provider/error payloads", async () => {
  reset(); state.attempts = [{ id: "attempt1", shopId: "shop1", queueItemId: "queue1", provider: "INDEXNOW", attemptNumber: 2,
    successful: false, responseCode: 429, startedAt: now, completedAt: now, responseBody: secret, error: secret }];
  const html = await render(detail, "/app/indexing/queue1", "/app/indexing/:queueId");
  assert.match(html, /rate limit/); assert.match(html, /429/); assert.doesNotMatch(html, /SYNTHETIC_PRIVATE_ERROR_BODY/);
});
test("SSR continuation links preserve filters and webhook preview explains bounded auth errors", async () => {
  reset(); state.queues = Array.from({ length: 26 }, (_, i) => ({ ...state.queue, id: `q${String(26-i).padStart(2, "0")}` }));
  state.webhooks = Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, shopId: "shop1", shopifyProductGid: null, topic: "PRODUCTS_UPDATE",
    status: "RETRY", attemptCount: 2, nextAttemptAt: now, receivedAt: now, lastErrorClass: "ADMIN_UNAVAILABLE" }));
  const html = await render(list, "/app/indexing?status=PENDING&provider=INDEXNOW&product=12", "/app/indexing");
  const href = /href="([^"]+)"[^>]*>Older jobs/.exec(html)[1].replaceAll("&amp;", "&");
  const params = new URL(href, "https://app.example").searchParams;
  assert.equal(params.get("status"), "PENDING"); assert.equal(params.get("provider"), "INDEXNOW"); assert.equal(params.get("product"), "12");
  assert.equal(params.get("cursor"), `${now.toISOString()}~q02`);
  assert.match(html, /authorization/); assert.match(html, /10 most recent/);
});
test("SSR attempt continuation uses the bounded last attempt number", async () => {
  reset(); state.attempts = Array.from({ length: 21 }, (_, i) => ({ id: `a${30-i}`, shopId: "shop1", queueItemId: "queue1", provider: "INDEXNOW",
    attemptNumber: 30-i, successful: true, responseCode: 202, startedAt: now, completedAt: now }));
  const html = await render(detail, "/app/indexing/queue1", "/app/indexing/:queueId");
  assert.match(html, /before=11/); assert.match(html, /key validation is pending/); assert.doesNotMatch(html, /Attempt 10</);
});
test("SSR errors are sanitized and authentication boundary is preserved", async () => {
  reset(); state.dbError = true;
  const html = await render(list, "/app/indexing", "/app/indexing");
  assert.match(html, /Indexing status is unavailable/); assert.doesNotMatch(html, new RegExp(secret));
  reset(); state.authError = true;
  const authHtml = await render(list, "/app/indexing", "/app/indexing");
  assert.match(authHtml, /Authentication required/); assert.equal(state.calls.length, 0);
});
test("response headers preserve Shopify boundary headers while preventing caching", () => {
  for (const route of [list, detail, home]) {
    const result = route.headers({}); assert.equal(result.get("X-Boundary-Fixture"), "preserved"); assert.equal(result.get("Cache-Control"), "private, no-store");
  }
});
test("home reuses grouped status and excludes raw scan/event errors from projections", async () => {
  reset(); const r = await home.loader(args("/app"));
  assert.equal(r.indexing.indexNow.enabled, true); assert.equal(JSON.stringify(r.scan).includes(secret), false);
  assert.equal(state.calls.find((c) => c.name === "events").args.select.error, undefined);
  assert.equal(state.calls.find((c) => c.name === "scan").args.select.errorMessage, undefined);
});
test("existing scan action returns safe scan projection and sanitizes thrown error/log", async () => {
  reset();
  const make = () => ({ request: request("/app", { method: "POST", body: new URLSearchParams({ intent: "start" }) }) });
  const success = await home.action(make()); assert.equal(JSON.stringify(success).includes(secret), false);
  state.scanError = true; const old = console.error; const logs = []; console.error = (...x) => logs.push(x);
  try { const r = await home.action(make()); assert.match(r.error, /Refresh its status/); assert.equal(JSON.stringify(r).includes(secret), false); }
  finally { console.error = old; }
  assert.deepEqual(logs, [[JSON.stringify({ event: "initial_scan_action_failed", code: "SCAN_ACTION_FAILED" })]]);
});
