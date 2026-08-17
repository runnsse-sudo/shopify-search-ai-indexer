import type { AdminGraphqlClient } from "./shopify-product.server";

type ShopQueryResult = {
  data?: { shop?: { primaryDomain?: { host: string; url: string } | null } };
  errors?: Array<{ message: string }>;
};

export async function fetchPrimaryShopDomain(admin: AdminGraphqlClient) {
  const response = await admin.graphql(`#graphql
    query ShopPrimaryDomain { shop { primaryDomain { host url } } }
  `);
  const body = (await response.json()) as ShopQueryResult;
  if (body.errors?.length) {
    throw new Error(`Shop query failed: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  return body.data?.shop?.primaryDomain?.host ?? null;
}

export function buildCanonicalProductUrl(primaryDomain: string | null, handle: string) {
  const domain = primaryDomain?.trim().toLowerCase();
  const cleanHandle = handle.trim();
  if (!domain || !cleanHandle) return null;
  return `https://${domain}/products/${encodeURIComponent(cleanHandle)}`;
}
