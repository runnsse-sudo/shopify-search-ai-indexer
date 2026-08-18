-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "IndexabilityState" AS ENUM ('INDEXABLE', 'NOT_ACTIVE', 'NOT_PUBLISHED', 'UNKNOWN_PUBLICATION', 'MISSING_URL');
CREATE TYPE "IndexEventType" AS ENUM ('CREATED', 'UPDATED', 'DELETED', 'INITIAL_SCAN', 'MANUAL_SCAN');
CREATE TYPE "IndexQueueStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED');
CREATE TYPE "IndexProvider" AS ENUM ('INTERNAL', 'BING', 'INDEXNOW', 'GOOGLE', 'AI_AUDIT');
CREATE TYPE "IndexQueueAction" AS ENUM ('INDEX', 'DEINDEX');
CREATE TYPE "ScanRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "primaryDomain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductIndexState" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "legacyProductId" TEXT,
    "handle" TEXT,
    "canonicalUrl" TEXT,
    "candidateUrl" TEXT,
    "title" TEXT,
    "productStatus" TEXT,
    "indexabilityState" "IndexabilityState" NOT NULL DEFAULT 'UNKNOWN_PUBLICATION',
    "published" BOOLEAN,
    "shopifyPublishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "previousContentHash" TEXT,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastQueuedAt" TIMESTAMP(3),
    "lastIndexedAt" TIMESTAMP(3),
    "lastSeenScanRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductIndexState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'PENDING',
    "activeKey" TEXT,
    "cursor" TEXT,
    "productsProcessed" INTEGER NOT NULL DEFAULT 0,
    "productsIndexable" INTEGER NOT NULL DEFAULT 0,
    "productsNonIndexable" INTEGER NOT NULL DEFAULT 0,
    "productsChanged" INTEGER NOT NULL DEFAULT 0,
    "queueItemsCreated" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "lastProgressAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "batchToken" TEXT,
    "batchClaimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IndexEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productIndexStateId" TEXT,
    "shopifyProductGid" TEXT NOT NULL,
    "eventType" "IndexEventType" NOT NULL,
    "meaningfulContentChanged" BOOLEAN NOT NULL,
    "oldHash" TEXT,
    "newHash" TEXT,
    "metadata" JSONB,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IndexEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IndexQueueItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productIndexStateId" TEXT,
    "shopifyProductGid" TEXT NOT NULL,
    "url" TEXT,
    "provider" "IndexProvider" NOT NULL DEFAULT 'INTERNAL',
    "action" "IndexQueueAction" NOT NULL DEFAULT 'INDEX',
    "status" "IndexQueueStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IndexQueueItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IndexAttempt" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "queueItemId" TEXT NOT NULL,
    "provider" "IndexProvider" NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "successful" BOOLEAN NOT NULL,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "IndexAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");
CREATE INDEX "ProductIndexState_shopId_indexabilityState_idx" ON "ProductIndexState"("shopId", "indexabilityState");
CREATE INDEX "ProductIndexState_shopId_lastSeenScanRunId_idx" ON "ProductIndexState"("shopId", "lastSeenScanRunId");
CREATE UNIQUE INDEX "ProductIndexState_shopId_shopifyProductGid_key" ON "ProductIndexState"("shopId", "shopifyProductGid");
CREATE UNIQUE INDEX "ScanRun_activeKey_key" ON "ScanRun"("activeKey");
CREATE UNIQUE INDEX "ScanRun_batchToken_key" ON "ScanRun"("batchToken");
CREATE INDEX "ScanRun_shopId_createdAt_idx" ON "ScanRun"("shopId", "createdAt");
CREATE INDEX "ScanRun_status_lastProgressAt_idx" ON "ScanRun"("status", "lastProgressAt");
CREATE INDEX "IndexEvent_shopId_receivedAt_idx" ON "IndexEvent"("shopId", "receivedAt");
CREATE INDEX "IndexEvent_shopifyProductGid_eventType_idx" ON "IndexEvent"("shopifyProductGid", "eventType");
CREATE UNIQUE INDEX "IndexQueueItem_dedupeKey_key" ON "IndexQueueItem"("dedupeKey");
CREATE INDEX "IndexQueueItem_status_nextAttemptAt_idx" ON "IndexQueueItem"("status", "nextAttemptAt");
CREATE INDEX "IndexQueueItem_shopId_shopifyProductGid_provider_action_sta_idx" ON "IndexQueueItem"("shopId", "shopifyProductGid", "provider", "action", "status");
CREATE INDEX "IndexAttempt_shopId_provider_startedAt_idx" ON "IndexAttempt"("shopId", "provider", "startedAt");
CREATE UNIQUE INDEX "IndexAttempt_queueItemId_attemptNumber_key" ON "IndexAttempt"("queueItemId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "ProductIndexState" ADD CONSTRAINT "ProductIndexState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexEvent" ADD CONSTRAINT "IndexEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexEvent" ADD CONSTRAINT "IndexEvent_productIndexStateId_fkey" FOREIGN KEY ("productIndexStateId") REFERENCES "ProductIndexState"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IndexQueueItem" ADD CONSTRAINT "IndexQueueItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexQueueItem" ADD CONSTRAINT "IndexQueueItem_productIndexStateId_fkey" FOREIGN KEY ("productIndexStateId") REFERENCES "ProductIndexState"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IndexAttempt" ADD CONSTRAINT "IndexAttempt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IndexAttempt" ADD CONSTRAINT "IndexAttempt_queueItemId_fkey" FOREIGN KEY ("queueItemId") REFERENCES "IndexQueueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
