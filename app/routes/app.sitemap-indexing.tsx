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
  runSitemapAudit,
} from "../services/sitemap/sitemap-audit.server";

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
          "Unknown sitemap audit action.",
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
      const result =
        await runSitemapAudit({
          primaryDomain:
            shop.primaryDomain,
        });

      return {
        ok: true,
        error: null,
        result,
      };
    } catch (error) {
      console.error(
        "Sitemap audit failed",
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
            : "Sitemap audit failed.",
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

export default function SitemapIndexing() {
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

  return (
    <s-page heading="Sitemap & Indexing">
      <s-section heading="Read-only sitemap audit">
        <s-paragraph>
          This phase reads the
          storefront sitemap and a
          bounded sample of listed
          pages. It does not change
          Shopify, theme files,
          redirects, robots.txt,
          sitemaps, IndexNow or the
          database.
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
            Root sitemap:{" "}
            {primaryDomain
              ? `https://${primaryDomain}/sitemap.xml`
              : "Unavailable"}
          </s-list-item>

          <s-list-item>
            Execution mode:
            read-only / ephemeral
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
              : "Run sitemap audit"}
          </button>
        </fetcher.Form>

        {fetcher.data?.error ? (
          <s-paragraph>
            Audit error:{" "}
            {fetcher.data.error}
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Sitemap inventory">
        {!result ? (
          <s-paragraph>
            Run the read-only audit to
            inventory Shopify sitemap
            documents, URLs and image
            references.
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
                label="Sitemap documents"
                value={
                  result.sitemapDocumentsFetched
                }
              />

              <Metric
                label="Unique URLs"
                value={
                  result.totalUrls
                }
              />

              <Metric
                label="Image references"
                value={
                  result.totalImages
                }
              />

              <Metric
                label="Unique images"
                value={
                  result.uniqueImages
                }
              />
            </s-stack>

            <s-unordered-list>
              <s-list-item>
                Products:{" "}
                {result.resourceCounts.PRODUCT.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Collections:{" "}
                {result.resourceCounts.COLLECTION.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Pages:{" "}
                {result.resourceCounts.PAGE.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Blogs:{" "}
                {result.resourceCounts.BLOG.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Articles:{" "}
                {result.resourceCounts.ARTICLE.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Other:{" "}
                {result.resourceCounts.OTHER.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Duplicate sitemap URLs:{" "}
                {result.duplicateUrls.toLocaleString()}
              </s-list-item>

              <s-list-item>
                Invalid/external URLs:{" "}
                {result.invalidUrls.toLocaleString()}
              </s-list-item>

              <s-list-item>
                URLs with image references:{" "}
                {result.urlsWithImages.toLocaleString()}
              </s-list-item>
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Bounded storefront verification">
        {!result ? (
          <s-paragraph>
            No storefront samples have
            been checked yet.
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
                label="Checked"
                value={
                  result.pageChecks.requested
                }
              />

              <Metric
                label="Fetch failed"
                value={
                  result.pageChecks.failed
                }
              />

              <Metric
                label="Redirects"
                value={
                  result.pageChecks.redirects
                }
              />

              <Metric
                label="Noindex"
                value={
                  result.pageChecks.noindex
                }
              />

              <Metric
                label="Canonical mismatch"
                value={
                  result.pageChecks.canonicalMismatch
                }
              />
            </s-stack>

            <s-unordered-list>
              {result.pageChecks.pages.map(
                (page) => (
                  <s-list-item
                    key={
                      page.url
                    }
                  >
                    {page.resourceType}
                    {" — "}
                    {page.statusCode ??
                      "FETCH ERROR"}
                    {" — "}
                    {page.url}
                    {page.redirectCount >
                    0
                      ? ` — redirects ${page.redirectCount}`
                      : ""}
                    {page.noindex
                      ? " — NOINDEX"
                      : ""}
                    {page.canonicalMismatch
                      ? " — CANONICAL MISMATCH"
                      : ""}
                    {page.error
                      ? ` — ${page.error}`
                      : ""}
                  </s-list-item>
                ),
              )}
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Detected sitemap issues">
        {!result ? (
          <s-paragraph>
            No sitemap audit has been
            run in this session.
          </s-paragraph>
        ) : result.issues.total === 0 ? (
          <s-paragraph>
            No sitemap-level issues
            were found in this bounded
            audit.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-paragraph>
              Total detected issues:{" "}
              {result.issues.total.toLocaleString()}
              {result.issues.truncated
                ? " (sample list truncated)"
                : ""}
            </s-paragraph>

            <s-unordered-list>
              {result.issues.samples.map(
                (
                  issue,
                  index,
                ) => (
                  <s-list-item
                    key={`${issue.code}-${index}`}
                  >
                    {issue.severity}
                    {" — "}
                    {issue.code}
                    {" — "}
                    {issue.message}
                    {issue.url
                      ? ` — ${issue.url}`
                      : ""}
                  </s-list-item>
                ),
              )}
            </s-unordered-list>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Phase boundaries">
        <s-unordered-list>
          <s-list-item>
            No sitemap publishing.
          </s-list-item>

          <s-list-item>
            No robots.txt writes.
          </s-list-item>

          <s-list-item>
            No noindex/nofollow writes.
          </s-list-item>

          <s-list-item>
            No redirect writes.
          </s-list-item>

          <s-list-item>
            No Shopify scope changes.
          </s-list-item>

          <s-list-item>
            No database persistence
            in Sitemap V1.
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
