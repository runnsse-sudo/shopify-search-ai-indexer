export function extractShopifyWebhookMetadata(headers: Headers, productId: unknown) {
  return {
    productLegacyId: String(productId),
    webhookId: headers.get("x-shopify-webhook-id"),
    eventId: headers.get("x-shopify-event-id"),
    triggeredAt: headers.get("x-shopify-triggered-at"),
  };
}
