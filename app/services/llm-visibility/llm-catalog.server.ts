import type { AdminGraphqlClient } from "../shopify-product.server";

export const publicCatalogQuery = `#graphql
  query PublicLlmCatalog($filter: String!) {
    products(first: 250, sortKey: ID, query: $filter) {
      nodes { legacyResourceId title status onlineStoreUrl }
      pageInfo { hasNextPage }
    }
  }`;

type CatalogResponse = {
  errors?: unknown[];
  data?: {
    products?: {
      nodes: { legacyResourceId: string; title: string; status: string; onlineStoreUrl: string | null }[];
      pageInfo: { hasNextPage: boolean };
    };
  };
};

function markdownLabel(title: string) {
  return title.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 255)
    .replace(/[\\[\]<>]/g, "\\$&");
}

export async function generatePublicLlmCatalog(admin: AdminGraphqlClient, primaryDomain: string) {
  const origin = new URL(`https://${primaryDomain}`).origin;
  const products = new Map<string, string>();
  let lastId = "0";
  let outputBytes = 0;
  const deadline = Date.now() + 120_000;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("CATALOG_EXPORT_LIMIT");
    const filter = `status:active published_status:published id:>${lastId}`;
    const response = await admin.graphql(publicCatalogQuery, { variables: { filter } });
    if (Date.now() >= deadline) throw new Error("CATALOG_EXPORT_LIMIT");
    if (!response.ok) throw new Error("CATALOG_READ_FAILED");
    const body = await response.json() as CatalogResponse;
    const page = body.data?.products;
    if (body.errors?.length || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("CATALOG_READ_FAILED");
    }
    for (const product of page.nodes) {
      if (!/^\d{1,20}$/.test(product.legacyResourceId) || BigInt(product.legacyResourceId) <= BigInt(lastId)) {
        throw new Error("CATALOG_CURSOR_INVALID");
      }
      lastId = product.legacyResourceId;
      if (product.status !== "ACTIVE" || !product.onlineStoreUrl) continue;
      const url = URL.parse(product.onlineStoreUrl);
      if (!url || url.origin !== origin || url.username || url.password ||
          !/^\/(?:[a-zA-Z-]+\/)?products\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname)) {
        throw new Error("CATALOG_URL_MISMATCH");
      }
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/$/, "");
      if (!products.has(url.href)) {
        const line = `- [${markdownLabel(product.title) || "Product"}](${url.href})`;
        outputBytes += new TextEncoder().encode(line + "\n").length;
        if (outputBytes > 8 * 1024 * 1024) throw new Error("CATALOG_EXPORT_LIMIT");
        products.set(url.href, line);
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    if (!page.nodes.length) throw new Error("CATALOG_CURSOR_INVALID");
  }

  const entries = [...products].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const text = [
    `# ${new URL(origin).hostname}`,
    "",
    "> Public Online Store product catalog.",
    "",
    "## Products",
    ...entries.map(([, line]) => line),
    "",
  ].join("\n");
  return { count: entries.length, text };
}
