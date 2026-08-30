CREATE TYPE "SeoAuditRunStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "SeoAuditRun" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "status" "SeoAuditRunStatus" NOT NULL DEFAULT 'PENDING',
  "activeKey" TEXT,
  "cursorProductGid" TEXT,
  "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
  "pagesSucceeded" INTEGER NOT NULL DEFAULT 0,
  "pagesFailed" INTEGER NOT NULL DEFAULT 0,
  "criticalCount" INTEGER NOT NULL DEFAULT 0,
  "highCount" INTEGER NOT NULL DEFAULT 0,
  "mediumCount" INTEGER NOT NULL DEFAULT 0,
  "lowCount" INTEGER NOT NULL DEFAULT 0,
  "infoCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "lastProgressAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "batchToken" TEXT,
  "batchClaimedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SeoAuditRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoAuditPage" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "productIndexStateId" TEXT,
  "shopifyProductGid" TEXT NOT NULL,
  "requestedUrl" TEXT NOT NULL,
  "finalUrl" TEXT,
  "statusCode" INTEGER,
  "redirectChain" JSONB,
  "title" TEXT,
  "metaDescription" TEXT,
  "h1Count" INTEGER,
  "canonicalUrl" TEXT,
  "canonicalLinks" JSONB,
  "robotsMeta" JSONB,
  "xRobotsTag" TEXT,
  "noindex" BOOLEAN,
  "jsonLdScriptCount" INTEGER NOT NULL DEFAULT 0,
  "jsonLdTypeCounts" JSONB,
  "jsonLdNodes" JSONB,
  "issues" JSONB,
  "criticalCount" INTEGER NOT NULL DEFAULT 0,
  "highCount" INTEGER NOT NULL DEFAULT 0,
  "mediumCount" INTEGER NOT NULL DEFAULT 0,
  "lowCount" INTEGER NOT NULL DEFAULT 0,
  "infoCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "auditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SeoAuditPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoAuditRun_activeKey_key"
ON "SeoAuditRun"("activeKey");

CREATE UNIQUE INDEX "SeoAuditRun_batchToken_key"
ON "SeoAuditRun"("batchToken");

CREATE INDEX "SeoAuditRun_shopId_createdAt_idx"
ON "SeoAuditRun"("shopId", "createdAt");

CREATE INDEX "SeoAuditRun_status_lastProgressAt_idx"
ON "SeoAuditRun"("status", "lastProgressAt");

CREATE UNIQUE INDEX "SeoAuditPage_runId_shopifyProductGid_key"
ON "SeoAuditPage"("runId", "shopifyProductGid");

CREATE INDEX "SeoAuditPage_shopId_auditedAt_idx"
ON "SeoAuditPage"("shopId", "auditedAt");

CREATE INDEX "SeoAuditPage_runId_statusCode_idx"
ON "SeoAuditPage"("runId", "statusCode");

CREATE INDEX "SeoAuditPage_runId_criticalCount_highCount_idx"
ON "SeoAuditPage"("runId", "criticalCount", "highCount");

ALTER TABLE "SeoAuditRun"
ADD CONSTRAINT "SeoAuditRun_shopId_fkey"
FOREIGN KEY ("shopId")
REFERENCES "Shop"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "SeoAuditPage"
ADD CONSTRAINT "SeoAuditPage_runId_fkey"
FOREIGN KEY ("runId")
REFERENCES "SeoAuditRun"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "SeoAuditPage"
ADD CONSTRAINT "SeoAuditPage_shopId_fkey"
FOREIGN KEY ("shopId")
REFERENCES "Shop"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "SeoAuditPage"
ADD CONSTRAINT "SeoAuditPage_productIndexStateId_fkey"
FOREIGN KEY ("productIndexStateId")
REFERENCES "ProductIndexState"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;