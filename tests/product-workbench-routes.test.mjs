import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { build, stop } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";

const now = new Date("2026-10-21T12:00:00.000Z");
const secret = "SYNTHETIC_PRIVATE_ERROR_BODY";
let state;
function reset() {
  delete process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED;
  state = { calls: [], authCalls: 0, products: [{ id: "p1", shopId: "s1", shopifyProductGid: "gid://shopify/Product/12", title: "Safe product", handle: "safe", canonicalUrl: "https://shop.example/products/safe", productStatus: "ACTIVE", indexabilityState: "INDEXABLE", published: true, deletedAt: null, lastIndexedAt: now, createdAt: now, updatedAt: now, queueItems: [] }] };
}
const record = (name, fn) => async (args) => { state.calls.push({ name, args }); if (state.dbError) throw new Error(secret); return fn(args); };
const client = {
  shop: { findUnique: record("shop", () => ({ id: "s1", primaryDomain: "shop.example" })) },
  productIndexState: { findMany: record("products", () => state.products) },
  indexQueueItem: { findMany: record("queue", () => []), createMany: record("create", ({ data }) => ({ count: data.length })), updateMany: record("cancel", () => ({ count: state.cancelCount ?? 1 })) },
  $transaction: async (fn, options) => { state.calls.push({ name: "transaction", options }); if (state.txError) throw { code: state.txError, message: secret }; return fn(client); },
};
globalThis.productRouteFixture = { client, auth: async () => { state.authCalls++; if (state.authError) throw new Response(secret, { status: 401 }); return { session: { shop: "owned.myshopify.com", id: "offline_shared" }, sessionToken: { sub: "42" } }; } };
const plugins = [{ name: "product-workbench-auth-and-db-fixture", setup(b) {
  b.onResolve({ filter: /db\.server$/ }, () => ({ path: "db", namespace: "fixture" }));
  b.onResolve({ filter: /shopify\.server$/ }, () => ({ path: "auth", namespace: "fixture" }));
  b.onResolve({ filter: /^@shopify\/shopify-app-react-router\/server$/ }, () => ({ path: "boundary", namespace: "fixture" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: path === "db" ? "export default globalThis.productRouteFixture.client;" : path === "auth" ? "export const authenticate={admin:(...a)=>globalThis.productRouteFixture.auth(...a)};" : "export const boundary={headers:()=>({'X-Boundary-Fixture':'preserved'}),error:()=> 'Authentication required'};" }));
} }];
mkdirSync(new URL("../build-tests", import.meta.url), { recursive: true });
for (const [entry, outfile] of [["app/routes/app.products.tsx", "product-list-route.mjs"], ["app/routes/app.products_.$productId.tsx", "product-detail-route.mjs"]]) await build({ entryPoints: [entry], outfile: `build-tests/${outfile}`, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", plugins });
stop();
const list = await import("../build-tests/product-list-route.mjs");
const detail = await import("../build-tests/product-detail-route.mjs");
const request = (path = "/app/products", init) => new Request(`https://app.example${path}`, init);
const args = (path, params = {}) => ({ request: request(path), params });
const post = (extra = {}) => ({ request: request("/app/products", { method: "POST", headers: { origin: "https://app.example", "content-type": "application/x-www-form-urlencoded", ...extra.headers }, body: extra.body ?? new URLSearchParams({ intent: "enqueue", requestKey: "11111111-1111-4111-8111-111111111111", product: `p1~${now.toISOString()}` }) }), params: {} });
async function render(route, path, pattern) {
  const handler = createStaticHandler([{ id: "test", path: pattern, loader: route.loader, Component: route.default, ErrorBoundary: route.ErrorBoundary }]);
  const context = await handler.query(request(path));
  assert.equal(context instanceof Response, false);
  return renderToStaticMarkup(React.createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context, hydrate: false }));
}

test("real loader authenticates, scopes shop and excludes writes and sensitive metadata", async () => {
  reset(); const r = await list.loader(args("/app/products?q=Safe"));
  assert.equal(state.authCalls, 1); assert.equal(state.calls[0].args.where.domain, "owned.myshopify.com");
  assert.equal(state.calls[1].args.where.shopId, "s1"); assert.equal(r.data.actionsEnabled, false); assert.match(r.data.requestKey, /^[a-f0-9-]{36}$/);
  assert.equal(r.init.headers["Cache-Control"], "private, no-store"); assert.doesNotMatch(JSON.stringify(r.data), /canonicalUrl|reason|contentHash/);
});
test("default-off gate blocks mutation before body/DB/transaction access", async () => {
  reset(); const r = await list.action(post()); assert.equal(r.init.status, 403); assert.equal(state.authCalls, 1); assert.equal(state.calls.length, 0);
});
test("real action uses SERIALIZABLE once with explicit local opt-in", async () => {
  reset(); process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED = "true";
  const r = await list.action(post()); assert.equal(r.data.ok, true); assert.equal(r.data.result.created, 1);
  const tx = state.calls.filter((c) => c.name === "transaction"); assert.equal(tx.length, 1); assert.deepEqual(tx[0].options, { isolationLevel: "Serializable", maxWait: 2000, timeout: 5000 });
  const row = state.calls.find((c) => c.name === "create").args.data[0]; assert.equal(row.provider, "INTERNAL"); assert.equal(row.shopId, "s1");
});
for (const code of ["P2034", "P2002"]) test(`concurrency ${code} becomes409 without retry or leaked DB text`, async () => {
  reset(); process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED = "true"; state.txError = code;
  const r = await list.action(post()); assert.equal(r.init.status, 409); assert.equal(state.calls.filter((c) => c.name === "transaction").length, 1); assert.doesNotMatch(JSON.stringify(r), new RegExp(secret));
});
test("unconfirmed DB error is503 and requires review rather than automatic resubmission", async () => {
  reset(); process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED = "true"; state.dbError = true;
  const r = await list.action(post()); assert.equal(r.init.status, 503); assert.match(r.data.message, /could not be confirmed/); assert.doesNotMatch(JSON.stringify(r), new RegExp(secret));
});
test("cross-origin and excessive selections fail before transaction", async () => {
  reset(); process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED = "true";
  assert.equal((await list.action(post({ headers: { origin: "https://evil.example" } }))).init.status, 403);
  const body = new URLSearchParams({ intent: "enqueue", requestKey: "11111111-1111-4111-8111-111111111111" }); for (let i = 0; i < 21; i++) body.append("product", `p${i}~${now.toISOString()}`);
  assert.equal((await list.action(post({ body }))).init.status, 400); assert.equal(state.calls.length, 0);
});
test("auth errors preserve SDK response and prevent DB access", async () => {
  reset(); state.authError = true; await assert.rejects(list.action(post()), (e) => e.status === 401); assert.equal(state.calls.length, 0);
});
test("wrong methods and invalid filters never query DB", async () => {
  reset(); await assert.rejects(list.loader(post()), (e) => e.status === 405);
  await assert.rejects(list.action(args("/app/products")), (e) => e.status === 405);
  await assert.rejects(list.loader(args("/app/products?state=FOREIGN")), (e) => e.status === 400); assert.equal(state.calls.length, 0);
});
test("SSR product list contains usable search, selection limits, history links and no activation claim", async () => {
  reset(); const html = await render(list, "/app/products", "/app/products");
  assert.match(html, /Safe product/); assert.match(html, /Queue actions are disabled/); assert.match(html, /0 of 20 selected/); assert.match(html, /\/app\/products\/p1/); assert.match(html, /type="checkbox"[^>]*disabled/); assert.doesNotMatch(html, /name="product" value="p1/);
});
test("SSR detail shows cancellation only for owned untouched internal rows", async () => {
  reset(); process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED = "true";
  const { workbenchOwner } = await import("../app/services/product-workbench.ts");
  state.products[0].queueItems = [{ id: "manual_" + "a".repeat(64), shopId: "s1", shopifyProductGid: state.products[0].shopifyProductGid, provider: "INTERNAL", action: "INDEX", status: "PENDING", updatedAt: now, reason: `manual-index/v1:${workbenchOwner("owned.myshopify.com", "42")}`, retryCount: 0, claimedAt: null, attempts: [] }];
  const html = await render(detail, "/app/products/p1", "/app/products/:productId");
  assert.match(html, /Cancel my waiting internal request/); assert.match(html, /action="\/app\/products"/); assert.match(html, /value="2026-10-21T12:00:00.000Z"/); assert.doesNotMatch(html, /manual-index\/v1/);
  state.products[0].queueItems[0].status = "PROCESSING";
  assert.doesNotMatch(await render(detail, "/app/products/p1", "/app/products/:productId"), /Cancel my waiting internal request/);
});
test("detail unknown product is404 and response headers preserve SDK and no-store", async () => {
  reset(); state.products = []; await assert.rejects(detail.loader(args("/app/products/foreign", { productId: "foreign" })), (e) => e.status === 404);
  for (const route of [list, detail]) { const headers = route.headers({}); assert.equal(headers.get("Cache-Control"), "private, no-store"); assert.equal(headers.get("X-Boundary-Fixture"), "preserved"); }
});
test.after(() => { delete process.env.PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED; delete globalThis.productRouteFixture; });
