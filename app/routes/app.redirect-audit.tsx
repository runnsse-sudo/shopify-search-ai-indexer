import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import {
  boundary,
} from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  authenticate,
} from "../shopify.server";
import {
  recheckAutomaticRedirect,
  runRedirectAudit,
} from "../services/redirect-audit/redirect-audit.server";

import { loadRedirectHistory } from "../services/redirect-audit/redirect-history.server";

import { loadDiscoveryQueue, rememberDiscoveryImport, rememberDiscoveryObservations } from "../services/redirect-audit/discovery-queue.server";
import { DiscoveryInputError, discoveryInputLimit, parseDiscoveryUrls, type DiscoveryObservation } from "../services/redirect-audit/discovery-import";
import type { RedirectDiagnostics } from "../services/redirect-audit/automatic-redirect.server";

const queueStatusLabels = {
  PENDING: "Awaiting check",
  UNVERIFIED: "Could not verify",
  DIRECT_404: "Verified direct 404",
  OTHER_RESPONSE: "Other response",
};

const skipExplanations: Record<string, string> = {
  INCOMPLETE_SITEMAP: "Sitemap coverage stopped automatic redirects",
  SOURCE_HAS_REDIRECT_CHAIN: "Source already redirects before returning 404",
  NO_SUGGESTED_TARGET: "No replacement page matched",
  SUGGESTION_NOT_ELIGIBLE: "Match did not meet the confidence, page type or clear-winner requirements",
  RESOURCE_TYPE_MISMATCH: "Source and target are not compatible page types",
  LOW_MATCH_CONFIDENCE: "Replacement match scored below the required confidence",
  AMBIGUOUS_TARGET: "Another replacement scored too close to the best match",
  OUTSIDE_EXACT_TEST: "Outside the approved test pair",
  CANDIDATE_LIMIT: "Outside the run's candidate limit",
  INVALID_RECHECK_URL: "Source or target URL did not pass validation",
  SOURCE_NOT_DIRECT_404: "Source no longer verified as a direct 404",
  TARGET_NOT_DIRECT_HTML_200: "Target did not verify as a direct HTML page with HTTP 200",
  RECHECK_UNVERIFIED: "The source and target could not be verified",
  PATH_POLICY_REJECTED: "Source or target path did not pass the redirect rules",
  REDIRECT_ALREADY_EXISTS: "Shopify already has a redirect for the source",
  REDIRECT_LOOKUP_UNVERIFIED: "Shopify redirect lookup could not confirm an empty result",
  EXACT_PAIR_RECHECK_FAILED: "The approved pair failed its final recheck",
  DEADLINE_REACHED: "The audit time limit was reached",
  CANDIDATE_OUTCOME_UNCONFIRMED: "The run stopped before this candidate's outcome was confirmed",
  RUN_STOPPED_BEFORE_OUTCOME: "The run stopped before this candidate was checked",
};

function RunDiagnostics({ diagnostics }: { diagnostics: RedirectDiagnostics | null }) {
  if (!diagnostics) return <s-paragraph>Verified 404s and candidate reasons were not recorded.</s-paragraph>;
  return <>
    <s-paragraph>Verified direct 404s: {diagnostics.verified404Count} | Links checked: {diagnostics.checkedLinks} | Unverified links: {diagnostics.unverifiedLinks}</s-paragraph>
    {!!diagnostics.unlisted404Count && <s-paragraph>{diagnostics.unlisted404Count} additional 404s were outside the detailed audit result limit.</s-paragraph>}
    {diagnostics.skipped.length > 0 && <details>
      <summary>Skipped candidates ({diagnostics.skipped.length})</summary>
      <s-unordered-list>
        {diagnostics.skipped.map(({ path, reason, score, targetPath }, index) => (
          <s-list-item key={index}>{path}{targetPath && ` → ${targetPath}`} | {skipExplanations[reason] ?? reason}{score === null ? "" : ` | Match score ${score}`}</s-list-item>
        ))}
      </s-unordered-list>
    </details>}
  </>;
}

export const loader =
  async ({
    request,
  }: LoaderFunctionArgs) => {
    const { session } =
      await authenticate.admin(
        request,
      );

    const shop =
      await prisma.shop.findUnique({
        where: {
          domain:
            session.shop,
        },
        select: {
          id: true, domain: true,
          primaryDomain: true,
        },
      });

    let history = null;
    try {
      history = await loadRedirectHistory(prisma, session.shop);
    } catch {
      console.error("Redirect audit history unavailable", { shop: session.shop });
    }
    const queue = shop
      ? await loadDiscoveryQueue(prisma, shop.id).catch(() => null)
      : [];
    return {
      queue,
      history,
      shopDomain:
        session.shop,
      primaryDomain:
        shop?.primaryDomain ??
        null,
      ready:
        Boolean(
          shop?.primaryDomain,
        ),
    };
  };

export const action =
  async ({
    request,
  }: ActionFunctionArgs) => {
    const { session } =
      await authenticate.admin(
        request,
      );

    const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/x-www-form-urlencoded") {
      throw new Response("Unsupported form", { status: 415 });
    }
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let encoded = "";
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          // UTF-8 percent encoding can expand each input character.
          if (size > discoveryInputLimit * 9 + 256) {
            await reader.cancel();
            throw new Response("Form too large", { status: 413 });
          }
          encoded += decoder.decode(value, { stream: true });
        }
        encoded += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    const formData = new URLSearchParams(encoded);

    const intent =
      String(
        formData.get(
          "intent",
        ) ?? "",
      );

    if (intent !== "run-read-only" && intent !== "run-discovery") {
      return {
        ok: false,
        error:
          "Unknown redirect audit action.",
        result: null,
      };
    }

    const shop =
      await prisma.shop.findUnique({
        where: {
          domain:
            session.shop,
        },
        select: {
          id: true, primaryDomain: true,
        },
      });

    if (
      !shop?.primaryDomain
    ) {
      return {
        ok: false,
        error:
          "Primary storefront domain has not been discovered.",
        result: null,
      };
    }

    const appUrl = process.env.SHOPIFY_APP_URL ? URL.parse(process.env.SHOPIFY_APP_URL) : null;
    if (intent === "run-discovery" && (!appUrl || request.headers.get("origin") !== appUrl.origin)) {
      throw new Response("Request not permitted", { status: 403 });
    }

    try {
      const discovery = intent === "run-discovery"
        ? parseDiscoveryUrls(String(formData.get("discoveryUrls") ?? ""), new URL(shop.primaryDomain.includes("://") ? shop.primaryDomain : `https://${shop.primaryDomain}`))
        : null;
      const startedAt = Date.now();
      const checkedAt = new Date(startedAt);
      const observations: DiscoveryObservation[] = [];
      let queuePaths: string[] = [];
      if (discovery) {
        await rememberDiscoveryImport(prisma, shop.id, discovery.paths, checkedAt);
        const queue = await loadDiscoveryQueue(prisma, shop.id);
        queuePaths = queue.filter(({ status }) => status !== "OTHER_RESPONSE").map(({ path }) => path);
      }
      const result =
        await runRedirectAudit({
          primaryDomain:
            shop.primaryDomain,
          ...(discovery && {
            discoveryPaths: [...new Set([...discovery.paths, ...queuePaths])],
            onDiscoveryObservation: (observation) => observations.push(observation),
            sourceRotationDay: Math.floor(startedAt / 86_400_000),
            maxSourcePages: 50,
            maxLinkChecks: 250,
            ...(session.shop === "3f457e-2.myshopify.com" && { maxSitemapDocuments: 75 }),
          }),
        });
      if (discovery) await rememberDiscoveryObservations(prisma, shop.id, observations, checkedAt);
      const deadlineAt = startedAt + result.auditDeadlineMs;
      const coverageAllowsRecheck =
        !result.coverage.sitemapDocumentsTruncated &&
        !result.coverage.sitemapUrlsTruncated &&
        !result.coverage.auditDeadlineReached &&
        Date.now() < deadlineAt;
      const candidates = coverageAllowsRecheck
        ? result.brokenInternalLinks.filter(
            (item) => item.suggestion?.eligibleForRecheck && item.redirectChain.length === 0,
          ).slice(0, 5)
        : [];
      const rechecks = await Promise.all(candidates.map(async (item) => ({
        sourceUrl: item.url,
        verified: Boolean(await recheckAutomaticRedirect(item, result.primaryHost, undefined, deadlineAt)),
      })));

      return {
        ok: true,
        error: null,
        result,
        observedAt: new Date().toISOString(),
        rechecks,
        discovery: discovery && { imported: discovery.paths.length, ignored: discovery.ignored },
      };
    } catch (error) {
      console.error(
        "Redirect audit failed",
        {
          shop:
            session.shop,
          ...(intent !== "run-discovery" && { error }),
        },
      );

      return {
        ok: false,
        error: error instanceof DiscoveryInputError || (intent !== "run-discovery" && error instanceof Error)
          ? error.message
          : "Redirect audit failed.",
        result: null,
      };
    }
  };

function Metric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
    >
      <s-stack
        direction="block"
        gap="small-200"
      >
        <s-text color="subdued">
          {label}
        </s-text>

        <s-heading>
          {value.toLocaleString()}
        </s-heading>
      </s-stack>
    </s-box>
  );
}

export default function RedirectAudit() {
  const {
    shopDomain,
    primaryDomain,
    ready,
    history,
    queue,
  } =
    useLoaderData<
      typeof loader
    >();

  const fetcher =
    useFetcher<
      typeof action
    >();

  const busy =
    fetcher.state !==
    "idle";

  const result =
    fetcher.data?.result ??
    null;
  const observedAt = fetcher.data?.ok ? fetcher.data.observedAt : undefined;
  const rechecks = fetcher.data?.rechecks ?? [];
  const partial = result && (
    Object.values(result.coverage).some(Boolean) ||
    result.sourcePagesFailed > 0 ||
    result.internalLinksUnverified > 0
  );

  function downloadReport() {
    if (!result || !observedAt) return;
    const report = { schemaVersion: 1, observedAt, partial, result, rechecks, discovery: fetcher.data?.discovery ?? null };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "redirect-audit-report.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <s-page heading="404 & Redirect Audit">
      <s-section heading="404 discovery queue">
        {queue === null ? <s-paragraph>The discovery queue is unavailable.</s-paragraph>
          : queue.length === 0 ? <s-paragraph>No discovery URLs have been saved.</s-paragraph>
          : <s-unordered-list>
              {queue.map((entry) => (
                <s-list-item key={entry.path}>
                  {entry.path} | {queueStatusLabels[entry.status]} | {entry.importedAt ? "Includes Search Console import" : "Storefront audit"}
                  { ` | First seen ${new Date(entry.firstSeenAt).toISOString()}` }
                  {entry.lastCheckedAt && ` | Checked ${new Date(entry.lastCheckedAt).toISOString()}`}
                </s-list-item>
              ))}
            </s-unordered-list>}
      </s-section>

      <s-section heading="Scheduled audit history">
        {history === null ? (
          <s-paragraph>Scheduled audit history is unavailable.</s-paragraph>
        ) : history.runs.length === 0 ? (
          <s-paragraph>No scheduled runs have been recorded for this shop yet.</s-paragraph>
        ) : history.runs.map((run) => (
          <s-box key={run.id} padding="base" borderWidth="base" borderRadius="base">
            <s-heading>{new Date(run.startedAt).toISOString()} · {run.status}</s-heading>
            {run.stopReason ? <s-paragraph>Stop reason: {run.stopReason}</s-paragraph> : null}
            {!run.finishedAt ? <s-paragraph>No final result has been recorded.</s-paragraph> : null}
            <RunDiagnostics diagnostics={run.diagnostics as RedirectDiagnostics | null} />
            <s-paragraph>Recorded redirects: {run.redirects.length}</s-paragraph>
            {run.redirects.length > 0 ? (
              <s-unordered-list>
                {run.redirects.map((redirect) => (
                  <s-list-item key={redirect.shopifyId}>
                    {redirect.source} → {redirect.target} · Shopify ID {redirect.shopifyId}
                  </s-list-item>
                ))}
              </s-unordered-list>
            ) : null}
          </s-box>
        ))}
      </s-section>

      <s-section heading="Redirect targets needing attention">
        {!history ? (
          <s-paragraph>Target checks are unavailable.</s-paragraph>
        ) : history.targetIssues.length === 0 ? (
          <s-paragraph>No HTTP 404 or onward redirects were found in the recorded target checks.</s-paragraph>
        ) : (
          <s-unordered-list>
            {history.targetIssues.map((issue) => (
              <s-list-item key={issue.id}>
                {issue.source} → {issue.target} · {issue.targetStatus === "NOT_FOUND" ? "HTTP 404" : "Redirects onward"}
                {" · Shopify ID "}{issue.shopifyId}
                {issue.checkedAt ? ` · Checked ${new Date(issue.checkedAt).toISOString()}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-section heading="Storefront audit">
        <s-paragraph>
          This bounded audit reads the
          Shopify sitemap and storefront
          pages to discover broken internal
          links, HTTP 404 responses,
          redirects, redirect chains and
          redirect loops. It also produces
          deterministic redirect
          suggestions with confidence
          scores.
        </s-paragraph>

        <s-unordered-list>
          <s-list-item>
            Shopify shop:{" "}
            {shopDomain}
          </s-list-item>

          <s-list-item>
            Primary domain:{" "}
            {primaryDomain ??
              "Not discovered"}
          </s-list-item>

          <s-list-item>
            Mode: read-only /
            ephemeral
          </s-list-item>

          <s-list-item>
            Shopify redirect writes:
            disabled
          </s-list-item>

          <s-list-item>
            Shopify scope migration:
            none
          </s-list-item>
        </s-unordered-list>

        <fetcher.Form method="post">
          <input
            type="hidden"
            name="intent"
            value="run-read-only"
          />

          <button
            type="submit"
            disabled={
              busy ||
              !ready
            }
          >
            {busy
              ? "Running audit…"
              : "Run read-only 404 audit"}
          </button>
        </fetcher.Form>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="run-discovery" />
          <label>
            Search Console URLs to save and check
            <textarea name="discoveryUrls" rows={4} maxLength={discoveryInputLimit}
              placeholder="Paste the Pages CSV or one storefront URL per line" />
          </label>
          <button type="submit" disabled={busy || !ready}>Run expanded read-only audit</button>
        </fetcher.Form>
        {fetcher.data?.discovery && <s-paragraph>
          Imported URLs saved in the queue: {fetcher.data.discovery.imported}. Ignored rows: {fetcher.data.discovery.ignored}.
        </s-paragraph>}

        {fetcher.data?.error ? (
          <s-paragraph>
            Audit error:{" "}
            {fetcher.data.error}
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Discovery summary">
        {!result ? (
          <s-paragraph>
            No Phase B audit has been run
            in this session.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            {partial ? (
              <s-banner tone="warning">
                This report covers only the URLs the audit could verify. See Performance &amp; coverage for details.
              </s-banner>
            ) : null}
            <s-button onClick={downloadReport}>Download JSON report</s-button>
            <s-stack
              direction="inline"
              gap="base"
            >
              <Metric
                label="Sitemap URLs"
                value={
                  result.sitemapUrls
                }
              />

              <Metric
                label="Internal links"
                value={
                  result.internalLinksDiscovered
                }
              />

              <Metric
                label="404s"
                value={
                  result.notFoundCount
                }
              />

              <Metric
                label="Broken internal"
                value={
                  result.brokenInternalLinkCount
                }
              />
            </s-stack>

            <s-stack
              direction="inline"
              gap="base"
            >
              <Metric
                label="Redirects"
                value={
                  result.redirectCount
                }
              />

              <Metric
                label="Chains"
                value={
                  result.redirectChainCount
                }
              />

              <Metric
                label="Loops"
                value={
                  result.redirectLoopCount
                }
              />

              <Metric
                label="Checked links"
                value={
                  result.internalLinksChecked
                }
              />
            </s-stack>

            <s-unordered-list>
              <s-list-item>
                Sitemap documents fetched:{" "}
                {result.sitemapDocumentsFetched.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Source pages checked:{" "}
                {result.sourcePagesRequested.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Source successes:{" "}
                {result.sourcePagesSucceeded.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Source failures:{" "}
                {result.sourcePagesFailed.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Internal links unverified:{" "}
                {result.internalLinksUnverified.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Client errors:{" "}
                {result.clientErrorCount.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Server errors:{" "}
                {result.serverErrorCount.toLocaleString()}
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Performance & coverage">
        {!result ? (
          <s-paragraph>
            Timing and coverage information
            appears after an audit.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-unordered-list>
              <s-list-item>
                Total runtime:{" "}
                {(
                  result.timings.totalMs /
                  1000
                ).toFixed(2)}
                {" s"}
              </s-list-item>

              <s-list-item>
                Sitemap phase:{" "}
                {(
                  result.timings.sitemapMs /
                  1000
                ).toFixed(2)}
                {" s"}
              </s-list-item>

              <s-list-item>
                Source-page phase:{" "}
                {(
                  result.timings.sourcePagesMs /
                  1000
                ).toFixed(2)}
                {" s · concurrency "}
                {result.sourceConcurrency}
              </s-list-item>

              <s-list-item>
                Link-check phase:{" "}
                {(
                  result.timings.linkChecksMs /
                  1000
                ).toFixed(2)}
                {" s · concurrency "}
                {result.linkConcurrency}
              </s-list-item>

              <s-list-item>
                Audit deadline:{" "}
                {(
                  result.auditDeadlineMs /
                  1000
                ).toFixed(0)}
                {" s"}
              </s-list-item>

              <s-list-item>
                Fetch retries performed:{" "}
                {result.retriesPerformed.toLocaleString()}
              </s-list-item>
            </s-unordered-list>

            <s-unordered-list>
              <s-list-item>
                Sitemap document limit hit:{" "}
                {result.coverage.sitemapDocumentsTruncated
                  ? "yes"
                  : "no"}
              </s-list-item>

              <s-list-item>
                Sitemap URL limit hit:{" "}
                {result.coverage.sitemapUrlsTruncated
                  ? "yes"
                  : "no"}
              </s-list-item>

              <s-list-item>
                Source-page sample limited:{" "}
                {result.coverage.sourcePagesTruncated
                  ? "yes"
                  : "no"}
              </s-list-item>

              <s-list-item>
                Internal-link checks limited:{" "}
                {result.coverage.internalLinksTruncated
                  ? "yes"
                  : "no"}
              </s-list-item>

              <s-list-item>
                Audit deadline reached:{" "}
                {result.coverage.auditDeadlineReached
                  ? "yes"
                  : "no"}
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Redirect suggestions">
        {!result ? (
          <s-paragraph>
            Suggestions appear after an
            audit.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-paragraph>
              HIGH:{" "}
              {result.suggestionCounts.HIGH.toLocaleString()}
              {" · "}
              MEDIUM:{" "}
              {result.suggestionCounts.MEDIUM.toLocaleString()}
              {" · "}
              LOW:{" "}
              {result.suggestionCounts.LOW.toLocaleString()}
            </s-paragraph>

            {result.brokenInternalLinks.length ===
            0 ? (
              <s-paragraph>
                No broken internal links
                were found in the bounded
                sample.
              </s-paragraph>
            ) : (
              <s-unordered-list>
                {result.brokenInternalLinks.map(
                  (item) => (
                    <s-list-item
                      key={
                        item.url
                      }
                    >
                      {item.url}
                      {" — "}
                      {item.statusCode ??
                        item.error ??
                        "unknown"}
                      {item.suggestion
                        ? ` → ${item.suggestion.targetUrl} (${item.suggestion.confidence}, ${item.suggestion.score})`
                        : ""}
                      {item.suggestion && (
                        item.suggestion.eligibleForRecheck && item.redirectChain.length === 0 &&
                        !result.coverage.sitemapDocumentsTruncated &&
                        !result.coverage.sitemapUrlsTruncated &&
                        !result.coverage.auditDeadlineReached
                          ? rechecks.find((check) => check.sourceUrl === item.url)?.verified
                            ? " · 404 and destination verified"
                            : " · Automatic recheck unconfirmed"
                          : " · Review required"
                      )}
                    </s-list-item>
                  ),
                )}
              </s-unordered-list>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Observed redirects">
        {!result ? (
          <s-paragraph>
            Redirect observations appear
            after an audit.
          </s-paragraph>
        ) : result.redirects.length ===
          0 ? (
          <s-paragraph>
            No redirects were observed in
            the bounded sample.
          </s-paragraph>
        ) : (
          <s-unordered-list>
            {result.redirects.map(
              (item) => (
                <s-list-item
                  key={
                    item.requestedUrl
                  }
                >
                  {item.requestedUrl}
                  {" → "}
                  {item.finalUrl}
                  {" · hops "}
                  {item.hopCount}
                  {item.loopDetected
                    ? " · LOOP"
                    : ""}
                </s-list-item>
              ),
            )}
          </s-unordered-list>
        )}
      </s-section>

      <s-section heading="Safety">
        <s-unordered-list>
          <s-list-item>
            No Shopify redirect writes.
          </s-list-item>

          <s-list-item>
            No theme writes.
          </s-list-item>

          <s-list-item>
            No sitemap publishing.
          </s-list-item>

          <s-list-item>
            No IndexNow execution.
          </s-list-item>

        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(
    useRouteError(),
  );
}

export const headers:
  HeadersFunction =
    (headersArgs) =>
      boundary.headers(
        headersArgs,
      );
