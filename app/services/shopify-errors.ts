import { HttpResponseError } from "@shopify/shopify-api";

export function isShopifyUnauthorizedError(error: unknown): boolean {
  return error instanceof HttpResponseError && error.response.code === 401;
}
