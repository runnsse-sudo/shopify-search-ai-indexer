-- CreateTable and enums are represented as text/check-free values by SQLite.
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "primaryDomain" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

CREATE TABLE "ProductIndexState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "legacyProductId" TEXT,
    "handle" TEXT,
    "canonicalUrl" TEXT,
    "candidateUrl" TEXT,
    "title" TEXT,
    "productStatus" TEXT,
    "indexabilityState" TEXT NOT NULL DEFAULT 'UNKNOWN_PUBLICATION',
    "published" BOOLEAN,
    "shopifyPublishedAt" DATETIME,
    "deletedAt" DATETIME,
    "shopifyUpdatedAt" DATETIME,
    "contentHash" TEXT,
    "previousContentHash" TEXT,
    "lastDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastQueuedAt" DATETIME,
    "lastIndexedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductIndexState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ProductIndexState_shopId_shopifyProductGid_key" ON "ProductIndexState"("shopId", "shopifyProductGid");
CREATE INDEX "ProductIndexState_shopId_indexabilityState_idx" ON "ProductIndexState"("shopId", "indexabilityState");

CREATE TABLE "IndexEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "productIndexStateId" TEXT,
    "shopifyProductGid" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "meaningfulContentChanged" BOOLEAN NOT NULL,
    "oldHash" TEXT,
    "newHash" TEXT,
    "metadata" JSONB,
    "error" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IndexEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IndexEvent_productIndexStateId_fkey" FOREIGN KEY ("productIndexStateId") REFERENCES "ProductIndexState" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "IndexEvent_shopId_receivedAt_idx" ON "IndexEvent"("shopId", "receivedAt");
CREATE INDEX "IndexEvent_shopifyProductGid_eventType_idx" ON "IndexEvent"("shopifyProductGid", "eventType");

CREATE TABLE "IndexQueueItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "productIndexStateId" TEXT,
    "shopifyProductGid" TEXT NOT NULL,
    "url" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'INTERNAL',
    "action" TEXT NOT NULL DEFAULT 'INDEX',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IndexQueueItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IndexQueueItem_productIndexStateId_fkey" FOREIGN KEY ("productIndexStateId") REFERENCES "ProductIndexState" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "IndexQueueItem_status_nextAttemptAt_idx" ON "IndexQueueItem"("status", "nextAttemptAt");
CREATE UNIQUE INDEX "IndexQueueItem_dedupeKey_key" ON "IndexQueueItem"("dedupeKey");
CREATE INDEX "IndexQueueItem_shopId_shopifyProductGid_provider_action_status_idx" ON "IndexQueueItem"("shopId", "shopifyProductGid", "provider", "action", "status");

CREATE TABLE "IndexAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "queueItemId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "successful" BOOLEAN NOT NULL,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "IndexAttempt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IndexAttempt_queueItemId_fkey" FOREIGN KEY ("queueItemId") REFERENCES "IndexQueueItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IndexAttempt_queueItemId_attemptNumber_key" ON "IndexAttempt"("queueItemId", "attemptNumber");
CREATE INDEX "IndexAttempt_shopId_provider_startedAt_idx" ON "IndexAttempt"("shopId", "provider", "startedAt");
