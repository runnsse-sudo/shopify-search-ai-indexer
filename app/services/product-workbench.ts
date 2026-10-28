import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { createPendingIntentKey } from "./index-queue-intent.ts";
import { attemptDiagnostic, parseQueueFilters } from "./indexing-dashboard.ts";
import { MAX_PRODUCT_SELECTION, PRODUCT_PAGE_SIZE, PRODUCT_STATES, PRODUCT_WORK_FILTERS } from "./product-workbench.shared.ts";
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// SDK-verified staff subject, never the shared offline-session ID or form input.
export const workbenchOwner = (shop: string, userId: string) => {
  if (!shop || !/^[1-9][0-9]{0,29}$/.test(userId)) throw new WorkbenchError("AUTH_CONTEXT_REQUIRED", 403);
  return hash(JSON.stringify([shop, userId]));
};
const reasonFor = (owner: string) => {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("AUTH_CONTEXT_REQUIRED");
  return `manual-index/v1:${owner}`;
};
export const manualRequestId = (shopId: string, owner: string, requestKey: string, productId: string) =>
  `manual_${hash(JSON.stringify([shopId, reasonFor(owner), requestKey, productId]))}`;

export class WorkbenchError extends Error {
  status: number;
  constructor(code: string, status = 400) { super(code); this.status = status; }
}

function date(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new WorkbenchError("INVALID_SELECTION");
  }
  return new Date(value);
}
export type WorkbenchCommand =
  | { intent: "enqueue"; requestKey: string; products: { id: string; updatedAt: Date }[] }
  | { intent: "cancel"; queueId: string; updatedAt: Date };

export function parseWorkbenchCommand(params: URLSearchParams): WorkbenchCommand {
  const intent = params.get("intent");
  const allowed = intent === "enqueue" ? ["intent", "requestKey", "product"] : ["intent", "queueId", "updatedAt"];
  for (const key of params.keys()) if (!allowed.includes(key) || (key !== "product" && params.getAll(key).length !== 1)) throw new WorkbenchError("INVALID_SELECTION");
  if (intent === "enqueue") {
    const requestKey = params.get("requestKey") ?? "";
    const values = params.getAll("product");
    if (!noncePattern.test(requestKey) || values.length < 1 || values.length > MAX_PRODUCT_SELECTION) throw new WorkbenchError("INVALID_SELECTION");
    const unique = new Map<string, Date>();
    for (const value of values) {
      const [id, version, extra] = value.split("~");
      if (!idPattern.test(id) || !version || extra !== undefined) throw new WorkbenchError("INVALID_SELECTION");
      const updatedAt = date(version);
      if (unique.has(id) && unique.get(id)!.getTime() !== updatedAt.getTime()) throw new WorkbenchError("INVALID_SELECTION");
      unique.set(id, updatedAt);
    }
    return { intent, requestKey, products: [...unique].map(([id, updatedAt]) => ({ id, updatedAt })) };
  }
  if (intent !== "cancel" || !/^manual_[a-f0-9]{64}$/.test(params.get("queueId") ?? "")) throw new WorkbenchError("INVALID_SELECTION");
  return { intent, queueId: params.get("queueId")!, updatedAt: date(params.get("updatedAt") ?? "") };
}

// Read a bounded stream, including when Content-Length is absent or misleading.
export async function readWorkbenchCommand(request: Request) {
  if (request.method !== "POST") throw new WorkbenchError("METHOD_NOT_ALLOWED", 405);
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new WorkbenchError("ORIGIN_REJECTED", 403);
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new WorkbenchError("INVALID_CONTENT_TYPE", 415);
  if (Number(request.headers.get("content-length")) > 16_384) throw new WorkbenchError("SELECTION_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new WorkbenchError("INVALID_SELECTION");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new WorkbenchError("SELECTION_TOO_LARGE", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return parseWorkbenchCommand(new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body)));
}

export function parseProductFilters(params: URLSearchParams) {
  for (const key of ["q", "state", "cursor", "work"]) if (params.getAll(key).length > 1) throw new WorkbenchError("INVALID_FILTER");
  const work = params.get("work") ?? "";
  if (work && !PRODUCT_WORK_FILTERS.includes(work as typeof PRODUCT_WORK_FILTERS[number])) throw new WorkbenchError("INVALID_FILTER");
  const q = (params.get("q") ?? "").trim();
  const state = params.get("state") ?? "";
  if (q.length > 100 || [...q].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || (state && !PRODUCT_STATES.includes(state as typeof PRODUCT_STATES[number]))) throw new WorkbenchError("INVALID_FILTER");
  const cursor = parseQueueFilters(new URLSearchParams(params.has("cursor") ? { cursor: params.get("cursor")! } : {})).cursor;
  return { q, state: state as "" | typeof PRODUCT_STATES[number], work: work as "" | typeof PRODUCT_WORK_FILTERS[number], cursor };
}

const productSelect = {
  id: true, shopId: true, shopifyProductGid: true, title: true, handle: true,
  canonicalUrl: true, productStatus: true, indexabilityState: true, published: true,
  deletedAt: true, lastIndexedAt: true, updatedAt: true, createdAt: true,
} satisfies Prisma.ProductIndexStateSelect;
type Product = Prisma.ProductIndexStateGetPayload<{ select: typeof productSelect }>;
const queueSelect = {
  id: true, shopId: true, shopifyProductGid: true, provider: true, action: true, status: true,
  updatedAt: true, createdAt: true, reason: true, retryCount: true, claimedAt: true,
  attempts: { where: {}, take: 1, orderBy: { attemptNumber: "desc" }, select: {
    provider: true, successful: true, responseCode: true, completedAt: true,
  } },
} satisfies Prisma.IndexQueueItemSelect;

export function productEligibilityReason(product: Product, primaryDomain: string | null) {
  if (product.deletedAt) return "Deletion recorded";
  if (product.productStatus !== "ACTIVE") return "Product is not recorded as active";
  if (product.published !== true) return "Publication is not confirmed";
  if (product.indexabilityState !== "INDEXABLE") return "Product is not recorded as indexable";
  try {
    const target = new URL(product.canonicalUrl ?? "");
    const primary = new URL(primaryDomain?.includes("://") ? primaryDomain : `https://${primaryDomain ?? ""}`);
    const valid = primary.protocol === "https:" && !primary.username && !primary.password && primary.pathname === "/" && !primary.search && !primary.hash &&
      target.protocol === "https:" && target.origin === primary.origin && !target.username && !target.password && !target.search && !target.hash && /^\/products\/[^/]+$/.test(target.pathname);
    return valid ? null : "Verified same-domain product URL is required";
  } catch { return "Verified same-domain product URL is required"; }
}
export function productEligibility(product: Product, primaryDomain: string | null) {
  return productEligibilityReason(product, primaryDomain) === null;
}

type Client = Pick<Prisma.TransactionClient, "shop" | "productIndexState" | "indexQueueItem">;
export async function readProducts(client: Client, domain: string, owner: string, filters: ReturnType<typeof parseProductFilters>, productId?: string) {
  if (productId !== undefined && !idPattern.test(productId)) throw new WorkbenchError("NOT_FOUND", 404);
  const shop = await client.shop.findUnique({ where: { domain }, select: { id: true, primaryDomain: true } });
  if (!shop) { if (productId) throw new WorkbenchError("NOT_FOUND", 404); return { items: [], nextCursor: null }; }
  const products = await client.productIndexState.findMany({
    where: { shopId: shop.id, ...(productId ? { id: productId } : {}),
      ...(filters.state ? { indexabilityState: filters.state } : {}),
      ...(filters.work ? { queueItems: filters.work === "NONE" ? { none: { shopId: shop.id } } : { some: {
        shopId: shop.id, status: filters.work === "ACTIVE" ? { in: ["PENDING", "PROCESSING"] } : "FAILED",
      } } } : {}),
      ...(filters.q ? { OR: ["title", "handle", "shopifyProductGid"].map((field) => ({ [field]: { contains: filters.q, mode: "insensitive" } })) } : {}),
      ...(filters.cursor ? { AND: [{ OR: [{ createdAt: { lt: filters.cursor.createdAt } }, { createdAt: filters.cursor.createdAt, id: { lt: filters.cursor.id } }] }] } : {}),
    }, select: { ...productSelect, queueItems: { where: { shopId: shop.id }, take: productId ? 10 : 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: queueSelect } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: productId ? 1 : PRODUCT_PAGE_SIZE + 1,
  });
  if (productId && !products.length) throw new WorkbenchError("NOT_FOUND", 404);
  const rows = products.slice(0, PRODUCT_PAGE_SIZE);
  const items = rows.map((p) => {
    if (p.shopId !== shop.id) throw new Error("WORKBENCH_SCOPE_MISMATCH");
    return { id: p.id, title: p.title, handle: p.handle, gid: p.shopifyProductGid, state: p.indexabilityState,
      productStatus: p.productStatus, published: p.published, deleted: Boolean(p.deletedAt), lastIndexedAt: p.lastIndexedAt,
      updatedAt: p.updatedAt, eligible: productEligibility(p, shop.primaryDomain), eligibilityReason: productEligibilityReason(p, shop.primaryDomain),
      jobs: p.queueItems.map((q) => {
        if (q.shopId !== shop.id || q.shopifyProductGid !== p.shopifyProductGid) throw new Error("WORKBENCH_SCOPE_MISMATCH");
        return { id: q.id, provider: q.provider, action: q.action, status: q.status, updatedAt: q.updatedAt,
          cancellable: q.id.startsWith("manual_") && q.reason === reasonFor(owner) && q.provider === "INTERNAL" && q.action === "INDEX" && q.status === "PENDING" && q.retryCount === 0 && q.claimedAt === null && q.attempts.length === 0,
          diagnostic: q.attempts[0] ? attemptDiagnostic(q.attempts[0]) : "No attempt recorded. Provider submission is unverified.",
        };
      }),
    };
  });
  const last = rows.at(-1);
  return { items, nextCursor: products.length > PRODUCT_PAGE_SIZE && last ? `${last.createdAt.toISOString()}~${last.id}` : null };
}

// Caller must run this entire function once in a SERIALIZABLE transaction. No retries.
export async function applyWorkbenchCommand(client: Client, domain: string, owner: string, command: WorkbenchCommand, now = new Date()) {
  const reason = reasonFor(owner);
  const shop = await client.shop.findUnique({ where: { domain }, select: { id: true, primaryDomain: true } });
  if (!shop) throw new WorkbenchError("NOT_FOUND", 404);
  if (command.intent === "cancel") {
    const result = await client.indexQueueItem.updateMany({ where: {
      id: command.queueId, shopId: shop.id, reason, provider: "INTERNAL", action: "INDEX", status: "PENDING",
      updatedAt: command.updatedAt, retryCount: 0, claimedAt: null, attempts: { none: {} },
    }, data: { status: "CANCELLED", completedAt: now, dedupeKey: null } });
    if (result.count !== 1) throw new WorkbenchError("STALE_OR_NOT_OWNED", 409);
    return { created: 0, skipped: 0, cancelled: 1 };
  }
  if (!command.products.length || command.products.length > MAX_PRODUCT_SELECTION) throw new WorkbenchError("INVALID_SELECTION");
  const products = await client.productIndexState.findMany({ where: { shopId: shop.id, id: { in: command.products.map((p) => p.id) } }, select: productSelect });
  if (products.length !== command.products.length) throw new WorkbenchError("STALE_SELECTION", 409);
  for (const p of products) {
    const expected = command.products.find((s) => s.id === p.id);
    if (p.shopId !== shop.id || !expected || p.updatedAt.getTime() !== expected.updatedAt.getTime() || !productEligibility(p, shop.primaryDomain)) throw new WorkbenchError("STALE_SELECTION", 409);
  }
  const ids = products.map((p) => manualRequestId(shop.id, owner, command.requestKey, p.id));
  const existing = await client.indexQueueItem.findMany({ where: { shopId: shop.id, OR: [
    { id: { in: ids } }, { shopifyProductGid: { in: products.map((p) => p.shopifyProductGid) }, status: { in: ["PENDING", "PROCESSING"] } },
  ] }, select: { id: true, shopifyProductGid: true }, take: 1001 });
  if (existing.length > 1000) throw new WorkbenchError("QUEUE_REVIEW_REQUIRED", 409);
  const rows = products.filter((p, i) => !existing.some((q) => q.id === ids[i] || q.shopifyProductGid === p.shopifyProductGid)).map((p) => ({
    id: manualRequestId(shop.id, owner, command.requestKey, p.id), shopId: shop.id, productIndexStateId: p.id,
    shopifyProductGid: p.shopifyProductGid, url: p.canonicalUrl, provider: "INTERNAL" as const, action: "INDEX" as const,
    status: "PENDING" as const, reason, dedupeKey: createPendingIntentKey({ shopId: shop.id, shopifyProductGid: p.shopifyProductGid, provider: "INTERNAL", action: "INDEX" }),
    nextAttemptAt: now,
  }));
  const created = rows.length ? (await client.indexQueueItem.createMany({ data: rows, skipDuplicates: true })).count : 0;
  return { created, skipped: products.length - created, cancelled: 0 };
}
