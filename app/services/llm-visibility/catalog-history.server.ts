import type { PrismaClient } from "@prisma/client";
import { robottoCatalogFailure, type CatalogPhase } from "./robotto-catalog-diagnostics.ts";

type CatalogDb = Pick<PrismaClient, "catalogRefreshRun">;
type CatalogResult = { status: string; sha256?: string };
const outcomes = new Set(["PUBLISHED", "UNCHANGED", "NOT_DUE", "ROLLED_BACK", "LINK_UPDATE_REQUIRED"]);

// Store only allowlisted outcome fields. Candidate URLs, tokens and provider errors stay out.
export async function recordCatalogRefresh<T extends CatalogResult>(
  db: CatalogDb,
  shopDomain: string,
  refresh: () => Promise<T>,
  currentPhase: () => CatalogPhase,
): Promise<T> {
  const run = await db.catalogRefreshRun.create({ data: { shopDomain }, select: { id: true } });
  let result: T;
  try {
    result = await refresh();
  } catch (error) {
    await db.catalogRefreshRun.update({
      where: { id: run.id },
      data: { status: "FAILED", stopReason: robottoCatalogFailure(error, currentPhase()).code, finishedAt: new Date() },
    });
    throw error;
  }
  const status = outcomes.has(result.status) ? result.status : "UNKNOWN";
  await db.catalogRefreshRun.update({
    where: { id: run.id },
    data: {
      status,
      sha256: typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256) ? result.sha256 : null,
      stopReason: ["ROLLED_BACK", "LINK_UPDATE_REQUIRED", "UNKNOWN"].includes(status) ? status : null,
      finishedAt: new Date(),
    },
  });
  return result;
}
