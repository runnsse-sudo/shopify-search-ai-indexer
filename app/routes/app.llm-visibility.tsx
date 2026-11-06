import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import type { action as catalogAction } from "./app.llm-visibility_.catalog";

import {
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";

import {
  boundary,
} from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { fetchPrimaryShopDomain } from "../services/shop-info.server";
import { llmDownload, llmReport, validateLlmAuditRequest } from "../services/llm-visibility/llm-delivery";

import {
  authenticate,
} from "../shopify.server";

import {
  runLlmVisibilityAudit,
} from "../services/llm-visibility/llm-visibility.server";


export const loader =
  async ({
    request,
  }: LoaderFunctionArgs) => {
    const {
      session, admin,
    } =
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


    const primaryDomain = shop?.primaryDomain ?? await fetchPrimaryShopDomain(admin).catch((): null => null);

    return {
      shopDomain:
        session.shop,

      primaryDomain:
        primaryDomain,

      ready:
        Boolean(
          primaryDomain,
        ),
    };
  };


export const action =
  async ({
    request,
  }: ActionFunctionArgs) => {
    const {
      session, admin,
    } =
      await authenticate.admin(
        request,
      );


    await validateLlmAuditRequest(request, process.env.SHOPIFY_APP_URL);

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


    const primaryDomain = shop?.primaryDomain ?? await fetchPrimaryShopDomain(admin).catch((): null => null);

    if (
      !primaryDomain
    ) {
      return {
        ok: false,

        error:
          "Primary storefront domain has not been discovered.",

        result:
          null,
        observedAt: null,
      };
    }


    try {
      const result =
        await runLlmVisibilityAudit({
          primaryDomain:
            primaryDomain,
        });


      return {
        ok: true,

        error:
          null,

        result,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error("AI visibility audit failed", { category: error instanceof Error ? "AUDIT_FAILED" : "UNKNOWN_FAILURE" });
      return { ok: false, error: "The audit could not be completed. Try again later. No files were published.", result: null, observedAt: null };

    }
  };


function Metric({
  label,
  value,
}: {
  label: string;

  value:
    string | number;
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
        <s-text
          color="subdued"
        >
          {label}
        </s-text>

        <s-heading>
          {typeof value ===
          "number"
            ? value.toLocaleString()
            : value}
        </s-heading>
      </s-stack>
    </s-box>
  );
}


function statusText(
  statusCode:
    number | null,

  error:
    string | null,
) {
  if (error) {
    return `ERROR — ${error}`;
  }


  return statusCode ===
    null
    ? "UNVERIFIED"
    : `HTTP ${statusCode}`;
}


function robotsGroupText(
  explicitGroup:
    boolean,

  wildcardFallback:
    boolean,
) {
  if (explicitGroup) {
    return "explicit robots group";
  }


  if (
    wildcardFallback
  ) {
    return "wildcard fallback";
  }


  return "no matching group";
}


export default function LlmVisibility() {
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

  const catalog = useFetcher<typeof catalogAction>();
  const catalogBusy = catalog.state !== "idle";

  const result =
    fetcher.data
      ?.result ??
    null;


  return (
    <s-page
      heading="AI / LLM Visibility"
    >
      <s-section heading="Public product catalog export">
        <s-paragraph>
          Generate a local llms-full.txt download from the products Shopify lists as public in this Online Store.
        </s-paragraph>
        <catalog.Form method="post" action="/app/llm-visibility/catalog">
          <input type="hidden" name="intent" value="export-public-catalog" />
          <button type="submit" disabled={catalogBusy}>
            {catalogBusy ? "Generating catalog…" : "Generate llms-full.txt"}
          </button>
        </catalog.Form>
        {!catalogBusy && catalog.data?.error && <s-paragraph>{catalog.data.error}</s-paragraph>}
        {!catalogBusy && catalog.data?.catalog && (
          <button type="button" onClick={() => {
            const file = catalog.data?.catalog;
            if (!file) return;
            const url = URL.createObjectURL(new Blob([file.text], { type: "text/plain;charset=utf-8" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "llms-full.txt";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>
            Download llms-full.txt ({catalog.data.catalog.count} products)
          </button>
        )}
      </s-section>
      <s-section
        heading="AI discovery check"
      >
        <s-paragraph>
          Shopify supplies the default agent-discovery information. This app checks published discovery files, crawler access and a bounded sitemap sample, then suggests improvements. You do not need to write llms files yourself. Custom theme templates can override Shopify’s defaults; this audit does not determine template ownership.
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
            robots.txt writes:
            disabled
          </s-list-item>

          <s-list-item>
            llms.txt publishing:
            disabled
          </s-list-item>

          <s-list-item>
            Shopify/database/theme
            writes: disabled
          </s-list-item>
        </s-unordered-list>


        <fetcher.Form
          method="post"
        >
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
              : "Run AI visibility audit"}
          </button>
        </fetcher.Form>


        {fetcher.data
          ?.error ? (
          <s-paragraph>
            Audit error:{" "}
            {fetcher.data.error}
          </s-paragraph>
        ) : null}
      </s-section>


      <s-section
        heading="Technical readiness"
      >
        {!result ? (
          <s-paragraph>
            Run the audit to
            calculate the technical
            AI visibility snapshot.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-stack
              direction="inline"
              gap="base"
            >
              <Metric
                label="Readiness score"
                value={
                  result.score === null ? "Unavailable" : `${result.score}/100`
                }
              />

              <Metric
                label="Score band"
                value={
                  result
                    .scoreLabel
                }
              />

              <Metric
                label="Sitemap URLs"
                value={
                  result
                    .sitemap
                    ?.totalUrls ?? "Unavailable"
                }
              />

              <Metric
                label="Pages sampled"
                value={
                  result
                    .sitemap
                    ?.sampledPages ?? "Unavailable"
                }
              />

              <Metric
                label="AI tokens audited"
                value={
                  result
                    .aiAccessSummary
                    .registeredTokens
                }
              />

              <Metric
                label="User-triggered fetchers"
                value={
                  result
                    .aiAccessSummary
                    .userTriggeredTokens
                }
              />
            </s-stack>


            <s-paragraph>
              {result.scoreNote}
            </s-paragraph>


            <s-unordered-list>
              <s-list-item>
                Total runtime:{" "}
                {(
                  result
                    .timings
                    .totalMs /
                  1000
                ).toFixed(2)}
                {" s"}
              </s-list-item>

              <s-list-item>
                robots/llms fetch
                phase:{" "}
                {(
                  result
                    .timings
                    .documentFetchMs /
                  1000
                ).toFixed(2)}
                {" s"}
              </s-list-item>

              <s-list-item>
                Sitemap visibility
                phase:{" "}
                {(
                  result
                    .timings
                    .sitemapAuditMs /
                  1000
                ).toFixed(2)}
                {" s"}
              </s-list-item>

              <s-list-item>
                Sampled noindex:{" "}
                {result
                  .sitemap
                  ?.sampledNoindex
                  .toLocaleString() ?? "Unavailable"}
              </s-list-item>

              <s-list-item>
                Sampled canonical
                mismatch:{" "}
                {result
                  .sitemap
                  ?.sampledCanonicalMismatch
                  .toLocaleString() ?? "Unavailable"}
              </s-list-item>

              <s-list-item>
                Sampled fetch
                failures:{" "}
                {result
                  .sitemap
                  ?.sampledFetchFailures
                  .toLocaleString() ?? "Unavailable"}
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>


      <s-section
        heading="robots.txt & AI crawler/fetcher policy"
      >
        {!result ? (
          <s-paragraph>
            No robots.txt policy
            has been evaluated in
            this session.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-unordered-list>
              <s-list-item>
                robots.txt:{" "}
                {statusText(
                  result
                    .robots
                    .statusCode,

                  result
                    .robots
                    .error,
                )}
              </s-list-item>

              <s-list-item>
                Parsed groups:{" "}
                {result
                  .robots
                  .groupCount
                  .toLocaleString()}
              </s-list-item>

              <s-list-item>
                Sitemap directives:{" "}
                {result
                  .robots
                  .sitemapCount
                  .toLocaleString()}
              </s-list-item>
            </s-unordered-list>


            <s-unordered-list>
              {result
                .crawlers
                .map(
                  (
                    crawler,
                  ) => (
                    <s-list-item
                      key={
                        crawler.token
                      }
                    >
                      {crawler.token}
                      {" — "}
                      {crawler.vendor}
                      {" — "}
                      {crawler.purpose}
                      {" — "}
                      {crawler
                        .userTriggered
                        ? "USER_TRIGGERED"
                        : "AUTOMATED_OR_CONTROL"}
                      {" — robots semantics "}
                      {crawler
                        .robotsBehavior}
                      {" — root "}
                      {crawler.rootAccess}
                      {" — representative paths "}
                      {crawler
                        .allRepresentativePathsAllowed
                        ? "ALLOW"
                        : "PARTIAL/BLOCKED/UNKNOWN"}
                      {" — "}
                      {robotsGroupText(
                        crawler
                          .explicitGroup,

                        crawler
                          .wildcardFallback,
                      )}
                    </s-list-item>
                  ),
                )}
            </s-unordered-list>


            <s-paragraph>
              Search visibility is
              scored separately from
              training, generative-AI
              controls, and user-triggered
              fetcher policy. ChatGPT-User,
              Claude-User, and
              Perplexity-User are shown
              with vendor-specific robots
              semantics and do not change
              the search-readiness score.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>


      <s-section
        heading="LLM discovery files"
      >
        {!result ? (
          <s-paragraph>
            No discovery files
            have been checked yet.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-unordered-list>
              <s-list-item>
                /agents.md (primary):{" "}
                {statusText(result.agentsMd.statusCode, result.agentsMd.error)}
                {result.agentsMd.analysis
                  ? result.agentsMd.analysis.looksLikeHtml
                    ? " — HTML response"
                    : result.agentsMd.analysis.nonEmpty
                      ? " — Discovery content found"
                      : " — Empty response"
                  : ""}
              </s-list-item>
              <s-list-item>
                /llms.txt:{" "}
                {statusText(
                  result
                    .llmsTxt
                    .statusCode,

                  result
                    .llmsTxt
                    .error,
                )}

                {result
                  .llmsTxt
                  .analysis
                  ? ` — ${result.llmsTxt.analysis.bytes.toLocaleString()} bytes — ${result.llmsTxt.analysis.headingCount.toLocaleString()} headings — ${result.llmsTxt.analysis.markdownLinkCount.toLocaleString()} markdown links`
                  : ""}
              </s-list-item>

              <s-list-item>
                /llms-full.txt:{" "}
                {statusText(
                  result
                    .llmsFullTxt
                    .statusCode,

                  result
                    .llmsFullTxt
                    .error,
                )}

                {result
                  .llmsFullTxt
                  .analysis
                  ? ` — ${result.llmsFullTxt.analysis.bytes.toLocaleString()} bytes — ${result.llmsFullTxt.analysis.headingCount.toLocaleString()} headings — ${result.llmsFullTxt.analysis.markdownLinkCount.toLocaleString()} markdown links`
                  : ""}
              </s-list-item>
            </s-unordered-list>


            <s-paragraph>
              These files are treated
              as optional discovery
              conventions. robots.txt
              remains the crawler
              access-control surface
              evaluated by this phase.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>


      <s-section
        heading="Recommendations"
      >
        {!result ? (
          <s-paragraph>
            Recommendations appear
            after an audit.
          </s-paragraph>
        ) :
        result
          .recommendations
          .length ===
        0 ? (
          <s-paragraph>
            No technical AI
            visibility recommendations
            were produced by this
            bounded audit.
          </s-paragraph>
        ) : (
          <s-unordered-list>
            {result
              .recommendations
              .map(
                (
                  item,
                ) => (
                  <s-list-item
                    key={
                      item.code
                    }
                  >
                    {item.severity}
                    {" — "}
                    {item.code}
                    {" — "}
                    {item.message}
                  </s-list-item>
                ),
              )}
          </s-unordered-list>
        )}
      </s-section>


      {result && fetcher.data?.observedAt ? <s-section heading="Your audit report">
        <s-paragraph>Observed: {fetcher.data.observedAt}. Technical readiness is based on a bounded sample, not AI mentions or rankings. A high score does not guarantee inclusion.</s-paragraph>
        <p><a download="ai-visibility-report.json" href={llmDownload(llmReport(result, fetcher.data.observedAt), "json")}>Download audit report</a></p>
        <s-paragraph>Next: review high-priority crawler, canonical and noindex findings. Improve product descriptions, titles and verified company information in Shopify, then run a new audit. Keep functioning Shopify discovery information in place.</s-paragraph>
      </s-section> : null}

      <s-section
        heading="Read-only checks"
      >
        <s-unordered-list>
          <s-list-item>
            No robots.txt writes.
          </s-list-item>

          <s-list-item>
            No llms.txt publishing.
          </s-list-item>

          <s-list-item>
            No theme changes.
          </s-list-item>

          <s-list-item>
            No redirect writes.
          </s-list-item>

          <s-list-item>
            No Shopify scope
            changes.
          </s-list-item>

          <s-list-item>
            No WAF/CDN allowlist
            writes.
          </s-list-item>

          <s-list-item>
            No database
            persistence in
            Phase C V1.
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
  HeadersFunction = (
    headersArgs,
  ) => {
    const headers = new Headers(boundary.headers(headersArgs));
    headers.set("Cache-Control", "private, no-store");
    return headers;
  };
