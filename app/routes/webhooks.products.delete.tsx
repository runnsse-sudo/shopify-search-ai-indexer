import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processProductDeletion } from "../services/product-indexing.server";
import { extractShopifyWebhookMetadata } from "../services/webhook-metadata";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  try {
    await processProductDeletion({ shopDomain: shop, productGid, metadata: extractShopifyWebhookMetadata(request.headers, payload.id) });
    return new Response();
  } catch (error) {
    console.error("products/delete processing failed", { shop, productGid, error });
    return new Response("Temporary processing failure", { status: 503 });
  }
};
