function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (
    value === undefined ||
    value.trim() === ""
  ) {
    return fallback;
  }

  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

export type MultiShopMaterializationConfig =
  | Readonly<{
      enabled: false;
    }>
  | Readonly<{
      enabled: true;
      dryRun: boolean;
      maxShops: number;
      maxItemsPerShop: number;
      pageSize: number;
      maxScannedPerShop: number;
      interShopDelayMs: number;
    }>;

export function parseMultiShopMaterializationConfig(
  env:
    Record<string, string | undefined>,
): MultiShopMaterializationConfig {
  if (
    env.PROVIDER_MATERIALIZATION_MULTISHOP_ENABLED !==
    "true"
  ) {
    return {
      enabled: false,
    };
  }

  const maxShops =
    boundedInteger(
      env.PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SHOPS,
      10,
      1,
      25,
      "PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SHOPS",
    );

  const maxItemsPerShop =
    boundedInteger(
      env.PROVIDER_MATERIALIZATION_MULTISHOP_MAX_ITEMS_PER_SHOP,
      100,
      1,
      100,
      "PROVIDER_MATERIALIZATION_MULTISHOP_MAX_ITEMS_PER_SHOP",
    );

  const pageSize =
    boundedInteger(
      env.PROVIDER_MATERIALIZATION_MULTISHOP_PAGE_SIZE,
      100,
      1,
      250,
      "PROVIDER_MATERIALIZATION_MULTISHOP_PAGE_SIZE",
    );

  const maxScannedPerShop =
    boundedInteger(
      env.PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SCANNED_PER_SHOP,
      5000,
      1,
      50000,
      "PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SCANNED_PER_SHOP",
    );

  if (
    maxScannedPerShop <
    maxItemsPerShop
  ) {
    throw new Error(
      "PROVIDER_MATERIALIZATION_MULTISHOP_MAX_SCANNED_PER_SHOP must be greater than or equal to max items per shop",
    );
  }

  const interShopDelayMs =
    boundedInteger(
      env.PROVIDER_MATERIALIZATION_MULTISHOP_INTER_SHOP_DELAY_MS,
      1000,
      0,
      60000,
      "PROVIDER_MATERIALIZATION_MULTISHOP_INTER_SHOP_DELAY_MS",
    );

  // Writes require exact false.
  const dryRun =
    env.PROVIDER_MATERIALIZATION_MULTISHOP_DRY_RUN !==
    "false";

  return {
    enabled: true,
    dryRun,
    maxShops,
    maxItemsPerShop,
    pageSize,
    maxScannedPerShop,
    interShopDelayMs,
  };
}

export type MultiShopIndexNowConfig =
  | Readonly<{
      enabled: false;
    }>
  | Readonly<{
      enabled: true;
      maxShops: number;
      maxItemsPerShop: number;
      interItemDelayMs: number;
      interShopDelayMs: number;
    }>;

export function parseMultiShopIndexNowConfig(
  env:
    Record<string, string | undefined>,
): MultiShopIndexNowConfig {
  if (
    env.INDEXNOW_MULTISHOP_ENABLED !==
    "true"
  ) {
    return {
      enabled: false,
    };
  }

  return {
    enabled: true,

    maxShops:
      boundedInteger(
        env.INDEXNOW_MULTISHOP_MAX_SHOPS,
        10,
        1,
        25,
        "INDEXNOW_MULTISHOP_MAX_SHOPS",
      ),

    maxItemsPerShop:
      boundedInteger(
        env.INDEXNOW_MULTISHOP_MAX_ITEMS_PER_SHOP,
        100,
        1,
        100,
        "INDEXNOW_MULTISHOP_MAX_ITEMS_PER_SHOP",
      ),

    interItemDelayMs:
      boundedInteger(
        env.INDEXNOW_MULTISHOP_INTER_ITEM_DELAY_MS,
        1000,
        0,
        60000,
        "INDEXNOW_MULTISHOP_INTER_ITEM_DELAY_MS",
      ),

    interShopDelayMs:
      boundedInteger(
        env.INDEXNOW_MULTISHOP_INTER_SHOP_DELAY_MS,
        1000,
        0,
        60000,
        "INDEXNOW_MULTISHOP_INTER_SHOP_DELAY_MS",
      ),
  };
}