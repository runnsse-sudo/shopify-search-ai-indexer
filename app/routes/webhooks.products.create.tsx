import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { acceptProductWebhook } from "../services/product-webhook-intake.server";
import { extractShopifyWebhookMetadata, requireShopifyWebhookId } from "../services/webhook-metadata";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  if (!admin) return new Response("Admin session unavailable", { status: 503 });
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  const metadata = extractShopifyWebhookMetadata(request.headers, payload.id);
  const webhookId = requireShopifyWebhookId(metadata);
  if (!webhookId) {
    console.error(JSON.stringify({ event: "product_webhook_intake_rejected", code: "MISSING_WEBHOOK_ID" }));
    return new Response("Missing X-Shopify-Webhook-Id", { status: 400 });
  }
  try {
    await acceptProductWebhook({ shopDomain: shop, productGid, webhookId, eventId: metadata.eventId, topic: "products/create", triggeredAt: metadata.triggeredAt });
    return new Response();
  } catch {
    console.error(JSON.stringify({ event: "product_webhook_intake_failed", code: "DURABLE_INTAKE_FAILED" }));
    return new Response("Temporary processing failure", { status: 503 });
  }
};
