CREATE TABLE "RedirectDiscoveryEntry" (
    "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "path" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL CHECK ("status" IN ('PENDING', 'DIRECT_404', 'UNVERIFIED', 'OTHER_RESPONSE')),
    PRIMARY KEY ("shopId", "path")
);

CREATE INDEX "RedirectDiscoveryEntry_shopId_status_lastCheckedAt_idx"
    ON "RedirectDiscoveryEntry" ("shopId", "status", "lastCheckedAt");
