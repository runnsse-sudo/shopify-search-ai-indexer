import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processProductDetection } from "../services/product-indexing.server";
import { extractShopifyWebhookMetadata, requireShopifyWebhookId } from "../services/webhook-metadata";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  if (!admin) return new Response("Admin session unavailable", { status: 503 });
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  const metadata = extractShopifyWebhookMetadata(request.headers, payload.id);
  const webhookId = requireShopifyWebhookId(metadata);
  if (!webhookId) {
    console.error("products/update missing webhook ID", { shop, productGid });
    return new Response("Missing X-Shopify-Webhook-Id", { status: 400 });
  }
  try {
    const result = await processProductDetection({ admin, shopDomain: shop, productGid, eventType: "UPDATED", metadata, webhook: { webhookId, eventId: metadata.eventId, topic: "products/update", triggeredAt: metadata.triggeredAt } });
    if ("duplicateWebhook" in result && result.duplicateWebhook) {
      console.info("products/update duplicate webhook ignored", { shop, productGid, webhookId });
    }
    return new Response();
  } catch (error) {
    console.error("products/update processing failed", { shop, productGid, error });
    return new Response("Temporary processing failure", { status: 503 });
  }
};
