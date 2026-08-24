export type ProviderMaterializationWorkerConfig =
  | Readonly<{
      enabled: false;
    }>
  | Readonly<{
      enabled: true;
      dryRun: boolean;
      shopDomain: string;
      maxItems: number;
      pageSize: number;
      maxScanned: number;
    }>;

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (value === undefined || value.trim() === "") return fallback;

  const parsed = Number(value);

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

export function parseProviderMaterializationWorkerConfig(
  env: Record<string, string | undefined>,
): ProviderMaterializationWorkerConfig {
  if (env.PROVIDER_MATERIALIZATION_ENABLED !== "true") {
    return { enabled: false };
  }

  const shopDomain =
    env.PROVIDER_MATERIALIZATION_SHOP_DOMAIN
      ?.trim()
      .toLowerCase();

  if (!shopDomain) {
    throw new Error(
      "PROVIDER_MATERIALIZATION_SHOP_DOMAIN is required when provider materialization is enabled",
    );
  }

  const maxItems = parseBoundedInteger(
    env.PROVIDER_MATERIALIZATION_MAX_ITEMS,
    1,
    1,
    100,
    "PROVIDER_MATERIALIZATION_MAX_ITEMS",
  );

  const pageSize = parseBoundedInteger(
    env.PROVIDER_MATERIALIZATION_PAGE_SIZE,
    100,
    1,
    250,
    "PROVIDER_MATERIALIZATION_PAGE_SIZE",
  );

  const maxScanned = parseBoundedInteger(
    env.PROVIDER_MATERIALIZATION_MAX_SCANNED,
    5000,
    1,
    50000,
    "PROVIDER_MATERIALIZATION_MAX_SCANNED",
  );

  if (maxScanned < maxItems) {
    throw new Error(
      "PROVIDER_MATERIALIZATION_MAX_SCANNED must be greater than or equal to PROVIDER_MATERIALIZATION_MAX_ITEMS",
    );
  }

  // Writing requires the exact raw literal "false".
  // Missing, TRUE, False, 0, or any other value stays dry-run.
  const dryRun =
    env.PROVIDER_MATERIALIZATION_DRY_RUN !== "false";

  return {
    enabled: true,
    dryRun,
    shopDomain,
    maxItems,
    pageSize,
    maxScanned,
  };
}

export function providerMaterializationIdentity(
  shopifyProductGid: string,
  action: string,
) {
  return `${shopifyProductGid}|${action}`;
}

export function sourceNeedsIndexNowMaterialization(
  sourceUpdatedAt: Date,
  latestTargetUpdatedAt: Date | null | undefined,
) {
  return (
    latestTargetUpdatedAt === null ||
    latestTargetUpdatedAt === undefined ||
    latestTargetUpdatedAt.getTime() < sourceUpdatedAt.getTime()
  );
}