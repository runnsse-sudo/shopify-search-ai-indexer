import type { Prisma } from "@prisma/client";

export type WebhookReceiptInput = {
  shopId: string;
  webhookId: string;
  eventId?: string | null;
  topic: string;
  shopifyProductGid?: string | null;
  triggeredAt?: string | null;
};

export type WebhookReceiptAcquisition = "ACQUIRED" | "DUPLICATE";

export async function acquireWebhookReceiptWithClient(
  tx: Prisma.TransactionClient,
  input: WebhookReceiptInput,
): Promise<WebhookReceiptAcquisition> {
  const result = await tx.webhookReceipt.createMany({
    data: {
      shopId: input.shopId,
      webhookId: input.webhookId,
      eventId: input.eventId ?? null,
      topic: input.topic,
      shopifyProductGid: input.shopifyProductGid ?? null,
      triggeredAt: input.triggeredAt ?? null,
    },
    skipDuplicates: true,
  });

  return result.count === 1 ? "ACQUIRED" : "DUPLICATE";
}

export async function runWithWebhookReceipt<T>(
  tx: Prisma.TransactionClient,
  input: WebhookReceiptInput,
  work: () => Promise<T>,
): Promise<{ duplicateWebhook: true } | { duplicateWebhook: false; value: T }> {
  const acquisition = await acquireWebhookReceiptWithClient(tx, input);
  if (acquisition === "DUPLICATE") return { duplicateWebhook: true };
  return { duplicateWebhook: false, value: await work() };
}
