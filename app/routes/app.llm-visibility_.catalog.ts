import { data, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { fetchPrimaryShopDomain } from "../services/shop-info.server";
import { generatePublicLlmCatalog } from "../services/llm-visibility/llm-catalog.server";
import { validateLlmAuditRequest } from "../services/llm-visibility/llm-delivery";

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  await validateLlmAuditRequest(request, process.env.SHOPIFY_APP_URL, "export-public-catalog");
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const domain = await fetchPrimaryShopDomain(admin);
    if (!domain) throw new Error("CATALOG_DOMAIN_MISSING");
    return data({ catalog: await generatePublicLlmCatalog(admin, domain), error: null }, { headers });
  } catch (error) {
    const message = error instanceof Error && error.message === "CATALOG_EXPORT_LIMIT"
      ? "This catalog exceeds the supported export size. No partial file was generated."
      : "The public catalog could not be exported in full. No file was generated.";
    return data({ catalog: null, error: message }, { headers });
  }
}
