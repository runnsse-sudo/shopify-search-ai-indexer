import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../db.server";
import { auditHtml, type SeoAuditIssue } from "./html-audit";
import { fetchStorefrontPage } from "./storefront-fetch.server";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;
const DEFAULT_INTER_PAGE_DELAY_MS = 250;
const MAX_INTER_PAGE_DELAY_MS = 5_000;
const BATCH_LEASE_MS = 10 * 60 * 1000;

type SeverityCounts = {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
};

function emptyCounts(): SeverityCounts {
  return {
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
  };
}

function countIssues(issues: SeoAuditIssue[]): SeverityCounts {
  const counts = emptyCounts();

  for (const issue of issues) {
    if (issue.severity === "CRITICAL") counts.criticalCount += 1;
    if (issue.severity === "HIGH") counts.highCount += 1;
    if (issue.severity === "MEDIUM") counts.mediumCount += 1;
    if (issue.severity === "LOW") counts.lowCount += 1;
    if (issue.severity === "INFO") counts.infoCount += 1;
  }

  return counts;
}


function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function activeKey(shopId: string) {
  return `SEO_AUDIT:${shopId}`;
}

function clampBatchSize(value?: number) {
  return Math.min(
    Math.max(
      Number.isFinite(value)
        ? Math.trunc(value!)
        : DEFAULT_BATCH_SIZE,
      1,
    ),
    MAX_BATCH_SIZE,
  );
}

function clampInterPageDelay(value?: number) {
  return Math.min(
    Math.max(
      Number.isFinite(value)
        ? Math.trunc(value!)
        : DEFAULT_INTER_PAGE_DELAY_MS,
      0,
    ),
    MAX_INTER_PAGE_DELAY_MS,
  );
}

async function delay(ms: number) {
  if (ms <= 0) return;

  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function startSeoAudit(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    throw new Error("SEO_AUDIT_SHOP_NOT_FOUND");
  }

  if (!shop.primaryDomain) {
    throw new Error("SEO_AUDIT_PRIMARY_DOMAIN_MISSING");
  }

  const key = activeKey(shop.id);

  return prisma.seoAuditRun.upsert({
    where: { activeKey: key },
    create: {
      shopId: shop.id,
      activeKey: key,
      status: "PENDING",
    },
    update: {},
  });
}

async function getOwnedRun(
  shopDomain: string,
  runId: string,
) {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
  });

  if (!shop) {
    throw new Error("SEO_AUDIT_SHOP_NOT_FOUND");
  }

  const run = await prisma.seoAuditRun.findFirst({
    where: {
      id: runId,
      shopId: shop.id,
    },
  });

  if (!run) {
    throw new Error("SEO_AUDIT_RUN_NOT_FOUND");
  }

  return { shop, run };
}

export async function resumeSeoAudit(
  shopDomain: string,
  runId: string,
) {
  const { shop, run } =
    await getOwnedRun(shopDomain, runId);

  if (
    run.status === "COMPLETED" ||
    run.status === "CANCELLED"
  ) {
    return run;
  }

  return prisma.seoAuditRun.update({
    where: { id: run.id },
    data: {
      status: "RUNNING",
      activeKey: activeKey(shop.id),
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
  });
}

export async function pauseSeoAudit(
  shopDomain: string,
  runId: string,
) {
  const { run } =
    await getOwnedRun(shopDomain, runId);

  if (
    run.status !== "PENDING" &&
    run.status !== "RUNNING"
  ) {
    return run;
  }

  return prisma.seoAuditRun.update({
    where: { id: run.id },
    data: {
      status: "PAUSED",
      batchToken: null,
      batchClaimedAt: null,
    },
  });
}

export async function cancelSeoAudit(
  shopDomain: string,
  runId: string,
) {
  const { run } =
    await getOwnedRun(shopDomain, runId);

  if (
    run.status === "COMPLETED" ||
    run.status === "CANCELLED"
  ) {
    return run;
  }

  return prisma.seoAuditRun.update({
    where: { id: run.id },
    data: {
      status: "CANCELLED",
      activeKey: null,
      batchToken: null,
      batchClaimedAt: null,
      completedAt: new Date(),
    },
  });
}

export async function markSeoAuditFailed(
  runId: string,
  error: unknown,
) {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown SEO audit failure";

  return prisma.seoAuditRun.updateMany({
    where: {
      id: runId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    data: {
      status: "FAILED",
      batchToken: null,
      batchClaimedAt: null,
      errorMessage: message.slice(0, 4_000),
    },
  });
}

export async function runNextSeoAuditBatch(input: {
  shopDomain: string;
  runId: string;
  batchSize?: number;
  interPageDelayMs?: number;
}) {
  const { shop, run } =
    await getOwnedRun(
      input.shopDomain,
      input.runId,
    );

  if (
    run.status !== "PENDING" &&
    run.status !== "RUNNING"
  ) {
    return run;
  }

  if (!shop.primaryDomain) {
    throw new Error(
      "SEO_AUDIT_PRIMARY_DOMAIN_MISSING",
    );
  }

  const batchSize =
    clampBatchSize(input.batchSize);

  const interPageDelayMs =
    clampInterPageDelay(
      input.interPageDelayMs,
    );

  const token = randomUUID();

  const claimed =
    await prisma.seoAuditRun.updateMany({
      where: {
        id: run.id,
        shopId: shop.id,
        status: {
          in: ["PENDING", "RUNNING"],
        },
        OR: [
          {
            batchToken: null,
          },
          {
            batchClaimedAt: {
              lt: new Date(
                Date.now() - BATCH_LEASE_MS,
              ),
            },
          },
        ],
      },
      data: {
        status: "RUNNING",
        startedAt:
          run.startedAt ?? new Date(),
        batchToken: token,
        batchClaimedAt: new Date(),
        errorMessage: null,
      },
    });

  if (claimed.count === 0) {
    return prisma.seoAuditRun.findUniqueOrThrow({
      where: { id: run.id },
    });
  }

  const products =
    await prisma.productIndexState.findMany({
      where: {
        shopId: shop.id,
        deletedAt: null,
        indexabilityState: "INDEXABLE",
        canonicalUrl: {
          not: null,
        },
        ...(run.cursorProductGid
          ? {
              shopifyProductGid: {
                gt: run.cursorProductGid,
              },
            }
          : {}),
      },
      orderBy: {
        shopifyProductGid: "asc",
      },
      take: batchSize + 1,
      select: {
        id: true,
        shopifyProductGid: true,
        canonicalUrl: true,
      },
    });

  const targets =
    products.slice(0, batchSize);

  const hasMore =
    products.length > batchSize;

  if (targets.length === 0) {
    return prisma.seoAuditRun.update({
      where: { id: run.id },
      data: {
        status: "COMPLETED",
        activeKey: null,
        batchToken: null,
        batchClaimedAt: null,
        completedAt: new Date(),
        lastProgressAt: new Date(),
      },
    });
  }



  for (
    let index = 0;
    index < targets.length;
    index += 1
  ) {
    const target = targets[index];

    const requestedUrl =
      target.canonicalUrl;

    if (!requestedUrl) {
      continue;
    }

    try {
      const fetched =
        await fetchStorefrontPage({
          url: requestedUrl,
          allowedHost: shop.primaryDomain,
        });

      const result =
        auditHtml({
          requestedUrl:
            fetched.requestedUrl,
          finalUrl:
            fetched.finalUrl,
          statusCode:
            fetched.statusCode,
          html:
            fetched.html,
          xRobotsTag:
            fetched.xRobotsTag,
          redirectChain:
            fetched.redirectChain,
          expectedPageType:
            "PRODUCT",
        });

      const counts =
        countIssues(result.issues);


      const nodeSummary =
        result.jsonLd.nodes.map(
          (node) => ({
            scriptIndex:
              node.scriptIndex,
            path:
              node.path,
            types:
              node.types,
            id:
              node.id,
            name:
              node.name,
            url:
              node.url,
            scriptId:
              node.scriptId,
            scriptClass:
              node.scriptClass,
            sourceHint:
              node.sourceHint,
          }),
        );

      await prisma.seoAuditPage.upsert({
        where: {
          runId_shopifyProductGid: {
            runId: run.id,
            shopifyProductGid:
              target.shopifyProductGid,
          },
        },
        create: {
          runId:
            run.id,
          shopId:
            shop.id,
          productIndexStateId:
            target.id,
          shopifyProductGid:
            target.shopifyProductGid,
          requestedUrl:
            result.requestedUrl,
          finalUrl:
            result.finalUrl,
          statusCode:
            result.statusCode,
          redirectChain:
            asJson(result.redirectChain),
          title:
            result.title,
          metaDescription:
            result.metaDescription,
          h1Count:
            result.h1Count,
          canonicalUrl:
            result.canonicalUrl,
          canonicalLinks:
            asJson(result.canonicalLinks),
          robotsMeta:
            asJson(result.robotsMeta),
          xRobotsTag:
            result.xRobotsTag,
          noindex:
            result.noindex,
          jsonLdScriptCount:
            result.jsonLd.scriptCount,
          jsonLdTypeCounts:
            asJson(
              result.jsonLd.typeCounts,
            ),
          jsonLdNodes:
            asJson(nodeSummary),
          issues:
            asJson(result.issues),
          ...counts,
          error:
            null,
          auditedAt:
            new Date(),
        },
        update: {
          productIndexStateId:
            target.id,
          requestedUrl:
            result.requestedUrl,
          finalUrl:
            result.finalUrl,
          statusCode:
            result.statusCode,
          redirectChain:
            asJson(result.redirectChain),
          title:
            result.title,
          metaDescription:
            result.metaDescription,
          h1Count:
            result.h1Count,
          canonicalUrl:
            result.canonicalUrl,
          canonicalLinks:
            asJson(result.canonicalLinks),
          robotsMeta:
            asJson(result.robotsMeta),
          xRobotsTag:
            result.xRobotsTag,
          noindex:
            result.noindex,
          jsonLdScriptCount:
            result.jsonLd.scriptCount,
          jsonLdTypeCounts:
            asJson(
              result.jsonLd.typeCounts,
            ),
          jsonLdNodes:
            asJson(nodeSummary),
          issues:
            asJson(result.issues),
          ...counts,
          error:
            null,
          auditedAt:
            new Date(),
        },
      });


    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown storefront audit failure";

      const issue: SeoAuditIssue = {
        code:
          "STOREFRONT_FETCH_FAILED",
        severity:
          "HIGH",
        message:
          "Storefront page could not be audited.",
        details: {
          error:
            message.slice(0, 1_000),
        },
      };

      const counts =
        countIssues([issue]);


      await prisma.seoAuditPage.upsert({
        where: {
          runId_shopifyProductGid: {
            runId:
              run.id,
            shopifyProductGid:
              target.shopifyProductGid,
          },
        },
        create: {
          runId:
            run.id,
          shopId:
            shop.id,
          productIndexStateId:
            target.id,
          shopifyProductGid:
            target.shopifyProductGid,
          requestedUrl,
          issues:
            asJson([issue]),
          ...counts,
          error:
            message.slice(0, 4_000),
          auditedAt:
            new Date(),
        },
        update: {
          productIndexStateId:
            target.id,
          requestedUrl,
          finalUrl:
            null,
          statusCode:
            null,
          redirectChain:
            asJson([]),
          title:
            null,
          metaDescription:
            null,
          h1Count:
            null,
          canonicalUrl:
            null,
          canonicalLinks:
            asJson([]),
          robotsMeta:
            asJson([]),
          xRobotsTag:
            null,
          noindex:
            null,
          jsonLdScriptCount:
            0,
          jsonLdTypeCounts:
            asJson({}),
          jsonLdNodes:
            asJson([]),
          issues:
            asJson([issue]),
          ...counts,
          error:
            message.slice(0, 4_000),
          auditedAt:
            new Date(),
        },
      });


    }

    if (
      index < targets.length - 1
    ) {
      await delay(
        interPageDelayMs,
      );
    }
  }

  return prisma.$transaction(
    async (tx) => {
      const current =
        await tx.seoAuditRun.findUniqueOrThrow({
          where: {
            id: run.id,
          },
        });

      if (
        current.batchToken !== token
      ) {
        return current;
      }

      const persistedPages =
        await tx.seoAuditPage.findMany({
          where: {
            runId: run.id,
          },
          select: {
            error: true,
            criticalCount: true,
            highCount: true,
            mediumCount: true,
            lowCount: true,
            infoCount: true,
          },
        });

      const exactCounts =
        persistedPages.reduce<SeverityCounts>(
          (counts, page) => {
            counts.criticalCount +=
              page.criticalCount;

            counts.highCount +=
              page.highCount;

            counts.mediumCount +=
              page.mediumCount;

            counts.lowCount +=
              page.lowCount;

            counts.infoCount +=
              page.infoCount;

            return counts;
          },
          emptyCounts(),
        );

      const pagesSucceeded =
        persistedPages.filter(
          (page) => page.error === null,
        ).length;

      const pagesFailed =
        persistedPages.length -
        pagesSucceeded;

      const completed =
        !hasMore;

      return tx.seoAuditRun.update({
        where: {
          id: run.id,
        },
        data: {
          cursorProductGid:
            targets[
              targets.length - 1
            ].shopifyProductGid,

          pagesProcessed:
            persistedPages.length,

          pagesSucceeded,

          pagesFailed,

          criticalCount:
            exactCounts.criticalCount,

          highCount:
            exactCounts.highCount,

          mediumCount:
            exactCounts.mediumCount,

          lowCount:
            exactCounts.lowCount,

          infoCount:
            exactCounts.infoCount,

          lastProgressAt:
            new Date(),

          status:
            completed
              ? "COMPLETED"
              : "RUNNING",

          activeKey:
            completed
              ? null
              : current.activeKey,

          completedAt:
            completed
              ? new Date()
              : current.completedAt,

          batchToken:
            null,

          batchClaimedAt:
            null,
        },
      });
    },
  );
}