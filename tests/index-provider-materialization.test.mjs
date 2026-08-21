import assert from "node:assert/strict";
import test from "node:test";

import { materializeProductPushPlanWithClient } from "../app/services/index-provider-materialization.ts";
import { cancelPendingForProviderActionWithClient } from "../app/services/index-queue-client.ts";

const productUrl = "https://shop.example/products/widget";
const source = {
  id: "queue-internal-1",
  shopId: "shop-1",
  productIndexStateId: "state-1",
  shopifyProductGid: "gid://shopify/Product/1",
  provider: "INTERNAL",
  action: "INDEX",
  url: productUrl,
  reason: "CONTENT_CHANGED",
};

function target(provider = "INDEXNOW", action = source.action, url = productUrl) {
  return { provider, action, url };
}

function plan(targets = [target()], overrides = {}) {
  return { rejectionReason: null, targets, skipped: [], ...overrides };
}

function harness(created = true) {
  const cancellations = [];
  const enqueues = [];
  const tx = { marker: "same-transaction-client" };
  return {
    tx,
    cancellations,
    enqueues,
    dependencies: {
      cancelPending: async (receivedTx, input) => {
        cancellations.push({ tx: receivedTx, input });
        return { count: 0 };
      },
      enqueue: async (receivedTx, input) => {
        enqueues.push({ tx: receivedTx, input });
        return { item: { id: "downstream" }, created };
      },
    },
  };
}

async function materialize(input = {}, created = true) {
  const mock = harness(created);
  const result = await materializeProductPushPlanWithClient(
    mock.tx,
    { source: input.source ?? source, plan: input.plan ?? plan() },
    mock.dependencies,
  );
  return { ...mock, result };
}

async function assertRejectedWithoutWrites(input, message) {
  const mock = harness();
  await assert.rejects(
    materializeProductPushPlanWithClient(
      mock.tx,
      { source: input.source ?? source, plan: input.plan ?? plan() },
      mock.dependencies,
    ),
    { message },
  );
  assert.equal(mock.cancellations.length, 0);
  assert.equal(mock.enqueues.length, 0);
}

test("INTERNAL INDEX cancels only INDEXNOW DEINDEX before enqueueing INDEX", async () => {
  const result = await materialize();
  assert.deepEqual(result.cancellations[0].input, {
    shopId: source.shopId,
    shopifyProductGid: source.shopifyProductGid,
    provider: "INDEXNOW",
    action: "DEINDEX",
  });
  assert.equal(result.enqueues[0].input.action, "INDEX");
  assert.equal(result.enqueues[0].input.provider, "INDEXNOW");
});

test("INTERNAL DEINDEX cancels only INDEXNOW INDEX before enqueueing DEINDEX", async () => {
  const deindexSource = { ...source, action: "DEINDEX", reason: "BECAME_NON_INDEXABLE" };
  const result = await materialize({ source: deindexSource, plan: plan([target("INDEXNOW", "DEINDEX")]) });
  assert.equal(result.cancellations[0].input.action, "INDEX");
  assert.equal(result.enqueues[0].input.action, "DEINDEX");
});

test("INDEXNOW and BING materialize in supplied deterministic order with separate cancellation", async () => {
  const result = await materialize({ plan: plan([target("INDEXNOW"), target("BING")]) });
  assert.deepEqual(result.result.targets, [
    { provider: "INDEXNOW", action: "INDEX", outcome: "CREATED" },
    { provider: "BING", action: "INDEX", outcome: "CREATED" },
  ]);
  assert.deepEqual(result.cancellations.map(({ input }) => input.provider), ["INDEXNOW", "BING"]);
  assert.ok(result.cancellations.every(({ tx }) => tx === result.tx));
  assert.ok(result.enqueues.every(({ tx }) => tx === result.tx));
});

test("source row and lifecycle fields are never mutated", async () => {
  const before = structuredClone(source);
  const result = await materialize();
  assert.deepEqual(source, before);
  assert.equal(result.result.sourceQueueItemId, source.id);
  assert.equal(result.enqueues.some(({ input }) => "claimedAt" in input || "retryCount" in input), false);
});

test("provider-specific cancellation uses the exact pending identity predicate", async () => {
  const calls = [];
  const tx = { indexQueueItem: { updateMany: async (args) => (calls.push(args), { count: 1 }) } };
  await cancelPendingForProviderActionWithClient(tx, {
    shopId: "shop-1",
    shopifyProductGid: "product-1",
    provider: "INDEXNOW",
    action: "DEINDEX",
  });
  assert.deepEqual(calls[0].where, {
    shopId: "shop-1",
    shopifyProductGid: "product-1",
    provider: "INDEXNOW",
    action: "DEINDEX",
    status: "PENDING",
  });
  assert.deepEqual(calls[0].data, {
    status: "CANCELLED",
    completedAt: calls[0].data.completedAt,
    claimedAt: null,
    dedupeKey: null,
  });
  assert.ok(calls[0].data.completedAt instanceof Date);
});

test("provider cancellation cannot affect INTERNAL or another provider", async () => {
  const result = await materialize();
  const where = result.cancellations[0].input;
  assert.equal(where.provider, "INDEXNOW");
  assert.notEqual(where.provider, "INTERNAL");
  assert.notEqual(where.provider, "BING");
});

test("an existing target pending intent reports REFRESHED", async () => {
  const result = await materialize({}, false);
  assert.deepEqual(result.result.targets, [
    { provider: "INDEXNOW", action: "INDEX", outcome: "REFRESHED" },
  ]);
});

test("non-INTERNAL source is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { source: { ...source, provider: "INDEXNOW" } },
    "Product push materialization rejected: source provider must be INTERNAL",
  );
});

test("a rejected plan is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { plan: plan([], { rejectionReason: "URL_REQUIRED" }) },
    "Product push materialization rejected: plan is rejected (URL_REQUIRED)",
  );
});

for (const [provider, message] of [
  ["GOOGLE", "GOOGLE does not support product-push INDEX"],
  ["AI_AUDIT", "AI_AUDIT does not support product-push INDEX"],
  ["INTERNAL", "INTERNAL cannot be a downstream target"],
]) {
  test(`forged ${provider} target is rejected before writes`, async () => {
    await assertRejectedWithoutWrites(
      { plan: plan([target(provider)]) },
      `Product push materialization rejected: ${message}`,
    );
  });
}

test("forged BING DEINDEX target is rejected before writes", async () => {
  const deindexSource = { ...source, action: "DEINDEX" };
  await assertRejectedWithoutWrites(
    { source: deindexSource, plan: plan([target("BING", "DEINDEX")]) },
    "Product push materialization rejected: BING does not support product-push DEINDEX",
  );
});

test("target action mismatch is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { plan: plan([target("INDEXNOW", "DEINDEX")]) },
    "Product push materialization rejected: target action does not match source action",
  );
});

test("target URL mismatch is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { plan: plan([target("INDEXNOW", "INDEX", "https://shop.example/products/other")]) },
    "Product push materialization rejected: target URL does not match source URL",
  );
});

test("malformed target URL is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { plan: plan([target("INDEXNOW", "INDEX", "not-a-url")]) },
    "Product push materialization rejected: target URL is invalid (URL_INVALID)",
  );
});

test("non-HTTPS target URL is rejected before writes", async () => {
  await assertRejectedWithoutWrites(
    { plan: plan([target("INDEXNOW", "INDEX", "http://shop.example/products/widget")]) },
    "Product push materialization rejected: target URL is invalid (URL_NOT_HTTPS)",
  );
});

test("duplicate target entries materialize once", async () => {
  const result = await materialize({ plan: plan([target(), target(), target()]) });
  assert.equal(result.cancellations.length, 1);
  assert.equal(result.enqueues.length, 1);
  assert.equal(result.result.targets.length, 1);
});

test("skipped entries are audited without queue writes", async () => {
  const skipped = [{ provider: "BING", reason: "ACTION_UNSUPPORTED" }];
  const result = await materialize({ plan: plan([], { skipped }) });
  assert.equal(result.cancellations.length, 0);
  assert.equal(result.enqueues.length, 0);
  assert.deepEqual(result.result.skipped, skipped);
});

test("source identity fields and reason are copied exactly and URL uses planner normalization", async () => {
  const spacedSource = { ...source, url: `  ${productUrl}  ` };
  const result = await materialize({ source: spacedSource });
  assert.deepEqual(result.enqueues[0].input, {
    shopId: source.shopId,
    productIndexStateId: source.productIndexStateId,
    shopifyProductGid: source.shopifyProductGid,
    provider: "INDEXNOW",
    action: "INDEX",
    url: productUrl,
    reason: source.reason,
  });
});

test("a null source state identity is preserved exactly", async () => {
  const result = await materialize({ source: { ...source, productIndexStateId: null } });
  assert.equal(result.enqueues[0].input.productIndexStateId, null);
});
