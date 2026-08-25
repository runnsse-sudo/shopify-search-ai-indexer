import { spawn } from "node:child_process";

import prisma from "../app/db.server";
import {
  listReadyIndexNowShopsForMaterialization,
  markIndexNowMaterializationRun,
} from "../app/services/indexnow-shop-config.server";
import {
  parseMultiShopMaterializationConfig,
} from "../app/services/multishop-provider-worker-control";
import {
  acquireProviderAutomationLease,
  releaseProviderAutomationLease,
} from "../app/services/provider-automation-lease.server";

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

async function delay(
  ms: number,
) {
  if (ms <= 0) return;

  await new Promise<void>(
    (resolve) => {
      setTimeout(
        resolve,
        ms,
      );
    },
  );
}

async function runSingleShopWorker(
  env: NodeJS.ProcessEnv,
) {
  await new Promise<void>(
    (resolve, reject) => {
      const child =
        spawn(
          process.execPath,
          [
            "./build-workers/provider-materialization-worker.mjs",
          ],
          {
            cwd:
              process.cwd(),

            env,

            stdio:
              "inherit",

            shell:
              false,
          },
        );

      child.once(
        "error",
        reject,
      );

      child.once(
        "exit",
        (
          code,
          signal,
        ) => {
          if (
            code === 0 &&
            signal === null
          ) {
            resolve();
            return;
          }

          reject(
            new Error(
              `Single-shop materialization worker failed with code=${code ?? "null"} signal=${signal ?? "null"}`,
            ),
          );
        },
      );
    },
  );
}

async function main() {
  const config =
    parseMultiShopMaterializationConfig(
      process.env,
    );

  if (!config.enabled) {
    log(
      "provider_materialization_multishop_disabled",
    );

    return;
  }

  const lease =
    await acquireProviderAutomationLease(
      "provider-materialization-multishop",
      30 * 60 * 1000,
    );

  if (!lease) {
    log(
      "provider_materialization_multishop_locked",
    );

    return;
  }

  try {
    const shops =
      await listReadyIndexNowShopsForMaterialization(
        config.maxShops,
      );

    log(
      "provider_materialization_multishop_started",
      {
        dryRun:
          config.dryRun,

        readyShops:
          shops.length,

        maxShops:
          config.maxShops,

        maxItemsPerShop:
          config.maxItemsPerShop,
      },
    );

    let completedShops = 0;

    for (
      let index = 0;
      index < shops.length;
      index += 1
    ) {
      const shop =
        shops[index];

      log(
        "provider_materialization_multishop_shop_started",
        {
          shopId:
            shop.shopId,

          shopDomain:
            shop.domain,

          dryRun:
            config.dryRun,
        },
      );

      await runSingleShopWorker({
        ...process.env,

        PROVIDER_MATERIALIZATION_ENABLED:
          "true",

        PROVIDER_MATERIALIZATION_DRY_RUN:
          config.dryRun
            ? "true"
            : "false",

        PROVIDER_MATERIALIZATION_SHOP_DOMAIN:
          shop.domain,

        PROVIDER_MATERIALIZATION_MAX_ITEMS:
          String(
            config.maxItemsPerShop,
          ),

        PROVIDER_MATERIALIZATION_PAGE_SIZE:
          String(
            config.pageSize,
          ),

        PROVIDER_MATERIALIZATION_MAX_SCANNED:
          String(
            config.maxScannedPerShop,
          ),
      });

      await markIndexNowMaterializationRun(
        shop.shopId,
      );

      completedShops += 1;

      log(
        "provider_materialization_multishop_shop_completed",
        {
          shopId:
            shop.shopId,

          shopDomain:
            shop.domain,

          dryRun:
            config.dryRun,
        },
      );

      if (
        index <
        shops.length - 1
      ) {
        await delay(
          config.interShopDelayMs,
        );
      }
    }

    log(
      "provider_materialization_multishop_stopped",
      {
        dryRun:
          config.dryRun,

        readyShops:
          shops.length,

        completedShops,
      },
    );
  } finally {
    await releaseProviderAutomationLease(
      lease,
    );
  }
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        event:
          "provider_materialization_multishop_failed",

        error:
          error instanceof Error
            ? error.message
            : "Unknown multi-shop materialization failure",
      }),
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });