import assert from "node:assert/strict";
import prisma from "../app/db.server";
import { enqueueProduct } from "../app/services/index-queue.server";
import {
  pauseInitialScan,
  resumeInitialScan,
  runNextBatch,
  startInitialScan,
} from "../app/services/initial-scan.server";
import type { AdminGraphqlClient } from "../app/services/shopify-product.server";

const shopDomain = `phase-2-test-${Date.now()}.myshopify.com`;

async function main() {
  try {
    const first = await startInitialScan(shopDomain);
    const duplicate = await startInitialScan(shopDomain);
    assert.equal(duplicate.id, first.id, "duplicate start must return the active run");

    const pageCursors: Array<string | null> = [];
    let pageNumber = 0;
    const admin: AdminGraphqlClient = {
      async graphql(_query, options) {
        pageCursors.push((options?.variables?.after as string | null) ?? null);
        pageNumber += 1;
        return new Response(JSON.stringify({
          data: {
            products: {
              nodes: [],
              pageInfo: pageNumber === 1
                ? { hasNextPage: true, endCursor: "persisted-cursor" }
                : { hasNextPage: false, endCursor: "final-cursor" },
            },
          },
        }), { headers: { "Content-Type": "application/json" } });
      },
    };

    const afterFirstPage = await runNextBatch({ admin, shopDomain, runId: first.id });
    assert.equal(afterFirstPage.status, "RUNNING");
    assert.equal(afterFirstPage.cursor, "persisted-cursor");

    await pauseInitialScan(shopDomain, first.id);
    const resumed = await resumeInitialScan(shopDomain, first.id);
    assert.equal(resumed.cursor, "persisted-cursor", "resume must preserve the cursor");
    const completed = await runNextBatch({ admin, shopDomain, runId: first.id });
    assert.equal(completed.status, "COMPLETED");
    assert.deepEqual(pageCursors, [null, "persisted-cursor"]);

    const shop = await prisma.shop.findUniqueOrThrow({ where: { domain: shopDomain } });
    const queueInput = {
      shopId: shop.id,
      shopifyProductGid: "gid://shopify/Product/phase-2-test",
      url: "https://example.com/products/phase-2-test",
      reason: "CONTENT_CHANGED",
    };
    const queued = await enqueueProduct(queueInput);
    const duplicateQueue = await enqueueProduct(queueInput);
    assert.equal(queued.item.id, duplicateQueue.item.id);
    assert.equal(queued.created, true);
    assert.equal(duplicateQueue.created, false);
    assert.equal(await prisma.indexQueueItem.count({ where: { shopId: shop.id } }), 1);

    console.log("Phase 2 scan integration assertions passed");
  } finally {
    await prisma.shop.deleteMany({ where: { domain: shopDomain } });
    await prisma.$disconnect();
  }
}

await main();
