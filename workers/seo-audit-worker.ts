import prisma from "../app/db.server";
import {
  markSeoAuditFailed,
  resumeSeoAudit,
  runNextSeoAuditBatch,
} from "../app/services/seo-audit/seo-audit-run.server";

let stopRequested = false;

function log(
  event: string,
  details: Record<string, unknown> = {},
) {
  console.log(
    JSON.stringify({
      event,
      ...details,
    }),
  );
}

function requestStop(signal: string) {
  stopRequested = true;

  log(
    "seo_audit_worker_shutdown_requested",
    { signal },
  );
}

process.on(
  "SIGTERM",
  () => requestStop("SIGTERM"),
);

process.on(
  "SIGINT",
  () => requestStop("SIGINT"),
);

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  const parsed =
    value === undefined
      ? defaultValue
      : Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Invalid integer config: ${value}`,
    );
  }

  return parsed;
}

async function resolveRun() {
  const runId =
    process.env.SEO_AUDIT_RUN_ID?.trim();

  if (runId) {
    const run =
      await prisma.seoAuditRun.findUnique({
        where: {
          id: runId,
        },
        include: {
          shop: true,
        },
      });

    if (!run) {
      throw new Error(
        `SEO_AUDIT_RUN_ID not found: ${runId}`,
      );
    }

    return run;
  }

  const shopDomain =
    process.env
      .SEO_AUDIT_SHOP_DOMAIN
      ?.trim();

  if (shopDomain) {
    const shop =
      await prisma.shop.findUnique({
        where: {
          domain:
            shopDomain,
        },
      });

    if (!shop) {
      throw new Error(
        `SEO_AUDIT_SHOP_DOMAIN not found: ${shopDomain}`,
      );
    }

    return prisma.seoAuditRun.findFirst({
      where: {
        shopId:
          shop.id,
        activeKey: {
          not: null,
        },
      },
      orderBy: {
        createdAt:
          "desc",
      },
      include: {
        shop: true,
      },
    });
  }

  const eligible =
    await prisma.seoAuditRun.findMany({
      where: {
        status: {
          in: [
            "PENDING",
            "RUNNING",
            "FAILED",
          ],
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 2,
      include: {
        shop: true,
      },
    });

  if (eligible.length === 0) {
    return null;
  }

  if (eligible.length > 1) {
    throw new Error(
      "Multiple eligible SEO audit runs exist; set SEO_AUDIT_RUN_ID or SEO_AUDIT_SHOP_DOMAIN",
    );
  }

  return eligible[0];
}

async function main() {
  const batchSize =
    parseInteger(
      process.env
        .SEO_AUDIT_BATCH_SIZE,
      10,
      1,
      25,
    );

  const maxBatches =
    parseInteger(
      process.env
        .SEO_AUDIT_MAX_BATCHES,
      1,
      1,
      100,
    );

  const interPageDelayMs =
    parseInteger(
      process.env
        .SEO_AUDIT_INTER_PAGE_DELAY_MS,
      250,
      0,
      5_000,
    );

  const selected =
    await resolveRun();

  if (!selected) {
    log(
      "seo_audit_worker_no_eligible_run",
    );
    return;
  }

  const runId =
    selected.id;

  const shopDomain =
    selected.shop.domain;

  let batchesExecuted = 0;

  log(
    "seo_audit_worker_started",
    {
      runId,
      shop:
        shopDomain,
      batchSize,
      maxBatches,
      interPageDelayMs,
    },
  );

  if (
    selected.status === "PENDING" ||
    selected.status === "FAILED"
  ) {
    await resumeSeoAudit(
      shopDomain,
      runId,
    );
  }

  try {
    while (
      !stopRequested &&
      batchesExecuted < maxBatches
    ) {
      const current =
        await prisma.seoAuditRun.findUniqueOrThrow({
          where: {
            id: runId,
          },
        });

      if (
        current.status === "COMPLETED" ||
        current.status === "CANCELLED" ||
        current.status === "PAUSED"
      ) {
        log(
          "seo_audit_worker_stopped_for_status",
          {
            runId,
            shop:
              shopDomain,
            status:
              current.status,
          },
        );

        return;
      }

      const result =
        await runNextSeoAuditBatch({
          shopDomain,
          runId,
          batchSize,
          interPageDelayMs,
        });

      batchesExecuted += 1;

      log(
        "seo_audit_worker_progress",
        {
          runId,
          shop:
            shopDomain,
          status:
            result.status,
          pagesProcessed:
            result.pagesProcessed,
          pagesSucceeded:
            result.pagesSucceeded,
          pagesFailed:
            result.pagesFailed,
          criticalCount:
            result.criticalCount,
          highCount:
            result.highCount,
          mediumCount:
            result.mediumCount,
          lowCount:
            result.lowCount,
          infoCount:
            result.infoCount,
          cursorProductGid:
            result.cursorProductGid,
          batchesExecuted,
        },
      );

      if (
        result.status ===
        "COMPLETED"
      ) {
        log(
          "seo_audit_worker_completed",
          {
            runId,
            shop:
              shopDomain,
            pagesProcessed:
              result.pagesProcessed,
            pagesSucceeded:
              result.pagesSucceeded,
            pagesFailed:
              result.pagesFailed,
            batchesExecuted,
          },
        );

        return;
      }
    }

    if (stopRequested) {
      log(
        "seo_audit_worker_stopped_after_checkpoint",
        {
          runId,
          shop:
            shopDomain,
          batchesExecuted,
        },
      );

      return;
    }

    log(
      "seo_audit_worker_safety_ceiling_reached",
      {
        runId,
        shop:
          shopDomain,
        batchesExecuted,
        maxBatches,
      },
    );
  } catch (error) {
    await markSeoAuditFailed(
      runId,
      error,
    );

    throw error;
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        event:
          "seo_audit_worker_failed",

        error:
          error instanceof Error
            ? error.message
            : "Unknown SEO audit worker failure",
      }),
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });