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

export const queuePageSize = 25;
export const queueFilters = ["PENDING", "UNVERIFIED", "DIRECT_404", "OTHER_RESPONSE"] as const;
export type QueueFilter = typeof queueFilters[number];

export function discoveryQueueView(params: URLSearchParams) {
  const status = queueFilters.find((value) => value === params.get("queueStatus"));
  const pageParam = params.get("queuePage") ?? "";
  const page = /^\d{1,6}$/.test(pageParam) ? Math.max(1, Number(pageParam)) : 1;
  return { status, page };
}

export async function discoveryQueueCounts(prisma: PrismaClient, shopId: string) {
  const rows = await prisma.$queryRaw<{ status: QueueFilter; count: bigint }[]>`
    SELECT "status", COUNT(*) AS count FROM "RedirectDiscoveryEntry"
    WHERE "shopId" = ${shopId} GROUP BY "status"
  `;
  const counts: Record<QueueFilter, number> = { PENDING: 0, UNVERIFIED: 0, DIRECT_404: 0, OTHER_RESPONSE: 0 };
  for (const { status, count } of rows) counts[status] = Number(count);
  return counts;
}

export async function loadDiscoveryQueuePage(prisma: PrismaClient, shopId: string, shopDomain: string,
  view: ReturnType<typeof discoveryQueueView>) {
  const counts = await discoveryQueueCounts(prisma, shopId);
  const total = view.status ? counts[view.status] : Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pages = Math.max(1, Math.ceil(total / queuePageSize));
  const page = Math.min(view.page, pages);
  const filter = view.status ? Prisma.sql`AND q."status" = ${view.status}` : Prisma.empty;
  const rows = await prisma.$queryRaw<(QueueRow & { failure: DiscoveryObservation | null })[]>`
    SELECT q."path", q."status", q."firstSeenAt", q."importedAt", q."lastCheckedAt", detail.failure
    FROM (
      SELECT * FROM "RedirectDiscoveryEntry" q WHERE q."shopId" = ${shopId} ${filter}
      ORDER BY CASE q."status" WHEN 'PENDING' THEN 0 WHEN 'UNVERIFIED' THEN 1
        WHEN 'DIRECT_404' THEN 2 ELSE 3 END, q."lastCheckedAt" ASC NULLS FIRST, q."path"
      LIMIT ${queuePageSize} OFFSET ${(page - 1) * queuePageSize}
    ) q LEFT JOIN LATERAL (
      SELECT item AS failure FROM "RedirectAuditRun" r
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(r.diagnostics->'queueFailures') = 'array'
          THEN r.diagnostics->'queueFailures' ELSE '[]'::jsonb END
      ) item
      WHERE q."status" = 'UNVERIFIED' AND r."shopDomain" = ${shopDomain}
        AND r."startedAt" BETWEEN q."lastCheckedAt" - interval '1 second' AND q."lastCheckedAt" + interval '1 minute'
        AND r.diagnostics->>'queueObservationAt' = to_char(q."lastCheckedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND item->>'path' = q."path"
      ORDER BY r."startedAt" DESC, r.id DESC LIMIT 1
    ) detail ON true
    ORDER BY CASE q."status" WHEN 'PENDING' THEN 0 WHEN 'UNVERIFIED' THEN 1
      WHEN 'DIRECT_404' THEN 2 ELSE 3 END, q."lastCheckedAt" ASC NULLS FIRST, q."path"
  `;
  return { rows, counts, total, pages, page, status: view.status };
}

export async function selectedDiscoveryPaths(prisma: PrismaClient, shopId: string, requested: readonly string[]) {
  const paths = [...new Set(requested)];
  if (paths.length < 1 || paths.length > 5 || requested.length !== paths.length || !paths.every(isDiscoveryPath)) return null;
  const rows = await prisma.$queryRaw<{ path: string }[]>`
    SELECT "path" FROM "RedirectDiscoveryEntry"
    WHERE "shopId" = ${shopId} AND "status" = 'UNVERIFIED' AND "path" IN (${Prisma.join(paths)})
  `;
  return rows.length === paths.length ? paths : null;
}
