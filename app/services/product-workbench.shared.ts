// Browser-safe limits and labels; server ownership/queue code stays out of the client.
export const MAX_PRODUCT_SELECTION = 20;
export const PRODUCT_PAGE_SIZE = 25;
export const PRODUCT_STATES = ["INDEXABLE", "NOT_ACTIVE", "NOT_PUBLISHED", "UNKNOWN_PUBLICATION", "MISSING_URL"] as const;
