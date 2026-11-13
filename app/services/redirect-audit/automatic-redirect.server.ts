import type { AdminGraphqlClient } from "../shopify-product.server";
import {
  recheckAutomaticRedirect,
  runRedirectAudit,
} from "./redirect-audit.server";

const navigationScopes = ["read_online_store_navigation", "write_online_store_navigation"];
const maxCandidates = 5;
const resourcePath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:(?:products|pages|collections)\/[a-z0-9-]+|blogs\/[a-z0-9-]+\/[a-z0-9-]+)$/;
const reservedCollection = /\/collections\/(?:all|vendors|types)$/;

async function graphql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const options = { variables, signal: AbortSignal.timeout(15_000) };
  const response = await admin.graphql(query, options);
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error("REDIRECT_ADMIN_REQUEST_FAILED");
  }
  return body.data;
}

export async function runAutomaticRedirectAudit(
  shop: string,
  admin: AdminGraphqlClient,
  audit = runRedirectAudit,
  recheck = recheckAutomaticRedirect,
  onCreated: (redirect: { id: string; path: string; target: string }) => void = () => {},
) {
  const identity = await graphql<{
    shop: { myshopifyDomain: string; primaryDomain: { host: string } };
    currentAppInstallation: { accessScopes: { handle: string }[] };
  }>(admin, `query AutomaticRedirectIdentity {
    shop { myshopifyDomain primaryDomain { host } }
    currentAppInstallation { accessScopes { handle } }
  }`);
  if (identity.shop?.myshopifyDomain !== shop) {
    throw new Error("REDIRECT_SHOP_MISMATCH");
  }
  const granted = new Set(identity.currentAppInstallation?.accessScopes?.map(({ handle }) => handle));
  if (!navigationScopes.every((scope) => granted.has(scope))) {
    return { status: "MISSING_SCOPE" as const, created: [] };
  }

  const startedAt = Date.now();
  const result = await audit({ primaryDomain: identity.shop.primaryDomain.host });
  if (result.coverage.sitemapDocumentsTruncated ||
      result.coverage.sitemapUrlsTruncated || result.coverage.auditDeadlineReached) {
    return { status: "INCOMPLETE_SITEMAP" as const, created: [] };
  }

  const deadlineAt = startedAt + result.auditDeadlineMs;
  const created: { id: string; path: string; target: string }[] = [];
  const candidates = result.brokenInternalLinks.filter(
    (link) => link.statusCode === 404 && !link.redirectChain.length && link.suggestion?.eligibleForRecheck,
  );

  for (const candidate of candidates.slice(0, maxCandidates)) {
    if (Date.now() >= deadlineAt) return { status: "DEADLINE_REACHED" as const, created };
    const plan = await recheck(candidate, result.primaryHost, undefined, deadlineAt);
    if (!plan || plan.path === plan.target || !resourcePath.test(plan.path) ||
        !resourcePath.test(plan.target) || reservedCollection.test(plan.path) ||
        reservedCollection.test(plan.target) || Date.now() >= deadlineAt) continue;

    const { urlRedirects } = await graphql<{
      urlRedirects: { nodes: { path: string }[]; pageInfo: { hasNextPage: boolean } };
    }>(admin, `query ExistingAutomaticRedirect($query: String!) {
      urlRedirects(first: 10, query: $query) {
        nodes { path }
        pageInfo { hasNextPage }
      }
    }`, { query: `path:"${plan.path}"` });
    if (!Array.isArray(urlRedirects?.nodes) || urlRedirects.pageInfo?.hasNextPage !== false ||
        urlRedirects.nodes.length || Date.now() >= deadlineAt) continue;

    const { urlRedirectCreate } = await graphql<{
      urlRedirectCreate: {
        urlRedirect: { id: string; path: string; target: string } | null;
        userErrors: unknown[];
      };
    }>(admin, `mutation CreateAutomaticRedirect($input: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $input) {
        urlRedirect { id path target }
        userErrors { field }
      }
    }`, { input: plan });
    const redirect = urlRedirectCreate?.urlRedirect;
    if (urlRedirectCreate?.userErrors?.length !== 0 ||
        !redirect?.id || redirect.path !== plan.path || redirect.target !== plan.target) {
      throw new Error("REDIRECT_CREATE_UNCONFIRMED");
    }
    created.push(redirect);
    onCreated(redirect);
  }
  if (Date.now() >= deadlineAt) return { status: "DEADLINE_REACHED" as const, created };
  return { status: "COMPLETE" as const, created };
}
