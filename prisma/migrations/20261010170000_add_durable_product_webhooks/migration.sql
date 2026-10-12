-- Legacy inserts deliberately remain COMPLETED with processedAt defaulting to now.
CREATE TYPE "ProductWebhookStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED', 'CANCELLED');
ALTER TABLE "Shop" ADD COLUMN "productWebhookNextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WebhookReceipt"
  ALTER COLUMN "processedAt" DROP NOT NULL,
  ADD COLUMN "status" "ProductWebhookStatus" NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorClass" VARCHAR(64);
UPDATE "WebhookReceipt" SET "receivedAt" = "processedAt", "completedAt" = "processedAt";
CREATE INDEX "WebhookReceipt_status_nextAttemptAt_receivedAt_idx" ON "WebhookReceipt"("status", "nextAttemptAt", "receivedAt");
CREATE INDEX "WebhookReceipt_status_claimedAt_idx" ON "WebhookReceipt"("status", "claimedAt");
