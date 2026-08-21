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
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (!isSerializableTransactionConflict(error) || attempt === maxAttempts) throw error;
    }
  }

  throw new Error("Serializable transaction retry loop ended unexpectedly");
}
