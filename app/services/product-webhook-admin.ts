import type { AdminGraphqlClient } from "./shopify-product.server";

// Preserve structured errors before the shared fetch helpers reduce them to messages.
// One SDK attempt per item; durable retries, rather than hidden HTTP retries, own backpressure.
export function productWebhookAdminClient(
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
      tries?: number;
      signal?: AbortSignal;
    },
  ) => Promise<Response>,
): AdminGraphqlClient {
  return {
    graphql: async (query, options) => {
      const response = await graphql(query, {
        ...options,
        tries: 1,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw { status: response.status };
      const body = (await response.clone().json()) as { errors?: unknown[] };
      if (Array.isArray(body.errors) && body.errors.length)
        throw { body: { errors: body.errors } };
      return response;
    },
  };
}
