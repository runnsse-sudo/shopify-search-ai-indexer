-- AlterTable
ALTER TABLE "ProductIndexState" ADD COLUMN "lastSeenScanRunId" TEXT;

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "activeKey" TEXT,
    "cursor" TEXT,
    "productsProcessed" INTEGER NOT NULL DEFAULT 0,
    "productsIndexable" INTEGER NOT NULL DEFAULT 0,
    "productsNonIndexable" INTEGER NOT NULL DEFAULT 0,
    "productsChanged" INTEGER NOT NULL DEFAULT 0,
    "queueItemsCreated" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "lastProgressAt" DATETIME,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "batchToken" TEXT,
    "batchClaimedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScanRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProductIndexState_shopId_lastSeenScanRunId_idx" ON "ProductIndexState"("shopId", "lastSeenScanRunId");
CREATE UNIQUE INDEX "ScanRun_activeKey_key" ON "ScanRun"("activeKey");
CREATE UNIQUE INDEX "ScanRun_batchToken_key" ON "ScanRun"("batchToken");
CREATE INDEX "ScanRun_shopId_createdAt_idx" ON "ScanRun"("shopId", "createdAt");
CREATE INDEX "ScanRun_status_lastProgressAt_idx" ON "ScanRun"("status", "lastProgressAt");
