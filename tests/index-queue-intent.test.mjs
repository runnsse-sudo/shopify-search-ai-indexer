import assert from "node:assert/strict";
import test from "node:test";
import {
  acquirePendingIntentSlot,
  applyQueueReconciliationPlan,
  auditQueueInvariants,
  assertQueueReconciliationCanApply,
  assertReconciliationCancellationCount,
  assertReconciliationNormalizationCount,
  buildQueueReconciliationPlan,
  claimPendingTransition,
  compactPendingIntent,
  createPendingIntentKey,
  pendingIntentRefresh,
  isExpiredProcessingClaim,
  normalizeRecoveryLimit,
  ownsProcessingClaim,
  processingCompletionTransition,
  processingFailureTransition,
  processingLeaseRecoveryTransition,
  retryRaceSupersededTransition,
  resolveProcessingLeaseBefore,
} from "../app/services/index-queue-intent.ts";

const identity = {
  shopId: "shop-1",
  shopifyProductGid: "gid://shopify/Product/1",
  provider: "INTERNAL",
  action: "INDEX",
};

test("pending identity excludes reason and URL while retaining all identity dimensions", () => {
  const key = createPendingIntentKey(identity);
  assert.equal(createPendingIntentKey({ ...identity, reason: "BECAME_INDEXABLE", url: "https://old" }), key);
  assert.equal(createPendingIntentKey({ ...identity, reason: "CONTENT_CHANGED", url: "https://new" }), key);
  assert.notEqual(createPendingIntentKey({ ...identity, action: "DEINDEX" }), key);
  assert.notEqual(createPendingIntentKey({ ...identity, provider: "BING" }), key);
  assert.notEqual(createPendingIntentKey({ ...identity, shopId: "shop-2" }), key);
  assert.notEqual(createPendingIntentKey({ ...identity, shopifyProductGid: "gid://shopify/Product/2" }), key);
});

test("pending compaction retains one slot and refreshes URL and reason without resetting retry count", () => {
  const pending = {
    ...identity,
    dedupeKey: createPendingIntentKey(identity),
    url: "https://old",
    reason: "BECAME_INDEXABLE",
    retryCount: 2,
  };
  const compacted = compactPendingIntent(pending, {
      url: "https://new",
      reason: "CONTENT_CHANGED",
      productIndexStateId: "state-new",
      now: new Date("2026-08-20T10:00:00Z"),
  });
  const refreshed = compacted.item;
  assert.equal(compacted.created, false);
  assert.equal(refreshed.dedupeKey, pending.dedupeKey);
  assert.equal(refreshed.url, "https://new");
  assert.equal(refreshed.reason, "CONTENT_CHANGED");
  assert.equal(refreshed.productIndexStateId, "state-new");
  assert.equal(refreshed.retryCount, 2);
  assert.equal(refreshed.lastError, null);
  assert.equal(compactPendingIntent(null, {
    url: "https://new",
    reason: "CONTENT_CHANGED",
    now: new Date(),
  }).created, true);
});

test("claim clears the pending slot key", () => {
  assert.deepEqual(claimPendingTransition(new Date("2026-08-20T10:00:00Z")), {
    status: "PROCESSING",
    claimedAt: new Date("2026-08-20T10:00:00Z"),
    completedAt: null,
    dedupeKey: null,
  });
});

test("claim token establishes ownership and only the correct owner can complete", () => {
  const token = new Date("2026-08-20T10:00:00Z");
  const item = { id: "queue-1", ...claimPendingTransition(token) };
  assert.equal(ownsProcessingClaim(item, "queue-1", token), true);
  assert.equal(ownsProcessingClaim(item, "queue-1", new Date("2026-08-20T10:00:01Z")), false);
  assert.deepEqual(processingCompletionTransition(new Date("2026-08-20T10:01:00Z")), {
    status: "COMPLETED",
    completedAt: new Date("2026-08-20T10:01:00Z"),
    claimedAt: null,
    dedupeKey: null,
    lastError: null,
  });
});

test("failure ownership rejects an old token and correct owner can restore one pending key", () => {
  const token = new Date("2026-08-20T10:00:00Z");
  const item = { id: "queue-1", ...claimPendingTransition(token) };
  assert.equal(ownsProcessingClaim(item, item.id, token), true);
  assert.equal(ownsProcessingClaim(item, item.id, new Date("2026-08-20T09:59:00Z")), false);
  const transition = processingFailureTransition({
    retryCount: 0,
    maxRetries: 5,
    error: "temporary",
    retryAt: new Date("2026-08-20T10:02:00Z"),
    pendingIntentKey: "pending-key",
    hasPendingSuccessor: false,
    now: new Date("2026-08-20T10:01:00Z"),
  });
  assert.equal(transition.status, "PENDING");
  assert.equal(transition.dedupeKey, "pending-key");
  assert.equal(transition.claimedAt, null);
});

test("failure with a newer successor skips old processing work without a second key", () => {
  const transition = processingFailureTransition({
    retryCount: 0,
    maxRetries: 5,
    error: "temporary",
    retryAt: new Date(),
    pendingIntentKey: "pending-key",
    hasPendingSuccessor: true,
    now: new Date(),
  });
  assert.equal(transition.status, "SKIPPED");
  assert.equal(transition.dedupeKey, null);
  assert.equal(transition.claimedAt, null);
});

test("expired processing recovery requeues without a successor and skips with one", () => {
  const base = {
    pendingIntentKey: "pending-key",
    now: new Date("2026-08-20T10:10:00Z"),
    nextAttemptAt: new Date("2026-08-20T10:10:00Z"),
  };
  const requeued = processingLeaseRecoveryTransition({ ...base, hasPendingSuccessor: false });
  assert.equal(requeued.status, "PENDING");
  assert.equal(requeued.dedupeKey, "pending-key");
  assert.equal(requeued.claimedAt, null);
  const superseded = processingLeaseRecoveryTransition({ ...base, hasPendingSuccessor: true });
  assert.equal(superseded.status, "SKIPPED");
  assert.equal(superseded.dedupeKey, null);
  assert.equal(superseded.claimedAt, null);
});

test("fresh processing is not expired and recovery is bounded", () => {
  const item = { status: "PROCESSING", claimedAt: new Date("2026-08-20T10:00:00Z") };
  assert.equal(isExpiredProcessingClaim(item, new Date("2026-08-20T09:59:00Z")), false);
  assert.equal(isExpiredProcessingClaim(item, new Date("2026-08-20T10:01:00Z")), true);
  assert.equal(normalizeRecoveryLimit(undefined), 100);
  assert.equal(normalizeRecoveryLimit(25), 25);
  assert.throws(() => normalizeRecoveryLimit(0), /between 1 and 1000/);
  assert.throws(() => normalizeRecoveryLimit(1001), /between 1 and 1000/);
  assert.equal(resolveProcessingLeaseBefore({
    leaseDurationMs: 60_000,
    now: new Date("2026-08-20T10:00:00Z"),
  }).toISOString(), "2026-08-20T09:59:00.000Z");
  assert.throws(() => resolveProcessingLeaseBefore({ leaseDurationMs: 0 }), /positive number/);
  assert.throws(() => resolveProcessingLeaseBefore({
    leaseBefore: new Date(),
    leaseDurationMs: 60_000,
  }), /not both/);
});

test("old recovery ownership cannot mutate a newer processing claim", () => {
  const staleToken = new Date("2026-08-20T09:00:00Z");
  const newerClaim = {
    id: "queue-1",
    status: "PROCESSING",
    claimedAt: new Date("2026-08-20T10:00:00Z"),
  };
  assert.equal(ownsProcessingClaim(newerClaim, newerClaim.id, staleToken), false);
  assert.equal(ownsProcessingClaim(newerClaim, newerClaim.id, newerClaim.claimedAt), true);
});

test("processing plus repeated changes creates and compacts one logical pending successor", () => {
  const processing = { ...identity, status: "PROCESSING", dedupeKey: null };
  const successor = {
    ...identity,
    status: "PENDING",
    dedupeKey: createPendingIntentKey(identity),
    url: "https://first",
    reason: "BECAME_INDEXABLE",
  };
  const compacted = {
    ...successor,
    ...pendingIntentRefresh({ url: "https://latest", reason: "CONTENT_CHANGED", now: new Date() }),
  };
  assert.equal(processing.dedupeKey, null);
  assert.equal(compacted.dedupeKey, successor.dedupeKey);
  assert.equal(compacted.url, "https://latest");
  assert.equal(compacted.reason, "CONTENT_CHANGED");
});

test("retry transitions restore a slot, skip when superseded, and terminate without a key", () => {
  const base = {
    retryCount: 0,
    maxRetries: 3,
    error: "provider failed",
    retryAt: new Date("2026-08-20T10:01:00Z"),
    pendingIntentKey: createPendingIntentKey(identity),
    now: new Date("2026-08-20T10:00:00Z"),
  };
  const retried = processingFailureTransition({ ...base, hasPendingSuccessor: false });
  assert.equal(retried.status, "PENDING");
  assert.equal(retried.dedupeKey, base.pendingIntentKey);
  const superseded = processingFailureTransition({ ...base, hasPendingSuccessor: true });
  assert.equal(superseded.status, "SKIPPED");
  assert.equal(superseded.dedupeKey, null);
  const terminal = processingFailureTransition({ ...base, retryCount: 2, hasPendingSuccessor: false });
  assert.equal(terminal.status, "FAILED");
  assert.equal(terminal.dedupeKey, null);
  assert.equal(terminal.claimedAt, null);
});

test("unique-key retry race fallback safely makes the older row terminal", () => {
  const transition = retryRaceSupersededTransition("race", new Date("2026-08-20T10:00:00Z"));
  assert.equal(transition.status, "SKIPPED");
  assert.equal(transition.dedupeKey, null);
  assert.deepEqual(transition.retryCount, { increment: 1 });
});

test("reconciliation keeps newest intent, is dry-run safe, and is idempotent", () => {
  const old = {
    ...identity,
    id: "old",
    status: "PENDING",
    dedupeKey: `${createPendingIntentKey(identity)}|BECAME_INDEXABLE`,
    url: "https://old",
    createdAt: new Date("2026-08-20T09:00:00Z"),
  };
  const newest = {
    ...identity,
    id: "new",
    status: "PENDING",
    dedupeKey: `${createPendingIntentKey(identity)}|CONTENT_CHANGED`,
    url: "https://new",
    createdAt: new Date("2026-08-20T10:00:00Z"),
  };
  const plan = buildQueueReconciliationPlan([old, newest]);
  assert.equal(plan.duplicateGroups, 1);
  assert.equal(plan.duplicateRowsToRemove, 1);
  assert.deepEqual(applyQueueReconciliationPlan([old, newest], plan, false), [old, newest]);
  const applied = applyQueueReconciliationPlan([old, newest], plan, true);
  assert.equal(applied.find((item) => item.id === "old").status, "CANCELLED");
  assert.equal(applied.find((item) => item.id === "new").url, "https://new");
  assert.equal(applied.find((item) => item.id === "new").dedupeKey, createPendingIntentKey(identity));
  const secondPlan = buildQueueReconciliationPlan(applied);
  assert.equal(secondPlan.duplicateGroups, 0);
  assert.equal(secondPlan.wouldMutate, 0);
});

test("reconciliation normalizes an old single key and APPLY rejects processing rows", () => {
  const single = {
    ...identity,
    id: "single",
    status: "PENDING",
    dedupeKey: `${createPendingIntentKey(identity)}|CONTENT_CHANGED`,
    url: "https://new",
    createdAt: new Date(),
  };
  const plan = buildQueueReconciliationPlan([single]);
  assert.equal(plan.singleRowsToNormalize, 1);
  assert.doesNotThrow(() => assertQueueReconciliationCanApply(0));
  assert.throws(() => assertQueueReconciliationCanApply(1), /zero PROCESSING/);
});

test("reconciliation keeper selection uses descending ID as the createdAt tie-break", () => {
  const createdAt = new Date("2026-08-20T10:00:00Z");
  const olderId = {
    ...identity,
    id: "item-a",
    status: "PENDING",
    dedupeKey: `${createPendingIntentKey(identity)}|OLD`,
    url: "https://old",
    createdAt,
  };
  const newerId = {
    ...identity,
    id: "item-z",
    status: "PENDING",
    dedupeKey: `${createPendingIntentKey(identity)}|NEW`,
    url: "https://new",
    createdAt,
  };
  const plan = buildQueueReconciliationPlan([olderId, newerId]);
  assert.deepEqual(plan.cancellations, [{ id: "item-a", keeperId: "item-z" }]);
  assert.deepEqual(plan.normalizations, [{
    id: "item-z",
    dedupeKey: createPendingIntentKey(identity),
  }]);
});

test("each reconciliation mutation count is checked independently", () => {
  assert.doesNotThrow(() => assertReconciliationCancellationCount(70, 70));
  assert.doesNotThrow(() => assertReconciliationNormalizationCount(16_882, 16_882));
  assert.throws(
    () => assertReconciliationCancellationCount(70, 69),
    /cancellation count mismatch/,
  );
  assert.throws(
    () => assertReconciliationNormalizationCount(16_882, 16_881),
    /normalization count mismatch/,
  );
});

test("queue audit distinguishes pending duplicates from processing and terminal key violations", () => {
  const item = (overrides) => ({
    ...identity,
    id: overrides.id,
    status: "PENDING",
    dedupeKey: createPendingIntentKey(identity),
    url: "https://product",
    createdAt: new Date(),
    ...overrides,
  });
  assert.deepEqual(auditQueueInvariants([
    item({ id: "pending-1" }),
    item({ id: "pending-2", dedupeKey: "old-reason-key" }),
    item({ id: "pending-no-key", shopifyProductGid: "gid://shopify/Product/2", dedupeKey: null }),
    item({ id: "processing", status: "PROCESSING", dedupeKey: "unexpected" }),
    item({ id: "terminal", status: "COMPLETED", dedupeKey: "unexpected" }),
  ]), {
    duplicatePendingIntentGroups: 1,
    processingWithDedupeKey: 1,
    pendingWithoutDedupeKey: 1,
    terminalWithDedupeKey: 1,
  });
});

test("enqueue retries when the old pending slot is claimed between conflict and refresh", async () => {
  const rows = [{ id: "old", status: "PENDING", dedupeKey: "K", url: "https://old" }];
  let createAttempts = 0;
  const result = await acquirePendingIntentSlot({
    createSlot: async () => {
      createAttempts += 1;
      if (rows.some((row) => row.dedupeKey === "K")) return false;
      rows.push({ id: "successor", status: "PENDING", dedupeKey: "K", url: "https://latest" });
      return true;
    },
    refreshSlot: async () => {
      if (createAttempts === 1) {
        const old = rows.find((row) => row.id === "old");
        old.status = "PROCESSING";
        old.dedupeKey = null;
      }
      const pending = rows.find((row) => row.status === "PENDING" && row.dedupeKey === "K");
      if (!pending) return false;
      pending.url = "https://latest";
      return true;
    },
    fetchSlot: async () => rows.find((row) => row.status === "PENDING" && row.dedupeKey === "K") ?? null,
  });
  assert.equal(result.created, true);
  assert.equal(result.attempts, 2);
  assert.equal(rows.find((row) => row.id === "old").status, "PROCESSING");
  assert.equal(rows.find((row) => row.id === "old").dedupeKey, null);
  assert.deepEqual(rows.filter((row) => row.status === "PENDING" && row.dedupeKey === "K"), [
    { id: "successor", status: "PENDING", dedupeKey: "K", url: "https://latest" },
  ]);
});

test("two concurrent-style enqueues share one slot and both resolve with latest refresh data", async () => {
  const rows = [];
  let releaseFirstRefresh;
  const firstMayRefresh = new Promise((resolve) => { releaseFirstRefresh = resolve; });
  let firstCreated;
  const enqueue = (url, pauseBeforeRefresh = false) => acquirePendingIntentSlot({
    createSlot: async () => {
      if (rows.some((row) => row.dedupeKey === "K")) return false;
      rows.push({ id: "pending", status: "PENDING", dedupeKey: "K", url });
      return true;
    },
    refreshSlot: async () => {
      if (pauseBeforeRefresh) await firstMayRefresh;
      const pending = rows.find((row) => row.status === "PENDING" && row.dedupeKey === "K");
      if (!pending) return false;
      pending.url = url;
      return true;
    },
    fetchSlot: async () => rows.find((row) => row.status === "PENDING" && row.dedupeKey === "K") ?? null,
  });

  const first = enqueue("https://first-finishes-last", true).then((result) => { firstCreated = result.created; return result; });
  await Promise.resolve();
  const second = await enqueue("https://second");
  releaseFirstRefresh();
  const firstResult = await first;
  assert.equal(firstCreated, true);
  assert.equal(second.created, false);
  assert.equal(firstResult.item.url, "https://first-finishes-last");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://first-finishes-last");
});
