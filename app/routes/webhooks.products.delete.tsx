import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processProductDeletion } from "../services/product-indexing.server";
import { extractShopifyWebhookMetadata, requireShopifyWebhookId } from "../services/webhook-metadata";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  const metadata = extractShopifyWebhookMetadata(request.headers, payload.id);
  const webhookId = requireShopifyWebhookId(metadata);
  if (!webhookId) {
    console.error("products/delete missing webhook ID", { shop, productGid });
    return new Response("Missing X-Shopify-Webhook-Id", { status: 400 });
  }
  try {
    const result = await processProductDeletion({ shopDomain: shop, productGid, metadata, webhook: { webhookId, eventId: metadata.eventId, topic: "products/delete", triggeredAt: metadata.triggeredAt } });
    if ("duplicateWebhook" in result && result.duplicateWebhook) {
      console.info("products/delete duplicate webhook ignored", { shop, productGid, webhookId });
    }
    return new Response();
  } catch (error) {
    console.error("products/delete processing failed", { shop, productGid, error });
    return new Response("Temporary processing failure", { status: 503 });
  }
};
