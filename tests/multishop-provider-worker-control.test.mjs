import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMultiShopIndexNowConfig,
  parseMultiShopMaterializationConfig,
} from "../app/services/multishop-provider-worker-control.ts";

test(
  "multi-shop materialization requires exact true",
  () => {
    for (const value of [
      undefined,
      "",
      "TRUE",
      " true ",
      "1",
    ]) {
      assert.deepEqual(
        parseMultiShopMaterializationConfig({
          PROVIDER_MATERIALIZATION_MULTISHOP_ENABLED:
            value,
        }),
        {
          enabled: false,
        },
      );
    }
  },
);

test(
  "multi-shop materialization defaults to dry-run and writes require exact false",
  () => {
    const safe =
      parseMultiShopMaterializationConfig({
        PROVIDER_MATERIALIZATION_MULTISHOP_ENABLED:
          "true",
      });

    assert.equal(
      safe.enabled,
      true,
    );

    assert.equal(
      safe.dryRun,
      true,
    );

    const write =
      parseMultiShopMaterializationConfig({
        PROVIDER_MATERIALIZATION_MULTISHOP_ENABLED:
          "true",

        PROVIDER_MATERIALIZATION_MULTISHOP_DRY_RUN:
          "false",
      });

    assert.equal(
      write.enabled,
      true,
    );

    assert.equal(
      write.dryRun,
      false,
    );
  },
);

test(
  "multi-shop limits are bounded",
  () => {
    assert.throws(
      () =>
        parseMultiShopMaterializationConfig({
          PROVIDER_MATERIALIZATION_MULTISHOP_ENABLED:
            "true",

          PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SHOPS:
            "26",
        }),
      /MAX_SHOPS/,
    );

    assert.throws(
      () =>
        parseMultiShopIndexNowConfig({
          INDEXNOW_MULTISHOP_ENABLED:
            "true",

          INDEXNOW_MULTISHOP_MAX_ITEMS_PER_SHOP:
            "101",
        }),
      /MAX_ITEMS_PER_SHOP/,
    );
  },
);

test(
  "multi-shop IndexNow requires exact true",
  () => {
    for (const value of [
      undefined,
      "",
      "TRUE",
      "true ",
      "1",
    ]) {
      assert.deepEqual(
        parseMultiShopIndexNowConfig({
          INDEXNOW_MULTISHOP_ENABLED:
            value,
        }),
        {
          enabled: false,
        },
      );
    }

    const enabled =
      parseMultiShopIndexNowConfig({
        INDEXNOW_MULTISHOP_ENABLED:
          "true",
      });

    assert.equal(
      enabled.enabled,
      true,
    );

    assert.equal(
      enabled.maxShops,
      10,
    );

    assert.equal(
      enabled.maxItemsPerShop,
      100,
    );
  },
);