export function indexNowRetryDelayMs(
  retryCount: number,
  baseMs = 60_000,
  capMs = 30 * 60_000,
) {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error("IndexNow retry count must be a non-negative integer");
  }
  return Math.min(capMs, baseMs * 2 ** retryCount);
}
