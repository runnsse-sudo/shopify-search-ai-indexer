CREATE TABLE "CatalogRefreshRun" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stopReason" TEXT,
    "sha256" TEXT,
    CONSTRAINT "CatalogRefreshRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogRefreshRun_shopDomain_startedAt_idx" ON "CatalogRefreshRun"("shopDomain", "startedAt");
ALTER TABLE "CatalogRefreshRun" ADD CONSTRAINT "CatalogRefreshRun_shopDomain_fkey"
    FOREIGN KEY ("shopDomain") REFERENCES "Shop"("domain") ON DELETE CASCADE ON UPDATE CASCADE;
