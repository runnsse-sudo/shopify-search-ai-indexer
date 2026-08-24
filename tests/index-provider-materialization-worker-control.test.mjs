import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderMaterializationWorkerConfig,
  providerMaterializationIdentity,
  sourceNeedsIndexNowMaterialization,
} from "../app/services/index-provider-materialization-worker-control.ts";

test("provider materialization is disabled unless exact true is supplied", () => {
  for (const value of [
    undefined,
    "",
    "TRUE",
    " true ",
    "true ",
    "1",
  ]) {
    assert.deepEqual(
      parseProviderMaterializationWorkerConfig({
        PROVIDER_MATERIALIZATION_ENABLED:
          value,
      }),
      {
        enabled: false,
      },
    );
  }
});

test("enabled provider materialization requires an explicit shop domain", () => {
  assert.throws(
    () =>
      parseProviderMaterializationWorkerConfig({
        PROVIDER_MATERIALIZATION_ENABLED:
          "true",
      }),
    /PROVIDER_MATERIALIZATION_SHOP_DOMAIN is required/,
  );
});

test("enabled materialization defaults to one-item dry-run", () => {
  const config =
    parseProviderMaterializationWorkerConfig({
      PROVIDER_MATERIALIZATION_ENABLED:
        "true",
      PROVIDER_MATERIALIZATION_SHOP_DOMAIN:
        " Robotto-7143.MyShopify.Com ",
    });

  assert.deepEqual(config, {
    enabled: true,
    dryRun: true,
    shopDomain:
      "robotto-7143.myshopify.com",
    maxItems: 1,
    pageSize: 100,
    maxScanned: 5000,
  });
});

test("writes require exact false dry-run literal", () => {
  for (const value of [
    undefined,
    "FALSE",
    "False",
    " false ",
    "0",
    "true",
  ]) {
    const config =
      parseProviderMaterializationWorkerConfig({
        PROVIDER_MATERIALIZATION_ENABLED:
          "true",
        PROVIDER_MATERIALIZATION_SHOP_DOMAIN:
          "shop.myshopify.com",
        PROVIDER_MATERIALIZATION_DRY_RUN:
          value,
      });

    assert.equal(config.enabled, true);
    assert.equal(config.dryRun, true);
  }

  const writeConfig =
    parseProviderMaterializationWorkerConfig({
      PROVIDER_MATERIALIZATION_ENABLED:
        "true",
      PROVIDER_MATERIALIZATION_SHOP_DOMAIN:
        "shop.myshopify.com",
      PROVIDER_MATERIALIZATION_DRY_RUN:
        "false",
    });

  assert.equal(writeConfig.enabled, true);
  assert.equal(writeConfig.dryRun, false);
});

test("worker limits are bounded and maxScanned cannot be smaller than maxItems", () => {
  const base = {
    PROVIDER_MATERIALIZATION_ENABLED:
      "true",
    PROVIDER_MATERIALIZATION_SHOP_DOMAIN:
      "shop.myshopify.com",
  };

  assert.throws(
    () =>
      parseProviderMaterializationWorkerConfig({
        ...base,
        PROVIDER_MATERIALIZATION_MAX_ITEMS:
          "0",
      }),
    /PROVIDER_MATERIALIZATION_MAX_ITEMS/,
  );

  assert.throws(
    () =>
      parseProviderMaterializationWorkerConfig({
        ...base,
        PROVIDER_MATERIALIZATION_PAGE_SIZE:
          "251",
      }),
    /PROVIDER_MATERIALIZATION_PAGE_SIZE/,
  );

  assert.throws(
    () =>
      parseProviderMaterializationWorkerConfig({
        ...base,
        PROVIDER_MATERIALIZATION_MAX_ITEMS:
          "10",
        PROVIDER_MATERIALIZATION_MAX_SCANNED:
          "5",
      }),
    /must be greater than or equal/,
  );
});

test("identity includes product GID and action", () => {
  assert.equal(
    providerMaterializationIdentity(
      "gid://shopify/Product/1",
      "DEINDEX",
    ),
    "gid://shopify/Product/1|DEINDEX",
  );

  assert.notEqual(
    providerMaterializationIdentity(
      "gid://shopify/Product/1",
      "INDEX",
    ),
    providerMaterializationIdentity(
      "gid://shopify/Product/1",
      "DEINDEX",
    ),
  );
});

test("source is materialized only when no equally-new or newer IndexNow target exists", () => {
  const sourceUpdatedAt =
    new Date("2026-08-24T10:00:00Z");

  assert.equal(
    sourceNeedsIndexNowMaterialization(
      sourceUpdatedAt,
      null,
    ),
    true,
  );

  assert.equal(
    sourceNeedsIndexNowMaterialization(
      sourceUpdatedAt,
      new Date(
        "2026-08-24T09:59:59Z",
      ),
    ),
    true,
  );

  assert.equal(
    sourceNeedsIndexNowMaterialization(
      sourceUpdatedAt,
      new Date(
        "2026-08-24T10:00:00Z",
      ),
    ),
    false,
  );

  assert.equal(
    sourceNeedsIndexNowMaterialization(
      sourceUpdatedAt,
      new Date(
        "2026-08-24T10:00:01Z",
      ),
    ),
    false,
  );
});