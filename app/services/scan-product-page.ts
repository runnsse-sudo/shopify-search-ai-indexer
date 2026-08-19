import type { BatchCounts } from "./scan-progress.ts";
import { isShopifyUnauthorizedError } from "./shopify-errors.ts";
import type { AdminGraphqlClient } from "./shopify-product.server.ts";

type ProductResult = {
  changed: boolean;
  queued: boolean;
  indexabilityState: string;
};

export class ProductAuthenticationRetryExhaustedError extends Error {
  constructor(productGid: string, cause: unknown) {
    super(`Shopify authentication retry failed for ${productGid}`, { cause });
    this.name = "ProductAuthenticationRetryExhaustedError";
  }
}

export async function processScanPageProducts(input: {
  admin: AdminGraphqlClient;
  primaryDomain: string | null;
  productGids: string[];
  refreshAdmin?: () => Promise<AdminGraphqlClient>;
  resolvePrimaryDomain: (admin: AdminGraphqlClient) => Promise<string | null>;
  processProduct: (
    admin: AdminGraphqlClient,
    primaryDomain: string | null,
    productGid: string,
  ) => Promise<ProductResult>;
  onProductError?: (productGid: string, error: unknown) => void;
}) {
  let currentAdmin = input.admin;
  let primaryDomain = input.primaryDomain;
  const counts: BatchCounts = {
    processed: 0,
    indexable: 0,
    nonIndexable: 0,
    changed: 0,
    queued: 0,
    errors: 0,
  };

  const countResult = (result: ProductResult) => {
    counts.processed += 1;
    if (result.indexabilityState === "INDEXABLE") counts.indexable += 1;
    else counts.nonIndexable += 1;
    if (result.changed) counts.changed += 1;
    if (result.queued) counts.queued += 1;
  };

  for (const productGid of input.productGids) {
    try {
      countResult(await input.processProduct(currentAdmin, primaryDomain, productGid));
      continue;
    } catch (error) {
      if (isShopifyUnauthorizedError(error)) {
        if (!input.refreshAdmin) throw error;
        try {
          currentAdmin = await input.refreshAdmin();
        } catch (refreshError) {
          if (isShopifyUnauthorizedError(refreshError)) {
            throw new ProductAuthenticationRetryExhaustedError(productGid, refreshError);
          }
          throw refreshError;
        }
        try {
          primaryDomain = await input.resolvePrimaryDomain(currentAdmin);
        } catch (domainError) {
          if (isShopifyUnauthorizedError(domainError)) {
            throw new ProductAuthenticationRetryExhaustedError(productGid, domainError);
          }
          throw domainError;
        }
        try {
          countResult(await input.processProduct(currentAdmin, primaryDomain, productGid));
          continue;
        } catch (retryError) {
          if (isShopifyUnauthorizedError(retryError)) {
            throw new ProductAuthenticationRetryExhaustedError(productGid, retryError);
          }
          input.onProductError?.(productGid, retryError);
          counts.processed += 1;
          counts.errors += 1;
          continue;
        }
      }
      input.onProductError?.(productGid, error);
      counts.processed += 1;
      counts.errors += 1;
    }
  }

  return { counts, admin: currentAdmin, primaryDomain };
}
