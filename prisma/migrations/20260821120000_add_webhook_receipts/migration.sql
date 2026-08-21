-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "topic" TEXT NOT NULL,
    "shopifyProductGid" TEXT,
    "triggeredAt" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_shopId_webhookId_key" ON "WebhookReceipt"("shopId", "webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_shopId_processedAt_idx" ON "WebhookReceipt"("shopId", "processedAt");

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
