import { spawn } from "node:child_process";

import prisma from "../app/db.server";
import {
  getReadyIndexNowRuntimeConfig,
  listReadyIndexNowShopsForExecution,
  markIndexNowProviderRun,
} from "../app/services/indexnow-shop-config.server";
import {
  parseMultiShopIndexNowConfig,
} from "../app/services/multishop-provider-worker-control";
import {
  acquireProviderAutomationLease,
  releaseProviderAutomationLease,
} from "../app/services/provider-automation-lease.server";
import {
  parseProviderConfigMasterKey,
} from "../app/services/provider-config-crypto";

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
            "./build-workers/indexnow-worker.mjs",
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
              `Single-shop IndexNow worker failed with code=${code ?? "null"} signal=${signal ?? "null"}`,
            ),
          );
        },
      );
    },
  );
}

async function main() {
  const config =
    parseMultiShopIndexNowConfig(
      process.env,
    );

  if (!config.enabled) {
    log(
      "indexnow_multishop_worker_disabled",
    );

    return;
  }

  // Fail before any tenant credential access.
  parseProviderConfigMasterKey(
    process.env
      .PROVIDER_CONFIG_MASTER_KEY,
  );

  const lease =
    await acquireProviderAutomationLease(
      "indexnow-multishop",
      30 * 60 * 1000,
    );

  if (!lease) {
    log(
      "indexnow_multishop_worker_locked",
    );

    return;
  }

  try {
    const shops =
      await listReadyIndexNowShopsForExecution(
        config.maxShops,
      );

    log(
      "indexnow_multishop_worker_started",
      {
        readyShops:
          shops.length,

        maxShops:
          config.maxShops,

        maxItemsPerShop:
          config.maxItemsPerShop,

        interItemDelayMs:
          config.interItemDelayMs,
      },
    );

    let completedShops = 0;
    let skippedShops = 0;

    for (
      let index = 0;
      index < shops.length;
      index += 1
    ) {
      const selectedShop =
        shops[index];

      // Decrypt only this tenant's credential.
      const shop =
        await getReadyIndexNowRuntimeConfig(
          selectedShop.shopId,
          process.env,
        );

      if (!shop) {
        skippedShops += 1;

        log(
          "indexnow_multishop_shop_skipped",
          {
            shopId:
              selectedShop.shopId,

            shopDomain:
              selectedShop.domain,

            reason:
              "SHOP_NO_LONGER_READY",
          },
        );

        continue;
      }

      log(
        "indexnow_multishop_shop_started",
        {
          shopId:
            shop.shopId,

          shopDomain:
            shop.domain,

          allowedHost:
            shop.allowedHost,
        },
      );

      await runSingleShopWorker({
        ...process.env,

        INDEXNOW_EXECUTION_ENABLED:
          "true",

        INDEXNOW_KEY:
          shop.key,

        INDEXNOW_KEY_LOCATION:
          shop.keyLocation,

        INDEXNOW_SHOP_DOMAIN:
          shop.domain,

        INDEXNOW_ALLOWED_HOST:
          shop.allowedHost,

        INDEXNOW_MAX_ITEMS:
          String(
            config.maxItemsPerShop,
          ),

        INDEXNOW_INTER_ITEM_DELAY_MS:
          String(
            config.interItemDelayMs,
          ),
      });

      await markIndexNowProviderRun(
        shop.shopId,
      );

      completedShops += 1;

      log(
        "indexnow_multishop_shop_completed",
        {
          shopId:
            shop.shopId,

          shopDomain:
            shop.domain,

          allowedHost:
            shop.allowedHost,
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
      "indexnow_multishop_worker_stopped",
      {
        readyShops:
          shops.length,

        completedShops,

        skippedShops,
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
          "indexnow_multishop_worker_failed",

        error:
          error instanceof Error
            ? error.message
            : "Unknown multi-shop IndexNow failure",
      }),
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });