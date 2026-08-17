import type { AdminGraphqlClient } from "./shopify-product.server";
import { processProductDetection } from "./product-indexing.server";

type ScanPage = {
  data?: {
    products: {
      nodes: Array<{ id: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
};

export type ScanProgress = {
  cursor: string | null;
  hasNextPage: boolean;
  processed: number;
  changed: number;
  queued: number;
  failed: number;
};

export async function scanProductPage(input: {
  admin: AdminGraphqlClient;
  shopDomain: string;
  cursor?: string | null;
  pageSize?: number;
}): Promise<ScanProgress> {
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100);
  const response = await input.admin.graphql(
    `#graphql
      query ProductsForInitialScan($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    { variables: { first: pageSize, after: input.cursor ?? null } },
  );
  const body = (await response.json()) as ScanPage;
  if (body.errors?.length || !body.data) {
    throw new Error(`Product scan query failed: ${body.errors?.map((error) => error.message).join("; ") ?? "missing data"}`);
  }
  let changed = 0;
  let queued = 0;
  let failed = 0;
  for (const product of body.data.products.nodes) {
    try {
      const result = await processProductDetection({
        admin: input.admin,
        shopDomain: input.shopDomain,
        productGid: product.id,
        eventType: "INITIAL_SCAN",
      });
      if (result.changed) changed += 1;
      if (result.queued) queued += 1;
    } catch (error) {
      failed += 1;
      console.error("Initial scan product failed", { shop: input.shopDomain, productId: product.id, error });
    }
  }
  return {
    cursor: body.data.products.pageInfo.endCursor,
    hasNextPage: body.data.products.pageInfo.hasNextPage,
    processed: body.data.products.nodes.length,
    changed,
    queued,
    failed,
  };
}
