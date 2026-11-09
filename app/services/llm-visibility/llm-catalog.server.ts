import { createHash } from "node:crypto";
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

// Keep the encoded URL in the export; decode only to validate its single handle.
// Inspect the original spelling too: URL.parse can normalize encoded dot segments.
export function isPublicProductPath(pathname: string, originalUrl = pathname) {
  if (/%(?:2e|2f|5c|25)/i.test(originalUrl.split(/[?#]/, 1)[0])) return false;
  const match = /^\/(?:[a-zA-Z-]+\/)?products\/([^/]+)\/?$/.exec(pathname);
  if (!match || !/^(?:[a-zA-Z0-9_-]|%[a-fA-F0-9]{2})+$/.test(match[1])) return false;
  try {
    const decoded = decodeURIComponent(match[1]);
    return [...decoded].every(character =>
      /^[a-zA-Z0-9_-]$/.test(character) ||
      (character.charCodeAt(0) > 127 && /^[\p{L}\p{M}\p{N}\p{S}]$/u.test(character)),
    );
  } catch {
    return false; // Malformed escapes or invalid UTF-8 are never exported.
  }
}

export async function generatePublicLlmCatalog(admin: AdminGraphqlClient, primaryDomain: string, strict = false) {
  const origin = new URL(`https://${primaryDomain}`).origin;
  const products = new Map<string, string>();
  let lastId = "0";
  let outputBytes = 0;
  const deadline = Date.now() + 120_000;

  for (;;) {
    if (Date.now() >= deadline) throw new Error("CATALOG_EXPORT_LIMIT");
    const publication = strict ? "online_store_channel" : "published";
    const filter = `status:active published_status:${publication} id:>${lastId}`;
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
      if (product.status !== "ACTIVE" || !product.onlineStoreUrl) {
        if (strict) throw new Error("CATALOG_PUBLICATION_MISMATCH");
        continue;
      }
      const url = URL.parse(product.onlineStoreUrl);
      if (!url || url.origin !== origin || url.username || url.password ||
          !isPublicProductPath(url.pathname, product.onlineStoreUrl)) {
        throw new Error("CATALOG_URL_MISMATCH");
      }
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/$/, "");
      if (strict && products.has(url.href)) throw new Error("CATALOG_DUPLICATE_URL");
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

export function prepareLlmStorefrontFiles(primaryDomain: string, catalog: { count: number; text: string }) {
  const origin = new URL(`https://${primaryDomain}`).origin;
  const title = new URL(origin).hostname;
  const discovery = [
    `# ${title}`,
    "",
    "> Public storefront and product discovery.",
    "",
    "## Store resources",
    `- [Storefront](${origin}/)`,
    `- [Sitemap](${origin}/sitemap.xml)`,
    `- [Public product catalog](${origin}/llms-full.txt)`,
    "",
  ].join("\n");

  return {
    count: catalog.count,
    files: [
      { name: "agents.md", text: discovery },
      { name: "llms.txt", text: discovery },
      { name: "llms-full.txt", text: catalog.text },
    ].map(file => ({
      ...file,
      target: new URL(file.name, origin).href,
      sha256: createHash("sha256").update(file.text, "utf8").digest("hex"),
    })),
  };
}
