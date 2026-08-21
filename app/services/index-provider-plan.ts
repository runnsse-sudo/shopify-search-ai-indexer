import type { IndexProvider, IndexQueueAction } from "@prisma/client";

import {
  INDEX_PROVIDER_CAPABILITIES,
  PRODUCT_PUSH_PROVIDER_ORDER,
  providerSupportsProductPushAction,
} from "./index-provider-capabilities.ts";

export type ProductPushPlanRejectionReason =
  | "SOURCE_PROVIDER_NOT_INTERNAL"
  | "URL_REQUIRED"
  | "URL_INVALID"
  | "URL_NOT_HTTPS";

export type ProductPushPlanSkippedReason =
  | "ACTION_UNSUPPORTED"
  | "INTERNAL_IS_SOURCE_INTENT_ONLY"
  | "GOOGLE_PRODUCT_PUSH_UNSUPPORTED"
  | "AI_AUDIT_IS_NOT_PRODUCT_PUSH";

export type ProductPushPlanInput = Readonly<{
  sourceProvider: IndexProvider;
  action: IndexQueueAction;
  url: string | null;
  explicitlyEnabledProviders?: readonly IndexProvider[];
}>;

export type ProductPushPlan = Readonly<{
  rejectionReason: ProductPushPlanRejectionReason | null;
  targets: readonly Readonly<{
    provider: IndexProvider;
    action: IndexQueueAction;
    url: string;
  }>[];
  skipped: readonly Readonly<{
    provider: IndexProvider;
    reason: ProductPushPlanSkippedReason;
  }>[];
}>;

export function validateProductPushUrl(url: string | null) {
  const candidate = url?.trim();
  if (!candidate) return { url: null, rejectionReason: "URL_REQUIRED" } as const;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") {
      return { url: null, rejectionReason: "URL_NOT_HTTPS" } as const;
    }
    return { url: candidate, rejectionReason: null } as const;
  } catch {
    return { url: null, rejectionReason: "URL_INVALID" } as const;
  }
}

export function planProductPush(input: ProductPushPlanInput): ProductPushPlan {
  if (input.sourceProvider !== "INTERNAL") {
    return { rejectionReason: "SOURCE_PROVIDER_NOT_INTERNAL", targets: [], skipped: [] };
  }

  const validatedUrl = validateProductPushUrl(input.url);
  if (validatedUrl.rejectionReason) {
    return { rejectionReason: validatedUrl.rejectionReason, targets: [], skipped: [] };
  }

  const selectedProviders = new Set<IndexProvider>(
    Object.entries(INDEX_PROVIDER_CAPABILITIES)
      .filter(([, capability]) => capability.defaultProductPushTarget)
      .map(([provider]) => provider as IndexProvider),
  );
  for (const provider of input.explicitlyEnabledProviders ?? []) selectedProviders.add(provider);

  const targets: ProductPushPlan["targets"][number][] = [];
  const skipped: ProductPushPlan["skipped"][number][] = [];

  for (const provider of PRODUCT_PUSH_PROVIDER_ORDER) {
    if (!selectedProviders.has(provider)) continue;

    const capability = INDEX_PROVIDER_CAPABILITIES[provider];
    if (!capability.productPush) {
      skipped.push({
        provider,
        reason: capability.productPushUnsupportedReason as ProductPushPlanSkippedReason,
      });
      continue;
    }
    if (!providerSupportsProductPushAction(provider, input.action)) {
      skipped.push({ provider, reason: "ACTION_UNSUPPORTED" });
      continue;
    }
    targets.push({ provider, action: input.action, url: validatedUrl.url });
  }

  return { rejectionReason: null, targets, skipped };
}
