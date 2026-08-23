function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseIndexNowMaxItems(value: string | undefined) {
  return parseBoundedInteger(value, 1, 1, 100, "INDEXNOW_MAX_ITEMS");
}

export function parseIndexNowInterItemDelay(value: string | undefined) {
  return parseBoundedInteger(value, 500, 0, 60_000, "INDEXNOW_INTER_ITEM_DELAY_MS");
}

export function shouldClaimAnotherIndexNowItem(
  stopRequested: boolean,
  processed: number,
  maxItems: number,
) {
  return !stopRequested && processed < maxItems;
}

export function indexNowWorkerEventForOutcome(
  outcome: "completed" | "retryable_failure" | "terminal_failure" | "rejected",
) {
  if (outcome === "completed") return "indexnow_attempt_completed" as const;
  if (outcome === "retryable_failure") return "indexnow_attempt_retryable_failure" as const;
  if (outcome === "terminal_failure") return "indexnow_attempt_terminal_failure" as const;
  return "indexnow_item_rejected" as const;
}
