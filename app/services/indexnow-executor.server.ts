import type { IndexQueueAction, IndexQueueItem } from "@prisma/client";
import { providerSupportsProductPushAction } from "./index-provider-capabilities.ts";
import {
  prepareIndexNowRequest,
  sanitizeIndexNowResult,
  type IndexNowClientResult,
} from "./indexnow-client.ts";
import { parseIndexNowExecutionConfig } from "./indexnow-execution-config.ts";
import { indexNowRetryDelayMs } from "./indexnow-retry.ts";

type IndexAttemptWrite = {
  shopId: string;
  queueItemId: string;
  provider: "INDEXNOW";
  successful: boolean;
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date;
};

type QueueTransitionResult = { outcome: string; item?: unknown };
type IndexNowPreInvocationDetails = Readonly<{
  queueItemId: string;
  shopId: string;
  action: IndexQueueAction;
  host: string;
}>;

export type IndexNowExecutorDependencies = {
  resolveShopId: (domain: string) => Promise<string | null>;
  recover: (input: { provider: "INDEXNOW"; limit: number; shopId?: string }) => Promise<unknown>;
  claim: (provider: "INDEXNOW", shopId?: string) => Promise<IndexQueueItem | null>;
  invoke: (request: ReturnType<typeof prepareIndexNowRequest>) => Promise<IndexNowClientResult>;
  createAttempt: (input: IndexAttemptWrite) => Promise<{ attemptNumber: number }>;
  complete: (id: string, claimedAt: Date) => Promise<QueueTransitionResult>;
  fail: (id: string, claimedAt: Date, error: string, retryAt?: Date, terminal?: boolean) => Promise<QueueTransitionResult>;
  now: () => Date;
  beforeInvoke?: (details: IndexNowPreInvocationDetails) => void | Promise<void>;
};

function safeError(result: IndexNowClientResult) {
  return (result.error ?? `IndexNow failed with HTTP ${result.responseCode ?? "unknown"}`).slice(0, 2000);
}

export async function executeOneIndexNowItem(
  env: Record<string, string | undefined>,
  dependencies: IndexNowExecutorDependencies,
) {
  const config = parseIndexNowExecutionConfig(env);
  if (!config.enabled) return { outcome: "disabled" as const };

  let selectedShopId: string | undefined;
  if (config.shopDomain) {
    selectedShopId = await dependencies.resolveShopId(config.shopDomain) ?? undefined;
    if (!selectedShopId) throw new Error("INDEXNOW_SHOP_DOMAIN did not match a configured shop");
  }

  await dependencies.recover({ provider: "INDEXNOW", limit: 25, shopId: selectedShopId });
  const item = await dependencies.claim("INDEXNOW", selectedShopId);
  if (!item) return { outcome: "no_work" as const };
  if (item.provider !== "INDEXNOW") throw new Error("IndexNow executor claimed a non-INDEXNOW item");
  if (!item.claimedAt || item.status !== "PROCESSING") {
    throw new Error("IndexNow executor claim is missing its ownership token");
  }
  if (selectedShopId && item.shopId !== selectedShopId) {
    throw new Error("IndexNow executor claimed an item outside the selected shop scope");
  }

  const rejectClaim = async (reason: string) => {
    const transition = await dependencies.fail(item.id, item.claimedAt!, reason, undefined, true);
    return { outcome: "rejected" as const, queueItemId: item.id, reason, transition };
  };

  if (!providerSupportsProductPushAction("INDEXNOW", item.action as IndexQueueAction)) {
    return rejectClaim("IndexNow action is unsupported");
  }
  if (!item.url) return rejectClaim("IndexNow queue item URL is missing");

  let prepared: ReturnType<typeof prepareIndexNowRequest>;
  try {
    prepared = prepareIndexNowRequest({ url: item.url, key: config.key, keyLocation: config.keyLocation });
  } catch (error) {
    return rejectClaim(error instanceof Error ? error.message : "IndexNow readiness rejected");
  }
  if (config.allowedHost && prepared.host.toLowerCase() !== config.allowedHost) {
    return rejectClaim("IndexNow URL host is outside INDEXNOW_ALLOWED_HOST");
  }

  await dependencies.beforeInvoke?.({
    queueItemId: item.id,
    shopId: item.shopId,
    action: item.action,
    host: prepared.host,
  });
  const startedAt = dependencies.now();
  const result = sanitizeIndexNowResult(await dependencies.invoke(prepared), config.key);
  const completedAt = dependencies.now();
  const attempt = await dependencies.createAttempt({
    shopId: item.shopId,
    queueItemId: item.id,
    provider: "INDEXNOW",
    successful: result.successful,
    responseCode: result.responseCode,
    responseBody: result.responseBody,
    error: result.error,
    startedAt,
    completedAt,
  });

  if (result.successful) {
    const transition = await dependencies.complete(item.id, item.claimedAt);
    return { outcome: "completed" as const, queueItemId: item.id, attemptNumber: attempt.attemptNumber, transition };
  }

  const error = safeError(result);
  const retryAt = result.retryable
    ? new Date(completedAt.getTime() + indexNowRetryDelayMs(item.retryCount))
    : undefined;
  const transition = await dependencies.fail(
    item.id,
    item.claimedAt,
    error,
    retryAt,
    !result.retryable,
  );
  return {
    outcome: result.retryable ? "retryable_failure" as const : "terminal_failure" as const,
    queueItemId: item.id,
    attemptNumber: attempt.attemptNumber,
    transition,
  };
}
