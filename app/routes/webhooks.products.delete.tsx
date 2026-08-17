import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processProductDeletion } from "../services/product-indexing.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const productGid = `gid://shopify/Product/${String(payload.id)}`;
  try {
    await processProductDeletion({ shopDomain: shop, productGid, metadata: { webhookId: String(payload.id) } });
    return new Response();
  } catch (error) {
    console.error("products/delete processing failed", { shop, productGid, error });
    return new Response("Temporary processing failure", { status: 503 });
  }
};
