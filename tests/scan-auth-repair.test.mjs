import assert from "node:assert/strict";
import test from "node:test";
import { HttpResponseError } from "@shopify/shopify-api";
import { scanPageFailureUpdate, scanPageProgressUpdate } from "../app/services/scan-page-control.ts";
import {
  processScanPageProducts,
  ProductAuthenticationRetryExhaustedError,
} from "../app/services/scan-product-page.ts";
import { selectRepairProductGids } from "../app/services/scan-repair.ts";
import { shouldRetryAuthentication } from "../app/services/scan-worker-control.ts";
import { resolvePrimaryShopDomain } from "../app/services/shop-info.server.ts";
import { isShopifyUnauthorizedError } from "../app/services/shopify-errors.ts";

test("Shopify unauthorized classifier recognizes only HttpResponseError 401", () => {
  const unauthorized = new HttpResponseError({
    message: "Unauthorized",
    code: 401,
    statusText: "Unauthorized",
  });
  const forbidden = new HttpResponseError({
    message: "Forbidden",
    code: 403,
    statusText: "Forbidden",
  });
  assert.equal(isShopifyUnauthorizedError(unauthorized), true);
  assert.equal(isShopifyUnauthorizedError(forbidden), false);
  assert.equal(isShopifyUnauthorizedError(new Error("401 Unauthorized")), false);
  assert.equal(isShopifyUnauthorizedError({ response: { code: 401 } }), false);
});

test("page failure marks failed once without advancing cursor or product counters", () => {
  const update = scanPageFailureUpdate(new Error("expired page token"));
  assert.deepEqual(update.errorsCount, { increment: 1 });
  assert.equal(update.status, "FAILED");
  assert.equal(update.batchToken, null);
  assert.equal(update.batchClaimedAt, null);
  assert.equal("cursor" in update, false);
  assert.equal("productsProcessed" in update, false);
});

test("authentication retry permits one retry per independent incident", () => {
  assert.equal(shouldRetryAuthentication(0), true);
  assert.equal(shouldRetryAuthentication(1), false);
  assert.equal(shouldRetryAuthentication(0), true);
});

test("repair selection enforces shop, event type, error, window, and deduplication", () => {
  const startedAt = new Date("2026-08-19T10:00:00Z");
  const completedAt = new Date("2026-08-19T11:00:00Z");
  const event = (overrides = {}) => ({
    shopId: "shop-1",
    shopifyProductGid: "gid://shopify/Product/1",
    eventType: "INITIAL_SCAN",
    error: "failed",
    receivedAt: new Date("2026-08-19T10:30:00Z"),
    ...overrides,
  });
  const selected = selectRepairProductGids([
    event(),
    event(),
    event({ shopifyProductGid: "gid://shopify/Product/2" }),
    event({ shopId: "shop-2" }),
    event({ eventType: "UPDATED" }),
    event({ error: null }),
    event({ receivedAt: new Date("2026-08-19T11:00:01Z") }),
  ], "shop-1", startedAt, completedAt);
  assert.deepEqual(selected, ["gid://shopify/Product/1", "gid://shopify/Product/2"]);
});

test("provided primary domain avoids another Shopify shop query", async () => {
  let graphqlCalls = 0;
  const admin = {
    graphql: async () => {
      graphqlCalls += 1;
      return new Response(JSON.stringify({ data: { shop: { primaryDomain: { host: "fallback.test" } } } }));
    },
  };
  assert.equal(await resolvePrimaryShopDomain(admin, { primaryDomain: "provided.test" }), "provided.test");
  assert.equal(graphqlCalls, 0);
  assert.equal(await resolvePrimaryShopDomain(admin), "fallback.test");
  assert.equal(graphqlCalls, 1);
});

function unauthorized() {
  return new HttpResponseError({ message: "Unauthorized", code: 401, statusText: "Unauthorized" });
}

test("a recovered mid-page 401 preserves earlier accounting and advances once", async () => {
  const firstAdmin = { graphql: async () => new Response() };
  const freshAdmin = { graphql: async () => new Response() };
  let refreshes = 0;
  let product2Attempts = 0;
  const result = await processScanPageProducts({
    admin: firstAdmin,
    primaryDomain: "first.test",
    productGids: ["product-1", "product-2", "product-3"],
    refreshAdmin: async () => {
      refreshes += 1;
      return freshAdmin;
    },
    resolvePrimaryDomain: async (admin) => {
      assert.equal(admin, freshAdmin);
      return "fresh.test";
    },
    processProduct: async (admin, primaryDomain, productGid) => {
      if (productGid === "product-2" && product2Attempts++ === 0) throw unauthorized();
      if (productGid === "product-2") {
        assert.equal(admin, freshAdmin);
        assert.equal(primaryDomain, "fresh.test");
      }
      return {
        changed: productGid !== "product-3",
        queued: productGid !== "product-3",
        indexabilityState: "INDEXABLE",
      };
    },
  });
  const checkpoint = scanPageProgressUpdate("cursor-after-page", result.counts);
  assert.equal(refreshes, 1);
  assert.deepEqual(result.counts, {
    processed: 3,
    indexable: 3,
    nonIndexable: 0,
    changed: 2,
    queued: 2,
    errors: 0,
  });
  assert.equal(checkpoint.cursor, "cursor-after-page");
  assert.deepEqual(checkpoint.productsProcessed, { increment: 3 });
  assert.deepEqual(checkpoint.productsChanged, { increment: 2 });
  assert.deepEqual(checkpoint.queueItemsCreated, { increment: 2 });
  assert.deepEqual(checkpoint.errorsCount, { increment: 0 });
});

test("a second 401 on the same product fails the page without checkpointing counters", async () => {
  let product1Committed = false;
  await assert.rejects(
    processScanPageProducts({
      admin: { graphql: async () => new Response() },
      primaryDomain: "first.test",
      productGids: ["product-1", "product-2"],
      refreshAdmin: async () => ({ graphql: async () => new Response() }),
      resolvePrimaryDomain: async () => "fresh.test",
      processProduct: async (_admin, _primaryDomain, productGid) => {
        if (productGid === "product-1") {
          product1Committed = true;
          return { changed: true, queued: true, indexabilityState: "INDEXABLE" };
        }
        throw unauthorized();
      },
    }),
    ProductAuthenticationRetryExhaustedError,
  );
  const failure = scanPageFailureUpdate(new Error("authentication retry failed"));
  assert.equal(product1Committed, true);
  assert.equal(failure.status, "FAILED");
  assert.deepEqual(failure.errorsCount, { increment: 1 });
  assert.equal(failure.batchToken, null);
  assert.equal(failure.batchClaimedAt, null);
  assert.equal("cursor" in failure, false);
  assert.equal("productsProcessed" in failure, false);
  assert.equal("productsChanged" in failure, false);
  assert.equal("queueItemsCreated" in failure, false);
});

test("a non-401 Admin refresh failure aborts without counting a product error", async () => {
  let productErrors = 0;
  let productCalls = 0;
  await assert.rejects(
    processScanPageProducts({
      admin: { graphql: async () => new Response() },
      primaryDomain: "first.test",
      productGids: ["product-1", "product-2"],
      refreshAdmin: async () => { throw new Error("session storage unavailable"); },
      resolvePrimaryDomain: async () => "fresh.test",
      processProduct: async () => {
        productCalls += 1;
        throw unauthorized();
      },
      onProductError: () => { productErrors += 1; },
    }),
    /session storage unavailable/,
  );
  assert.equal(productCalls, 1);
  assert.equal(productErrors, 0);
});

test("a non-401 primary-domain refresh failure aborts without counting a product error", async () => {
  let productErrors = 0;
  let productCalls = 0;
  await assert.rejects(
    processScanPageProducts({
      admin: { graphql: async () => new Response() },
      primaryDomain: "first.test",
      productGids: ["product-1", "product-2"],
      refreshAdmin: async () => ({ graphql: async () => new Response() }),
      resolvePrimaryDomain: async () => { throw new Error("shop query unavailable"); },
      processProduct: async () => {
        productCalls += 1;
        throw unauthorized();
      },
      onProductError: () => { productErrors += 1; },
    }),
    /shop query unavailable/,
  );
  assert.equal(productCalls, 1);
  assert.equal(productErrors, 0);
});

test("an ordinary error from the retried product is counted and the page continues", async () => {
  let firstProductAttempts = 0;
  const failedProducts = [];
  const result = await processScanPageProducts({
    admin: { graphql: async () => new Response() },
    primaryDomain: "first.test",
    productGids: ["product-1", "product-2"],
    refreshAdmin: async () => ({ graphql: async () => new Response() }),
    resolvePrimaryDomain: async () => "fresh.test",
    processProduct: async (_admin, _primaryDomain, productGid) => {
      if (productGid === "product-1") {
        firstProductAttempts += 1;
        if (firstProductAttempts === 1) throw unauthorized();
        throw new Error("malformed product data");
      }
      return { changed: true, queued: true, indexabilityState: "INDEXABLE" };
    },
    onProductError: (productGid) => { failedProducts.push(productGid); },
  });
  assert.deepEqual(failedProducts, ["product-1"]);
  assert.deepEqual(result.counts, {
    processed: 2,
    indexable: 1,
    nonIndexable: 0,
    changed: 1,
    queued: 1,
    errors: 1,
  });
});
