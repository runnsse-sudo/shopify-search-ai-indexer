import { Prisma } from "@prisma/client";

export const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;

export function isSerializableTransactionConflict(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function runSerializableTransactionWithRetry<T>(
  transaction: () => Promise<T>,
  maxAttempts = SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: () => number = Math.random,
): Promise<T> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS)
    throw new Error("INVALID_SERIALIZABLE_RETRY_LIMIT");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (!isSerializableTransactionConflict(error) || attempt === maxAttempts) throw error;
      // The failed transaction has rolled back before waiting. Jitter prevents
      // concurrent deliveries from colliding again in immediate retry waves.
      const sample = random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
        throw new Error("INVALID_SERIALIZABLE_RETRY_JITTER");
      const baseDelay = 25 * 2 ** (attempt - 1);
      await wait(baseDelay + Math.floor(sample * baseDelay));
    }
  }

  throw new Error("Serializable transaction retry loop ended unexpectedly");
}
