export type RepairEventCandidate = {
  shopId: string;
  shopifyProductGid: string;
  eventType: string;
  error: string | null;
  receivedAt: Date;
};

export function selectRepairProductGids(
  events: RepairEventCandidate[],
  shopId: string,
  startedAt: Date,
  completedAt: Date,
) {
  return [...new Set(events
    .filter((event) =>
      event.shopId === shopId &&
      event.eventType === "INITIAL_SCAN" &&
      event.error !== null &&
      event.receivedAt >= startedAt &&
      event.receivedAt <= completedAt,
    )
    .map((event) => event.shopifyProductGid))];
}
