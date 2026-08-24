import prisma from "../app/db.server";
import { materializeProductPushPlanWithClient } from "../app/services/index-provider-materialization";
import { planProductPush } from "../app/services/index-provider-plan";
import {
  parseProviderMaterializationWorkerConfig,
  providerMaterializationIdentity,
  sourceNeedsIndexNowMaterialization,
} from "../app/services/index-provider-materialization-worker-control";

function log(
  event: string,
  details: Record<string, unknown> = {},
) {
  console.log(JSON.stringify({ event, ...details }));
}

function exactIndexNowPlan(
  source: {
    provider: "INTERNAL";
    action: "INDEX" | "DEINDEX";
    url: string | null;
  },
) {
  const plan = planProductPush({
    sourceProvider: source.provider,
    action: source.action,
    url: source.url,
  });

  if (plan.rejectionReason !== null) {
    return {
      plan,
      rejectionReason: plan.rejectionReason,
    } as const;
  }

  if (
    plan.targets.length !== 1 ||
    plan.targets[0].provider !== "INDEXNOW" ||
    plan.targets[0].action !== source.action
  ) {
    throw new Error(
      "Provider materialization worker expected exactly one INDEXNOW target",
    );
  }

  return {
    plan,
    rejectionReason: null,
  } as const;
}

async function main() {
  const config =
    parseProviderMaterializationWorkerConfig(process.env);

  if (!config.enabled) {
    log("provider_materialization_worker_disabled");
    return;
  }

  const shop = await prisma.shop.findUnique({
    where: {
      domain: config.shopDomain,
    },
    select: {
      id: true,
      domain: true,
      primaryDomain: true,
    },
  });

  if (!shop) {
    throw new Error(
      "PROVIDER_MATERIALIZATION_SHOP_DOMAIN did not match a configured shop",
    );
  }

  log("provider_materialization_worker_started", {
    dryRun: config.dryRun,
    shopDomain: shop.domain,
    maxItems: config.maxItems,
    pageSize: config.pageSize,
    maxScanned: config.maxScanned,
    targetProvider: "INDEXNOW",
  });

  const eligibleBefore = new Date();

  let cursorId: string | undefined;
  let scanned = 0;
  let candidates = 0;
  let materialized = 0;
  let created = 0;
  let refreshed = 0;
  let skippedCurrent = 0;
  let skippedChanged = 0;
  let rejected = 0;

  while (
    candidates < config.maxItems &&
    scanned < config.maxScanned
  ) {
    const remainingScan =
      config.maxScanned - scanned;

    const take = Math.min(
      config.pageSize,
      remainingScan,
    );

    const page =
      await prisma.indexQueueItem.findMany({
        where: {
          shopId: shop.id,
          provider: "INTERNAL",
          status: "PENDING",
          url: {
            not: null,
          },
          nextAttemptAt: {
            lte: eligibleBefore,
          },
        },
        orderBy: [
          {
            nextAttemptAt: "asc",
          },
          {
            createdAt: "asc",
          },
          {
            id: "asc",
          },
        ],
        take,
        ...(cursorId
          ? {
              cursor: {
                id: cursorId,
              },
              skip: 1,
            }
          : {}),
      });

    if (page.length === 0) break;

    cursorId = page[page.length - 1].id;
    scanned += page.length;

    const productGids = [
      ...new Set(
        page.map(
          (source) =>
            source.shopifyProductGid,
        ),
      ),
    ];

    const targets =
      await prisma.indexQueueItem.findMany({
        where: {
          shopId: shop.id,
          provider: "INDEXNOW",
          shopifyProductGid: {
            in: productGids,
          },
        },
        select: {
          shopifyProductGid: true,
          action: true,
          updatedAt: true,
        },
        orderBy: [
          {
            updatedAt: "desc",
          },
        ],
      });

    const latestTargetByIdentity =
      new Map<string, Date>();

    for (const target of targets) {
      const identity =
        providerMaterializationIdentity(
          target.shopifyProductGid,
          target.action,
        );

      if (
        !latestTargetByIdentity.has(identity)
      ) {
        latestTargetByIdentity.set(
          identity,
          target.updatedAt,
        );
      }
    }

    for (const source of page) {
      if (candidates >= config.maxItems) {
        break;
      }

      const identity =
        providerMaterializationIdentity(
          source.shopifyProductGid,
          source.action,
        );

      const latestTargetUpdatedAt =
        latestTargetByIdentity.get(identity);

      if (
        !sourceNeedsIndexNowMaterialization(
          source.updatedAt,
          latestTargetUpdatedAt,
        )
      ) {
        skippedCurrent += 1;
        continue;
      }

      if (
        source.provider !== "INTERNAL"
      ) {
        throw new Error(
          "Provider materialization worker selected a non-INTERNAL source",
        );
      }

      const planned = exactIndexNowPlan({
        provider: source.provider,
        action: source.action,
        url: source.url,
      });

      if (planned.rejectionReason) {
        rejected += 1;

        log(
          "provider_materialization_source_rejected",
          {
            sourceQueueItemId: source.id,
            shopifyProductGid:
              source.shopifyProductGid,
            action: source.action,
            rejectionReason:
              planned.rejectionReason,
          },
        );

        continue;
      }

      candidates += 1;

      if (config.dryRun) {
        log(
          "provider_materialization_candidate",
          {
            sourceQueueItemId: source.id,
            shopifyProductGid:
              source.shopifyProductGid,
            action: source.action,
            targetProvider: "INDEXNOW",
          },
        );

        continue;
      }

      const outcome =
        await prisma.$transaction(
          async (tx) => {
            const current =
              await tx.indexQueueItem.findUnique({
                where: {
                  id: source.id,
                },
              });

            if (
              !current ||
              current.provider !== "INTERNAL" ||
              current.status !== "PENDING" ||
              current.shopId !== shop.id
            ) {
              return {
                outcome: "source_changed",
              } as const;
            }

            const latestTarget =
              await tx.indexQueueItem.findFirst({
                where: {
                  shopId: current.shopId,
                  shopifyProductGid:
                    current.shopifyProductGid,
                  provider: "INDEXNOW",
                  action: current.action,
                },
                orderBy: [
                  {
                    updatedAt: "desc",
                  },
                ],
                select: {
                  updatedAt: true,
                },
              });

            if (
              !sourceNeedsIndexNowMaterialization(
                current.updatedAt,
                latestTarget?.updatedAt,
              )
            ) {
              return {
                outcome: "already_current",
              } as const;
            }

            const freshPlan =
              exactIndexNowPlan({
                provider: current.provider,
                action: current.action,
                url: current.url,
              });

            if (freshPlan.rejectionReason) {
              return {
                outcome: "rejected",
                rejectionReason:
                  freshPlan.rejectionReason,
              } as const;
            }

            const result =
              await materializeProductPushPlanWithClient(
                tx,
                {
                  source: {
                    id: current.id,
                    shopId: current.shopId,
                    productIndexStateId:
                      current.productIndexStateId,
                    shopifyProductGid:
                      current.shopifyProductGid,
                    provider: current.provider,
                    action: current.action,
                    url: current.url,
                    reason: current.reason,
                  },
                  plan: freshPlan.plan,
                },
              );

            return {
              outcome: "materialized",
              result,
            } as const;
          },
          {
            isolationLevel: "Serializable",
          },
        );

      if (
        outcome.outcome ===
        "source_changed"
      ) {
        skippedChanged += 1;
        candidates -= 1;
        continue;
      }

      if (
        outcome.outcome ===
        "already_current"
      ) {
        skippedCurrent += 1;
        candidates -= 1;
        continue;
      }

      if (
        outcome.outcome === "rejected"
      ) {
        rejected += 1;
        candidates -= 1;

        log(
          "provider_materialization_source_rejected",
          {
            sourceQueueItemId: source.id,
            shopifyProductGid:
              source.shopifyProductGid,
            action: source.action,
            rejectionReason:
              outcome.rejectionReason,
          },
        );

        continue;
      }

      materialized += 1;

      for (
        const target of
        outcome.result.targets
      ) {
        if (
          target.provider !== "INDEXNOW"
        ) {
          throw new Error(
            "Materialization worker produced a non-INDEXNOW target",
          );
        }

        if (
          target.outcome === "CREATED"
        ) {
          created += 1;
        } else {
          refreshed += 1;
        }
      }

      log(
        "provider_materialization_completed",
        {
          sourceQueueItemId: source.id,
          shopifyProductGid:
            source.shopifyProductGid,
          action: source.action,
          targetProvider: "INDEXNOW",
          targetOutcome:
            outcome.result.targets[0]
              ?.outcome ?? null,
        },
      );
    }
  }

  log(
    "provider_materialization_worker_stopped",
    {
      dryRun: config.dryRun,
      shopDomain: shop.domain,
      scanned,
      candidates,
      materialized,
      created,
      refreshed,
      skippedCurrent,
      skippedChanged,
      rejected,
      maxItems: config.maxItems,
      maxScanned: config.maxScanned,
      targetProvider: "INDEXNOW",
    },
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        event:
          "provider_materialization_worker_failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown provider materialization worker failure",
      }),
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });