import { Prisma, type PrismaClient } from "@prisma/client";
import { isDiscoveryPath, type DiscoveryObservation } from "./discovery-import";

type QueueRow = {
  path: string;
  status: DiscoveryObservation["status"] | "PENDING";
  firstSeenAt: Date;
  importedAt: Date | null;
  lastCheckedAt: Date | null;
};

export function loadDiscoveryQueue(prisma: PrismaClient, shopId: string) {
  return prisma.$queryRaw<QueueRow[]>`
    SELECT "path", "status", "firstSeenAt", "importedAt", "lastCheckedAt"
    FROM "RedirectDiscoveryEntry"
    WHERE "shopId" = ${shopId}
    ORDER BY CASE "status" WHEN 'PENDING' THEN 0 WHEN 'UNVERIFIED' THEN 1
      WHEN 'DIRECT_404' THEN 2 ELSE 3 END, "lastCheckedAt" ASC NULLS FIRST, "path" ASC
    LIMIT 100
  `;
}

export async function rememberDiscoveryImport(
  prisma: PrismaClient,
  shopId: string,
  paths: readonly string[],
  observedAt: Date,
) {
  if (!paths.length) return;
  const rows = [...new Set(paths)].filter(isDiscoveryPath).sort()
    .map((path) => Prisma.sql`(${shopId}, ${path}, ${observedAt}, ${observedAt}, 'PENDING')`);
  if (!rows.length) return;
  await prisma.$executeRaw`
    INSERT INTO "RedirectDiscoveryEntry" ("shopId", "path", "firstSeenAt", "importedAt", "status")
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("shopId", "path") DO UPDATE SET
      "firstSeenAt" = LEAST("RedirectDiscoveryEntry"."firstSeenAt", EXCLUDED."firstSeenAt"),
      "importedAt" = GREATEST("RedirectDiscoveryEntry"."importedAt", EXCLUDED."importedAt")
  `;
}

export async function rememberDiscoveryObservations(
  prisma: PrismaClient,
  shopId: string,
  observations: readonly DiscoveryObservation[],
  observedAt: Date,
) {
  const distinct = new Map(observations.map((observation) => [observation.path, observation]));
  const rows = [...distinct.values()].filter(({ path }) => isDiscoveryPath(path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, status }) => Prisma.sql`(${path}, ${status})`);
  if (!rows.length) return;

  await prisma.$executeRaw`
    INSERT INTO "RedirectDiscoveryEntry" ("shopId", "path", "firstSeenAt", "lastCheckedAt", "status")
    SELECT ${shopId}, observed.path, ${observedAt}, ${observedAt}, observed.status
    FROM (VALUES ${Prisma.join(rows)}) AS observed(path, status)
    WHERE observed.status <> 'OTHER_RESPONSE' OR EXISTS (
      SELECT 1 FROM "RedirectDiscoveryEntry" existing
      WHERE existing."shopId" = ${shopId} AND existing."path" = observed.path
    )
    ON CONFLICT ("shopId", "path") DO UPDATE SET
      "firstSeenAt" = LEAST("RedirectDiscoveryEntry"."firstSeenAt", EXCLUDED."firstSeenAt"),
      "lastCheckedAt" = EXCLUDED."lastCheckedAt",
      "status" = EXCLUDED."status"
    WHERE "RedirectDiscoveryEntry"."lastCheckedAt" IS NULL
       OR "RedirectDiscoveryEntry"."lastCheckedAt" < EXCLUDED."lastCheckedAt"
  `;
}
