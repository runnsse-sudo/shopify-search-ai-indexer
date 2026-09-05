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
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  cancelSeoAudit,
  pauseSeoAudit,
  resumeSeoAudit,
  startSeoAudit,
} from "../services/seo-audit/seo-audit-run.server";

function structuredDataTypes(
  value: unknown,
): string[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return [];
  }

  return Object.entries(
    value as Record<string, unknown>,
  )
    .filter(
      ([, count]) =>
        typeof count === "number" &&
        count > 0,
    )
    .sort(([left], [right]) =>
      left.localeCompare(right),
    )
    .map(
      ([type, count]) =>
        `${type} (${String(count)})`,
    );
}

type DisplayIssue = {
  code: string;
  severity: string;
  message: string | null;
};

function displayIssues(
  value: unknown,
): DisplayIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item)
    ) {
      return [];
    }

    const issue = item as Record<
      string,
      unknown
    >;

    if (
      typeof issue.code !== "string" ||
      typeof issue.severity !== "string"
    ) {
      return [];
    }

    return [
      {
        code: issue.code,
        severity: issue.severity,
        message:
          typeof issue.message === "string"
            ? issue.message
            : null,
      },
    ];
  });
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const { session } =
    await authenticate.admin(request);

  const shop =
    await prisma.shop.findUnique({
      where: {
        domain: session.shop,
      },
      select: {
        id: true,
        domain: true,
        primaryDomain: true,
      },
    });

  if (!shop) {
    return {
      shopReady: false,
      shopDomain: session.shop,
      primaryDomain: null,
      indexableProducts: 0,
      latestRun: null,
      recentPages: [],
      issuePages: [],
      issuePageCount: 0,
    };
  }

  const [
    indexableProducts,
    latestRun,
  ] = await Promise.all([
    prisma.productIndexState.count({
      where: {
        shopId: shop.id,
        deletedAt: null,
        indexabilityState:
          "INDEXABLE",
        canonicalUrl: {
          not: null,
        },
      },
    }),

    prisma.seoAuditRun.findFirst({
      where: {
        shopId: shop.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        status: true,
        pagesProcessed: true,
        pagesSucceeded: true,
        pagesFailed: true,
        criticalCount: true,
        highCount: true,
        mediumCount: true,
        lowCount: true,
        infoCount: true,
        cursorProductGid: true,
        startedAt: true,
        lastProgressAt: true,
        completedAt: true,
        errorMessage: true,
        createdAt: true,
      },
    }),
  ]);

  let recentPages: Array<{
    id: string;
    requestedUrl: string;
    finalUrl: string | null;
    statusCode: number | null;
    title: string | null;
    canonicalUrl: string | null;
    noindex: boolean | null;
    jsonLdScriptCount: number;
    schemaTypes: string[];
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    infoCount: number;
    error: string | null;
    auditedAt: Date;
  }> = [];

  let issuePages: Array<{
    id: string;
    requestedUrl: string;
    finalUrl: string | null;
    statusCode: number | null;
    title: string | null;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    infoCount: number;
    issues: DisplayIssue[];
    error: string | null;
    auditedAt: Date;
  }> = [];

  let issuePageCount = 0;

  if (latestRun) {
    const issuePageWhere = {
      runId: latestRun.id,
      OR: [
        { criticalCount: { gt: 0 } },
        { highCount: { gt: 0 } },
        { mediumCount: { gt: 0 } },
        { lowCount: { gt: 0 } },
        { infoCount: { gt: 0 } },
      ],
    };

    const [
      pages,
      pagesWithIssues,
      totalIssuePages,
    ] = await Promise.all([
      prisma.seoAuditPage.findMany({
        where: {
          runId: latestRun.id,
        },
        orderBy: {
          auditedAt: "desc",
        },
        take: 20,
        select: {
          id: true,
          requestedUrl: true,
          finalUrl: true,
          statusCode: true,
          title: true,
          canonicalUrl: true,
          noindex: true,
          jsonLdScriptCount: true,
          jsonLdTypeCounts: true,
          criticalCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
          infoCount: true,
          error: true,
          auditedAt: true,
        },
      }),

      prisma.seoAuditPage.findMany({
        where: issuePageWhere,
        orderBy: [
          {
            criticalCount: "desc",
          },
          {
            highCount: "desc",
          },
          {
            mediumCount: "desc",
          },
          {
            lowCount: "desc",
          },
          {
            infoCount: "desc",
          },
          {
            auditedAt: "desc",
          },
        ],
        take: 100,
        select: {
          id: true,
          requestedUrl: true,
          finalUrl: true,
          statusCode: true,
          title: true,
          criticalCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
          infoCount: true,
          issues: true,
          error: true,
          auditedAt: true,
        },
      }),

      prisma.seoAuditPage.count({
        where: issuePageWhere,
      }),
    ]);

    recentPages = pages.map(
      (page) => ({
        id: page.id,
        requestedUrl:
          page.requestedUrl,
        finalUrl:
          page.finalUrl,
        statusCode:
          page.statusCode,
        title:
          page.title,
        canonicalUrl:
          page.canonicalUrl,
        noindex:
          page.noindex,
        jsonLdScriptCount:
          page.jsonLdScriptCount,
        schemaTypes:
          structuredDataTypes(
            page.jsonLdTypeCounts,
          ),
        criticalCount:
          page.criticalCount,
        highCount:
          page.highCount,
        mediumCount:
          page.mediumCount,
        lowCount:
          page.lowCount,
        infoCount:
          page.infoCount,
        error:
          page.error,
        auditedAt:
          page.auditedAt,
      }),
    );

    issuePages = pagesWithIssues.map(
      (page) => ({
        id: page.id,
        requestedUrl:
          page.requestedUrl,
        finalUrl:
          page.finalUrl,
        statusCode:
          page.statusCode,
        title:
          page.title,
        criticalCount:
          page.criticalCount,
        highCount:
          page.highCount,
        mediumCount:
          page.mediumCount,
        lowCount:
          page.lowCount,
        infoCount:
          page.infoCount,
        issues:
          displayIssues(page.issues),
        error:
          page.error,
        auditedAt:
          page.auditedAt,
      }),
    );

    issuePageCount = totalIssuePages;
  }

  return {
    shopReady:
      Boolean(shop.primaryDomain),
    shopDomain:
      shop.domain,
    primaryDomain:
      shop.primaryDomain,
    indexableProducts,
    latestRun,
    recentPages,
    issuePages,
    issuePageCount,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs) => {
  const { session } =
    await authenticate.admin(request);

  const formData =
    await request.formData();

  const intent =
    String(
      formData.get("intent") ?? "",
    );

  const runId =
    String(
      formData.get("runId") ?? "",
    );

  try {
    if (intent === "start") {
      const run =
        await startSeoAudit(
          session.shop,
        );

      return {
        ok: true,
        error: null,
        runId: run.id,
      };
    }

    if (!runId) {
      return {
        ok: false,
        error:
          "A SEO audit run is required.",
        runId: null,
      };
    }

    if (intent === "continue") {
      const run =
        await resumeSeoAudit(
          session.shop,
          runId,
        );

      return {
        ok: true,
        error: null,
        runId: run.id,
      };
    }

    if (intent === "pause") {
      const run =
        await pauseSeoAudit(
          session.shop,
          runId,
        );

      return {
        ok: true,
        error: null,
        runId: run.id,
      };
    }

    if (intent === "cancel") {
      const run =
        await cancelSeoAudit(
          session.shop,
          runId,
        );

      return {
        ok: true,
        error: null,
        runId: run.id,
      };
    }

    return {
      ok: false,
      error:
        "Unknown SEO audit action.",
      runId: null,
    };
  } catch (error) {
    console.error(
      "SEO audit admin action failed",
      {
        shop: session.shop,
        intent,
        runId:
          runId || null,
        error,
      },
    );

    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "SEO audit action failed.",
      runId: null,
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

function formatDate(
  value:
    | string
    | Date
    | null
    | undefined,
) {
  if (!value) {
    return "—";
  }

  return new Date(
    value,
  ).toLocaleString();
}

export default function SeoAudit() {
  const {
    shopReady,
    shopDomain,
    primaryDomain,
    indexableProducts,
    latestRun,
    recentPages,
    issuePages,
    issuePageCount,
  } = useLoaderData<
    typeof loader
  >();

  const fetcher =
    useFetcher<
      typeof action
    >();

  const busy =
    fetcher.state !== "idle";

  const terminal =
    latestRun
      ? [
          "COMPLETED",
          "CANCELLED",
        ].includes(
          latestRun.status,
        )
      : false;

  const canStart =
    shopReady &&
    (!latestRun || terminal);

  const canContinue =
    Boolean(
      latestRun &&
        [
          "PENDING",
          "PAUSED",
          "FAILED",
        ].includes(
          latestRun.status,
        ),
    );

  const canPause =
    Boolean(
      latestRun &&
        [
          "PENDING",
          "RUNNING",
        ].includes(
          latestRun.status,
        ),
    );

  const canCancel =
    Boolean(
      latestRun &&
        !terminal,
    );

  const progressPercent =
    latestRun &&
    indexableProducts > 0
      ? Math.min(
          100,
          Math.round(
            (
              latestRun.pagesProcessed /
              indexableProducts
            ) * 100,
          ),
        )
      : 0;

  const copyRunId = () => {
    if (!latestRun) {
      return;
    }

    void navigator.clipboard?.writeText(
      latestRun.id,
    );
  };

  return (
    <s-page heading="SEO Audit">
      <s-section heading="Read-only storefront audit">
        <s-paragraph>
          Runn audits the server-returned
          storefront HTML without changing
          products, theme, structured
          data, redirects, sitemaps or
          IndexNow configuration.
        </s-paragraph>

        <s-paragraph>
          Client-side-only markup is not
          browser-rendered in this phase
          and may require a later rendered
          audit for complete coverage.
        </s-paragraph>

        <s-unordered-list>
          <s-list-item>
            Shopify shop: {shopDomain}
          </s-list-item>

          <s-list-item>
            Primary domain:{" "}
            {primaryDomain ??
              "Not discovered"}
          </s-list-item>

          <s-list-item>
            Eligible product URLs:{" "}
            {indexableProducts.toLocaleString()}
          </s-list-item>

          <s-list-item>
            Execution mode:
            read-only
          </s-list-item>
        </s-unordered-list>

        {!shopReady ? (
          <s-paragraph>
            SEO Audit cannot start
            until this shop has a
            discovered primary domain.
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Audit controls">
        <s-paragraph>
          Starting an audit creates
          durable audit state. The
          bounded SEO Audit worker
          processes the actual
          storefront pages separately.
        </s-paragraph>

        <s-stack
          direction="inline"
          gap="base"
        >
          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="start"
            />

            <button
              type="submit"
              disabled={
                busy ||
                !canStart
              }
            >
              Start new audit
            </button>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="continue"
            />

            <input
              type="hidden"
              name="runId"
              value={
                latestRun?.id ?? ""
              }
            />

            <button
              type="submit"
              disabled={
                busy ||
                !canContinue
              }
            >
              Continue / resume
            </button>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="pause"
            />

            <input
              type="hidden"
              name="runId"
              value={
                latestRun?.id ?? ""
              }
            />

            <button
              type="submit"
              disabled={
                busy ||
                !canPause
              }
            >
              Pause
            </button>
          </fetcher.Form>

          <fetcher.Form method="post">
            <input
              type="hidden"
              name="intent"
              value="cancel"
            />

            <input
              type="hidden"
              name="runId"
              value={
                latestRun?.id ?? ""
              }
            />

            <button
              type="submit"
              disabled={
                busy ||
                !canCancel
              }
            >
              Cancel
            </button>
          </fetcher.Form>
        </s-stack>

        {fetcher.data?.error ? (
          <s-paragraph>
            {fetcher.data.error}
          </s-paragraph>
        ) : null}
      </s-section>

      <s-section heading="Latest audit">
        {!latestRun ? (
          <s-paragraph>
            No SEO audit has been
            created for this shop yet.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="base"
          >
            <s-unordered-list>
              <s-list-item>
                Status:{" "}
                {latestRun.status}
              </s-list-item>

              <s-list-item>
                Audit run ID:{" "}
                {latestRun.id}{" "}
                <button
                  type="button"
                  onClick={copyRunId}
                >
                  Copy
                </button>
              </s-list-item>

              <s-list-item>
                Progress:{" "}
                {latestRun.pagesProcessed.toLocaleString()}
                {" / "}
                {indexableProducts.toLocaleString()}
                {" "}
                ({progressPercent}%)
              </s-list-item>

              <s-list-item>
                Started:{" "}
                {formatDate(
                  latestRun.startedAt,
                )}
              </s-list-item>

              <s-list-item>
                Last progress:{" "}
                {formatDate(
                  latestRun.lastProgressAt,
                )}
              </s-list-item>

              <s-list-item>
                Completed:{" "}
                {formatDate(
                  latestRun.completedAt,
                )}
              </s-list-item>
            </s-unordered-list>

            {latestRun.errorMessage ? (
              <s-paragraph>
                Last run error:{" "}
                {latestRun.errorMessage}
              </s-paragraph>
            ) : null}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Audit totals">
        <s-stack
          direction="inline"
          gap="base"
        >
          <Metric
            label="Processed"
            value={
              latestRun?.pagesProcessed ??
              0
            }
          />

          <Metric
            label="Succeeded"
            value={
              latestRun?.pagesSucceeded ??
              0
            }
          />

          <Metric
            label="Failed"
            value={
              latestRun?.pagesFailed ??
              0
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="SEO issue severity">
        <s-stack
          direction="inline"
          gap="base"
        >
          <Metric
            label="Critical"
            value={
              latestRun?.criticalCount ??
              0
            }
          />

          <Metric
            label="High"
            value={
              latestRun?.highCount ??
              0
            }
          />

          <Metric
            label="Medium"
            value={
              latestRun?.mediumCount ??
              0
            }
          />

          <Metric
            label="Low"
            value={
              latestRun?.lowCount ??
              0
            }
          />

          <Metric
            label="Info"
            value={
              latestRun?.infoCount ??
              0
            }
          />
        </s-stack>
      </s-section>

      <s-section heading="Products with SEO issues">
        {issuePages.length === 0 ? (
          <s-paragraph>
            No SEO issues have been
            recorded in the latest run.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="small-300"
          >
            <s-paragraph>
              Showing{" "}
              {issuePages.length.toLocaleString()}
              {" of "}
              {issuePageCount.toLocaleString()}
              {" "}
              audited product pages with
              one or more SEO issues.
            </s-paragraph>

            {issuePages.map((page) => (
              <s-box
                key={page.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack
                  direction="block"
                  gap="small-200"
                >
                  <s-heading>
                    {page.title ??
                      "Untitled product"}
                  </s-heading>

                  <s-paragraph>
                    {page.finalUrl ??
                      page.requestedUrl}
                  </s-paragraph>

                  <s-unordered-list>
                    <s-list-item>
                      HTTP: {page.statusCode ??
                        "No response"}
                    </s-list-item>

                    <s-list-item>
                      Severity totals:{" "}
                      Critical {page.criticalCount},
                      {" "}High {page.highCount},
                      {" "}Medium {page.mediumCount},
                      {" "}Low {page.lowCount},
                      {" "}Info {page.infoCount}
                    </s-list-item>

                    <s-list-item>
                      Audited: {formatDate(
                        page.auditedAt,
                      )}
                    </s-list-item>
                  </s-unordered-list>

                  {page.issues.length > 0 ? (
                    <s-unordered-list>
                      {page.issues.map(
                        (issue, index) => (
                          <s-list-item
                            key={`${page.id}-${issue.code}-${String(index)}`}
                          >
                            {issue.severity}: {issue.code}
                            {issue.message
                              ? ` — ${issue.message}`
                              : ""}
                          </s-list-item>
                        ),
                      )}
                    </s-unordered-list>
                  ) : (
                    <s-paragraph>
                      Issue details could not
                      be decoded; severity
                      totals are shown above.
                    </s-paragraph>
                  )}

                  {page.error ? (
                    <s-paragraph>
                      Audit error: {page.error}
                    </s-paragraph>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Recent audited products">
        {recentPages.length === 0 ? (
          <s-paragraph>
            No storefront pages have
            been audited in the latest
            run yet.
          </s-paragraph>
        ) : (
          <s-stack
            direction="block"
            gap="small-300"
          >
            {recentPages.map(
              (page) => {
                const issueTotal =
                  page.criticalCount +
                  page.highCount +
                  page.mediumCount +
                  page.lowCount +
                  page.infoCount;

                return (
                  <s-box
                    key={page.id}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                  >
                    <s-stack
                      direction="block"
                      gap="small-200"
                    >
                      <s-heading>
                        {page.title ??
                          "Untitled product"}
                      </s-heading>

                      <s-paragraph>
                        {page.finalUrl ??
                          page.requestedUrl}
                      </s-paragraph>

                      <s-unordered-list>
                        <s-list-item>
                          HTTP:{" "}
                          {page.statusCode ??
                            "No response"}
                        </s-list-item>

                        <s-list-item>
                          Canonical:{" "}
                          {page.canonicalUrl ??
                            "Missing"}
                        </s-list-item>

                        <s-list-item>
                          Noindex:{" "}
                          {page.noindex ===
                          null
                            ? "Unknown"
                            : page.noindex
                              ? "Yes"
                              : "No"}
                        </s-list-item>

                        <s-list-item>
                          JSON-LD scripts:{" "}
                          {page.jsonLdScriptCount}
                        </s-list-item>

                        <s-list-item>
                          Schema types:{" "}
                          {page.schemaTypes
                            .length > 0
                            ? page.schemaTypes.join(
                                ", ",
                              )
                            : "None detected"}
                        </s-list-item>

                        <s-list-item>
                          Issues:{" "}
                          {issueTotal}
                        </s-list-item>

                        <s-list-item>
                          Audited:{" "}
                          {formatDate(
                            page.auditedAt,
                          )}
                        </s-list-item>
                      </s-unordered-list>

                      {page.error ? (
                        <s-paragraph>
                          Audit error:{" "}
                          {page.error}
                        </s-paragraph>
                      ) : null}
                    </s-stack>
                  </s-box>
                );
              },
            )}
          </s-stack>
        )}
      </s-section>

      <s-section
        slot="aside"
        heading="Structured Data"
      >
        <s-paragraph>
          The audit currently detects
          JSON-LD schema types,
          duplicate/conflicting product
          data, BreadcrumbList,
          Organization, Review,
          AggregateRating and related
          nodes.
        </s-paragraph>
      </s-section>

      <s-section
        slot="aside"
        heading="Safety"
      >
        <s-paragraph>
          This module is audit-only.
          autoSchema remains unchanged
          until the separate replacement
          gate has passed.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(
    useRouteError(),
  );
}

export const headers: HeadersFunction =
  (headersArgs) =>
    boundary.headers(
      headersArgs,
    );
