import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { createIndexAttemptWithClient } from "./index-attempt";

export { createIndexAttemptWithClient } from "./index-attempt";

export function createIndexAttempt(input: Parameters<typeof createIndexAttemptWithClient>[1]) {
  return createIndexAttemptWithClient(
    prisma,
    input,
    (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
  );
}
