/* global globalThis */
import { Buffer } from "node:buffer";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  felkCatalogAddress,
  felkCatalogUrls,
  verifyFelkCatalogAddress,
} from "../app/services/llm-visibility/felk-catalog-address.ts";

const shop = "94d715-94.myshopify.com";
const bytes = Buffer.from(
  "# www.felkodslasare.se\n\n- [Produkt](https://www.felkodslasare.se/products/test)\n",
);
const plan = felkCatalogAddress(shop, bytes);
const metadata = {
  shop,
  id: "gid://shopify/GenericFile/999",
  status: "READY",
  url: `https://cdn.shopify.com${plan.canonicalPath}?v=123`,
};
const input = () => ({
  candidate: bytes,
  sessionShop: shop,
  before: { ...metadata },
  after: { ...metadata },
  canonical: bytes,
  download: bytes,
});

test("filename binds all 64 SHA256 digits and exact bytes", () => {
  assert.equal(
    plan.filename,
    `llms-full-${createHash("sha256").update(bytes).digest("hex")}.txt`,
  );
  assert.equal(plan.createInput.duplicateResolutionMode, "RAISE_ERROR");
  assert.notEqual(
    felkCatalogAddress(shop, Buffer.concat([bytes, Buffer.from("\n")]))
      .filename,
    plan.filename,
  );
  assert.equal(plan.lockObject, `shops/${shop}/llms-full/publication.lock`);
  assert.equal(plan.previousFileId, "gid://shopify/GenericFile/77579264491788");
});
test("matching delivery paths produce verified candidate, not publication", () => {
  const result = verifyFelkCatalogAddress(input());
  assert.equal(result.status, "VERIFIED_CANDIDATE");
  assert.equal(
    result.download,
    `https://www.felkodslasare.se/cdn/shop/files/${plan.filename}?v=123`,
  );
});
for (const side of ["canonical", "download"])
  test(`stale ${side} rejected`, () => {
    const value = input();
    value[side] = Buffer.from("old CDN content");
    assert.throws(
      () => verifyFelkCatalogAddress(value),
      /PUBLIC_HASH_NOT_VERIFIED/,
    );
  });
for (const [field, value] of Object.entries({
  shop: "robotto-7143.myshopify.com",
  id: plan.previousFileId,
  status: "PROCESSING",
  url: "https://cdn.shopify.com/s/files/llms-full.txt?v=123",
})) {
  test(`reject metadata ${field}`, () =>
    assert.throws(
      () => felkCatalogUrls(plan, { ...metadata, [field]: value }),
      /MISMATCH/,
    ));
}
for (const suffix of ["", "?v=123&other=1", "?v=123#fragment"])
  test(`reject nonexact version suffix ${suffix}`, () => {
    assert.throws(
      () =>
        felkCatalogUrls(plan, {
          ...metadata,
          url: `https://cdn.shopify.com${plan.canonicalPath}${suffix}`,
        }),
      /MISMATCH/,
    );
  });
test("reject version drift after byte reads", () => {
  const value = input();
  value.after.url = value.after.url.replace("123", "124");
  assert.throws(
    () => verifyFelkCatalogAddress(value),
    /PUBLIC_FILE_VERSION_DRIFT/,
  );
});
test("reject file identity drift after byte reads", () => {
  const value = input();
  value.after.id = "gid://shopify/GenericFile/1000";
  assert.throws(
    () => verifyFelkCatalogAddress(value),
    /PUBLIC_FILE_VERSION_DRIFT/,
  );
});
test("reject foreign tenant and malformed catalog", () => {
  assert.throws(
    () => felkCatalogAddress("robotto-7143.myshopify.com", bytes),
    /TENANT/,
  );
  assert.throws(
    () => felkCatalogAddress(shop, Buffer.from("wrong header")),
    /INVALID/,
  );
  assert.throws(
    () => felkCatalogAddress(shop, Buffer.from([255])),
    /encoded data/,
  );
});
test("preparation and verification never invoke network", () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("NETWORK_FORBIDDEN");
  };
  try {
    assert.equal(verifyFelkCatalogAddress(input()).sha256, plan.sha256);
  } finally {
    globalThis.fetch = original;
  }
});
