import type { IndexProvider, IndexQueueAction, Prisma } from "@prisma/client";

import {
  cancelPendingForProviderActionWithClient,
  enqueueProductWithClient,
} from "./index-queue-client.ts";
import { providerSupportsProductPushAction } from "./index-provider-capabilities.ts";
import {
  type ProductPushPlan,
  validateProductPushUrl,
} from "./index-provider-plan.ts";

export type ProductPushSource = Readonly<{
  id: string;
  shopId: string;
  productIndexStateId: string | null;
  shopifyProductGid: string;
  provider: IndexProvider;
  action: IndexQueueAction;
  url: string | null;
  reason: string;
}>;

type MaterializationDependencies = Readonly<{
  cancelPending: typeof cancelPendingForProviderActionWithClient;
  enqueue: typeof enqueueProductWithClient;
}>;

const DEFAULT_DEPENDENCIES: MaterializationDependencies = {
  cancelPending: cancelPendingForProviderActionWithClient,
  enqueue: enqueueProductWithClient,
};

function reject(reason: string): never {
  throw new Error(`Product push materialization rejected: ${reason}`);
}

function oppositeAction(action: IndexQueueAction): IndexQueueAction {
  return action === "INDEX" ? "DEINDEX" : "INDEX";
}

function validatedUniqueTargets(source: ProductPushSource, plan: ProductPushPlan) {
  if (source.provider !== "INTERNAL") reject("source provider must be INTERNAL");
  if (plan.rejectionReason !== null) reject(`plan is rejected (${plan.rejectionReason})`);

  const sourceUrl = validateProductPushUrl(source.url);
  if (sourceUrl.rejectionReason) reject(`source URL is invalid (${sourceUrl.rejectionReason})`);

  const seen = new Set<string>();
  const targets: ProductPushPlan["targets"][number][] = [];
  for (const target of plan.targets) {
    if (target.provider === "INTERNAL") reject("INTERNAL cannot be a downstream target");
    if (!providerSupportsProductPushAction(target.provider, source.action)) {
      reject(`${target.provider} does not support product-push ${source.action}`);
    }
    if (target.action !== source.action) reject("target action does not match source action");

    const targetUrl = validateProductPushUrl(target.url);
    if (targetUrl.rejectionReason) {
      reject(`target URL is invalid (${targetUrl.rejectionReason})`);
    }
    if (targetUrl.url !== sourceUrl.url) reject("target URL does not match source URL");

    const identity = `${target.provider}|${target.action}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    targets.push({ ...target, url: targetUrl.url });
  }
  return targets;
}

export async function materializeProductPushPlanWithClient(
  tx: Prisma.TransactionClient,
  input: Readonly<{ source: ProductPushSource; plan: ProductPushPlan }>,
  dependencies: MaterializationDependencies = DEFAULT_DEPENDENCIES,
) {
  const targets = validatedUniqueTargets(input.source, input.plan);
  const outcomes: Array<{
    provider: IndexProvider;
    action: IndexQueueAction;
    outcome: "CREATED" | "REFRESHED";
  }> = [];

  for (const target of targets) {
    await dependencies.cancelPending(tx, {
      shopId: input.source.shopId,
      shopifyProductGid: input.source.shopifyProductGid,
      provider: target.provider,
      action: oppositeAction(target.action),
    });
    const enqueued = await dependencies.enqueue(tx, {
      shopId: input.source.shopId,
      productIndexStateId: input.source.productIndexStateId,
      shopifyProductGid: input.source.shopifyProductGid,
      provider: target.provider,
      action: target.action,
      url: target.url,
      reason: input.source.reason,
    });
    outcomes.push({
      provider: target.provider,
      action: target.action,
      outcome: enqueued.created ? "CREATED" : "REFRESHED",
    });
  }

  return {
    sourceQueueItemId: input.source.id,
    targets: outcomes,
    skipped: input.plan.skipped,
  };
}
