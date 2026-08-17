import assert from "node:assert/strict";
import test from "node:test";
import { createProductFingerprint } from "../app/services/product-fingerprint.server.ts";
import { determineIndexTransition } from "../app/services/index-transition.ts";
import {
  addBatchCounts,
  buildScanPageVariables,
  initialScanActiveKey,
  nextScanStatus,
} from "../app/services/scan-progress.ts";

const product = {
  id: "gid://shopify/Product/1",
  handle: "example",
  title: "Example",
  descriptionHtml: "<p>Description</p>",
  productType: "Widget",
  vendor: "Runn",
  tags: ["beta", "alpha"],
  status: "ACTIVE",
  onlineStoreUrl: "https://example.com/products/example",
  publishedAt: "2026-08-17T10:00:00Z",
  seo: { title: "Example", description: "Description" },
  variants: [{ id: "gid://shopify/ProductVariant/1", title: "Default", price: "10.00", compareAtPrice: null, availableForSale: true, sku: "EX-1" }],
  media: [{ id: "gid://shopify/MediaImage/1", alt: "Example", mediaContentType: "IMAGE" }],
};

test("identical product state produces an identical fingerprint", () => {
  assert.equal(createProductFingerprint(product), createProductFingerprint(structuredClone(product)));
});

test("tag ordering does not change the fingerprint", () => {
  assert.equal(createProductFingerprint(product), createProductFingerprint({ ...product, tags: ["alpha", "beta"] }));
});

test("meaningful content changes the fingerprint", () => {
  assert.notEqual(createProductFingerprint(product), createProductFingerprint({ ...product, title: "Changed" }));
});

test("indexable to non-indexable produces DEINDEX work", () => {
  assert.deepEqual(determineIndexTransition({ hadExistingState: true, wasIndexable: true, isIndexable: false, contentChanged: true }), { action: "DEINDEX", reason: "BECAME_NON_INDEXABLE" });
});

test("non-indexable to indexable produces INDEX work", () => {
  assert.deepEqual(determineIndexTransition({ hadExistingState: true, wasIndexable: false, isIndexable: true, contentChanged: false }), { action: "INDEX", reason: "BECAME_INDEXABLE" });
});

test("an initial scan has one deterministic active key per shop", () => {
  assert.equal(initialScanActiveKey("shop-1"), initialScanActiveKey("shop-1"));
  assert.notEqual(initialScanActiveKey("shop-1"), initialScanActiveKey("shop-2"));
});

test("resume page variables use the persisted cursor", () => {
  assert.deepEqual(buildScanPageVariables("saved-cursor", 25), { first: 25, after: "saved-cursor" });
});

test("a completed page adds exact counters", () => {
  assert.deepEqual(
    addBatchCounts(
      { processed: 25, indexable: 20, nonIndexable: 5, changed: 8, queued: 7, errors: 0 },
      { processed: 10, indexable: 6, nonIndexable: 4, changed: 2, queued: 1, errors: 1 },
    ),
    { processed: 35, indexable: 26, nonIndexable: 9, changed: 10, queued: 8, errors: 1 },
  );
});

test("scan completes only when the page has no successor", () => {
  assert.equal(nextScanStatus(true), "RUNNING");
  assert.equal(nextScanStatus(false), "COMPLETED");
});
