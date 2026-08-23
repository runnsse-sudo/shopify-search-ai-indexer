import type { IndexProvider, Prisma } from "@prisma/client";

type AttemptClient = Pick<Prisma.TransactionClient, "indexAttempt">;

export async function createIndexAttemptWithClient(
  client: AttemptClient,
  input: {
    shopId: string;
    queueItemId: string;
    provider: IndexProvider;
    successful: boolean;
    responseCode: number | null;
    responseBody: string | null;
    error: string | null;
    startedAt: Date;
    completedAt: Date;
  },
  isAttemptNumberConflict: (error: unknown) => boolean,
  maxAttempts = 3,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const aggregate = await client.indexAttempt.aggregate({
      where: { queueItemId: input.queueItemId },
      _max: { attemptNumber: true },
    });
    try {
      return await client.indexAttempt.create({
        data: { ...input, attemptNumber: (aggregate._max.attemptNumber ?? 0) + 1 },
      });
    } catch (error) {
      if (!isAttemptNumberConflict(error) || attempt === maxAttempts) throw error;
    }
  }
  throw new Error("IndexAttempt allocation ended unexpectedly");
}
