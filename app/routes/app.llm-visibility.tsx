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
  runLlmVisibilityAudit,
} from "../services/llm-visibility/llm-visibility.server";


export const loader =
  async ({
    request,
  }: LoaderFunctionArgs) => {
    const {
      session,
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
    const {
      session,
    } =
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
          "Unknown AI visibility audit action.",

        result:
          null,
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

        result:
          null,
      };
    }


    try {
      const result =
        await runLlmVisibilityAudit({
          primaryDomain:
            shop.primaryDomain,
        });


      return {
        ok: true,

        error:
          null,

        result,
      };
    } catch (error) {
      console.error(
        "AI visibility audit failed",
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
            : "AI visibility audit failed.",

        result:
          null,
      };
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


  const result =
    fetcher.data
      ?.result ??
    null;


  return (
    <s-page
      heading="AI / LLM Visibility"
    >
      <s-section
        heading="Read-only Phase C audit"
      >
        <s-paragraph>
          This audit evaluates AI
          crawler policy in robots.txt,
          checks optional llms.txt
          files, reuses the bounded
          sitemap inventory for
          canonical/noindex visibility,
          and generates deterministic
          unpublished llms.txt
          previews.
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
                  `${result.score}/100`
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
                    .totalUrls
                }
              />

              <Metric
                label="Pages sampled"
                value={
                  result
                    .sitemap
                    .sampledPages
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
                  .sampledNoindex
                  .toLocaleString()}
              </s-list-item>

              <s-list-item>
                Sampled canonical
                mismatch:{" "}
                {result
                  .sitemap
                  .sampledCanonicalMismatch
                  .toLocaleString()}
              </s-list-item>

              <s-list-item>
                Sampled fetch
                failures:{" "}
                {result
                  .sitemap
                  .sampledFetchFailures
                  .toLocaleString()}
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>


      <s-section
        heading="robots.txt & AI crawler policy"
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
              training or generative-AI
              policy choices. Blocking
              a training crawler does
              not reduce the score.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>


      <s-section
        heading="LLM discovery files"
      >
        {!result ? (
          <s-paragraph>
            No llms.txt resources
            have been checked yet.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-unordered-list>
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


      <s-section
        heading="Unpublished llms.txt candidate"
      >
        {!result ? (
          <s-paragraph>
            The deterministic
            preview is generated
            only after an audit.
          </s-paragraph>
        ) : (
          <pre>
            {result
              .previews
              .llmsTxt}
          </pre>
        )}
      </s-section>


      <s-section
        heading="Unpublished llms-full.txt candidate"
      >
        {!result ? (
          <s-paragraph>
            The bounded extended
            preview is not published
            to the storefront.
          </s-paragraph>
        ) : (
          <pre>
            {result
              .previews
              .llmsFullTxt}
          </pre>
        )}
      </s-section>


      <s-section
        heading="Phase boundaries"
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
    return boundary.headers(
      headersArgs,
    );
  };