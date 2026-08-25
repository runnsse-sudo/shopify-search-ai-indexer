-- CreateTable
CREATE TABLE "ShopProviderConfig" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "indexNowEnabled" BOOLEAN NOT NULL DEFAULT false,
    "indexNowAllowedHost" TEXT,
    "indexNowCredentialCiphertext" TEXT,
    "indexNowCredentialIv" TEXT,
    "indexNowCredentialTag" TEXT,
    "indexNowOwnershipVerifiedAt" TIMESTAMP(3),
    "indexNowOwnershipLastCheckedAt" TIMESTAMP(3),
    "indexNowOwnershipError" TEXT,
    "materializationLastRunAt" TIMESTAMP(3),
    "indexNowLastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderAutomationLease" (
    "key" TEXT NOT NULL,
    "ownerToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderAutomationLease_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopProviderConfig_shopId_key"
ON "ShopProviderConfig"("shopId");

-- CreateIndex
CREATE INDEX "ShopProviderConfig_indexNowEnabled_indexNowOwnershipVerifiedAt_idx"
ON "ShopProviderConfig"("indexNowEnabled", "indexNowOwnershipVerifiedAt");

-- AddForeignKey
ALTER TABLE "ShopProviderConfig"
ADD CONSTRAINT "ShopProviderConfig_shopId_fkey"
FOREIGN KEY ("shopId")
REFERENCES "Shop"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
-- CreateIndex
CREATE INDEX "ShopProviderConfig_indexNowEnabled_materializationLastRunAt_idx"
ON "ShopProviderConfig"("indexNowEnabled", "materializationLastRunAt");

-- CreateIndex
CREATE INDEX "ShopProviderConfig_indexNowEnabled_indexNowLastRunAt_idx"
ON "ShopProviderConfig"("indexNowEnabled", "indexNowLastRunAt");