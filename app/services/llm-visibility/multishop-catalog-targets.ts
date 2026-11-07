export const CATALOG_SHOPS = Object.freeze([
  "dxf00a-wf.myshopify.com",
  "1cba5a-f6.myshopify.com",
  "robotto-7143.myshopify.com",
  "3f457e-2.myshopify.com",
  "94d715-94.myshopify.com",
  "game-dungeon-9024.myshopify.com",
] as const);

export type CatalogTarget = {
  shop: string;
  primaryDomain: string;
  fileId: string;
  cdnPath: string;
};

export function validateCatalogTarget(
  value: CatalogTarget,
): Readonly<CatalogTarget> {
  if (
    !value ||
    !CATALOG_SHOPS.some((shop) => shop === value.shop) ||
    typeof value.primaryDomain !== "string" ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(
      value.primaryDomain,
    ) ||
    !/^gid:\/\/shopify\/GenericFile\/[1-9]\d*$/.test(value.fileId) ||
    !/^\/s\/files\/1\/\d{4}\/\d{4}\/files\/llms-full\.txt$/.test(value.cdnPath)
  ) {
    throw new Error("INVALID_CATALOG_TARGET");
  }
  return Object.freeze({
    shop: value.shop,
    primaryDomain: value.primaryDomain,
    fileId: value.fileId,
    cdnPath: value.cdnPath,
  });
}

// Unknown file/domain bindings are supplied only after per-store verification.
export function parseCatalogTargets(json: string) {
  const values: unknown = JSON.parse(json);
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > CATALOG_SHOPS.length
  ) {
    throw new Error("INVALID_CATALOG_TARGETS");
  }
  const targets = values.map(validateCatalogTarget);
  for (const key of ["shop", "primaryDomain", "fileId", "cdnPath"] as const) {
    if (new Set(targets.map((target) => target[key])).size !== targets.length) {
      throw new Error("CATALOG_TARGET_COLLISION");
    }
  }
  return targets;
}

export function catalogPrefix(shop: string) {
  if (!CATALOG_SHOPS.some((allowed) => allowed === shop))
    throw new Error("INVALID_CATALOG_TARGET");
  // Share Robotto's existing lock with the legacy worker; never split its exclusion domain.
  return shop === "robotto-7143.myshopify.com"
    ? "robotto/llms-full/"
    : `shops/${shop}/llms-full/`;
}
