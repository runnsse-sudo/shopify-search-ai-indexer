import assert from "node:assert/strict";
import test from "node:test";
import { createProductFingerprint } from "../app/services/product-fingerprint.server.ts";
import { determineIndexTransition } from "../app/services/index-transition.ts";

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
