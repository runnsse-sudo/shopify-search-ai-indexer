import type { IndexProvider, IndexQueueAction } from "@prisma/client";

export type IndexProviderRole =
  | "SOURCE_INTENT"
  | "PRODUCT_PUSH"
  | "SEARCH_CONSOLE_STRATEGY"
  | "AI_AUDIT";

export type IndexProviderCapability = Readonly<{
  role: IndexProviderRole;
  externallyExecutable: boolean;
  productPush: boolean;
  supportedActions: readonly IndexQueueAction[];
  defaultProductPushTarget: boolean;
  productPushUnsupportedReason: string | null;
}>;

export const INDEX_PROVIDER_CAPABILITIES = {
  INTERNAL: {
    role: "SOURCE_INTENT",
    externallyExecutable: false,
    productPush: false,
    supportedActions: [],
    defaultProductPushTarget: false,
    productPushUnsupportedReason: "INTERNAL_IS_SOURCE_INTENT_ONLY",
  },
  INDEXNOW: {
    role: "PRODUCT_PUSH",
    externallyExecutable: true,
    productPush: true,
    supportedActions: ["INDEX", "DEINDEX"],
    defaultProductPushTarget: true,
    productPushUnsupportedReason: null,
  },
  BING: {
    role: "PRODUCT_PUSH",
    externallyExecutable: true,
    productPush: true,
    supportedActions: ["INDEX"],
    defaultProductPushTarget: false,
    productPushUnsupportedReason: null,
  },
  GOOGLE: {
    role: "SEARCH_CONSOLE_STRATEGY",
    externallyExecutable: false,
    productPush: false,
    supportedActions: [],
    defaultProductPushTarget: false,
    productPushUnsupportedReason: "GOOGLE_PRODUCT_PUSH_UNSUPPORTED",
  },
  AI_AUDIT: {
    role: "AI_AUDIT",
    externallyExecutable: false,
    productPush: false,
    supportedActions: [],
    defaultProductPushTarget: false,
    productPushUnsupportedReason: "AI_AUDIT_IS_NOT_PRODUCT_PUSH",
  },
} as const satisfies Record<IndexProvider, IndexProviderCapability>;

export const PRODUCT_PUSH_PROVIDER_ORDER = [
  "INDEXNOW",
  "BING",
  "GOOGLE",
  "AI_AUDIT",
  "INTERNAL",
] as const satisfies readonly IndexProvider[];

export function providerSupportsProductPushAction(
  provider: IndexProvider,
  action: IndexQueueAction,
) {
  const capability: IndexProviderCapability = INDEX_PROVIDER_CAPABILITIES[provider];
  return capability.productPush && capability.supportedActions.includes(action);
}
