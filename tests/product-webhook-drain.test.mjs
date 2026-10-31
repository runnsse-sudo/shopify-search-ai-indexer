/* eslint-env node, es2020 */
import assert from "node:assert/strict";
import test from "node:test";
import { build, stop } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { manifestDrainFixture } from "./product-webhook-fixture.mjs";
import {
  canonicalDrainJson,
  drainHash,
  drainProduct,
  drainQueue,
  parseProductWebhookDrain,
  createDrainEffectState,
} from "../app/services/product-webhook-drain-contract.ts";
import {
  productWebhookConfig,
  WebhookOwnershipLostError,
} from "../app/services/product-webhook-control.ts";
import {
  preflightProductWebhookDrainWithClient,
  claimManifestProductWebhookWithClient as exactClaim,
  acquireProductWebhookLeaseWithClient,
  releaseProductWebhookLeaseWithClient,
  guardProductWebhookClaimWithClient,
  failProductWebhookWithClient,
} from "../app/services/product-webhook-store.ts";
import {
  runManifestBoundProductWebhookDrain,
  runProductWebhookWorker,
} from "../app/services/product-webhook-runner.ts";

const temp = mkdtempSync(join(tmpdir(), "webhook-drain-tests-"));
const plugin = {
  name: "isolated-drain-db",
  setup(b) {
    b.onResolve({ filter: /^@prisma\/client$/ }, () => ({
      path: "prisma",
      namespace: "drain",
    }));
    b.onResolve({ filter: /db\.server$/ }, () => ({
      path: "db",
      namespace: "drain",
    }));
    b.onResolve({ filter: /shopify\.server$/ }, () => ({
      path: "auth",
      namespace: "drain",
    }));
    b.onLoad({ filter: /.*/, namespace: "drain" }, ({ path }) => ({
      loader: "js",
      contents:
        path === "prisma"
          ? `import{createRequire}from'node:module';export const {Prisma}=createRequire(${JSON.stringify(join(process.cwd(), "package.json"))})('@prisma/client');`
          : path === "db"
            ? "export default new Proxy({}, {get:(_,key)=>globalThis.drainDB[key]});"
            : "export const unauthenticated={admin:()=>{throw Error('SDK_ADMIN_FORBIDDEN')}};export const sessionStorage={loadSession:()=>{if(globalThis.drainSessionLoad)return globalThis.drainSessionLoad();throw Error('SESSION_LOAD_FORBIDDEN')}};",
    }));
  },
};
const modules = {};
for (const [name, entry] of Object.entries({
  core: "app/services/product-indexing.server.ts",
  auth: "app/services/product-webhook-drain-auth.server.ts",
  queue: "app/services/index-queue.server.ts",
  info: "app/services/shop-info.server.ts",
  product: "app/services/shopify-product.server.ts",
  worker: "workers/product-webhook-worker.ts",
})) {
  const out = join(temp, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: out,
    plugins: [plugin],
    nodePaths: [join(process.cwd(), "node_modules")],
  });
  if (name !== "worker") modules[name] = await import(pathToFileURL(out));
}
await build({
  entryPoints: ["workers/product-webhook-worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: join(temp, "worker-scaled.mjs"),
  plugins: [
    plugin,
    {
      name: "scaled-drain-clock",
      setup(b) {
        b.onLoad({ filter: /product-webhook-control\.ts$/ }, ({ path }) => ({
          loader: "ts",
          contents: readFileSync(path, "utf8").replace(
            "PRODUCT_WEBHOOK_HARD_LIMIT_MS = 240000",
            // Allow the fixture to finish its 20 synthetic claims on slower hosts;
            // the real worker deadline and the watchdog assertions are unchanged.
            "PRODUCT_WEBHOOK_HARD_LIMIT_MS = 2000",
          ),
        }));
        b.onLoad({ filter: /product-webhook-worker\.ts$/ }, ({ path }) => ({
          loader: "ts",
          contents: readFileSync(path, "utf8").replace(
            "setTimeout(resolve, ms)",
            "setTimeout(resolve, 0)",
          ),
        }));
      },
    },
  ],
});
stop();
const at = new Date();
const claimManifestProductWebhookWithClient = (...args) =>
  exactClaim(...args, "drain-test.myshopify.com");
function envFor(f) {
  const manifest = f.state.receipts
    .slice(0, 20)
    .map((r) =>
      Object.fromEntries(
        ["id", "shopId", "webhookId", "shopifyProductGid", "topic"].map((k) => [
          k,
          r[k],
        ]),
      ),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const raw = canonicalDrainJson(manifest),
    hash = drainHash(raw);
  const context = {
    manifestSha256: hash,
    domain: f.state.shops[0].domain,
    primaryDomain: f.state.shops[0].primaryDomain,
    products: f.state.products.map(drainProduct),
    queues: f.state.queues.map(drainQueue),
  };
  const effects = canonicalDrainJson(context);
  return {
    PRODUCT_WEBHOOK_WORKER_ENABLED: "true",
    PRODUCT_WEBHOOK_DRAIN_MODE: "manifest-once-v1",
    PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64: Buffer.from(raw).toString("base64"),
    PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256: hash,
    PRODUCT_WEBHOOK_DRAIN_EFFECTS_B64: Buffer.from(effects).toString("base64"),
    PRODUCT_WEBHOOK_DRAIN_EFFECTS_SHA256: drainHash(effects),
  };
}
function setup() {
  const f = manifestDrainFixture(at);
  const env = envFor(f);
  const config = productWebhookConfig(env);
  globalThis.drainDB = f.client;
  return { f, env, config, spec: config.drain };
}
function product(id) {
  return {
    id,
    legacyResourceId: "1",
    handle: "sample",
    title: "Sample",
    descriptionHtml: "",
    productType: "",
    vendor: "",
    tags: [],
    status: "ACTIVE",
    onlineStoreUrl: "https://store.example/products/sample",
    publishedAt: at.toISOString(),
    updatedAt: at.toISOString(),
    seo: { title: null, description: null },
    variants: { nodes: [] },
    media: { nodes: [] },
  };
}
function authInput(spec) {
  let clock = +at,
    loads = 0;
  const requests = [];
  const metadata = {
    domain: "drain-test.myshopify.com",
    primaryDomain: "store.example",
    sessions: [
      {
        id: "offline_drain-test.myshopify.com",
        shop: "drain-test.myshopify.com",
        isOnline: false,
        scope: "read_products",
        expires: new Date(clock + 3600000),
      },
    ],
  };
  const input = {
    spec,
    requiredScopes: "read_products",
    now: () => new Date(clock),
    readMetadata: async () => structuredClone(metadata),
    loadSession: async () => {
      loads++;
      return {
        ...metadata.sessions[0],
        accessToken: "SYNTHETIC_SECRET",
        isScopeChanged: () => false,
      };
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({
        url,
        redirect: options.redirect,
        method: options.method,
      });
      return new Response(
        JSON.stringify(
          body.query.includes("ShopPrimaryDomain")
            ? {
                data: {
                  shop: {
                    primaryDomain: {
                      host: "store.example",
                      url: "https://store.example",
                    },
                  },
                },
              }
            : { data: { product: product(body.variables.id) } },
        ),
      );
    },
  };
  return {
    input,
    metadata,
    requests,
    loads: () => loads,
    advance: (ms) => {
      clock += ms;
    },
  };
}
function dependencies(f, spec) {
  const logs = [],
    counts = { auth: 0, acquire: 0, fail: 0, process: 0 };
  const a = authInput(spec);
  const d = {
    preflight: () =>
      f.tx((tx) => preflightProductWebhookDrainWithClient(tx, spec, at)),
    auth: async () => {
      counts.auth++;
      return modules.auth.prepareProductWebhookDrainAuth(a.input);
    },
    acquireLease: () => {
      counts.acquire++;
      return acquireProductWebhookLeaseWithClient(f.client, 900000, at);
    },
    releaseLease: (lease) =>
      releaseProductWebhookLeaseWithClient(f.client, lease),
    claim: (m, lease, now) =>
      f.tx((tx) =>
        claimManifestProductWebhookWithClient(tx, spec, m, lease, now),
      ),
    guard: (work, now) =>
      f.tx((tx) => guardProductWebhookClaimWithClient(tx, work, now)),
    process: (work, admin, effects) => {
      counts.process++;
      return modules.core.processProductDetection({
        admin,
        shopDomain: work.shop.domain,
        productGid: work.shopifyProductGid,
        eventType: "UPDATED",
        metadata: { webhookId: work.webhookId },
        durableClaim: work,
        drainEffects: effects,
      });
    },
    fail: (work, error, now) => {
      counts.fail++;
      return f.tx((tx) =>
        failProductWebhookWithClient(
          tx,
          work,
          productWebhookConfig({}),
          error,
          now,
        ),
      );
    },
    log: (event, details) => logs.push({ event, ...details }),
    now: () => at,
    delay: async () => {},
    shouldStop: () => false,
  };
  return { d, a, counts, logs };
}

test("strict canonical synthetic20/one-shop/17 parser and separate effect hash", () => {
  const { env, spec } = setup();
  assert.equal(spec.manifest.length, 20);
  assert.equal(spec.context.products.length, 17);
  assert.ok(Object.isFrozen(spec.manifest[0]));
  for (const patch of [
    { PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256: "0".repeat(64) },
    { PRODUCT_WEBHOOK_DRAIN_MODE: "bulk" },
    { PRODUCT_WEBHOOK_DRAIN_EXTRA: "1" },
    { PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64: "!!!!" },
    { PRODUCT_WEBHOOK_WORKER_MAX_ITEMS: "25" },
    { PRODUCT_WEBHOOK_WORKER_INTER_ITEM_DELAY_MS: "500" },
  ])
    assert.throws(() => productWebhookConfig({ ...env, ...patch }));
});
test("duplicate/extra keys, whitespace, wrong count/shop/GID cannot parse", () => {
  const { env, spec } = setup();
  const variants = [
    spec.manifest.slice(1),
    [...spec.manifest.slice(1), spec.manifest[1]],
    spec.manifest.map((r, i) => (i ? r : { ...r, extra: true })),
    spec.manifest.map((r, i) => (i ? r : { ...r, topic: "products/delete" })),
    spec.manifest.map((r, i) => (i ? r : { ...r, shopifyProductGid: "wrong" })),
    spec.manifest.map((r, i) => (i ? r : { ...r, shopId: "other" })),
  ];
  for (const m of variants) {
    const raw = canonicalDrainJson(m);
    assert.throws(() =>
      parseProductWebhookDrain({
        ...env,
        PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64: Buffer.from(raw).toString("base64"),
        PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256: drainHash(raw),
      }),
    );
  }
  const raw = ` ${canonicalDrainJson(spec.manifest)}`;
  assert.throws(() =>
    parseProductWebhookDrain({
      ...env,
      PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64: Buffer.from(raw).toString("base64"),
      PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256: drainHash(raw),
    }),
  );
});
test("disabled drain does zero metadata/auth/lease work; ordinary rejects drain dispatch", async () => {
  const { f, env, spec } = setup();
  const h = dependencies(f, spec);
  await runManifestBoundProductWebhookDrain(
    productWebhookConfig({ ...env, PRODUCT_WEBHOOK_WORKER_ENABLED: "false" }),
    h.d,
  );
  assert.equal(h.counts.auth, 0);
  assert.equal(h.counts.acquire, 0);
  await assert.rejects(runProductWebhookWorker(productWebhookConfig(env), h.d));
});
test("exact claims ignore earlier arrivals and never recover retries/stale processing", async () => {
  const { f, spec } = setup();
  const extra = {
    ...f.state.receipts[0],
    id: "outside",
    webhookId: "outside",
    receivedAt: new Date(0),
  };
  f.state.receipts.push(extra);
  const lease = await acquireProductWebhookLeaseWithClient(
    f.client,
    900000,
    at,
  );
  const w = await f.tx((tx) =>
    claimManifestProductWebhookWithClient(
      tx,
      spec,
      spec.manifest[0],
      lease,
      at,
    ),
  );
  assert.equal(w.id, spec.manifest[0].id);
  assert.equal(extra.attemptCount, 0);
  await assert.rejects(
    f.tx((tx) =>
      claimManifestProductWebhookWithClient(
        tx,
        spec,
        { ...spec.manifest[1], id: "outside" },
        lease,
        at,
      ),
    ),
  );
  for (const status of ["RETRY", "PROCESSING", "COMPLETED", "FAILED"]) {
    f.state.receipts[1].status = status;
    await assert.rejects(
      f.tx((tx) =>
        claimManifestProductWebhookWithClient(
          tx,
          spec,
          spec.manifest[1],
          lease,
          at,
        ),
      ),
    );
  }
});
test("missing/changed/owned/not-due M blocks before auth and lease", async () => {
  for (const change of [
    (f) => f.state.receipts.pop(),
    (f) => {
      f.state.receipts[0].webhookId = "changed";
    },
    (f) => {
      f.state.receipts[0].claimToken = "owned";
    },
    (f) => {
      f.state.receipts[0].nextAttemptAt = new Date(+at + 1);
    },
  ]) {
    const { f, spec, config } = setup();
    change(f);
    const h = dependencies(f, spec);
    await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
    assert.equal(h.counts.auth, 0);
    assert.equal(h.counts.acquire, 0);
  }
});
test("expired/near/null/online/ambiguous/scopes block before credential load/network/lease", async () => {
  for (const mutate of [
    (m) => {
      m.sessions[0].expires = new Date(+at - 1);
    },
    (m) => {
      m.sessions[0].expires = new Date(+at + 600000);
    },
    (m) => {
      m.sessions[0].expires = null;
    },
    (m) => {
      m.sessions[0].isOnline = true;
    },
    (m) => {
      m.sessions.push({ ...m.sessions[0] });
    },
    (m) => {
      m.sessions[0].scope = "read_orders";
    },
  ]) {
    const { f, spec, config } = setup();
    const h = dependencies(f, spec);
    mutate(h.a.metadata);
    await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
    assert.equal(h.a.loads(), 0);
    assert.equal(h.a.requests.length, 0);
    assert.equal(h.counts.acquire, 0);
    assert.equal(f.state.leases.length, 0);
    assert.ok(f.state.receipts.every((r) => r.attemptCount === 0));
  }
});
test("session load race and later clock/expiry/domain drift stop without refresh", async () => {
  const { spec } = setup();
  const h = authInput(spec);
  h.input.loadSession = async () => ({
    ...h.metadata.sessions[0],
    expires: new Date(+at + 7200000),
    accessToken: "SYNTHETIC_SECRET",
    isScopeChanged: () => false,
  });
  await assert.rejects(modules.auth.prepareProductWebhookDrainAuth(h.input));
  assert.equal(h.requests.length, 0);
  const a = authInput(spec);
  const ready = await modules.auth.prepareProductWebhookDrainAuth(a.input);
  a.advance(3600000);
  await assert.rejects(ready.check());
  assert.equal(a.loads(), 1);
});
test("auth read before lease; valid20 same-shop receipts commit20 events/17 products, no provider or secret logs", async () => {
  const { f, config, spec } = setup();
  const h = dependencies(f, spec);
  await runManifestBoundProductWebhookDrain(config, h.d);
  assert.equal(h.counts.process, 20);
  assert.equal(f.state.events.length, 20);
  assert.equal(f.state.products.length, 17);
  assert.ok(
    f.state.receipts.every(
      (r) =>
        r.status === "COMPLETED" &&
        r.attemptCount === 1 &&
        r.claimToken === null,
    ),
  );
  assert.equal(h.a.requests.length, 21);
  assert.ok(
    h.a.requests.every(
      (r) =>
        r.url ===
          "https://drain-test.myshopify.com/admin/api/2026-07/graphql.json" &&
        r.redirect === "error",
    ),
  );
  assert.ok(
    !JSON.stringify(h.logs).match(
      /SYNTHETIC_SECRET|myshopify|claimToken|delivery-/,
    ),
  );
  assert.equal(f.state.leases[0].ownerToken, null);
  await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
});
test("unknown operations/variables/headers and request cap fail without OAuth transport", async () => {
  const { spec } = setup();
  const h = authInput(spec);
  const { admin } = await modules.auth.prepareProductWebhookDrainAuth(h.input);
  await assert.rejects(admin.graphql("mutation { shop { id } }"));
  assert.equal(h.requests.length, 1);
  await assert.rejects(
    modules.product.fetchProductForIndexing(admin, "gid://shopify/Product/999"),
  );
  assert.equal(h.requests.length, 1);
  const h2 = authInput(spec);
  const r = await modules.auth.prepareProductWebhookDrainAuth(h2.input);
  for (let i = 0; i < 20; i++)
    await modules.product.fetchProductForIndexing(
      r.admin,
      spec.manifest[0].shopifyProductGid,
    );
  await assert.rejects(
    modules.product.fetchProductForIndexing(
      r.admin,
      spec.manifest[0].shopifyProductGid,
    ),
  );
  assert.equal(h2.requests.length, 21);
});
test("401/403 and network first failure stop without another claim or refresh", async () => {
  for (const status of [401, 403, 429]) {
    const { f, spec, config } = setup();
    const h = dependencies(f, spec);
    const original = h.a.input.fetch;
    h.a.input.fetch = (url, opts) =>
      JSON.parse(opts.body).query.includes("ProductForIndexing")
        ? Promise.resolve(new Response("", { status }))
        : original(url, opts);
    await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
    assert.equal(h.a.loads(), 1);
    assert.equal(h.counts.process, 1);
    assert.equal(h.counts.fail, 1);
    assert.equal(
      f.state.receipts.filter((r) => r.attemptCount === 1).length,
      1,
    );
    assert.equal(
      f.state.receipts.filter((r) => r.status === "PENDING").length,
      19,
    );
  }
});
test("unknown queue or product version causes atomic product/event/completion rollback", async () => {
  for (const mutate of [
    (f) =>
      f.state.queues.push({
        id: "unknown",
        shopId: "drain-shop",
        shopifyProductGid: "gid://shopify/Product/1",
        status: "PENDING",
        action: "INDEX",
        provider: "BING",
        updatedAt: at,
        dedupeKey: "foreign",
      }),
    (f) => {
      f.state.products[0].contentHash = "b".repeat(64);
    },
  ]) {
    const { f, spec } = setup();
    const state = createDrainEffectState(spec);
    const lease = await acquireProductWebhookLeaseWithClient(
      f.client,
      900000,
      at,
    );
    const work = await f.tx((tx) =>
      claimManifestProductWebhookWithClient(
        tx,
        spec,
        spec.manifest[0],
        lease,
        at,
      ),
    );
    mutate(f);
    globalThis.drainDB = f.client;
    const a = await modules.auth.prepareProductWebhookDrainAuth(
      authInput(spec).input,
    );
    await assert.rejects(
      modules.core.processProductDetection({
        admin: a.admin,
        shopDomain: work.shop.domain,
        productGid: work.shopifyProductGid,
        eventType: "UPDATED",
        durableClaim: work,
        drainEffects: state,
      }),
    );
    assert.equal(f.state.receipts[0].status, "PROCESSING");
    assert.equal(f.state.events.length, 0);
    assert.equal(state.created.size, 0);
  }
});
test("lease busy, ownership loss, stop and release failure cannot signal full drain", async () => {
  const { f, config, spec } = setup();
  const h = dependencies(f, spec);
  h.d.acquireLease = async () => null;
  await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
  assert.equal(h.counts.process, 0);
  const h2 = dependencies(f, spec);
  h2.d.guard = async () => {
    throw new WebhookOwnershipLostError();
  };
  await assert.rejects(runManifestBoundProductWebhookDrain(config, h2.d));
  assert.equal(h2.counts.fail, 0);
  const s = setup();
  const h3 = dependencies(s.f, s.spec);
  h3.d.shouldStop = () => true;
  await assert.rejects(runManifestBoundProductWebhookDrain(s.config, h3.d));
  assert.equal(h3.counts.auth, 0);
});
test("effect allowance remains unchanged if transaction fails after internal intent creation", async () => {
  const { f, spec } = setup();
  const state = createDrainEffectState(spec);
  const lease = await acquireProductWebhookLeaseWithClient(
    f.client,
    900000,
    at,
  );
  const work = await f.tx((tx) =>
    claimManifestProductWebhookWithClient(
      tx,
      spec,
      spec.manifest[0],
      lease,
      at,
    ),
  );
  const a = await modules.auth.prepareProductWebhookDrainAuth(
    authInput(spec).input,
  );
  f.failCommit = true;
  await assert.rejects(
    modules.core.processProductDetection({
      admin: a.admin,
      shopDomain: work.shop.domain,
      productGid: work.shopifyProductGid,
      eventType: "UPDATED",
      durableClaim: work,
      drainEffects: state,
    }),
  );
  assert.equal(state.created.size, 0);
  assert.equal(f.state.queues.length, 0);
  assert.equal(f.state.events.length, 0);
  assert.equal(f.state.receipts[0].status, "PROCESSING");
});
test("actual isolated entrypoint expired metadata never calls SDK admin, session load, fetch or lease", () => {
  const { env } = setup();
  const code = `import {manifestDrainFixture} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "tests/product-webhook-fixture.mjs")).href)};const f=manifestDrainFixture();globalThis.drainDB=f.client;f.client.session={findMany:async()=>[{id:'offline_drain-test.myshopify.com',shop:'drain-test.myshopify.com',isOnline:false,scope:'read_products',expires:new Date(0)}]};globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};f.client.$disconnect=async()=>{console.log(JSON.stringify({leases:f.state.leases.length,claims:f.state.receipts.filter(r=>r.attemptCount).length}))};await import(${JSON.stringify(pathToFileURL(join(temp, "worker.mjs")).href)});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      env: { ...env, NODE_PATH: join(process.cwd(), "node_modules") },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(child.status, 1);
  assert.match(child.stdout, /AUTH_REFRESH_REQUIRED/);
  assert.match(child.stdout, /"leases":0,"claims":0/);
  assert.ok(!child.stdout.includes("SYNTHETIC_SECRET"));
});

test("owned intents refresh/cancel across repeated products; provider history stays untouched", async () => {
  const f = manifestDrainFixture(at);
  const p = "gid://shopify/Product/1";
  for (let i = 0; i < 18; i++)
    f.state.queues.push({
      id: `provider-${i}`,
      shopId: "drain-shop",
      shopifyProductGid: `gid://shopify/Product/${(i % 17) + 1}`,
      provider: "INDEXNOW",
      action: "INDEX",
      status: "COMPLETED",
      updatedAt: at,
      dedupeKey: null,
    });
  f.state.queues.push({
    id: "cancelled",
    shopId: "drain-shop",
    shopifyProductGid: p,
    provider: "INTERNAL",
    action: "INDEX",
    status: "CANCELLED",
    updatedAt: at,
    dedupeKey: null,
  });
  f.state.queues.push({
    id: "pending-deindex",
    shopId: "drain-shop",
    shopifyProductGid: p,
    provider: "INTERNAL",
    action: "DEINDEX",
    status: "PENDING",
    updatedAt: at,
    dedupeKey: `drain-shop|${p}|INTERNAL|DEINDEX`,
  });
  const before = structuredClone(f.state.queues.slice(0, 19)),
    config = productWebhookConfig(envFor(f)),
    spec = config.drain;
  globalThis.drainDB = f.client;
  const h = dependencies(f, spec);
  const seen = new Map();
  let effects;
  h.a.input.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes("ShopPrimaryDomain"))
      return Response.json({
        data: { shop: { primaryDomain: { host: "store.example" } } },
      });
    const id = body.variables.id,
      count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    const value = product(id);
    if (id === p && count === 2)
      Object.assign(value, {
        status: "DRAFT",
        onlineStoreUrl: null,
        publishedAt: null,
        updatedAt: new Date(+at + 1).toISOString(),
      });
    if (id === "gid://shopify/Product/2" && count === 2)
      Object.assign(value, {
        title: "Changed",
        updatedAt: new Date(+at + 1).toISOString(),
      });
    return Response.json({ data: { product: value } });
  };
  const process = h.d.process;
  h.d.process = (work, admin, state) => {
    effects = state;
    return process(work, admin, state);
  };
  await runManifestBoundProductWebhookDrain(config, h.d);
  assert.deepEqual(f.state.queues.slice(0, 19), before);
  assert.equal(
    f.state.queues.find((q) => q.id === "pending-deindex").status,
    "CANCELLED",
  );
  assert.equal(effects.created.size, 18);
  assert.equal(effects.cancelled.size, 2);
  assert.equal(effects.events.size, 20);
  assert.equal(
    f.state.queues.find(
      (q) =>
        q.shopifyProductGid === "gid://shopify/Product/2" &&
        q.provider === "INTERNAL",
    ).reason,
    "CONTENT_CHANGED",
  );
});
test("new intent budget and late event failure rollback without allowance leaks", async () => {
  const { f, spec } = setup();
  const effects = createDrainEffectState(spec);
  effects.created = new Set(Array.from({ length: 20 }, (_, i) => `used-${i}`));
  const lease = await acquireProductWebhookLeaseWithClient(
    f.client,
    900000,
    at,
  );
  const work = await f.tx((tx) =>
    claimManifestProductWebhookWithClient(
      tx,
      spec,
      spec.manifest[0],
      lease,
      at,
    ),
  );
  const a = await modules.auth.prepareProductWebhookDrainAuth(
    authInput(spec).input,
  );
  await assert.rejects(
    modules.core.processProductDetection({
      admin: a.admin,
      shopDomain: work.shop.domain,
      productGid: work.shopifyProductGid,
      eventType: "UPDATED",
      durableClaim: work,
      drainEffects: effects,
    }),
  );
  assert.equal(f.state.queues.length, 0);
  assert.equal(f.state.events.length, 0);
  assert.equal(f.state.receipts[0].status, "PROCESSING");
});
test("clock deadline before lease and failed release reject without full success", async () => {
  const { f, spec, config } = setup();
  const h = dependencies(f, spec);
  let clock = +at;
  h.d.now = () => new Date(clock);
  const auth = h.d.auth;
  h.d.auth = async (shop) => {
    const r = await auth(shop);
    clock += 240000;
    return r;
  };
  await assert.rejects(runManifestBoundProductWebhookDrain(config, h.d));
  assert.equal(h.counts.acquire, 0);
  const s = setup(),
    r = dependencies(s.f, s.spec);
  r.d.releaseLease = async () => {
    throw new Error("SYNTHETIC_DISCONNECT_SECRET");
  };
  await assert.rejects(runManifestBoundProductWebhookDrain(s.config, r.d));
  assert.ok(!JSON.stringify(r.logs).includes("SYNTHETIC_DISCONNECT_SECRET"));
});
test("shop race before CAS and receipt identity race after claim are fenced", async () => {
  const { f, spec } = setup();
  const lease = await acquireProductWebhookLeaseWithClient(
    f.client,
    900000,
    at,
  );
  f.state.shops[0].domain = "changed.myshopify.com";
  await assert.rejects(
    f.tx((tx) =>
      claimManifestProductWebhookWithClient(
        tx,
        spec,
        spec.manifest[0],
        lease,
        at,
      ),
    ),
  );
  assert.equal(f.state.receipts[0].attemptCount, 0);
  f.state.shops[0].domain = "drain-test.myshopify.com";
  const work = await f.tx((tx) =>
    claimManifestProductWebhookWithClient(
      tx,
      spec,
      spec.manifest[0],
      lease,
      at,
    ),
  );
  f.state.receipts[0].webhookId = "changed-after-claim";
  await assert.rejects(
    f.tx((tx) => guardProductWebhookClaimWithClient(tx, work, at)),
    WebhookOwnershipLostError,
  );
});
for (const mode of ["pending-auth", "pending-disconnect"])
  test(`scaled actual drain watchdog stops ${mode} without OAuth or hidden rerun`, () => {
    const { env } = setup();
    const code = `import {manifestDrainFixture} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "tests/product-webhook-fixture.mjs")).href)};const f=manifestDrainFixture(at);globalThis.drainDB=f.client;const metadata={id:'offline_drain-test.myshopify.com',shop:'drain-test.myshopify.com',isOnline:false,scope:'read_products',expires:new Date(Date.now()+3600000)};f.client.session={findMany:async()=>[metadata]};globalThis.drainSessionLoad=async()=>({...metadata,accessToken:'SYNTHETIC_ONLY',isScopeChanged:()=>false});globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);if(${JSON.stringify(mode)}==='pending-auth')return new Promise(()=>{});if(body.query.includes('ShopPrimaryDomain'))return Response.json({data:{shop:{primaryDomain:{host:'store.example'}}}});return Response.json({data:{product:${product.toString()}(body.variables.id)}})};f.client.$disconnect=async()=>{if(${JSON.stringify(mode)}==='pending-disconnect')await new Promise(()=>{});};process.on('exit',()=>console.log(JSON.stringify({claims:f.state.receipts.filter(r=>r.attemptCount).length})));await import(${JSON.stringify(pathToFileURL(join(temp, "worker-scaled.mjs")).href)});`;
    // The synthetic product helper uses only this local timestamp, never environment credentials.
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const at=new Date(${JSON.stringify(at.toISOString())});${code}`,
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /HARD_LIFETIME_EXCEEDED/);
    assert.match(
      child.stdout,
      mode === "pending-auth" ? /"claims":0/ : /"claims":20/,
    );
  });
