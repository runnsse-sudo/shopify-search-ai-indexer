import type { PrismaClient } from "@prisma/client";
import type { RedirectDiagnostics } from "./automatic-redirect.server";
import { checkRedirectDestination } from "./redirect-audit.server";

type HistoryDb = Pick<PrismaClient, "redirectAuditRun" | "redirectAuditCreation">;
export type CreatedRedirect = { id: string; path: string; target: string };
type AuditResult = { status: string; limitsReached?: string[] };

const safeErrors = new Set([
  "SESSION_MISMATCH", "REDIRECT_SHOP_MISMATCH", "REDIRECT_ADMIN_REQUEST_FAILED",
  "REDIRECT_CREATE_UNCONFIRMED",
]);

export async function recordScheduledRedirectAudit(
  db: HistoryDb,
  shopDomain: string,
  audit: (onCreated: (redirect: CreatedRedirect) => Promise<void>, onDiagnostics: (diagnostics: RedirectDiagnostics) => void) => Promise<AuditResult>,
) {
  const run = await db.redirectAuditRun.create({ data: { shopDomain }, select: { id: true } });
  let diagnostics: RedirectDiagnostics | undefined;
  let result: AuditResult;
  try {
    result = await audit(async (redirect) => {
      await db.redirectAuditCreation.create({
        data: { runId: run.id, shopifyId: redirect.id, source: redirect.path, target: redirect.target },
      });
    }, (value) => { diagnostics = value; });
  } catch (error) {
    const reason = error instanceof Error && safeErrors.has(error.message)
      ? error.message : "AUTOMATIC_REDIRECT_AUDIT_FAILED";
    await db.redirectAuditRun.update({
      where: { id: run.id }, data: { status: "FAILED", stopReason: reason, finishedAt: new Date(), diagnostics },
    });
    throw error;
  }
  await db.redirectAuditRun.update({
    where: { id: run.id },
    data: {
      status: result.status,
      diagnostics,
      stopReason: result.status === "COMPLETE" ? null : result.limitsReached?.join(", ") || result.status,
      finishedAt: new Date(),
    },
  });
  return result;
}

export async function checkStoredRedirectTargets(
  db: HistoryDb,
  shopDomain: string,
  primaryDomain: string,
  check = checkRedirectDestination,
) {
  const pending = await db.redirectAuditCreation.findMany({
    where: { run: { shopDomain } },
    orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 10,
    select: { id: true, target: true },
  });
  const deadlineAt = Date.now() + 8_000;
  for (let offset = 0; offset < pending.length && Date.now() < deadlineAt; offset += 2) {
    await Promise.all(pending.slice(offset, offset + 2).map(async ({ id, target }) => {
      const checkedAt = new Date();
      const status = await check(primaryDomain, target, deadlineAt);
      await db.redirectAuditCreation.updateMany({
        where: { id, run: { shopDomain }, OR: [{ checkedAt: null }, { checkedAt: { lt: checkedAt } }] },
        data: { checkedAt, targetStatus: status },
      });
    }));
  }
}

export async function loadRedirectHistory(db: HistoryDb, shopDomain: string) {
  const [runs, targetIssues] = await Promise.all([
    db.redirectAuditRun.findMany({
      where: { shopDomain },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 10,
      select: {
        id: true, startedAt: true, finishedAt: true, status: true, stopReason: true, diagnostics: true,
        redirects: { orderBy: { id: "asc" }, select: { shopifyId: true, source: true, target: true } },
      },
    }),
    db.redirectAuditCreation.findMany({
      where: { run: { shopDomain }, targetStatus: { in: ["NOT_FOUND", "REDIRECTS"] } },
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      take: 25,
      select: { id: true, shopifyId: true, source: true, target: true, checkedAt: true, targetStatus: true },
    }),
  ]);
  return { runs, targetIssues };
}
