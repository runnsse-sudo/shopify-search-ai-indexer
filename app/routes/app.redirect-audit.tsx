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
          domain: true,
          primaryDomain: true,
        },
      });

    return {
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

    const formData =
      await request.formData();

    const intent =
      String(
        formData.get(
          "intent",
        ) ?? "",
      );

    if (
      intent !==
      "run-read-only"
    ) {
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
          primaryDomain: true,
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

    try {
      const startedAt = Date.now();
      const result =
        await runRedirectAudit({
          primaryDomain:
            shop.primaryDomain,
        });
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
      };
    } catch (error) {
      console.error(
        "Redirect audit failed",
        {
          shop:
            session.shop,
          error,
        },
      );

      return {
        ok: false,
        error:
          error instanceof Error
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
    const report = { schemaVersion: 1, observedAt, partial, result, rechecks };
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

          <s-list-item>
            No audit persistence in this
            Phase B version.
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
