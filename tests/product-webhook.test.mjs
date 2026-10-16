/* eslint-env node, es2020 */
import assert from "node:assert/strict";
import test from "node:test";
import nodeProcess from "node:process";
import { spawnSync } from "node:child_process";
import { build, stop } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { HttpRequestError, GraphqlQueryError } from "@shopify/shopify-api";
import { webhookFixture } from "./product-webhook-fixture.mjs";
import {
  productWebhookConfig,
  classifyProductWebhookError,
  productWebhookBackoffMs,
  WebhookOwnershipLostError,
  PRODUCT_WEBHOOK_HARD_LIMIT_MS,
  PRODUCT_WEBHOOK_SAFETY_MARGIN_MS,
} from "../app/services/product-webhook-control.ts";
import {
  acceptProductWebhookWithClient as accept,
  acquireProductWebhookLeaseWithClient as acquire,
  releaseProductWebhookLeaseWithClient as release,
  claimProductWebhookWithClient as claim,
  completeProductWebhookWithClient as complete,
  failProductWebhookWithClient as fail,
  guardProductWebhookClaimWithClient as guard,
} from "../app/services/product-webhook-store.ts";
import { runProductWebhookWorker } from "../app/services/product-webhook-runner.ts";

const config = productWebhookConfig({ PRODUCT_WEBHOOK_WORKER_ENABLED: "true" });
const input = {
  shopDomain: "test.myshopify.com",
  webhookId: "delivery-1",
  productGid: "gid://shopify/Product/1",
  topic: "products/update",
};
const now = () => new Date();
const add = (f, overrides = {}) =>
  f.tx((tx) => accept(tx, { ...input, ...overrides }, now()));
const getLease = (f) => acquire(f.client, config.claimStaleMs, now());
const getClaim = (f, lease, time = now(), excluded = []) =>
  f.tx((tx) => claim(tx, config, lease, excluded, time));

mkdirSync("build-tests", { recursive: true });
const mockPlugin = {
  name: "webhook-fixtures",
  setup(builder) {
    builder.onResolve({ filter: /(?:db|shopify)\.server$/ }, (args) => ({
      path: args.path.includes("shopify") ? "auth" : "db",
      namespace: "webhook-test",
    }));
    builder.onLoad({ filter: /.*/, namespace: "webhook-test" }, (args) => ({
      loader: "js",
      contents:
        args.path === "auth"
          ? "export const authenticate = { webhook: async () => { if (globalThis.webhookAuth instanceof Error) throw globalThis.webhookAuth; return globalThis.webhookAuth; } }; export const sessionStorage = {loadSession: async () => { throw new Error('unexpected session load'); }}; export const unauthenticated = { admin: async (domain) => { if (globalThis.webhookOfflineAdmin) return globalThis.webhookOfflineAdmin(domain); throw new Error('unexpected offline admin'); } };"
          : "export default new Proxy({}, {get: (_, key) => globalThis.webhookDB[key]});",
    }));
  },
};
const modules = {};
for (const [name, entry] of Object.entries({
  create: "app/routes/webhooks.products.create.tsx",
  update: "app/routes/webhooks.products.update.tsx",
  core: "app/services/product-indexing.server.ts",
  admin: "app/services/product-webhook-admin.ts",
})) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: `build-tests/product-webhook-${name}-test.mjs`,
    plugins: [mockPlugin],
    metafile: true,
  });
  assert.ok(
    Object.keys(result.metafile.inputs).every(
      (path) =>
        !/indexnow-executor|provider-materialization|storefront-fetch/.test(
          path,
        ),
    ),
    "no provider execution dependency",
  );
  modules[name] = await import(
    `../build-tests/product-webhook-${name}-test.mjs`
  );
}
const workerGraph = await build({
  entryPoints: ["workers/product-webhook-worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: "build-tests/product-webhook-worker-entry-test.mjs",
  metafile: true,
  plugins: [mockPlugin],
});
stop();
function auth(
  f,
  admin = {
    graphql: () => {
      throw new Error("HTTP must not query");
    },
  },
) {
  globalThis.webhookDB = f.client;
  globalThis.webhookAuth = {
    admin,
    shop: input.shopDomain,
    payload: { id: 1 },
  };
}
function request(id = "delivery-1") {
  return new Request("https://app.example/webhook", {
    method: "POST",
    headers: id ? { "X-Shopify-Webhook-Id": id } : {},
  });
}
function productResponse(updatedAt = "2026-01-01T00:00:00Z") {
  return Response.json({
    data: {
      product: {
        id: input.productGid,
        legacyResourceId: "1",
        handle: "sample",
        title: "Sample",
        descriptionHtml: "",
        productType: "",
        vendor: "",
        tags: [],
        status: "DRAFT",
        onlineStoreUrl: null,
        publishedAt: null,
        updatedAt,
        seo: { title: null, description: null },
        variants: { nodes: [] },
        media: { nodes: [] },
      },
    },
  });
}
const process = (work, admin) =>
  modules.core.processProductDetection({
    admin,
    shopDomain: work.shop.domain,
    productGid: work.shopifyProductGid,
    eventType: "UPDATED",
    primaryDomain: work.shop.primaryDomain,
    durableClaim: work,
  });
function runner(f, admin, time = now()) {
  const logs = [],
    delays = [];
  return {
    logs,
    delays,
    acquireLease: () => acquire(f.client, config.claimStaleMs, time),
    releaseLease: (lease) => release(f.client, lease),
    claim: (lease, excluded, at) => getClaim(f, lease, at, excluded),
    admin,
    guard: (work, at) => f.tx((tx) => guard(tx, work, at)),
    process,
    fail: (work, error, at) => f.tx((tx) => fail(tx, work, config, error, at)),
    log: (event, details) => logs.push({ event, ...details }),
    now: () => time,
    delay: async (ms) => {
      delays.push(ms);
    },
    shouldStop: () => false,
  };
}

test("configuration is default-disabled, strict and bounded; backoff finite", () => {
  assert.equal(productWebhookConfig({}).drain, null);
  assert.equal(productWebhookConfig({}).maxItemsPerShop, 2);
  assert.throws(() => productWebhookConfig({ PRODUCT_WEBHOOK_DRAIN_MODE: "manifest-once-v1" }));
  assert.equal(productWebhookConfig({}).enabled, false);
  for (const [key, value] of [
    ["ENABLED", "1"],
    ["MAX_ITEMS", "26"],
    ["MAX_ITEMS", "0"],
    ["MAX_ATTEMPTS", "13"],
    ["CLAIM_STALE_MS", "1"],
    ["INTER_ITEM_DELAY_MS", "0"],
  ])
    assert.throws(() =>
      productWebhookConfig({ [`PRODUCT_WEBHOOK_WORKER_${key}`]: value }),
    );
  assert.deepEqual(
    [1, 2, 3, 4, 5, 100].map(productWebhookBackoffMs),
    [30000, 120000, 300000, 900000, 1800000, 1800000],
  );
});

for (const name of ["create", "update"]) {
  test(`actual ${name} route: ACK awaits commit; 100 duplicates do zero GraphQL and produce one work item`, async () => {
    const f = webhookFixture();
    auth(f);
    let unblock;
    f.commitGate = new Promise((resolve) => {
      unblock = resolve;
    });
    let ack = false;
    const delivery = modules[name]
      .action({ request: request() })
      .then((result) => {
        ack = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ack, false);
    unblock();
    assert.equal((await delivery).status, 200);
    f.commitGate = null;
    const responses = await Promise.all(
      Array.from({ length: 99 }, () =>
        modules[name].action({ request: request() }),
      ),
    );
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(f.state.receipts.length, 1);
    assert.equal(f.state.receipts[0].status, "PENDING");
    let queries = 0;
    const deps = runner(f, async () =>
      modules.admin.productWebhookAdminClient(async (_query, options) => {
        queries++;
        assert.equal(options.tries, 1);
        assert.ok(options.signal);
        return productResponse();
      }),
    );
    await runProductWebhookWorker(config, deps);
    assert.equal(queries, 1);
    assert.equal(f.state.receipts[0].status, "COMPLETED");
    assert.equal(f.state.products.length, 1);
    await modules[name].action({ request: request() });
    await runProductWebhookWorker(config, deps);
    assert.equal(queries, 1);
  });
  test(`actual ${name} route preserves missing admin 503, missing ID 400 and commit failure 503`, async () => {
    const f = webhookFixture();
    auth(f, null);
    assert.equal(
      (await modules[name].action({ request: request() })).status,
      503,
    );
    auth(f);
    assert.equal(
      (await modules[name].action({ request: request(null) })).status,
      400,
    );
    f.failCommit = true;
    assert.equal(
      (await modules[name].action({ request: request() })).status,
      503,
    );
    assert.equal(f.state.receipts.length, 0);
    globalThis.webhookAuth = new Error("invalid signature");
    await assert.rejects(
      modules[name].action({ request: request() }),
      /invalid signature/,
    );
    assert.equal(f.state.receipts.length, 0);
  });
}

test("idempotency is shop-scoped; legacy completed, failed and cancelled duplicates never restart", async () => {
  const f = webhookFixture();
  const outcomes = await Promise.all(Array.from({ length: 100 }, () => add(f)));
  assert.equal(outcomes.filter((value) => value === "ACCEPTED").length, 1);
  assert.equal(
    outcomes.filter((value) => value === "DUPLICATE_DURABLE").length,
    99,
  );
  await add(f, { shopDomain: "other.myshopify.com" });
  assert.equal(f.state.receipts.length, 2);
  for (const status of ["COMPLETED", "FAILED", "CANCELLED"]) {
    f.state.receipts[0].status = status;
    assert.equal(await add(f), "DUPLICATE_DURABLE");
    assert.equal(f.state.receipts[0].status, status);
  }
});

test("competing claims select distinct work; run lease excludes overlapping workers", async () => {
  const f = webhookFixture();
  await add(f);
  await add(f, { webhookId: "delivery-2" });
  const lease = await getLease(f);
  assert.equal(await getLease(f), null);
  const works = await Promise.all([getClaim(f, lease), getClaim(f, lease)]);
  assert.notEqual(works[0].id, works[1].id);
  assert.notEqual(works[0].claimToken, works[1].claimToken);
  await release(f.client, lease);
  assert.ok(await getLease(f));
});

test("expired claims recover with a new token; old owner cannot complete, retry, fail or release newer lease", async () => {
  const f = webhookFixture();
  await add(f);
  const oldLease = await getLease(f),
    old = await getClaim(f, oldLease);
  const later = new Date(+old.claimedAt + config.claimStaleMs + 1);
  const lease = await acquire(f.client, config.claimStaleMs, later);
  const current = await getClaim(f, lease, later);
  assert.equal(current.staleRecovered, true);
  assert.equal(current.attemptCount, 2);
  assert.notEqual(current.claimToken, old.claimToken);
  for (const error of [
    { code: "THROTTLED", retryable: true },
    { code: "APPLICATION_ERROR", retryable: false },
  ])
    await assert.rejects(
      f.tx((tx) => fail(tx, old, config, error, later)),
      WebhookOwnershipLostError,
    );
  await assert.rejects(
    f.tx((tx) => complete(tx, old, later)),
    WebhookOwnershipLostError,
  );
  await release(f.client, oldLease);
  assert.equal(f.state.leases[0].ownerToken, lease.ownerToken);
  await f.tx((tx) => complete(tx, current, later));
  assert.equal(f.state.receipts[0].status, "COMPLETED");
});

test("same live lease cannot use a superseded row claim", async () => {
  const f = webhookFixture();
  await add(f);
  const lease = await getLease(f),
    old = await getClaim(f, lease);
  f.state.receipts[0].claimToken = "replacement";
  await assert.rejects(
    f.tx((tx) => complete(tx, old)),
    WebhookOwnershipLostError,
  );
  await assert.rejects(
    f.tx((tx) =>
      fail(tx, old, config, { code: "THROTTLED", retryable: true }, now()),
    ),
    WebhookOwnershipLostError,
  );
  assert.equal(f.state.receipts[0].status, "PROCESSING");
});

test("future retry, live processing and terminal rows are skipped; stale final attempt becomes FAILED", async () => {
  const f = webhookFixture();
  await add(f);
  const lease = await getLease(f);
  const row = f.state.receipts[0],
    time = now();
  for (const status of [
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "RETRY",
    "PROCESSING",
  ]) {
    Object.assign(row, {
      status,
      nextAttemptAt: new Date(+time + 10000),
      claimedAt: time,
    });
    assert.equal(await getClaim(f, lease, time), null);
  }
  Object.assign(row, {
    status: "PROCESSING",
    claimedAt: new Date(+time - config.claimStaleMs - 1),
    attemptCount: config.maxAttempts,
  });
  assert.equal((await getClaim(f, lease, time)).exhausted, true);
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastErrorClass, "ATTEMPTS_EXHAUSTED");
});

test("structured throttle survives Response and SDK errors, HTTP failures and network errors are retryable", async () => {
  for (const value of [
    { errors: [{ extensions: { code: "THROTTLED" } }] },
    {
      body: {
        errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] },
      },
    },
    { response: { status: 429 } },
  ])
    assert.deepEqual(classifyProductWebhookError(value), {
      code: "THROTTLED",
      retryable: true,
    });
  for (const value of [
    { status: 503 },
    { code: "ECONNRESET" },
    { cause: { code: "ETIMEDOUT" } },
    { name: "TimeoutError" },
    { code: "P2034" },
  ])
    assert.equal(classifyProductWebhookError(value).retryable, true);
  assert.equal(
    classifyProductWebhookError(new HttpRequestError("synthetic no response"))
      .code,
    "NETWORK",
  );
  assert.equal(
    classifyProductWebhookError(
      new GraphqlQueryError({
        message: "private",
        response: { status: 200 },
        headers: {},
        body: {
          errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] },
        },
      }),
    ).code,
    "THROTTLED",
  );
  assert.equal(
    classifyProductWebhookError(new Error("secret arbitrary message"))
      .retryable,
    false,
  );
  const admin = modules.admin.productWebhookAdminClient(async () =>
    Response.json({
      errors: [{ message: "private", extensions: { code: "THROTTLED" } }],
    }),
  );
  await assert.rejects(
    admin.graphql("query"),
    (error) => classifyProductWebhookError(error).code === "THROTTLED",
  );
});

test("throttle durably retries and cools down whole shop across runs, other shop proceeds, later retry completes", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  await add(f, { webhookId: "delivery-2" });
  await add(f, { shopDomain: "other.myshopify.com", webhookId: "other" });
  let queries = 0,
    throttle = true;
  const admin = async (domain) =>
    modules.admin.productWebhookAdminClient(async () => {
      queries++;
      return throttle && domain === input.shopDomain
        ? Response.json({
            errors: [{ message: "private", extensions: { code: "THROTTLED" } }],
          })
        : productResponse();
    });
  const at = now(),
    deps = runner(f, admin, at);
  await runProductWebhookWorker(config, deps);
  assert.equal(queries, 2);
  assert.deepEqual(
    f.state.receipts.map((row) => row.status),
    ["RETRY", "PENDING", "COMPLETED"],
  );
  assert.equal(+f.state.receipts[0].nextAttemptAt, +at + 30000);
  await runProductWebhookWorker(config, runner(f, admin, at));
  assert.equal(queries, 2);
  throttle = false;
  await runProductWebhookWorker(
    config,
    runner(f, admin, new Date(+at + 30001)),
  );
  assert.equal(queries, 4);
  assert.ok(f.state.receipts.every((row) => row.status === "COMPLETED"));
  assert.ok(!JSON.stringify(deps.logs).includes("private"));
});

test("fair per-shop cap, run bound, offline admin failure and finite terminal attempts", async () => {
  const f = webhookFixture();
  auth(f);
  for (let i = 0; i < 5; i++) await add(f, { webhookId: `item-${i}` });
  await add(f, { webhookId: "other", shopDomain: "other.myshopify.com" });
  let calls = 0;
  await runProductWebhookWorker(
    config,
    runner(f, async () => {
      calls++;
      return { graphql: async () => productResponse() };
    }),
  );
  assert.equal(calls, 3);
  assert.equal(
    f.state.receipts.filter((row) => row.status === "PENDING").length,
    3,
  );
  const pending = f.state.receipts.find((row) => row.status === "PENDING");
  pending.attemptCount = config.maxAttempts - 1;
  await runProductWebhookWorker(
    { ...config, maxItems: 1 },
    runner(f, async () => {
      throw new Error("secret offline auth failure");
    }),
  );
  assert.equal(pending.status, "FAILED");
  assert.equal(pending.lastErrorClass, "ADMIN_UNAVAILABLE");
});

test("actual product transaction rolls receipt completion back on downstream error and fences stale owner before mutations", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  const lease = await getLease(f),
    work = await getClaim(f, lease);
  f.eventFailure = true;
  await assert.rejects(
    process(work, { graphql: async () => productResponse() }),
  );
  assert.equal(f.state.receipts[0].status, "PROCESSING");
  assert.equal(f.state.products.length, 0);
  assert.equal(f.state.events.length, 0);
  f.eventFailure = false;
  f.state.receipts[0].claimToken = "new-owner";
  await assert.rejects(
    process(work, { graphql: async () => productResponse() }),
    /WEBHOOK_OWNERSHIP_LOST/,
  );
  assert.equal(f.state.products.length, 0);
  assert.equal(f.state.events.length, 0);
});

test("actual core preserves newer snapshots and deletion tombstones, completes stale receipt without product/queue mutation", async () => {
  for (const deletedAt of [null, new Date()]) {
    const f = webhookFixture();
    auth(f);
    await add(f);
    const work = await getClaim(f, await getLease(f));
    const stored = {
      id: "state",
      shopId: work.shopId,
      shopifyProductGid: input.productGid,
      deletedAt,
      shopifyUpdatedAt: new Date("2027-01-01"),
      lastDetectedAt: now(),
      contentHash: "newer",
      indexabilityState: "NOT_PUBLISHED",
    };
    f.state.products.push(stored);
    const before = structuredClone(stored);
    const result = await process(work, {
      graphql: async () => productResponse(),
    });
    assert.equal(result.stale, true);
    assert.deepEqual(f.state.products[0], before);
    assert.equal(f.state.queues.length, 0);
    assert.equal(f.state.receipts[0].status, "COMPLETED");
  }
});

test("default-disabled runner does no durable/admin/provider work", async () => {
  const calls = [];
  const deps = new Proxy(
    { log: (event) => calls.push(event) },
    {
      get: (target, key) =>
        target[key] ??
        (() => {
          throw new Error(`unexpected ${String(key)}`);
        }),
    },
  );
  await runProductWebhookWorker(productWebhookConfig({}), deps);
  assert.deepEqual(calls, ["product_webhook_worker_disabled"]);
  const worker = readFileSync("workers/product-webhook-worker.ts", "utf8");
  assert.ok(
    !/executeIndexNow|sendIndexNow|materializeProvider|fetch\(/.test(worker),
  );
});

test("actual core commits one INTERNAL queue intent with canonical URL, fingerprint changes and no provider call", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  const lease = await getLease(f);
  let title = "First";
  let updatedAt = "2026-01-01T00:00:00.000Z";
  const admin = {
    graphql: async () => {
      const body = await productResponse(updatedAt).json();
      Object.assign(body.data.product, {
        status: "ACTIVE",
        title,
        onlineStoreUrl: "https://public.example/products/sample",
        publishedAt: "2025-01-01",
      });
      return Response.json(body);
    },
  };
  let result = await process(await getClaim(f, lease), admin);
  assert.equal(result.queued, true);
  assert.equal(f.state.queues.length, 1);
  assert.equal(f.state.queues[0].provider, "INTERNAL");
  assert.equal(f.state.queues[0].url, "https://public.example/products/sample");
  const hash = f.state.products[0].contentHash;
  await add(f, { webhookId: "delivery-2" });
  title = "Changed";
  updatedAt = "2026-01-01T00:00:01.000Z";
  result = await process(await getClaim(f, lease), admin);
  assert.equal(result.changed, true);
  assert.equal(result.stale, false);
  assert.equal(f.state.queues.length, 1);
  assert.notEqual(f.state.products[0].contentHash, hash);
  await add(f, { webhookId: "delivery-3" });
  result = await process(await getClaim(f, lease), admin);
  assert.equal(result.changed, false);
  assert.equal(result.queued, false);
  assert.equal(result.stale, false);
  assert.equal(f.state.queues.length, 1);
  assert.ok(f.state.receipts.every((row) => row.status === "COMPLETED"));
});

test("actual worker import graph has no indexing provider client or executor", () => {
  const paths = Object.keys(workerGraph.metafile.inputs);
  assert.ok(paths.some((path) => path.endsWith("product-indexing.server.ts")));
  assert.ok(
    paths.every(
      (path) =>
        !/indexnow-(?:client|executor)|provider-materialization|bing|google/i.test(
          path,
        ),
    ),
  );
  const imports = Object.values(workerGraph.metafile.inputs).flatMap((input) =>
    input.imports.map((item) => item.path),
  );
  assert.ok(
    imports.every(
      (path) =>
        !/indexnow-(?:client|executor)|provider-materialization/i.test(path),
    ),
  );
});

test("route and worker logs never expose synthetic credentials, response bodies or merchant identifiers", async () => {
  const f = webhookFixture();
  auth(f);
  const secret = "synthetic-private-token";
  const messages = [],
    original = console.error;
  console.error = (message) => messages.push(message);
  const transaction = f.client.$transaction;
  try {
    f.client.$transaction = async () => {
      throw new Error(`${secret} private body ${input.shopDomain}`);
    };
    assert.equal(
      (await modules.update.action({ request: request() })).status,
      503,
    );
  } finally {
    console.error = original;
    f.client.$transaction = transaction;
  }
  await add(f);
  const deps = runner(f, async () => {
    throw new Error(`${secret} private body ${input.shopDomain}`);
  });
  await runProductWebhookWorker(config, deps);
  const output = JSON.stringify([
    ...messages,
    ...deps.logs,
    f.state.receipts[0].lastErrorClass,
  ]);
  for (const sensitive of [
    secret,
    "private body",
    input.shopDomain,
    input.webhookId,
  ])
    assert.ok(!output.includes(sensitive));
});

test("competing compare-and-set updates cannot both own one receipt", async () => {
  const f = webhookFixture();
  await add(f);
  const lease = await getLease(f),
    at = now();
  const results = await Promise.all([
    claim(f.client, config, lease, [], at),
    claim(f.client, config, lease, [], at),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.state.receipts[0].attemptCount, 1);
});

test("actual default-disabled worker entry performs no DB/admin work and sanitizes disconnect failure", async () => {
  const enabled = nodeProcess.env.PRODUCT_WEBHOOK_WORKER_ENABLED,
    exitCode = nodeProcess.exitCode;
  const originalLog = console.log,
    originalError = console.error,
    logs = [];
  let disconnected = 0;
  nodeProcess.env.PRODUCT_WEBHOOK_WORKER_ENABLED = "false";
  globalThis.webhookDB = {
    $disconnect: async () => {
      disconnected++;
      throw new Error("synthetic-private-disconnect");
    },
  };
  console.log = console.error = (message) => logs.push(message);
  try {
    await import("../build-tests/product-webhook-worker-entry-test.mjs");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnected, 1);
    assert.equal(nodeProcess.exitCode, 1);
    assert.ok(
      logs.some((message) =>
        message.includes("product_webhook_worker_disabled"),
      ),
    );
    assert.ok(logs.some((message) => message.includes("DISCONNECT_FAILURE")));
    assert.ok(!JSON.stringify(logs).includes("synthetic-private-disconnect"));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    nodeProcess.exitCode = exitCode;
    if (enabled === undefined)
      delete nodeProcess.env.PRODUCT_WEBHOOK_WORKER_ENABLED;
    else nodeProcess.env.PRODUCT_WEBHOOK_WORKER_ENABLED = enabled;
  }
});

test("missing primary-domain fallback persists domain only within the fenced product transaction", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  f.state.shops[0].primaryDomain = null;
  const work = await getClaim(f, await getLease(f));
  let queries = 0;
  const result = await modules.core.processProductDetection({
    admin: {
      graphql: async (query) => {
        queries++;
        return query.includes("ShopPrimaryDomain")
          ? Response.json({
              data: {
                shop: {
                  primaryDomain: {
                    host: "new.example",
                    url: "https://new.example",
                  },
                },
              },
            })
          : productResponse();
      },
    },
    shopDomain: work.shop.domain,
    productGid: work.shopifyProductGid,
    eventType: "UPDATED",
    durableClaim: work,
  });
  assert.equal(result.stale, false);
  assert.equal(queries, 2);
  assert.equal(f.state.shops[0].primaryDomain, "new.example");
  assert.equal(
    f.state.products[0].candidateUrl,
    "https://new.example/products/sample",
  );
});

test("hard lifetime has at least 60s margin to every accepted stale/lease configuration", () => {
  assert.equal(PRODUCT_WEBHOOK_HARD_LIMIT_MS, 240000);
  assert.equal(PRODUCT_WEBHOOK_SAFETY_MARGIN_MS, 60000);
  for (const stale of [300000, 300001, 900000, 3600000]) {
    const cfg = productWebhookConfig({ PRODUCT_WEBHOOK_WORKER_CLAIM_STALE_MS: String(stale) });
    assert.ok(PRODUCT_WEBHOOK_HARD_LIMIT_MS + PRODUCT_WEBHOOK_SAFETY_MARGIN_MS <= cfg.claimStaleMs);
  }
  assert.throws(() => productWebhookConfig({ PRODUCT_WEBHOOK_WORKER_CLAIM_STALE_MS: "299999" }));
});

for (const loss of ["receipt", "lease", "expired"]) {
  test(`post-admin guard: pending admin returns after ${loss} ownership loss; zero product queries or mutations`, async () => {
    const f = webhookFixture();
    auth(f);
    await add(f);
    let resolveAdmin, began;
    const started = new Promise((resolve) => { began = resolve; });
    let queries = 0;
    const deps = runner(f, () => { began(); return new Promise((resolve) => { resolveAdmin = resolve; }); });
    const running = runProductWebhookWorker(config, deps);
    await started;
    if (loss === "receipt") f.state.receipts[0].claimToken = "replacement";
    if (loss === "lease") f.state.leases[0].ownerToken = "replacement";
    if (loss === "expired") deps.now = () => new Date(+f.state.receipts[0].claimedAt + config.claimStaleMs + 1);
    resolveAdmin({ graphql: async () => { queries++; return productResponse(); } });
    await running;
    assert.equal(queries, 0);
    assert.equal(f.state.products.length, 0);
    assert.equal(f.state.events.length, 0);
    assert.equal(f.state.receipts[0].status, "PROCESSING");
    if (loss === "lease") assert.equal(f.state.leases[0].ownerToken, "replacement");
    assert.ok(deps.logs.some((entry) => entry.reason === "OWNERSHIP_LOST"));
  });
}

test("runner claims sequentially through success, failure and delay barriers", { timeout: 5000 }, async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const expected = [
    "acquire", "claim1:start", "claim1:end", "admin1:start", "admin1:end",
    "guard1:start", "guard1:end", "process1:start", "process1:end", "delay1:start", "delay1:end",
    "claim2:start", "claim2:end", "admin2:start", "admin2:end",
    "guard2:start", "guard2:end", "process2:start", "process2:end",
    "fail2:start", "fail2:end", "delay2:start", "delay2:end",
    "claim3:start", "claim3:end", "release",
  ];
  const events = [];
  const record = (event) => {
    assert.equal(event, expected[events.length], "NEXT_CLAIM_STARTED_BEFORE_WORK_CYCLE_FINISHED");
    events.push(event);
  };
  const stages = ["claim1", "admin1", "guard1", "process1", "delay1", "fail2", "delay2"];
  const gates = new Map(stages.map((stage) => [stage, { entered: deferred(), finish: deferred() }]));
  const hold = async (stage) => {
    const gate = gates.get(stage);
    gate.entered.resolve();
    await gate.finish.promise;
  };
  let claimCalls = 0, currentClaims = 0, maxConcurrentClaims = 0;
  let acquireCalls = 0, releaseCalls = 0, delayCalls = 0;
  const lease = { ownerToken: "synthetic-lease", ttlMs: config.claimStaleMs };
  const work = (number) => ({
    exhausted: false, shopId: String(number), shop: { domain: "synthetic.example" },
    shopifyProductGid: "gid://shopify/Product/1", attemptCount: 1, number,
  });
  const running = runProductWebhookWorker({ ...config, maxItems: 3 }, {
    acquireLease: async () => { acquireCalls++; record("acquire"); return lease; },
    releaseLease: async (released) => {
      assert.equal(released, lease); releaseCalls++; record("release");
    },
    claim: async (owned) => {
      assert.equal(owned, lease);
      const number = ++claimCalls;
      currentClaims++; maxConcurrentClaims = Math.max(maxConcurrentClaims, currentClaims);
      record("claim" + number + ":start");
      try {
        if (number === 1) await hold("claim1");
        record("claim" + number + ":end");
        return number < 3 ? work(number) : null;
      } finally { currentClaims--; }
    },
    admin: async (domain) => {
      assert.equal(domain, "synthetic.example");
      const number = claimCalls;
      record("admin" + number + ":start");
      if (number === 1) await hold("admin1");
      record("admin" + number + ":end");
      return {};
    },
    guard: async (item) => {
      record("guard" + item.number + ":start");
      if (item.number === 1) await hold("guard1");
      record("guard" + item.number + ":end");
    },
    process: async (item) => {
      record("process" + item.number + ":start");
      if (item.number === 1) await hold("process1");
      record("process" + item.number + ":end");
      if (item.number === 2) throw new Error("SYNTHETIC_APPLICATION_FAILURE");
    },
    fail: async (item, error) => {
      assert.equal(item.number, 2);
      assert.deepEqual(error, { code: "APPLICATION_ERROR", retryable: false });
      record("fail2:start"); await hold("fail2"); record("fail2:end");
      return { status: "FAILED", lastErrorClass: "APPLICATION_ERROR" };
    },
    delay: async (ms) => {
      assert.equal(ms, config.interItemDelayMs);
      const stage = "delay" + ++delayCalls;
      record(stage + ":start"); await hold(stage); record(stage + ":end");
    },
    now, shouldStop: () => false, log: () => {},
  });
  // Observe errors immediately, including early speculative claims, so a broken
  // runner fails the test rather than hanging while we await an unreached gate.
  const outcome = running.then(() => ({ done: true }), (error) => ({ error }));
  const ended = outcome.then((result) => {
    throw result.error ?? new Error("RUNNER_FINISHED_BEFORE_EXPECTED_BARRIER");
  });
  try {
    for (const stage of stages) {
      await Promise.race([gates.get(stage).entered.promise, ended]);
      assert.equal(claimCalls, stage === "fail2" || stage === "delay2" ? 2 : 1);
      assert.equal(currentClaims, stage === "claim1" ? 1 : 0);
      gates.get(stage).finish.resolve();
    }
    const result = await outcome;
    if (result.error) throw result.error;
    assert.equal(acquireCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(claimCalls, 3);
    assert.equal(maxConcurrentClaims, 1);
    assert.equal(currentClaims, 0);
    assert.equal(delayCalls, 2);
    assert.deepEqual(events, expected);
  } finally {
    for (const gate of gates.values()) gate.finish.resolve();
    // The race observer intentionally rejects on normal completion too.
    await ended.catch(() => {});
  }
});

test("stop requested during admin acquisition prevents product processing and further claims", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  await add(f, { webhookId: "second" });
  let stopped = false, queries = 0;
  const deps = runner(f, async () => {
    stopped = true;
    return { graphql: async () => { queries++; return productResponse(); } };
  });
  deps.shouldStop = () => stopped;
  await runProductWebhookWorker(config, deps);
  assert.equal(queries, 0);
  assert.deepEqual(f.state.receipts.map((row) => row.status), ["PROCESSING", "PENDING"]);
  assert.equal(f.state.products.length, 0);
});

// Execute the ACTUAL bundled worker entry in a separate process. Only its clock and
// external I/O are replaced: no production environment override of the hard limit.
function workerChild(mode) {
  const script = `
    import assert from 'node:assert/strict';
    import timers from 'node:timers';
    import {syncBuiltinESMExports} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import {Session} from '@shopify/shopify-api';
    import {setAbstractFetchFunc} from '@shopify/shopify-api/runtime';
    import {webhookFixture} from './tests/product-webhook-fixture.mjs';
    const root = pathToFileURL(process.cwd() + '/');
    const {unauthenticatedAdminContextFactory} = await import(new URL('node_modules/@shopify/shopify-app-react-router/dist/esm/server/unauthenticated/admin/factory.mjs', root));
    const {refreshToken} = await import(new URL('node_modules/@shopify/shopify-api/dist/esm/lib/auth/oauth/refresh-token.mjs', root));
    const {acceptProductWebhookWithClient} = await import('./app/services/product-webhook-store.ts');
    const f = webhookFixture();
    await f.tx(tx => acceptProductWebhookWithClient(tx, ${JSON.stringify(input)}));
    globalThis.webhookDB = f.client;
    let armedAt, timerRequested, refreshBegan = false, sessionWrites = 0, productQueries = 0, cleared = false;
    const set = timers.setTimeout, clear = timers.clearTimeout;
    let hardTimer;
    timers.setTimeout = (fn, ms, ...args) => {
      if (ms === 240000) { timerRequested = ms; armedAt = performance.now(); hardTimer = set(fn, ms / 100, ...args); return hardTimer; }
      return set(fn, ms, ...args);
    };
    timers.clearTimeout = handle => { if (handle === hardTimer) cleared = true; return clear(handle); };
    syncBuiltinESMExports();
    const logger = {debug() {}, info() {}, warning() {}, error() {}};
    const apiConfig = {apiKey:'synthetic-key', apiSecretKey:'synthetic-secret', hostName:'app.example', logger:{level:0,log() {}}};
    const session = new Session({id:'offline_test', shop:${JSON.stringify(input.shopDomain)}, state:'', isOnline:false, accessToken:'synthetic-token', refreshToken:'synthetic-refresh', expires:new Date(0)});
    const params = {
      logger,
      config: {distribution:'app_store', future:{expiringOfflineAccessTokens:true}, sessionStorage:{loadSession:async()=>session,storeSession:async()=>{sessionWrites++;}}},
      api: {session:{getOfflineId:()=>session.id},auth:{refreshToken:refreshToken(apiConfig)}}
    };
    setAbstractFetchFunc((_url, options) => {
      assert.equal(f.state.receipts[0].status, 'PROCESSING');
      assert.equal(options.signal, undefined);
      refreshBegan = true;
      if (${JSON.stringify(mode)} === 'signal-pending') process.emit('SIGTERM');
      return new Promise(() => {});
    });
    globalThis.webhookOfflineAdmin = ${JSON.stringify(mode)} === 'fast'
      ? async () => ({session, admin:{graphql:async()=>{productQueries++;return ${productResponse.toString()}();}}})
      : unauthenticatedAdminContextFactory(params);
    const input = ${JSON.stringify(input)};
    process.env.PRODUCT_WEBHOOK_WORKER_ENABLED = 'true';
    process.env.PRODUCT_WEBHOOK_WORKER_CLAIM_STALE_MS = '300000';
    process.env.PRODUCT_WEBHOOK_WORKER_MAX_ITEMS = '1';
    process.on('exit', () => console.log(JSON.stringify({probe:'worker-child',mode:${JSON.stringify(mode)},timerRequested,elapsed:performance.now()-armedAt,refreshBegan,sessionWrites,productQueries,cleared,status:f.state.receipts[0].status,products:f.state.products.length,events:f.state.events.length,leaseOwned:!!f.state.leases[0]?.ownerToken})));
    await import('./build-tests/product-webhook-worker-entry-test.mjs');
  `;
  const env = { ...nodeProcess.env };
  delete env.DATABASE_URL;
  const child = spawnSync(nodeProcess.execPath, [
    "--experimental-strip-types", "--import", "./scripts/pure-test-isolation.mjs",
    "--input-type=module", "--eval", script,
  ], { cwd: nodeProcess.cwd(), env, encoding: "utf8", timeout: 15000 });
  assert.ifError(child.error);
  const line = child.stdout.split(/\r?\n/).find((value) => value.includes('"probe":"worker-child"'));
  assert.ok(line, child.stderr + child.stdout);
  return { child, result: JSON.parse(line) };
}

for (const mode of ["pending", "signal-pending"]) {
  test(`actual child worker hard-exits with installed pending SDK refresh (${mode}), before scaled stale window`, () => {
    const { child, result } = workerChild(mode);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(result.timerRequested, PRODUCT_WEBHOOK_HARD_LIMIT_MS);
    assert.equal(result.refreshBegan, true);
    assert.ok(result.elapsed >= 2300 && result.elapsed < 3000, JSON.stringify(result));
    assert.equal(result.productQueries, 0);
    assert.equal(result.sessionWrites, 0);
    assert.equal(result.products, 0);
    assert.equal(result.events, 0);
    assert.equal(result.status, "PROCESSING");
    assert.equal(result.leaseOwned, true);
    assert.equal(result.cleared, false);
    assert.match(child.stderr, /HARD_LIFETIME_EXCEEDED/);
  });
}

test("actual fast child worker completes and clears hard timer after disconnect", () => {
  const { child, result } = workerChild("fast");
  assert.equal(child.status, 0, child.stderr);
  assert.equal(result.productQueries, 1);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.cleared, true);
  assert.equal(result.leaseOwned, false);
  assert.ok(result.elapsed < 2400);
});

test("claim domain A never overwrites current domain B; product only and candidate uses B", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  const work = await getClaim(f, await getLease(f));
  const oldDomain = work.shop.primaryDomain;
  f.state.shops[0].primaryDomain = "current.example";
  let productQueries = 0;
  await process(work, { graphql: async (query) => {
    assert.ok(!query.includes("ShopPrimaryDomain"));
    productQueries++;
    return productResponse();
  } });
  assert.notEqual(oldDomain, f.state.shops[0].primaryDomain);
  assert.equal(f.state.shops[0].primaryDomain, "current.example");
  assert.equal(f.state.products[0].candidateUrl, "https://current.example/products/sample");
  assert.equal(productQueries, 1);
});

test("fresh fallback F cannot overwrite concurrent persisted B; candidate uses B without query loop", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  f.state.shops[0].primaryDomain = null;
  const work = await getClaim(f, await getLease(f));
  let products = 0, domains = 0;
  await process(work, { graphql: async (query) => {
    if (!query.includes("ShopPrimaryDomain")) { products++; return productResponse(); }
    domains++;
    f.state.shops[0].primaryDomain = "concurrent.example";
    return Response.json({ data: { shop: { primaryDomain: { host: "fresh.example" } } } });
  } });
  assert.equal(f.state.shops[0].primaryDomain, "concurrent.example");
  assert.equal(f.state.products[0].candidateUrl, "https://concurrent.example/products/sample");
  assert.equal(products, 1);
  assert.equal(domains, 1);
});

test("stable persisted domain uses one product query and preserves authoritative onlineStoreUrl", async () => {
  const f = webhookFixture();
  auth(f);
  await add(f);
  const work = await getClaim(f, await getLease(f));
  let queries = 0;
  await process(work, { graphql: async (query) => {
    assert.ok(!query.includes("ShopPrimaryDomain"));
    queries++;
    const body = await productResponse().json();
    body.data.product.onlineStoreUrl = "https://canonical.example/products/canonical";
    return Response.json(body);
  } });
  assert.equal(queries, 1);
  assert.equal(f.state.shops[0].primaryDomain, work.shop.primaryDomain);
  assert.equal(f.state.products[0].candidateUrl, "https://store.example/products/sample");
  assert.equal(f.state.products[0].canonicalUrl, "https://canonical.example/products/canonical");
});

test("domain changed after core read uses transaction current domain; stale owner cannot persist fallback", async () => {
  for (const stale of [false, true]) {
    const f = webhookFixture();
    auth(f);
    await add(f);
    if (stale) f.state.shops[0].primaryDomain = null;
    const work = await getClaim(f, await getLease(f));
    const processing = process(work, { graphql: async (query) => {
      if (query.includes("ShopPrimaryDomain")) {
        f.state.receipts[0].claimToken = "replacement";
        return Response.json({ data: { shop: { primaryDomain: { host: "fresh.example" } } } });
      }
      if (!stale) f.state.shops[0].primaryDomain = "transaction.example";
      return productResponse();
    } });
    if (stale) {
      await assert.rejects(processing, /WEBHOOK_OWNERSHIP_LOST/);
      assert.equal(f.state.shops[0].primaryDomain, null);
      assert.equal(f.state.products.length, 0);
    } else {
      await processing;
      assert.equal(f.state.shops[0].primaryDomain, "transaction.example");
      assert.equal(f.state.products[0].candidateUrl, "https://transaction.example/products/sample");
    }
  }
});
