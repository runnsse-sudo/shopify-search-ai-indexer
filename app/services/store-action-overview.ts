import type { PrismaClient } from "@prisma/client";

type OverviewDb = Pick<PrismaClient, "catalogRefreshRun" | "redirectAuditRun" | "redirectAuditCreation">;
type Run = { status: string; startedAt: Date; finishedAt: Date | null; stopReason: string | null };
const catalogSuccess = ["PUBLISHED", "UNCHANGED"];
const safeReason = (value: string | null) => value && /^[A-Z0-9_]+(?:, [A-Z0-9_]+)*$/.test(value) && value.length <= 200 ? value : null;

export type ActionCard = {
  title: string;
  href: string;
  state: "attention" | "current" | "unknown";
  status: string;
  observedAt: string | null;
  lastSuccessAt: string | null;
  message: string;
  change: string | null;
  reason: string | null;
};

function card(title: string, href: string, run: Run | undefined, success: Run | null, now: number): ActionCard {
  const result: ActionCard = {
    title, href, state: "unknown", status: run?.status ?? "NO_HISTORY",
    observedAt: run?.startedAt.toISOString() ?? null,
    lastSuccessAt: success?.finishedAt?.toISOString() ?? null,
    message: "No recorded run yet. Open the details to review setup and available evidence.",
    change: null, reason: safeReason(run?.stopReason ?? null),
  };
  if (!run) return result;
  if (run.startedAt.getTime() > now || (success?.finishedAt?.getTime() ?? 0) > now) {
    return { ...result, message: "Recorded time is in the future. Review the run timestamps." };
  }
  if (run.status === "RUNNING") {
    const overdue = now - run.startedAt.getTime() > 2 * 60 * 60 * 1000;
    return { ...result, state: overdue ? "attention" : "unknown", message: overdue
      ? "This run has no recorded completion after two hours. Review its logs before retrying."
      : "A run has started. Its result is still pending." };
  }
  if (!["COMPLETE", "PUBLISHED", "UNCHANGED", "NOT_DUE"].includes(run.status)) {
    const advice: Record<string, string> = {
      WRITE_FILES_NOT_GRANTED: "Open AI / LLM visibility and review file access for this store.",
      CATALOG_SESSION_MISMATCH: "Review this store's Shopify connection before retrying.",
      CATALOG_PUBLICATION_LOCKED: "Another publication lock exists. Review its owner and run status before retrying.",
      LINK_UPDATE_REQUIRED: "The catalog needs a verified link handover. Review the catalog connection.",
      ROLLED_BACK: "The previous catalog was restored. Review publication verification before retrying.",
      PUBLIC_HASH_NOT_VERIFIED: "The public file could not be verified. Review its download link and CDN evidence.",
      INCOMPLETE_SITEMAP: "The sitemap audit was incomplete. Review the coverage limits in the audit details.",
    };
    return { ...result, state: "attention", message: advice[result.reason ?? run.status] ?? "The latest run needs review. Open its details before taking action." };
  }
  if (!success?.finishedAt) return { ...result, message: "No completed verification has been recorded yet." };
  // A skipped daily attempt does not refresh the last successful verification time.
  const stale = now - success.finishedAt.getTime() > 36 * 60 * 60 * 1000;
  return { ...result, state: stale ? "attention" : "current", message: stale
    ? "The last successful verification is over 36 hours old. Review the scheduled job."
    : "The latest recorded verification completed successfully." };
}

export async function readStoreActionOverview(db: OverviewDb, shopDomain: string, now = new Date()) {
  const unavailable = (title: string, href: string): ActionCard => ({
    title, href, state: "unknown", status: "UNAVAILABLE", observedAt: null, lastSuccessAt: null,
    message: "History could not be read. Reload the page or review the service logs.", change: null, reason: null,
  });
  const [catalog, redirects] = await Promise.all([
    (async () => {
      const [runs, success] = await Promise.all([
        db.catalogRefreshRun.findMany({ where: { shopDomain, status: { not: "NOT_DUE" } },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 2,
          select: { status: true, startedAt: true, finishedAt: true, stopReason: true, sha256: true } }),
        db.catalogRefreshRun.findFirst({ where: { shopDomain, status: { in: catalogSuccess } },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: { status: true, startedAt: true, finishedAt: true, stopReason: true } }),
      ]);
      const summary = card("LLM catalog", "/app/llm-visibility", runs[0], success, now.getTime());
      const [latest, previous] = runs;
      if (latest && catalogSuccess.includes(latest.status)) {
        summary.message += latest.status === "PUBLISHED" ? " A catalog file was published." : " Product links were unchanged.";
        if (previous && catalogSuccess.includes(previous.status) && latest.sha256 && previous.sha256) {
          summary.change = latest.sha256 === previous.sha256 ? "Same file SHA256 as the previous recorded verification." : "File SHA256 changed since the previous recorded verification.";
        }
      }
      return summary;
    })().catch(() => unavailable("LLM catalog", "/app/llm-visibility")),
    (async () => {
      const [runs, success, issueCount, issues] = await Promise.all([
        db.redirectAuditRun.findMany({ where: { shopDomain }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 2,
          select: { status: true, startedAt: true, finishedAt: true, stopReason: true, _count: { select: { redirects: true } } } }),
        db.redirectAuditRun.findFirst({ where: { shopDomain, status: "COMPLETE" }, orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: { status: true, startedAt: true, finishedAt: true, stopReason: true } }),
        db.redirectAuditCreation.count({ where: { run: { shopDomain }, targetStatus: { in: ["NOT_FOUND", "REDIRECTS"] } } }),
        db.redirectAuditCreation.findMany({ where: { run: { shopDomain }, targetStatus: { in: ["NOT_FOUND", "REDIRECTS"] } },
          orderBy: [{ checkedAt: "desc" }, { id: "desc" }], take: 5,
          select: { shopifyId: true, source: true, target: true, targetStatus: true, checkedAt: true } }),
      ]);
      const summary = card("404 & redirect audit", "/app/redirect-audit", runs[0], success, now.getTime());
      const [latest, previous] = runs;
      if (latest) summary.change = `${latest._count.redirects} redirects recorded in the latest run.` +
        (previous ? ` Previous run: ${previous._count.redirects}.` : "");
      if (issueCount > 0) {
        summary.state = "attention";
        summary.message += ` ${issueCount} recorded target checks need attention. Open the audit to review them.`;
      }
      return { summary, issueCount, issues };
    })().catch(() => ({ summary: unavailable("404 & redirect audit", "/app/redirect-audit"), issueCount: null, issues: [] })),
  ]);
  return { shopDomain, observedAt: now.toISOString(), catalog, redirects };
}
