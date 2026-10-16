import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { Prisma } from "@prisma/client";

export class ProductWebhookDrainBlocked extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function drainNeed(ok: unknown, code = "DRAIN_SCOPE_DRIFT"): asserts ok {
  if (!ok) throw new ProductWebhookDrainBlocked(code);
}
export type DrainMember = Readonly<{
  id: string;
  shopId: string;
  webhookId: string;
  shopifyProductGid: string;
  topic: "products/create" | "products/update";
}>;
export function canonicalDrainJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalDrainJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalDrainJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function drainHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function object(v: unknown): Record<string, unknown> {
  drainNeed(
    v && typeof v === "object" && !Array.isArray(v),
    "DRAIN_CONFIG_INVALID",
  );
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, names: string[]) {
  drainNeed(
    Object.keys(v).sort().join("|") === [...names].sort().join("|"),
    "DRAIN_CONFIG_INVALID",
  );
}
function identifier(v: unknown): asserts v is string {
  drainNeed(
    typeof v === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(v),
    "DRAIN_CONFIG_INVALID",
  );
}
function decode(
  env: Record<string, string | undefined>,
  key: string,
  max: number,
) {
  const encoded = env[key],
    hash = env[`${key.replace(/_B64$/, "")}_SHA256`];
  drainNeed(
    typeof encoded === "string" &&
      encoded.length <= Math.ceil(max / 3) * 4 &&
      typeof hash === "string" &&
      /^[a-f0-9]{64}$/.test(hash),
    "DRAIN_CONFIG_INVALID",
  );
  const bytes = Buffer.from(encoded, "base64");
  drainNeed(
    bytes.length <= max &&
      bytes.toString("base64") === encoded &&
      isUtf8(bytes),
    "DRAIN_CONFIG_INVALID",
  );
  const raw = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProductWebhookDrainBlocked("DRAIN_CONFIG_INVALID");
  }
  drainNeed(
    canonicalDrainJson(value) === raw && drainHash(raw) === hash,
    "DRAIN_CONFIG_INVALID",
  );
  return { value, hash };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export type DrainProduct = {
  id: string;
  shopId: string;
  shopifyProductGid: string;
  contentHash: string | null;
  deletedAt: string | null;
  shopifyUpdatedAt: string | null;
  lastDetectedAt: string;
  updatedAt: string;
  indexabilityState: string;
};
export type DrainQueue = {
  id: string;
  shopId: string;
  shopifyProductGid: string;
  provider: string;
  action: string;
  status: string;
  updatedAt: string;
  hasDedupeKey: boolean;
};
export function drainProduct(row: {
  id: string;
  shopId: string;
  shopifyProductGid: string;
  contentHash: string | null;
  deletedAt: Date | null;
  shopifyUpdatedAt: Date | null;
  lastDetectedAt: Date;
  updatedAt: Date;
  indexabilityState: string;
}): DrainProduct {
  return {
    id: row.id,
    shopId: row.shopId,
    shopifyProductGid: row.shopifyProductGid,
    contentHash: row.contentHash,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    shopifyUpdatedAt: row.shopifyUpdatedAt?.toISOString() ?? null,
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    indexabilityState: row.indexabilityState,
  };
}
export function drainQueue(row: {
  id: string;
  shopId: string;
  shopifyProductGid: string;
  provider: string;
  action: string;
  status: string;
  updatedAt: Date;
  dedupeKey: string | null;
}): DrainQueue {
  return {
    id: row.id,
    shopId: row.shopId,
    shopifyProductGid: row.shopifyProductGid,
    provider: row.provider,
    action: row.action,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    hasDedupeKey: row.dedupeKey !== null,
  };
}
const pair = (r: { shopId: string; shopifyProductGid: string }) =>
  `${r.shopId}|${r.shopifyProductGid}`;
function equal(a: unknown, b: unknown) {
  return canonicalDrainJson(a) === canonicalDrainJson(b);
}
export type DrainEffectContext = Readonly<{
  manifestSha256: string;
  domain: string;
  primaryDomain: string;
  products: DrainProduct[];
  queues: DrainQueue[];
}>;
export type DrainSpec = Readonly<{
  manifest: readonly DrainMember[];
  sha256: string;
  effectsSha256: string;
  context: DrainEffectContext;
}>;
export function parseProductWebhookDrain(
  env: Record<string, string | undefined>,
): DrainSpec | null {
  const fields = Object.keys(env).filter(
    (k) => k.startsWith("PRODUCT_WEBHOOK_DRAIN_") && env[k] !== undefined,
  );
  if (!fields.length) return null;
  drainNeed(
    fields.sort().join("|") ===
      [
        "PRODUCT_WEBHOOK_DRAIN_MODE",
        "PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64",
        "PRODUCT_WEBHOOK_DRAIN_MANIFEST_SHA256",
        "PRODUCT_WEBHOOK_DRAIN_EFFECTS_B64",
        "PRODUCT_WEBHOOK_DRAIN_EFFECTS_SHA256",
      ]
        .sort()
        .join("|") && env.PRODUCT_WEBHOOK_DRAIN_MODE === "manifest-once-v1",
    "DRAIN_CONFIG_INVALID",
  );
  const decoded = decode(env, "PRODUCT_WEBHOOK_DRAIN_MANIFEST_B64", 16384);
  drainNeed(
    Array.isArray(decoded.value) && decoded.value.length === 20,
    "DRAIN_CONFIG_INVALID",
  );
  const manifest = decoded.value.map((v) => {
    const r = object(v);
    keys(r, ["id", "shopId", "webhookId", "shopifyProductGid", "topic"]);
    for (const k of ["id", "shopId", "webhookId"]) identifier(r[k]);
    drainNeed(
      typeof r.shopifyProductGid === "string" &&
        /^gid:\/\/shopify\/Product\/[0-9]{1,30}$/.test(r.shopifyProductGid) &&
        ["products/create", "products/update"].includes(String(r.topic)),
      "DRAIN_CONFIG_INVALID",
    );
    return r as unknown as DrainMember;
  });
  drainNeed(
    new Set(manifest.map((r) => r.id)).size === 20 &&
      new Set(manifest.map((r) => `${r.shopId}|${r.webhookId}`)).size === 20 &&
      new Set(manifest.map((r) => r.shopId)).size === 1 &&
      new Set(manifest.map(pair)).size === 17,
    "DRAIN_CONFIG_INVALID",
  );
  drainNeed(
    manifest.every((r, i) => i === 0 || manifest[i - 1].id < r.id),
    "DRAIN_CONFIG_INVALID",
  );
  const effects = decode(env, "PRODUCT_WEBHOOK_DRAIN_EFFECTS_B64", 65536),
    c = object(effects.value);
  keys(c, ["manifestSha256", "domain", "primaryDomain", "products", "queues"]);
  drainNeed(
    c.manifestSha256 === decoded.hash &&
      typeof c.domain === "string" &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(c.domain) &&
      typeof c.primaryDomain === "string" &&
      /^[a-z0-9.-]+$/.test(c.primaryDomain) &&
      Array.isArray(c.products) &&
      c.products.length === 17 &&
      Array.isArray(c.queues) &&
      c.queues.length <= 500,
    "DRAIN_CONFIG_INVALID",
  );
  const pairs = new Set(manifest.map(pair));
  for (const [list, names] of [
    [
      c.products,
      [
        "id",
        "shopId",
        "shopifyProductGid",
        "contentHash",
        "deletedAt",
        "shopifyUpdatedAt",
        "lastDetectedAt",
        "updatedAt",
        "indexabilityState",
      ],
    ],
    [
      c.queues,
      [
        "id",
        "shopId",
        "shopifyProductGid",
        "provider",
        "action",
        "status",
        "updatedAt",
        "hasDedupeKey",
      ],
    ],
  ] as const) {
    for (const v of list as unknown[]) {
      const r = object(v);
      keys(r, [...names]);
      identifier(r.id);
      identifier(r.shopId);
      drainNeed(
        pairs.has(pair(r as unknown as DrainMember)),
        "DRAIN_CONFIG_INVALID",
      );
      for (const key of [
        "updatedAt",
        "lastDetectedAt",
        "deletedAt",
        "shopifyUpdatedAt",
      ].filter((k) => k in r))
        drainNeed(
          (r[key] === null &&
            ["deletedAt", "shopifyUpdatedAt"].includes(key)) ||
            (typeof r[key] === "string" &&
              Number.isFinite(Date.parse(r[key] as string)) &&
              new Date(r[key] as string).toISOString() === r[key]),
          "DRAIN_CONFIG_INVALID",
        );
      if ("provider" in r)
        drainNeed(
          ["INTERNAL", "BING", "INDEXNOW", "GOOGLE", "AI_AUDIT"].includes(
            String(r.provider),
          ) &&
            ["INDEX", "DEINDEX"].includes(String(r.action)) &&
            [
              "PENDING",
              "PROCESSING",
              "COMPLETED",
              "FAILED",
              "CANCELLED",
              "SKIPPED",
            ].includes(String(r.status)) &&
            typeof r.hasDedupeKey === "boolean",
          "DRAIN_CONFIG_INVALID",
        );
      else
        drainNeed(
          (r.contentHash === null ||
            (typeof r.contentHash === "string" &&
              /^[a-f0-9]{64}$/.test(r.contentHash))) &&
            [
              "INDEXABLE",
              "NOT_ACTIVE",
              "NOT_PUBLISHED",
              "UNKNOWN_PUBLICATION",
              "MISSING_URL",
            ].includes(String(r.indexabilityState)),
          "DRAIN_CONFIG_INVALID",
        );
    }
  }
  const context = c as unknown as DrainEffectContext;
  drainNeed(
    new Set(context.products.map(pair)).size === 17 &&
      new Set(context.products.map((p) => p.id)).size === 17 &&
      new Set(context.queues.map((r) => r.id)).size === context.queues.length &&
      context.queues.filter((r) => r.status === "PENDING").length <= 17 &&
      context.queues.every(
        (r) => r.status !== "PENDING" || r.provider === "INTERNAL",
      ),
    "DRAIN_CONFIG_INVALID",
  );
  return deepFreeze({
    manifest,
    sha256: decoded.hash,
    effectsSha256: effects.hash,
    context,
  });
}

export type DrainCommittedEffect = {
  product: DrainProduct;
  queues: DrainQueue[];
  created: string[];
  cancelled: string[];
  eventId: string;
};
export type DrainEffectState = {
  spec: DrainSpec;
  products: Map<string, DrainProduct>;
  queues: Map<string, DrainQueue>;
  created: Set<string>;
  cancelled: Set<string>;
  events: Set<string>;
};
export function createDrainEffectState(spec: DrainSpec): DrainEffectState {
  return {
    spec,
    products: new Map(spec.context.products.map((p) => [pair(p), p])),
    queues: new Map(spec.context.queues.map((q) => [q.id, q])),
    created: new Set(),
    cancelled: new Set(),
    events: new Set(),
  };
}
export type DrainTransactionFence = {
  state: DrainEffectState;
  shopId: string;
  shopifyProductGid: string;
  created: Set<string>;
  cancelled: Set<string>;
};
export function assertDrainQueue(
  fence: DrainTransactionFence,
  row: Parameters<typeof drainQueue>[0],
) {
  drainNeed(
    row.shopId === fence.shopId &&
      row.shopifyProductGid === fence.shopifyProductGid &&
      equal(fence.state.queues.get(row.id), drainQueue(row)),
  );
}
export async function beginDrainTransaction(
  state: DrainEffectState,
  tx: Prisma.TransactionClient,
  product: Parameters<typeof drainProduct>[0] | null,
  shopId: string,
  productId: string,
  primaryDomain: string | null,
) {
  drainNeed(
    product &&
      primaryDomain === state.spec.context.primaryDomain &&
      equal(
        state.products.get(`${shopId}|${productId}`),
        drainProduct(product),
      ),
  );
  const rows = await tx.indexQueueItem.findMany({
    where: { shopId, shopifyProductGid: productId },
    take: 501,
  });
  const expected = [...state.queues.values()].filter(
    (q) => q.shopId === shopId && q.shopifyProductGid === productId,
  );
  drainNeed(rows.length <= 500 && rows.length === expected.length);
  const fence: DrainTransactionFence = {
    state,
    shopId,
    shopifyProductGid: productId,
    created: new Set(),
    cancelled: new Set(),
  };
  rows.forEach((q) => assertDrainQueue(fence, q));
  return fence;
}
export async function finishDrainTransaction(
  fence: DrainTransactionFence,
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<DrainCommittedEffect> {
  const product = await tx.productIndexState.findUniqueOrThrow({
    where: {
      shopId_shopifyProductGid: {
        shopId: fence.shopId,
        shopifyProductGid: fence.shopifyProductGid,
      },
    },
  });
  const queues = await tx.indexQueueItem.findMany({
    where: { shopId: fence.shopId, shopifyProductGid: fence.shopifyProductGid },
    take: 501,
  });
  drainNeed(
    queues.length <= 500 &&
      fence.state.created.size + fence.created.size <= 20 &&
      new Set([...fence.state.cancelled, ...fence.cancelled]).size <= 37 &&
      fence.state.events.size < 20 &&
      !fence.state.events.has(eventId),
  );
  return {
    product: drainProduct(product),
    queues: queues.map(drainQueue),
    created: [...fence.created],
    cancelled: [...fence.cancelled],
    eventId,
  };
}
// Called only after the enclosing product transaction resolves successfully.
export function commitDrainEffect(
  state: DrainEffectState,
  receipt: DrainCommittedEffect,
) {
  state.products.set(pair(receipt.product), receipt.product);
  for (const q of receipt.queues) state.queues.set(q.id, q);
  receipt.created.forEach((id) => state.created.add(id));
  receipt.cancelled.forEach((id) => state.cancelled.add(id));
  state.events.add(receipt.eventId);
}
