import { setTimeout, clearTimeout } from "node:timers";
import { parseProductWebhookDrain, drainNeed } from "./product-webhook-drain-contract.ts";

// Whole enabled invocation, starting BEFORE lease acquisition (including disconnect).
// Fixed, not environment-configurable: 240s + 60s <= every allowed lease/stale TTL.
export const PRODUCT_WEBHOOK_HARD_LIMIT_MS = 240000;
export const PRODUCT_WEBHOOK_SAFETY_MARGIN_MS = 60000;
export const PRODUCT_WEBHOOK_CLAIM_STALE_MIN_MS =
  PRODUCT_WEBHOOK_HARD_LIMIT_MS + PRODUCT_WEBHOOK_SAFETY_MARGIN_MS;

export function startProductWebhookWatchdog() {
  const timer = setTimeout(() => {
    console.error(JSON.stringify({ event: "product_webhook_worker_failed", code: "HARD_LIFETIME_EXCEEDED" }));
    // exitCode / rejected promises cannot stop an uncancellable SDK refresh.
    process.exit(1);
  }, PRODUCT_WEBHOOK_HARD_LIMIT_MS);
  return () => clearTimeout(timer);
}

export class WebhookOwnershipLostError extends Error {
  constructor() {
    super("WEBHOOK_OWNERSHIP_LOST");
  }
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("INVALID_PRODUCT_WEBHOOK_CONFIG");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error("INVALID_PRODUCT_WEBHOOK_CONFIG");
  return parsed;
}

export function productWebhookConfig(env: Record<string, string | undefined>) {
  const drain = parseProductWebhookDrain(env);
  if (drain) drainNeed((env.PRODUCT_WEBHOOK_WORKER_MAX_ITEMS === undefined || env.PRODUCT_WEBHOOK_WORKER_MAX_ITEMS === "20") && (env.PRODUCT_WEBHOOK_WORKER_INTER_ITEM_DELAY_MS === undefined || env.PRODUCT_WEBHOOK_WORKER_INTER_ITEM_DELAY_MS === "1000"), "DRAIN_CONFIG_INVALID");
  const enabled = env.PRODUCT_WEBHOOK_WORKER_ENABLED;
  if (enabled !== undefined && enabled !== "true" && enabled !== "false")
    throw new Error("INVALID_PRODUCT_WEBHOOK_CONFIG");
  return {
    enabled: enabled === "true",
    maxItems: integer(env.PRODUCT_WEBHOOK_WORKER_MAX_ITEMS, drain ? 20 : 10, 1, 25),
    interItemDelayMs: integer(
      env.PRODUCT_WEBHOOK_WORKER_INTER_ITEM_DELAY_MS,
      1000,
      500,
      10000,
    ),
    maxAttempts: integer(env.PRODUCT_WEBHOOK_WORKER_MAX_ATTEMPTS, 8, 1, 12),
    claimStaleMs: integer(
      env.PRODUCT_WEBHOOK_WORKER_CLAIM_STALE_MS,
      900000,
      PRODUCT_WEBHOOK_CLAIM_STALE_MIN_MS,
      3600000,
    ),
    maxItemsPerShop: 2,
    drain,
  };
}
export type ProductWebhookConfig = ReturnType<typeof productWebhookConfig>;
export type ProductWebhookErrorClass =
  | "THROTTLED"
  | "UPSTREAM_5XX"
  | "NETWORK"
  | "ADMIN_UNAVAILABLE"
  | "DATABASE_TRANSIENT"
  | "APPLICATION_ERROR"
  | "INVALID_WORK"
  | "ATTEMPTS_EXHAUSTED";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function classifyProductWebhookError(error: unknown): {
  code: ProductWebhookErrorClass;
  retryable: boolean;
} {
  const e = object(error),
    body = object(e.body),
    errors = object(body.errors);
  const structured = [
    e.errors,
    body.errors,
    errors.graphQLErrors,
    e.graphQLErrors,
  ];
  const codes = structured
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map((value) => object(object(value).extensions).code);
  const status = Number(
    e.status ??
      e.statusCode ??
      object(e.response).status ??
      object(e.response).code,
  );
  if (codes.includes("THROTTLED") || status === 429)
    return { code: "THROTTLED", retryable: true };
  if (
    (status >= 500 && status <= 599) ||
    codes.includes("INTERNAL_SERVER_ERROR")
  )
    return { code: "UPSTREAM_5XX", retryable: true };
  const networkCode = e.code ?? object(e.cause).code;
  // Shopify's HttpRequestError wraps a no-response network failure without preserving its cause.
  const sdkClass = error instanceof Error ? error.constructor.name : e.name;
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ].includes(String(networkCode)) ||
    ["AbortError", "TimeoutError"].includes(String(e.name)) ||
    sdkClass === "HttpRequestError"
  )
    return { code: "NETWORK", retryable: true };
  if (
    ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(
      String(e.code),
    )
  )
    return { code: "DATABASE_TRANSIENT", retryable: true };
  // SDK fallback only: never persist the source message or use it as the sole structured-code check.
  if (
    sdkClass === "GraphqlQueryError" &&
    /\bthrottled\b/i.test(String(e.message))
  )
    return { code: "THROTTLED", retryable: true };
  return { code: "APPLICATION_ERROR", retryable: false };
}

export function productWebhookBackoffMs(attempt: number) {
  const schedule = [30000, 120000, 300000, 900000, 1800000];
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("INVALID_WEBHOOK_ATTEMPT");
  return schedule[Math.min(attempt - 1, schedule.length - 1)];
}

export function productWebhookFailure(
  attempt: number,
  maxAttempts: number,
  error: ReturnType<typeof classifyProductWebhookError>,
  now: Date,
) {
  return {
    status:
      error.retryable && attempt < maxAttempts
        ? ("RETRY" as const)
        : ("FAILED" as const),
    nextAttemptAt: new Date(now.getTime() + productWebhookBackoffMs(attempt)),
    lastErrorClass: error.code,
  };
}
