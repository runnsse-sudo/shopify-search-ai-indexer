import { randomUUID } from "node:crypto";

import prisma from "../db.server";

export async function acquireProviderAutomationLease(
  key: string,
  ttlMs: number,
  now = new Date(),
) {
  if (
    !key.trim() ||
    ttlMs < 1000
  ) {
    throw new Error(
      "Provider automation lease input is invalid",
    );
  }

  await prisma.providerAutomationLease.upsert({
    where: {
      key,
    },
    create: {
      key,
    },
    update: {},
  });

  const ownerToken =
    randomUUID();

  const leaseUntil =
    new Date(
      now.getTime() + ttlMs,
    );

  const claimed =
    await prisma.providerAutomationLease.updateMany({
      where: {
        key,
        OR: [
          {
            leaseUntil: null,
          },
          {
            leaseUntil: {
              lte: now,
            },
          },
        ],
      },
      data: {
        ownerToken,
        leaseUntil,
      },
    });

  if (claimed.count !== 1) {
    return null;
  }

  return {
    key,
    ownerToken,
    leaseUntil,
  } as const;
}

export async function releaseProviderAutomationLease(
  lease: {
    key: string;
    ownerToken: string;
  },
) {
  await prisma.providerAutomationLease.updateMany({
    where: {
      key:
        lease.key,
      ownerToken:
        lease.ownerToken,
    },
    data: {
      ownerToken:
        null,
      leaseUntil:
        null,
    },
  });
}