import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNextWithClient,
  markCompletedWithClient,
  markFailedWithClient,
  recoverExpiredProcessingWithClient,
} from "../app/services/index-queue-orchestration.ts";

const token = new Date("2026-08-20T10:00:00Z");
const fixedNow = new Date("2026-08-20T10:10:00Z");

function queueItem(overrides = {}) {
  return {
    id: "queue-1",
    shopId: "shop-1",
    shopifyProductGid: "gid://shopify/Product/1",
    provider: "INTERNAL",
    action: "INDEX",
    status: "PROCESSING",
    claimedAt: token,
    dedupeKey: null,
    retryCount: 0,
    maxRetries: 5,
    ...overrides,
  };
}

test("claimNext uses one exact ownership token and clears pending-only fields", async () => {
  let updateArgs;
  const claimed = queueItem({ claimedAt: token });
  const client = { indexQueueItem: {
    findFirst: async () => queueItem({ status: "PENDING", claimedAt: null, dedupeKey: "pending-key" }),
    updateMany: async (args) => { updateArgs = args; return { count: 1 }; },
    findUniqueOrThrow: async () => claimed,
  } };
  const result = await claimNextWithClient(client, "INTERNAL", () => token);
  assert.equal(result, claimed);
  assert.deepEqual(updateArgs.where, { id: "queue-1", status: "PENDING" });
  assert.equal(updateArgs.data.claimedAt, token);
  assert.equal(updateArgs.data.dedupeKey, null);
  assert.equal(updateArgs.data.completedAt, null);
});

test("markCompleted predicates on exact ownership and reports loss without an unconditional update", async () => {
  for (const [count, expected] of [[1, "completed"], [0, "ownership_lost"]]) {
    const calls = [];
    const client = { indexQueueItem: {
      updateMany: async (args) => { calls.push(args); return { count }; },
      findUniqueOrThrow: async () => queueItem({ status: "COMPLETED", claimedAt: null }),
    } };
    const result = await markCompletedWithClient(client, "queue-1", token, () => fixedNow);
    assert.equal(result.outcome, expected);
    assert.deepEqual(calls[0].where, { id: "queue-1", status: "PROCESSING", claimedAt: token });
    assert.equal(calls.length, 1);
  }
});

function failedHarness({ current = queueItem(), successor = null, updateCount = 1 } = {}) {
  const updates = [];
  let finds = 0;
  const tx = { indexQueueItem: {
    findUnique: async () => (finds++ === 0 ? current : successor),
    updateMany: async (args) => { updates.push(args); return { count: updateCount }; },
    findUniqueOrThrow: async () => queueItem({ status: successor ? "SKIPPED" : "PENDING", claimedAt: null }),
  } };
  return { tx, updates };
}

test("markFailed normal path predicates on owner for retry and supersession", async () => {
  for (const successor of [null, queueItem({ id: "successor", status: "PENDING", dedupeKey: "shop-1|gid://shopify/Product/1|INTERNAL|INDEX" })]) {
    const harness = failedHarness({ successor });
    const result = await markFailedWithClient({
      client: harness.tx,
      runTransaction: (operation) => operation(harness.tx),
      isUniqueConstraintError: () => false,
      id: "queue-1",
      expectedClaimedAt: token,
      error: "failed",
      retryAt: fixedNow,
      now: () => fixedNow,
    });
    assert.equal(result.outcome, "updated");
    assert.deepEqual(harness.updates[0].where, { id: "queue-1", status: "PROCESSING", claimedAt: token });
    assert.equal(harness.updates[0].data.status, successor ? "SKIPPED" : "PENDING");
  }
});

test("markFailed wrong owner performs no transition mutation", async () => {
  const harness = failedHarness({ current: queueItem({ claimedAt: new Date("2026-08-20T10:00:01Z") }) });
  const result = await markFailedWithClient({
    client: harness.tx,
    runTransaction: (operation) => operation(harness.tx),
    isUniqueConstraintError: () => false,
    id: "queue-1",
    expectedClaimedAt: token,
    error: "failed",
  });
  assert.equal(result.outcome, "ownership_lost");
  assert.equal(harness.updates.length, 0);
});

test("markFailed P2002 fallback is owner-protected for both winner outcomes", async () => {
  for (const [count, expected] of [[1, "updated"], [0, "ownership_lost"]]) {
    let fallbackArgs;
    const client = { indexQueueItem: {
      updateMany: async (args) => { fallbackArgs = args; return { count }; },
      findUniqueOrThrow: async () => queueItem({ status: "SKIPPED", claimedAt: null }),
    } };
    const result = await markFailedWithClient({
      client,
      runTransaction: async () => { throw { code: "P2002" }; },
      isUniqueConstraintError: (error) => error?.code === "P2002",
      id: "queue-1",
      expectedClaimedAt: token,
      error: "race",
      now: () => fixedNow,
    });
    assert.equal(result.outcome, expected);
    assert.deepEqual(fallbackArgs.where, { id: "queue-1", status: "PROCESSING", claimedAt: token });
  }
});

function recoveryHarness({ current = queueItem(), successor = null, updateCount = 1, fallbackCount = 1 } = {}) {
  let selectionArgs;
  const mutationArgs = [];
  const fallbackArgs = [];
  let finds = 0;
  const tx = { indexQueueItem: {
    findUnique: async () => (finds++ === 0 ? current : successor),
    updateMany: async (args) => { mutationArgs.push(args); return { count: updateCount }; },
  } };
  const client = { indexQueueItem: {
    findMany: async (args) => { selectionArgs = args; return [queueItem()]; },
    updateMany: async (args) => { fallbackArgs.push(args); return { count: fallbackCount }; },
  } };
  return { client, tx, mutationArgs, fallbackArgs, getSelectionArgs: () => selectionArgs };
}

test("expired recovery is scoped and owner-protected with and without successor", async () => {
  for (const successor of [null, queueItem({ id: "successor", status: "PENDING", dedupeKey: "shop-1|gid://shopify/Product/1|INTERNAL|INDEX" })]) {
    const harness = recoveryHarness({ successor });
    const result = await recoverExpiredProcessingWithClient({
      client: harness.client,
      runTransaction: (operation) => operation(harness.tx),
      isUniqueConstraintError: () => false,
      provider: "INTERNAL",
      leaseBefore: fixedNow,
      limit: 25,
      now: () => fixedNow,
    });
    assert.deepEqual(harness.getSelectionArgs().where, {
      provider: "INTERNAL",
      status: "PROCESSING",
      claimedAt: { lt: fixedNow },
    });
    assert.equal(harness.getSelectionArgs().take, 25);
    assert.deepEqual(harness.mutationArgs[0].where, { id: "queue-1", status: "PROCESSING", claimedAt: token });
    assert.equal(harness.mutationArgs[0].data.status, successor ? "SKIPPED" : "PENDING");
    assert.equal(successor ? result.skipped : result.requeued, 1);
  }
});

test("recovery reread with a newer claim records ownership loss without mutation", async () => {
  const harness = recoveryHarness({ current: queueItem({ claimedAt: new Date("2026-08-20T10:00:01Z") }) });
  const result = await recoverExpiredProcessingWithClient({
    client: harness.client,
    runTransaction: (operation) => operation(harness.tx),
    isUniqueConstraintError: () => false,
    provider: "INTERNAL",
    leaseBefore: fixedNow,
  });
  assert.equal(result.ownershipLost, 1);
  assert.equal(harness.mutationArgs.length, 0);
});

test("recovery P2002 fallback predicates on stale token and distinguishes loss", async () => {
  for (const [count, expectedSkipped, expectedLost] of [[1, 1, 0], [0, 0, 1]]) {
    const harness = recoveryHarness({ fallbackCount: count });
    const result = await recoverExpiredProcessingWithClient({
      client: harness.client,
      runTransaction: async () => { throw { code: "P2002" }; },
      isUniqueConstraintError: (error) => error?.code === "P2002",
      provider: "INTERNAL",
      leaseBefore: fixedNow,
      now: () => fixedNow,
    });
    assert.deepEqual(harness.fallbackArgs[0].where, { id: "queue-1", status: "PROCESSING", claimedAt: token });
    assert.equal(result.skipped, expectedSkipped);
    assert.equal(result.ownershipLost, expectedLost);
  }
});
