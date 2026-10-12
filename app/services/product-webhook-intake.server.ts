import prisma from "../db.server";
import { acceptProductWebhookWithClient } from "./product-webhook-store";
import { runSerializableTransactionWithRetry } from "./serializable-transaction-retry.server";

export async function acceptProductWebhook(
  input: Parameters<typeof acceptProductWebhookWithClient>[1],
) {
  return runSerializableTransactionWithRetry(() =>
    prisma.$transaction((tx) => acceptProductWebhookWithClient(tx, input), {
      isolationLevel: "Serializable",
    }),
  );
}
