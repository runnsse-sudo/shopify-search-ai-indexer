import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProductSnapshotOrder,
  parseShopifyUpdatedAt,
  staleDetectionResult,
  staleScanBookkeepingUpdate,
} from "../app/services/product-snapshot-order.ts";
import { processScanPageProducts } from "../app/services/scan-product-page.ts";
import { extractShopifyWebhookMetadata } from "../app/services/webhook-metadata.ts";

const storedVersion = new Date("2026-08-20T10:00:00Z");
const storedObservation = new Date("2026-08-20T10:01:00Z");
const existing = {
  deletedAt: null,
  shopifyUpdatedAt: storedVersion,
  lastDetectedAt: storedObservation,
  contentHash: "hash-a",
};

function decide(overrides = {}) {
  return decideProductSnapshotOrder({
    existing,
    incomingShopifyUpdatedAt: storedVersion,
    incomingSnapshotObservedAt: storedObservation,
    incomingContentHash: "hash-a",
    ...overrides,
  });
}

test("snapshot ordering accepts a first state and newer Shopify version", () => {
  assert.deepEqual(decide({ existing: null }), { accept: true, staleReason: null });
  assert.deepEqual(decide({ incomingShopifyUpdatedAt: new Date("2026-08-20T10:00:01Z") }), {
    accept: true,
    staleReason: null,
  });
});

test("snapshot ordering rejects an older Shopify version", () => {
  assert.deepEqual(decide({ incomingShopifyUpdatedAt: new Date("2026-08-20T09:59:59Z") }), {
    accept: false,
    staleReason: "OLDER_SHOPIFY_UPDATED_AT",
  });
});

test("equal Shopify versions use observation time", () => {
  assert.deepEqual(decide({ incomingSnapshotObservedAt: new Date("2026-08-20T10:01:01Z") }), {
    accept: true,
    staleReason: null,
  });
  assert.deepEqual(decide({ incomingSnapshotObservedAt: new Date("2026-08-20T10:00:59Z") }), {
    accept: false,
    staleReason: "OLDER_EQUAL_VERSION_SNAPSHOT",
  });
});

test("exactly equal timestamps accept identical hashes and reject ambiguous hashes", () => {
  assert.deepEqual(decide(), { accept: true, staleReason: null });
  assert.deepEqual(decide({ incomingContentHash: "hash-b" }), {
    accept: false,
    staleReason: "AMBIGUOUS_EQUAL_VERSION_SNAPSHOT",
  });
});

test("a deletion tombstone rejects even a newer Shopify snapshot", () => {
  assert.deepEqual(decide({
    existing: { ...existing, deletedAt: new Date("2026-08-20T10:02:00Z") },
    incomingShopifyUpdatedAt: new Date("2026-08-20T11:00:00Z"),
  }), { accept: false, staleReason: "PRODUCT_ALREADY_DELETED" });
});

test("invalid Shopify updatedAt fails clearly", () => {
  assert.throws(() => parseShopifyUpdatedAt("not-a-date"), /Invalid Shopify product updatedAt/);
  assert.equal(parseShopifyUpdatedAt("2026-08-20T10:00:00Z").toISOString(), "2026-08-20T10:00:00.000Z");
});

test("stale results and scan bookkeeping cannot inflate changed or queued counts", async () => {
  assert.deepEqual(staleDetectionResult("INDEXABLE"), {
    changed: false,
    queued: false,
    stale: true,
    indexabilityState: "INDEXABLE",
  });
  assert.deepEqual(staleScanBookkeepingUpdate("scan-1"), { lastSeenScanRunId: "scan-1" });
  assert.deepEqual(staleScanBookkeepingUpdate(), {});
  const page = await processScanPageProducts({
    admin: { graphql: async () => new Response() },
    primaryDomain: "shop.test",
    productGids: ["product-1"],
    resolvePrimaryDomain: async () => "shop.test",
    processProduct: async () => staleDetectionResult("INDEXABLE"),
  });
  assert.equal(page.counts.changed, 0);
  assert.equal(page.counts.queued, 0);
  assert.equal(page.counts.processed, 1);
});

test("a newer Shopify version resets observation ordering for that version", () => {
  const snapshotAUpdatedAt = new Date("2026-08-20T10:01:00Z");
  const snapshotAObservedAt = new Date("2026-08-20T10:04:00Z");
  const snapshotA = decide({
    existing: {
      ...existing,
      shopifyUpdatedAt: new Date("2026-08-20T10:00:00Z"),
      lastDetectedAt: new Date("2026-08-20T10:05:00Z"),
    },
    incomingShopifyUpdatedAt: snapshotAUpdatedAt,
    incomingSnapshotObservedAt: snapshotAObservedAt,
    incomingContentHash: "hash-a-version-2",
  });
  assert.deepEqual(snapshotA, { accept: true, staleReason: null });

  const persistedAfterA = {
    deletedAt: null,
    shopifyUpdatedAt: snapshotAUpdatedAt,
    lastDetectedAt: snapshotAObservedAt,
    contentHash: "hash-a-version-2",
  };
  assert.equal(persistedAfterA.lastDetectedAt.toISOString(), "2026-08-20T10:04:00.000Z");

  const snapshotB = decide({
    existing: persistedAfterA,
    incomingShopifyUpdatedAt: snapshotAUpdatedAt,
    incomingSnapshotObservedAt: new Date("2026-08-20T10:04:30Z"),
    incomingContentHash: "hash-b-version-2",
  });
  assert.deepEqual(snapshotB, { accept: true, staleReason: null });
});

test("webhook metadata uses delivery headers rather than the product ID", () => {
  const headers = new Headers({
    "x-shopify-webhook-id": "webhook-123",
    "x-shopify-event-id": "event-456",
    "x-shopify-triggered-at": "2026-08-20T10:00:00Z",
  });
  assert.deepEqual(extractShopifyWebhookMetadata(headers, 789), {
    productLegacyId: "789",
    webhookId: "webhook-123",
    eventId: "event-456",
    triggeredAt: "2026-08-20T10:00:00Z",
  });
  assert.deepEqual(extractShopifyWebhookMetadata(new Headers(), 789), {
    productLegacyId: "789",
    webhookId: null,
    eventId: null,
    triggeredAt: null,
  });
});
