import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertIndexNowReady,
  evaluateIndexNowVerification,
  isValidIndexNowKey,
} from "../app/services/indexnow-verification.ts";

const key = "example-key-123";
const rootLocation = `https://shop.example/${key}.txt`;

function evaluate(overrides = {}) {
  return evaluateIndexNowVerification({
    submittedUrl: "https://shop.example/products/foo",
    key,
    keyLocation: rootLocation,
    ...overrides,
  });
}

test("valid root key verifies a product URL", () => {
  assert.deepEqual(evaluate(), {
    ready: true,
    mode: "ROOT",
    reason: "READY_ROOT",
    normalizedKeyLocation: rootLocation,
  });
});

test("valid root key verifies a collection URL", () => {
  assert.equal(evaluate({ submittedUrl: "https://shop.example/collections/foo" }).ready, true);
});

test("only the exact single-slash key pathname is root", () => {
  assert.equal(evaluate({ keyLocation: rootLocation }).reason, "READY_ROOT");

  const repeatedSlash = evaluate({
    keyLocation: `https://shop.example//${key}.txt`,
  });
  assert.equal(repeatedSlash.mode, "NOT_READY");
  assert.equal(repeatedSlash.reason, "URL_OUTSIDE_KEY_SCOPE");
});

test("scoped catalog key verifies a direct catalog item", () => {
  const result = evaluate({
    submittedUrl: "https://shop.example/catalog/item",
    keyLocation: `https://shop.example/catalog/${key}.txt`,
  });
  assert.equal(result.reason, "READY_SCOPED");
});

test("scoped catalog key verifies a nested catalog item", () => {
  const result = evaluate({
    submittedUrl: "https://shop.example/catalog/sub/item",
    keyLocation: `https://shop.example/catalog/${key}.txt`,
  });
  assert.equal(result.ready, true);
  assert.equal(result.mode, "SCOPED");
});

test("scoped catalog key rejects a product URL", () => {
  assert.equal(evaluate({
    keyLocation: `https://shop.example/catalog/${key}.txt`,
  }).reason, "URL_OUTSIDE_KEY_SCOPE");
});

for (const proxyRoot of ["a", "apps", "community", "tools"]) {
  test(`Shopify /${proxyRoot}/ scoped key does not verify a normal product URL`, () => {
    assert.equal(evaluate({
      keyLocation: `https://shop.example/${proxyRoot}/indexnow/${key}.txt`,
    }).reason, "URL_OUTSIDE_KEY_SCOPE");
  });
}

test("a scoped Shopify app-proxy key can verify a URL genuinely under its scope", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/apps/indexnow/product/foo",
    keyLocation: `https://shop.example/apps/indexnow/${key}.txt`,
  }).reason, "READY_SCOPED");
});

test("different host is rejected", () => {
  assert.equal(evaluate({ keyLocation: `https://other.example/${key}.txt` }).reason, "HOST_MISMATCH");
});

test("subdomain mismatch is rejected", () => {
  assert.equal(evaluate({ keyLocation: `https://www.shop.example/${key}.txt` }).reason, "HOST_MISMATCH");
});

test("matching hosts without explicit ports are accepted", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/products/foo",
    keyLocation: `https://shop.example/${key}.txt`,
  }).reason, "READY_ROOT");
});

test("explicit HTTPS default port matches its normalized host", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example:443/products/foo",
    keyLocation: `https://shop.example/${key}.txt`,
  }).reason, "READY_ROOT");
});

test("non-default submitted URL port does not match an unqualified key host", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example:8443/products/foo",
    keyLocation: `https://shop.example/${key}.txt`,
  }).reason, "HOST_MISMATCH");
});

test("unqualified submitted host does not match a non-default key-location port", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/products/foo",
    keyLocation: `https://shop.example:8443/${key}.txt`,
  }).reason, "HOST_MISMATCH");
});

test("HTTP submitted URL is rejected", () => {
  assert.equal(evaluate({ submittedUrl: "http://shop.example/products/foo" }).reason, "SUBMITTED_URL_NOT_HTTPS");
});

test("HTTP key location is rejected", () => {
  assert.equal(evaluate({ keyLocation: `http://shop.example/${key}.txt` }).reason, "KEY_LOCATION_NOT_HTTPS");
});

test("malformed submitted URL is rejected", () => {
  assert.equal(evaluate({ submittedUrl: "not-a-url" }).reason, "SUBMITTED_URL_INVALID");
});

test("malformed key location is rejected", () => {
  assert.equal(evaluate({ keyLocation: "not-a-url" }).reason, "KEY_LOCATION_INVALID");
});

test("short key is rejected", () => {
  assert.equal(evaluate({ key: "short", keyLocation: "https://shop.example/short.txt" }).reason, "KEY_INVALID");
});

test("key longer than 128 characters is rejected", () => {
  const longKey = "a".repeat(129);
  assert.equal(evaluate({ key: longKey, keyLocation: `https://shop.example/${longKey}.txt` }).reason, "KEY_INVALID");
});

test("key with invalid characters is rejected", () => {
  assert.equal(isValidIndexNowKey("invalid_key"), false);
});

test("matching standard key filename is accepted", () => {
  assert.equal(evaluate().reason, "READY_ROOT");
});

test("mismatching key filename is rejected", () => {
  assert.equal(evaluate({ keyLocation: "https://shop.example/different-key.txt" }).reason, "KEY_FILENAME_MISMATCH");
});

test("catalog scope does not match catalogue prefix collision", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/catalogue/item",
    keyLocation: `https://shop.example/catalog/${key}.txt`,
  }).reason, "URL_OUTSIDE_KEY_SCOPE");
});

test("query strings do not affect the path-scope decision", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/catalog/item?variant=1",
    keyLocation: `https://shop.example/catalog/${key}.txt?version=1`,
  }).reason, "READY_SCOPED");
});

test("submitted URL fragments are rejected conservatively", () => {
  assert.equal(evaluate({
    submittedUrl: "https://shop.example/products/foo#details",
  }).reason, "SUBMITTED_URL_FRAGMENT_NOT_ALLOWED");
});

test("key location fragments are rejected conservatively", () => {
  assert.equal(evaluate({
    keyLocation: `${rootLocation}#key`,
  }).reason, "KEY_LOCATION_FRAGMENT_NOT_ALLOWED");
});

test("credentials in either URL are rejected", () => {
  assert.equal(evaluate({
    submittedUrl: "https://user:pass@shop.example/products/foo",
  }).reason, "SUBMITTED_URL_CREDENTIALS_NOT_ALLOWED");
  assert.equal(evaluate({
    keyLocation: `https://user:pass@shop.example/${key}.txt`,
  }).reason, "KEY_LOCATION_CREDENTIALS_NOT_ALLOWED");
});

test("identical input produces an identical deterministic result", () => {
  assert.deepEqual(evaluate(), evaluate());
});

test("assertion helper returns readiness and throws deterministic failures", () => {
  assert.equal(assertIndexNowReady({
    submittedUrl: "https://shop.example/products/foo",
    key,
    keyLocation: rootLocation,
  }).reason, "READY_ROOT");
  assert.throws(() => assertIndexNowReady({
    submittedUrl: "https://other.example/products/foo",
    key,
    keyLocation: rootLocation,
  }), { message: "IndexNow ownership verification is not ready: HOST_MISMATCH" });
});

test("verification module has no network imports or calls", async () => {
  const source = await readFile(
    new URL("../app/services/indexnow-verification.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|from ["']https?["']/);
});
