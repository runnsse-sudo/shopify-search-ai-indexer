import type { Prisma } from "@prisma/client";
import { parseProductFilters, WorkbenchError } from "./product-workbench.ts";
import { PRODUCT_PAGE_SIZE } from "./product-workbench.shared.ts";

export function parseOwnedRequestFilters(params: URLSearchParams) {
  for (const key of params.keys()) if (!["q", "cursor", "format"].includes(key)) throw new WorkbenchError("INVALID_FILTER");
  if (params.getAll("format").length > 1 || (params.has("format") && params.get("format") !== "csv")) throw new WorkbenchError("INVALID_FILTER");
  return parseProductFilters(params);
}

// This is the same untouched, staff-owned INTERNAL/INDEX subset accepted by cancellation.
// Do not include provider rows, manifest work, attempts, claims or retried work.
export async function readOwnedPendingRequests(
  client: Pick<Prisma.TransactionClient, "shop" | "indexQueueItem">,
  domain: string, owner: string, filters: ReturnType<typeof parseOwnedRequestFilters>,
) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new WorkbenchError("AUTH_CONTEXT_REQUIRED", 403);
  const shop = await client.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) return { items: [], nextCursor: null };
  const rows = await client.indexQueueItem.findMany({
    where: {
      shopId: shop.id, id: { startsWith: "manual_" }, reason: `manual-index/v1:${owner}`,
      provider: "INTERNAL", action: "INDEX", status: "PENDING", retryCount: 0,
      claimedAt: null, attempts: { none: {} },
      productIndexState: { is: { shopId: shop.id, ...(filters.q ? {
        OR: ["title", "handle", "shopifyProductGid"].map((field) => ({ [field]: { contains: filters.q, mode: "insensitive" as const } })),
      } : {}) } },
      ...(filters.cursor ? { OR: [
        { createdAt: { lt: filters.cursor.createdAt } },
        { createdAt: filters.cursor.createdAt, id: { lt: filters.cursor.id } },
      ] } : {}),
    },
    select: {
      id: true, shopId: true, shopifyProductGid: true, createdAt: true, updatedAt: true,
      productIndexState: { select: { id: true, shopId: true, shopifyProductGid: true, title: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PRODUCT_PAGE_SIZE + 1,
  });
  const visible = rows.slice(0, PRODUCT_PAGE_SIZE);
  const items = visible.map((q) => {
    const p = q.productIndexState;
    if (q.shopId !== shop.id || !p || p.shopId !== shop.id || p.shopifyProductGid !== q.shopifyProductGid || !/^manual_[a-f0-9]{64}$/.test(q.id)) throw new Error("WORKBENCH_SCOPE_MISMATCH");
    return { id: q.id, productId: p.id, gid: q.shopifyProductGid, title: p.title, createdAt: q.createdAt, updatedAt: q.updatedAt };
  });
  const last = visible.at(-1);
  return { items, nextCursor: rows.length > PRODUCT_PAGE_SIZE && last ? `${last.createdAt.toISOString()}~${last.id}` : null };
}
