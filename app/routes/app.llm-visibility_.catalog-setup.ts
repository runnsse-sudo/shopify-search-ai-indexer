import { data, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { inspectCatalogSetup } from "../services/llm-visibility/catalog-setup.server";
import { validateLlmAuditRequest } from "../services/llm-visibility/llm-delivery";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  await validateLlmAuditRequest(request, process.env.SHOPIFY_APP_URL, "prepare-catalog-setup");
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const manifest = await inspectCatalogSetup(session.shop, admin);
    return data({ ok: true as const, manifest, error: null }, { headers });
  } catch {
    return data({ ok: false as const, manifest: null, error: "Katalogkopplingen kunde inte verifieras. Inget har ändrats." }, { headers, status: 409 });
  }
}
