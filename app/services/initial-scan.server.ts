import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { ensureShop, processProductDetection } from "./product-indexing.server";
import {
  buildScanPageVariables,
  initialScanActiveKey,
  nextScanStatus,
  type BatchCounts,
} from "./scan-progress";
import type { AdminGraphqlClient } from "./shopify-product.server";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const BATCH_LEASE_MS = 5 * 60 * 1000;

type ScanPage = {
  data?: {
    products: {
      nodes: Array<{ id: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
};

async function fetchScanPage(
  admin: AdminGraphqlClient,
  cursor: string | null,
  pageSize: number,
) {
  const response = await admin.graphql(
    `#graphql
      query ProductsForInitialScan($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    { variables: buildScanPageVariables(cursor, pageSize) },
  );
  const body = (await response.json()) as ScanPage;
  if (body.errors?.length || !body.data) {
    throw new Error(`Product scan query failed: ${body.errors?.map((error) => error.message).join("; ") ?? "missing data"}`);
  }
  return body.data.products;
}

export async function startInitialScan(shopDomain: string) {
  const shop = await ensureShop(shopDomain);
  const activeKey = initialScanActiveKey(shop.id);
  return prisma.scanRun.upsert({
    where: { activeKey },
    create: { shopId: shop.id, activeKey, status: "PENDING" },
    update: {},
  });
}

async function getOwnedRun(shopDomain: string, runId: string) {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) throw new Error("Shop scan state does not exist");
  const run = await prisma.scanRun.findFirst({ where: { id: runId, shopId: shop.id } });
  if (!run) throw new Error("Scan run was not found for this shop");
  return { shop, run };
}

export async function resumeInitialScan(shopDomain: string, runId: string) {
  const { shop, run } = await getOwnedRun(shopDomain, runId);
  if (["COMPLETED", "CANCELLED"].includes(run.status)) return run;
  return prisma.scanRun.update({
    where: { id: run.id },
    data: {
      status: "RUNNING",
      activeKey: initialScanActiveKey(shop.id),
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    },
  });
}

export async function pauseInitialScan(shopDomain: string, runId: string) {
  const { run } = await getOwnedRun(shopDomain, runId);
  if (!["PENDING", "RUNNING"].includes(run.status)) return run;
  return prisma.scanRun.update({ where: { id: run.id }, data: { status: "PAUSED" } });
}

export async function cancelInitialScan(shopDomain: string, runId: string) {
  const { run } = await getOwnedRun(shopDomain, runId);
  if (["COMPLETED", "CANCELLED"].includes(run.status)) return run;
  return prisma.scanRun.update({
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

export async function runNextBatch(input: {
  admin: AdminGraphqlClient;
  shopDomain: string;
  runId: string;
  batchSize?: number;
}) {
  const { shop, run } = await getOwnedRun(input.shopDomain, input.runId);
  if (!["PENDING", "RUNNING"].includes(run.status)) return run;

  const token = randomUUID();
  const claimed = await prisma.scanRun.updateMany({
    where: {
      id: run.id,
      shopId: shop.id,
      status: { in: ["PENDING", "RUNNING"] },
      OR: [
        { batchToken: null },
        { batchClaimedAt: { lt: new Date(Date.now() - BATCH_LEASE_MS) } },
      ],
    },
    data: {
      status: "RUNNING",
      startedAt: run.startedAt ?? new Date(),
      batchToken: token,
      batchClaimedAt: new Date(),
      errorMessage: null,
    },
  });
  if (claimed.count === 0) {
    return prisma.scanRun.findUniqueOrThrow({ where: { id: run.id } });
  }

  const pageSize = Math.min(Math.max(input.batchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  let page: Awaited<ReturnType<typeof fetchScanPage>>;
  try {
    page = await fetchScanPage(input.admin, run.cursor, pageSize);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scan page failure";
    await prisma.scanRun.updateMany({
      where: { id: run.id, batchToken: token, status: "RUNNING" },
      data: {
        status: "FAILED",
        errorMessage: message.slice(0, 4000),
        errorsCount: { increment: 1 },
        batchToken: null,
        batchClaimedAt: null,
      },
    });
    throw error;
  }

  const counts: BatchCounts = {
    processed: 0,
    indexable: 0,
    nonIndexable: 0,
    changed: 0,
    queued: 0,
    errors: 0,
  };
  for (const product of page.nodes) {
    try {
      const result = await processProductDetection({
        admin: input.admin,
        shopDomain: input.shopDomain,
        productGid: product.id,
        eventType: "INITIAL_SCAN",
        scanRunId: run.id,
      });
      counts.processed += 1;
      if (result.indexabilityState === "INDEXABLE") counts.indexable += 1;
      else counts.nonIndexable += 1;
      if (result.changed) counts.changed += 1;
      if (result.queued) counts.queued += 1;
    } catch (error) {
      counts.processed += 1;
      counts.errors += 1;
      console.error("Initial scan product failed", {
        shop: input.shopDomain,
        productId: product.id,
        scanRunId: run.id,
        error,
      });
    }
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.scanRun.findUniqueOrThrow({ where: { id: run.id } });
    if (current.batchToken !== token) return current;
    const canComplete = current.status === "RUNNING" && !page.pageInfo.hasNextPage;
    const status = canComplete ? nextScanStatus(false) : current.status;
    return tx.scanRun.update({
      where: { id: run.id },
      data: {
        cursor: page.pageInfo.endCursor,
        productsProcessed: { increment: counts.processed },
        productsIndexable: { increment: counts.indexable },
        productsNonIndexable: { increment: counts.nonIndexable },
        productsChanged: { increment: counts.changed },
        queueItemsCreated: { increment: counts.queued },
        errorsCount: { increment: counts.errors },
        lastProgressAt: new Date(),
        status,
        completedAt: canComplete ? new Date() : current.completedAt,
        activeKey: canComplete ? null : current.activeKey,
        batchToken: null,
        batchClaimedAt: null,
      },
    });
  });
}

// A completed scan marks every seen ProductIndexState with lastSeenScanRunId.
// Missing-product reconciliation is deliberately non-destructive in Phase 2;
// the marker supports a future proof-based reconciliation step after completion.
