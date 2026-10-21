import type { Prisma, PrismaClient } from "@prisma/client";

export const QUEUE_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED", "SKIPPED"] as const;
export const QUEUE_PROVIDERS = ["INTERNAL", "INDEXNOW", "BING", "GOOGLE", "AI_AUDIT"] as const;
export const QUEUE_PAGE_SIZE = 25;
export const ATTEMPT_PAGE_SIZE = 20;
export const WEBHOOK_PREVIEW_SIZE = 10;

type DashboardClient = Pick<PrismaClient, "shop" | "indexQueueItem" | "indexAttempt" | "webhookReceipt" | "shopProviderConfig">;
type QueueStatus = typeof QUEUE_STATUSES[number];
type Provider = typeof QUEUE_PROVIDERS[number];
export type QueueFilters = {
  status: QueueStatus | null;
  provider: Provider | null;
  product: string;
  cursor: { id: string; createdAt: Date } | null;
};

export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  const single = (key: string) => {
    if (params.getAll(key).length > 1) throw new Error("INVALID_QUEUE_FILTER");
    return params.get(key) ?? "";
  };
  const status = single("status");
  const provider = single("provider");
  const product = single("product").trim();
  const cursor = single("cursor");
  if ((status && !QUEUE_STATUSES.includes(status as QueueStatus)) ||
      (provider && !QUEUE_PROVIDERS.includes(provider as Provider)) ||
      (product && !/^(?:gid:\/\/shopify\/Product\/)?[1-9][0-9]{0,29}$/.test(product))) {
    throw new Error("INVALID_QUEUE_FILTER");
  }
  let position: QueueFilters["cursor"] = null;
  if (cursor) {
    // Plain, bounded position, never an arbitrary Prisma cursor or query object.
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([a-zA-Z0-9_-]{1,80})$/.exec(cursor);
    if (!match || !Number.isFinite(Date.parse(match[1])) || new Date(match[1]).toISOString() !== match[1]) {
      throw new Error("INVALID_QUEUE_FILTER");
    }
    position = { id: match[2], createdAt: new Date(match[1]) };
  }
  return { status: status as QueueStatus || null, provider: provider as Provider || null, product, cursor: position };
}

export function queueHref(filters: QueueFilters, cursor: string | null = null) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.product) params.set("product", filters.product);
  if (cursor) params.set("cursor", cursor);
  return `/app/indexing${params.size ? `?${params}` : ""}`;
}

export function parseAttemptBefore(params: URLSearchParams) {
  const value = params.get("before");
  if (params.getAll("before").length > 1 || (value !== null && !/^[1-9][0-9]{0,9}$/.test(value))) {
    throw new Error("INVALID_ATTEMPT_POSITION");
  }
  const number = value === null ? null : Number(value);
  if (number !== null && number > 2_147_483_647) throw new Error("INVALID_ATTEMPT_POSITION");
  return number;
}

const attemptSelect = {
  id: true, shopId: true, queueItemId: true, provider: true, attemptNumber: true,
  successful: true, responseCode: true, startedAt: true, completedAt: true,
} satisfies Prisma.IndexAttemptSelect;

const queueSelect = {
  id: true, shopId: true, shopifyProductGid: true, provider: true, action: true,
  status: true, retryCount: true, maxRetries: true, nextAttemptAt: true,
  claimedAt: true, completedAt: true, createdAt: true, updatedAt: true,
} satisfies Prisma.IndexQueueItemSelect;

type Attempt = Prisma.IndexAttemptGetPayload<{ select: typeof attemptSelect }>;
type Queue = Prisma.IndexQueueItemGetPayload<{ select: typeof queueSelect }>;

export function webhookDiagnostic(errorClass: string | null) {
  const messages: Record<string, string> = {
    THROTTLED: "Shopify rate limit reached. Check the next scheduled attempt.",
    UPSTREAM_5XX: "Shopify reported a temporary server error.",
    NETWORK: "The upstream request could not be completed.",
    ADMIN_UNAVAILABLE: "Shop access is unavailable. Review the app installation and authorization.",
    DATABASE_TRANSIENT: "A temporary database problem interrupted processing.",
    APPLICATION_ERROR: "Processing stopped with an application error. Review operational diagnostics.",
    INVALID_WORK: "This event could not be safely processed. Review operational diagnostics.",
    ATTEMPTS_EXHAUSTED: "The retry budget is exhausted. Review the outcome before further action.",
  };
  return errorClass && Object.hasOwn(messages, errorClass) ? messages[errorClass]
    : errorClass ? "A processing issue was recorded. Review operational diagnostics."
    : "No processing error class recorded. Waiting does not prove that a worker is running.";
}

export function attemptDiagnostic(attempt: Pick<Attempt, "provider" | "successful" | "responseCode" | "completedAt">) {
  if (!attempt.completedAt) return "Attempt has no recorded completion. Review its outcome before taking action.";
  const code = attempt.responseCode;
  if (attempt.successful) {
    if (attempt.provider === "INTERNAL") return "Internal preparation completed. No search engine submission is proven.";
    if (attempt.provider === "INDEXNOW" && (code === 200 || code === 202)) {
      return code === 202
        ? "IndexNow accepted the request; key validation is pending. Search engine inclusion is unverified."
        : "IndexNow accepted the request. Search engine inclusion is unverified.";
    }
    return "Recorded success needs review: provider acceptance is not proven by this response.";
  }
  if (code === 200 || code === 202) return "Provider response and recorded outcome disagree. Review the attempt before further action.";
  if (code === 401 || code === 403) return "Provider access was rejected. Review provider configuration and ownership verification.";
  if (code === 429) return "Provider rate limit reached. Check the scheduled retry time.";
  if (code !== null && code >= 500 && code <= 599) return "Provider reported a temporary server error. Check the scheduled retry time.";
  if (code === 400 || code === 422) return "Provider rejected the request. Review the product and provider configuration.";
  return "Attempt was not successful. No automatic retry or provider acceptance is implied by this page.";
}

function publicAttempt(row: Attempt, shopId: string, queueId: string, provider: Provider) {
  if (row.shopId !== shopId || row.queueItemId !== queueId) throw new Error("INDEXING_SCOPE_MISMATCH");
  // Deliberate projection: never send stored errors, URLs, provider bodies or credentials to the browser.
  return {
    id: row.id, provider: row.provider, attemptNumber: row.attemptNumber,
    successful: row.successful, responseCode: row.responseCode,
    startedAt: row.startedAt, completedAt: row.completedAt,
    diagnostic: row.provider === provider ? attemptDiagnostic(row) : "The recorded provider does not match this job. Review the attempt before further action.",
  };
}

function publicQueue(row: Queue, shopId: string, now: Date) {
  if (row.shopId !== shopId) throw new Error("INDEXING_SCOPE_MISMATCH");
  const schedule = row.status !== "PENDING" ? null
    : row.retryCount >= row.maxRetries ? "Retry budget exhausted; review required"
    : row.nextAttemptAt > now ? "Scheduled for later" : "Waiting for a permitted worker";
  return {
    id: row.id, shopifyProductGid: row.shopifyProductGid, provider: row.provider,
    action: row.action, status: row.status, retryCount: row.retryCount,
    maxRetries: row.maxRetries, nextAttemptAt: row.nextAttemptAt,
    claimedAt: row.claimedAt, completedAt: row.completedAt, createdAt: row.createdAt,
    updatedAt: row.updatedAt, schedule,
    outcome: row.status !== "COMPLETED" ? null : row.provider === "INTERNAL"
      ? "Internal preparation completed; external submission is not proven."
      : "Queue processing completed; search engine inclusion is unverified.",
  };
}

export async function readIndexingSummary(client: DashboardClient, shopId: string) {
  const [queueGroups, webhookGroups, config] = await Promise.all([
    client.indexQueueItem.groupBy({ by: ["provider", "status"], where: { shopId }, _count: { _all: true } }),
    client.webhookReceipt.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
    client.shopProviderConfig.findUnique({ where: { shopId }, select: { indexNowEnabled: true, indexNowOwnershipVerifiedAt: true } }),
  ]);
  const counts = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, SKIPPED: 0 };
  for (const group of queueGroups) counts[group.status] += group._count._all;
  const webhooks = { waiting: 0, processing: 0, failed: 0 };
  for (const group of webhookGroups) {
    if (group.status === "PENDING" || group.status === "RETRY") webhooks.waiting += group._count._all;
    if (group.status === "PROCESSING") webhooks.processing += group._count._all;
    if (group.status === "FAILED") webhooks.failed += group._count._all;
  }
  return {
    counts, webhooks,
    providers: QUEUE_PROVIDERS.map((provider) => ({
      provider,
      pending: queueGroups.filter((g) => g.provider === provider && g.status === "PENDING").reduce((n, g) => n + g._count._all, 0),
      failed: queueGroups.filter((g) => g.provider === provider && g.status === "FAILED").reduce((n, g) => n + g._count._all, 0),
    })),
    indexNow: { configured: config !== null, enabled: config?.indexNowEnabled ?? false, ownershipVerifiedAt: config?.indexNowOwnershipVerifiedAt ?? null },
  };
}

export async function readIndexingDashboard(client: DashboardClient, shopDomain: string, filters: QueueFilters, now = new Date()) {
  const shop = await client.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
  if (!shop) return { summary: null, items: [], nextCursor: null, webhooks: [], moreWebhooks: false, observedAt: now };
  const where: Prisma.IndexQueueItemWhereInput = {
    shopId: shop.id,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.provider ? { provider: filters.provider } : {}),
    ...(filters.product ? { shopifyProductGid: filters.product.startsWith("gid://") ? filters.product : `gid://shopify/Product/${filters.product}` } : {}),
    ...(filters.cursor ? { OR: [
      { createdAt: { lt: filters.cursor.createdAt } },
      { createdAt: filters.cursor.createdAt, id: { lt: filters.cursor.id } },
    ] } : {}),
  };
  const [summary, rows, webhookRows] = await Promise.all([
    readIndexingSummary(client, shop.id),
    client.indexQueueItem.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: QUEUE_PAGE_SIZE + 1,
      select: { ...queueSelect, attempts: { where: { shopId: shop.id }, orderBy: { attemptNumber: "desc" }, take: 1, select: attemptSelect } } }),
    client.webhookReceipt.findMany({ where: { shopId: shop.id, status: { in: ["PENDING", "RETRY", "PROCESSING", "FAILED"] } },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: WEBHOOK_PREVIEW_SIZE + 1,
      select: { id: true, shopId: true, topic: true, shopifyProductGid: true, status: true, attemptCount: true, nextAttemptAt: true, receivedAt: true, lastErrorClass: true } }),
  ]);
  const page = rows.slice(0, QUEUE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    summary,
    items: page.map((row) => ({ ...publicQueue(row, shop.id, now), latestAttempt: row.attempts[0] ? publicAttempt(row.attempts[0], shop.id, row.id, row.provider) : null })),
    nextCursor: rows.length > QUEUE_PAGE_SIZE && last ? `${last.createdAt.toISOString()}~${last.id}` : null,
    webhooks: webhookRows.slice(0, WEBHOOK_PREVIEW_SIZE).map((row) => {
      if (row.shopId !== shop.id) throw new Error("INDEXING_SCOPE_MISMATCH");
      return { id: row.id, product: row.shopifyProductGid, status: row.status, attemptCount: row.attemptCount,
        topic: ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE"].includes(row.topic) ? row.topic : "Webhook event",
        nextAttemptAt: row.nextAttemptAt, receivedAt: row.receivedAt, diagnostic: webhookDiagnostic(row.lastErrorClass) };
    }),
    moreWebhooks: webhookRows.length > WEBHOOK_PREVIEW_SIZE,
    observedAt: now,
  };
}

export async function readIndexingDetail(client: DashboardClient, shopDomain: string, queueId: string, before: number | null, now = new Date()) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(queueId)) return null;
  const shop = await client.shop.findUnique({ where: { domain: shopDomain }, select: { id: true } });
  if (!shop) return null;
  const row = await client.indexQueueItem.findFirst({ where: { id: queueId, shopId: shop.id }, select: queueSelect });
  if (!row) return null;
  const item = publicQueue(row, shop.id, now);
  const rows = await client.indexAttempt.findMany({ where: { shopId: shop.id, queueItemId: queueId, ...(before !== null ? { attemptNumber: { lt: before } } : {}) },
    orderBy: { attemptNumber: "desc" }, take: ATTEMPT_PAGE_SIZE + 1, select: attemptSelect });
  const page = rows.slice(0, ATTEMPT_PAGE_SIZE);
  return { item, attempts: page.map((attempt) => publicAttempt(attempt, shop.id, queueId, row.provider)),
    nextBefore: rows.length > ATTEMPT_PAGE_SIZE ? page.at(-1)?.attemptNumber ?? null : null, observedAt: now };
}
