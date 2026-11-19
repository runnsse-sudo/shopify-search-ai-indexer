import type { AdminGraphqlClient } from "../shopify-product.server";
import {
  recheckAutomaticRedirect,
  runRedirectAudit,
  type RedirectAuditBrokenLink,
} from "./redirect-audit.server";

const navigationScopes = ["read_online_store_navigation", "write_online_store_navigation"];
const maxCandidates = 5;
export type RedirectDiagnostics = {
  verified404Count: number;
  checkedLinks: number;
  unlisted404Count?: number;
  unverifiedLinks: number;
  skipped: { path: string; reason: string; score: number | null }[];
};
function diagnosticPath(url: string) {
  try {
    const path = new URL(url).pathname;
    return path.length <= 512 && resourcePath.test(path) ? path : "[unsupported path]";
  } catch {
    return "[invalid URL]";
  }
}
export const motokoHyperBodyShop = "robotto-7143.myshopify.com";
const motokoHyperBodyHost = "www.robotto.se";
const motokoHyperBodyPair = {
  path: "/products/ghost-in-the-shell-motoko-kusanagi-simple-armor-hyper-body",
  target: "/products/ghost-in-the-shell-motoko-kusanagi-simple-armor-hyper-body-actionfigur",
} as const;

export function runMotokoHyperBodyRedirectTest(
  admin: AdminGraphqlClient,
  audit = runRedirectAudit,
  recheck = recheckAutomaticRedirect,
  onCreated?: Parameters<typeof runAutomaticRedirectAudit>[4],
) {
  return runAutomaticRedirectAudit(
    motokoHyperBodyShop, admin, audit, recheck, onCreated, "motoko-hyper-body",
  );
}
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
  onCreated: (redirect: { id: string; path: string; target: string }) => void | Promise<void> = () => {},
  test?: "motoko-hyper-body",
  onDiagnostics: (diagnostics: RedirectDiagnostics) => void = () => {},
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

  const pair = test === "motoko-hyper-body" ? motokoHyperBodyPair : null;
  if (pair && (shop !== motokoHyperBodyShop || identity.shop.primaryDomain.host !== motokoHyperBodyHost)) {
    throw new Error("REDIRECT_TEST_IDENTITY_MISMATCH");
  }
  const maxSitemapDocuments = shop === "3f457e-2.myshopify.com" ? 75 : undefined;
  const startedAt = Date.now();
  const result = await audit({
    primaryDomain: identity.shop.primaryDomain.host,
    ...(maxSitemapDocuments === undefined ? {} : { maxSitemapDocuments }),
    ...(pair ? { additionalSourcePath: pair.path } : {}),
  });
  if (pair && result.primaryHost !== motokoHyperBodyHost) throw new Error("REDIRECT_TEST_HOST_MISMATCH");
  const found404s = result.brokenInternalLinks.filter((link) => link.statusCode === 404);
  const diagnostics: RedirectDiagnostics = {
    verified404Count: result.verifiedDirect404Count ?? new Set(found404s.filter((link) => !link.error && !link.redirectChain.length).map((link) => link.url)).size,
    unlisted404Count: Math.max(0, (result.notFoundCount ?? found404s.length) - found404s.length),
    checkedLinks: result.internalLinksChecked ?? 0,
    unverifiedLinks: result.internalLinksUnverified ?? 0,
    skipped: [],
  };
  const skip = (link: RedirectAuditBrokenLink, reason: string) => {
    diagnostics.skipped.push({ path: diagnosticPath(link.url), reason, score: link.suggestion?.score ?? null });
  };
  onDiagnostics(diagnostics);
  if (result.coverage.sitemapDocumentsTruncated ||
      result.coverage.sitemapUrlsTruncated || result.coverage.auditDeadlineReached) {
    const { sitemapDocumentsTruncated, sitemapUrlsTruncated, auditDeadlineReached } = result.coverage;
    const limitsReached = [
      ...(sitemapDocumentsTruncated && !auditDeadlineReached ? ["SITEMAP_DOCUMENT_LIMIT"] : []),
      ...(sitemapUrlsTruncated ? ["SITEMAP_URL_LIMIT"] : []),
      ...(auditDeadlineReached ? ["AUDIT_DEADLINE"] : []),
    ];
    for (const link of found404s) skip(link, "INCOMPLETE_SITEMAP");
    return {
      status: "INCOMPLETE_SITEMAP" as const,
      created: [],
      limitsReached,
      sitemapDocumentsFetched: result.sitemapDocumentsFetched,
      sitemapUrls: result.sitemapUrls,
    };
  }

  const deadlineAt = startedAt + result.auditDeadlineMs;
  const created: { id: string; path: string; target: string }[] = [];
  const candidates = result.brokenInternalLinks.filter(
    (link) => link.statusCode === 404 && !link.redirectChain.length && link.suggestion?.eligibleForRecheck,
  );

  const selected = pair
    ? candidates.filter(({ url, suggestion }) =>
        url === `https://${motokoHyperBodyHost}${pair.path}` &&
        suggestion?.targetUrl === `https://${motokoHyperBodyHost}${pair.target}`)
    : candidates;
  const budget = pair ? 1 : maxCandidates;
  const selectedSet = new Set(selected);
  for (const link of found404s) {
    if (link.redirectChain.length) skip(link, "SOURCE_HAS_REDIRECT_CHAIN");
    else if (!link.suggestion) skip(link, "NO_SUGGESTED_TARGET");
    else if (!link.suggestion.eligibleForRecheck) skip(link, link.suggestion.ineligibleReason ?? "SUGGESTION_NOT_ELIGIBLE");
    else if (!selectedSet.has(link)) skip(link, "OUTSIDE_EXACT_TEST");
  }
  for (const link of selected.slice(budget)) skip(link, "CANDIDATE_LIMIT");
  const toCheck = selected.slice(0, budget);
  let handled = 0;
  try {
    for (const candidate of toCheck) {
      if (Date.now() >= deadlineAt) return { status: "DEADLINE_REACHED" as const, created };
      let rejection = "RECHECK_UNVERIFIED";
      const plan = await recheck(candidate, result.primaryHost, undefined, deadlineAt, (reason) => { rejection = reason; });
      if (!plan || plan.path === plan.target || !resourcePath.test(plan.path) ||
          !resourcePath.test(plan.target) || (pair && (plan.path !== pair.path || plan.target !== pair.target)) ||
          reservedCollection.test(plan.path) ||
          reservedCollection.test(plan.target) || Date.now() >= deadlineAt) {
          skip(candidate, Date.now() >= deadlineAt ? "DEADLINE_REACHED" : plan ? "PATH_POLICY_REJECTED" : rejection);
          handled++;
          continue;
        }

      const { urlRedirects } = await graphql<{
        urlRedirects: { nodes: { path: string }[]; pageInfo: { hasNextPage: boolean } };
      }>(admin, `query ExistingAutomaticRedirect($query: String!) {
        urlRedirects(first: 10, query: $query) {
          nodes { path }
          pageInfo { hasNextPage }
        }
      }`, { query: `path:"${plan.path}"` });
      if (!Array.isArray(urlRedirects?.nodes) || urlRedirects.pageInfo?.hasNextPage !== false ||
          urlRedirects.nodes.length || Date.now() >= deadlineAt) {
          skip(candidate, Date.now() >= deadlineAt ? "DEADLINE_REACHED" :
            urlRedirects?.nodes?.length ? "REDIRECT_ALREADY_EXISTS" : "REDIRECT_LOOKUP_UNVERIFIED");
          handled++;
          continue;
        }

      if (pair) {
        const fresh = await recheck(candidate, result.primaryHost, undefined, deadlineAt);
        if (fresh?.path !== pair.path || fresh.target !== pair.target || Date.now() >= deadlineAt) {
          skip(candidate, Date.now() >= deadlineAt ? "DEADLINE_REACHED" : "EXACT_PAIR_RECHECK_FAILED");
          handled++;
          continue;
        }
      }

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
      handled++;
      await onCreated(redirect);
    }
  } finally {
    const unhandled = toCheck.slice(handled);
    if (unhandled.length && Date.now() >= deadlineAt) {
      for (const link of unhandled) skip(link, "DEADLINE_REACHED");
    } else if (unhandled.length) {
      skip(unhandled[0], "CANDIDATE_OUTCOME_UNCONFIRMED");
      for (const link of unhandled.slice(1)) skip(link, "RUN_STOPPED_BEFORE_OUTCOME");
    }
  }
  if (Date.now() >= deadlineAt) return { status: "DEADLINE_REACHED" as const, created };
  if (pair && !created.length) return { status: "PAIR_NOT_CREATED" as const, created };
  return { status: "COMPLETE" as const, created };
}
