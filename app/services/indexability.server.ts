import type { IndexabilityState } from "@prisma/client";

export type IndexabilityInput = {
  status: string;
  onlineStoreUrl: string | null;
  publishedAt: string | null;
};

export function evaluateIndexability(input: IndexabilityInput): IndexabilityState {
  if (input.status !== "ACTIVE") return "NOT_ACTIVE";
  if (!input.onlineStoreUrl) return "NOT_PUBLISHED";
  try {
    const url = new URL(input.onlineStoreUrl);
    if (url.protocol !== "https:" || !url.hostname) return "MISSING_URL";
  } catch {
    return "MISSING_URL";
  }
  return "INDEXABLE";
}
