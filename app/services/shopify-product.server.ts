import type { ProductFingerprintInput } from "./product-fingerprint.server";

export type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type FetchedProduct = ProductFingerprintInput & {
  legacyResourceId: string;
  updatedAt: string;
};

type ProductQueryResult = {
  data?: {
    product?: {
      id: string;
      legacyResourceId: string;
      handle: string;
      title: string;
      descriptionHtml: string;
      productType: string;
      vendor: string;
      tags: string[];
      status: string;
      onlineStoreUrl: string | null;
      publishedAt: string | null;
      updatedAt: string;
      seo: { title: string | null; description: string | null };
      variants: { nodes: FetchedProduct["variants"] };
      media: { nodes: FetchedProduct["media"] };
    } | null;
  };
  errors?: Array<{ message: string }>;
};

export async function fetchProductForIndexing(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<FetchedProduct | null> {
  const response = await admin.graphql(
    `#graphql
      query ProductForIndexing($id: ID!) {
        product(id: $id) {
          id legacyResourceId handle title descriptionHtml productType vendor tags
          status onlineStoreUrl publishedAt updatedAt
          seo { title description }
          variants(first: 100) {
            nodes { id title price compareAtPrice availableForSale sku }
          }
          media(first: 50) {
            nodes { id alt mediaContentType }
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const body = (await response.json()) as ProductQueryResult;
  if (body.errors?.length) {
    throw new Error(`Product query failed: ${body.errors.map((error) => error.message).join("; ")}`);
  }
  const product = body.data?.product;
  if (!product) return null;
  return {
    ...product,
    variants: product.variants.nodes,
    media: product.media.nodes,
  };
}

// Phase 1 caps variants at 100 and media at 50. The isolated fetch layer can be
// upgraded to connection pagination without changing fingerprint consumers.
