// Browser-safe limits and labels; server ownership/queue code stays out of the client.
export const MAX_PRODUCT_SELECTION = 20;
export const PRODUCT_PAGE_SIZE = 25;
export const PRODUCT_STATES = ["INDEXABLE", "NOT_ACTIVE", "NOT_PUBLISHED", "UNKNOWN_PUBLICATION", "MISSING_URL"] as const;
export const PRODUCT_WORK_FILTERS = ["ACTIVE", "FAILED", "NONE"] as const;
export const PRODUCT_WORK_LABELS = { ACTIVE: "Has waiting or processing work", FAILED: "Has failed request history", NONE: "No recorded requests" };

// Selection remains page-local; the server rechecks eligibility and active work.
export function selectEligibleProducts(items: { id: string; updatedAt: Date | string; eligible: boolean }[]) {
  return items.filter((p) => p.eligible).slice(0, MAX_PRODUCT_SELECTION)
    .map((p) => `${p.id}~${new Date(p.updatedAt).toISOString()}`);
}
