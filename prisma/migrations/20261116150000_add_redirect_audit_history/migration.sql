CREATE TABLE "RedirectAuditRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stopReason" TEXT,
    CONSTRAINT "RedirectAuditRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RedirectAuditCreation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "targetStatus" TEXT,
    CONSTRAINT "RedirectAuditCreation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RedirectAuditRun_shopDomain_startedAt_idx" ON "RedirectAuditRun"("shopDomain", "startedAt");
CREATE INDEX "RedirectAuditCreation_runId_idx" ON "RedirectAuditCreation"("runId");

ALTER TABLE "RedirectAuditRun" ADD CONSTRAINT "RedirectAuditRun_shopDomain_fkey"
    FOREIGN KEY ("shopDomain") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RedirectAuditCreation" ADD CONSTRAINT "RedirectAuditCreation_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "RedirectAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
