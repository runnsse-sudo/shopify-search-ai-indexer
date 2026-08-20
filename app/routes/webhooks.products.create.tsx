import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processProductDetection } from "../services/product-indexing.server";
import { extractShopifyWebhookMetadata } from "../services/webhook-metadata";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  if (!admin) return new Response("Admin session unavailable", { status: 503 });
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  try {
    await processProductDetection({ admin, shopDomain: shop, productGid, eventType: "CREATED", metadata: extractShopifyWebhookMetadata(request.headers, payload.id) });
    return new Response();
  } catch (error) {
    console.error("products/create processing failed", { shop, productGid, error });
    return new Response("Temporary processing failure", { status: 503 });
  }
};
