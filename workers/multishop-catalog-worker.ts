import { parseCatalogTargets } from "../app/services/llm-visibility/multishop-catalog-targets.ts";
import { catalogPublisher } from "../app/services/llm-visibility/multishop-catalog-publication.server.ts";
import { catalogStorage } from "../app/services/llm-visibility/multishop-catalog-storage.server.ts";

import {
  robottoCatalogFailure,
  type CatalogPhase,
} from "../app/services/llm-visibility/robotto-catalog-diagnostics.ts";

let phase: CatalogPhase = "configuration";

// Only the explicitly enabled worker entrypoint may invoke publication.
async function main() {
  const command = process.argv.slice(2).join(" ");
  const candidateOnly = command === "--publish-felk-candidate-once";
  if (
    (command !== "--run-enabled-catalogs-once" && !candidateOnly) ||
    !process.env.LLM_CATALOG_TARGETS ||
    !process.env.LLM_CATALOG_BUCKET
  ) {
    throw new Error("CATALOG_WORKER_NOT_ENABLED");
  }
  const configured = parseCatalogTargets(process.env.LLM_CATALOG_TARGETS);
  const targets = candidateOnly
    ? configured.filter((target) => target.shop === "94d715-94.myshopify.com")
    : configured;
  if (!targets.length) throw new Error("INVALID_CATALOG_TARGETS");
  const bucket = process.env.LLM_CATALOG_BUCKET;
  phase = "initialization";
  const { default: prisma } = await import("../app/db.server");
  let failed = false;
  try {
    for (const target of targets) {
      try {
        phase = "lock";
        const result = await catalogPublisher(
          target,
          (next) => {
            phase = next;
          },
          candidateOnly ? "felk-sha-candidate" : "existing-file",
        ).refresh(
          catalogStorage(bucket, target.shop),
          target.shop,
          async () => {
            const { unauthenticated } = await import("../app/shopify.server");
            const { admin, session } = await unauthenticated.admin(target.shop);
            if (session.isOnline || session.shop !== target.shop)
              throw new Error("CATALOG_SESSION_MISMATCH");
            return admin;
          },
        );
        console.log(JSON.stringify({ shop: target.shop, ...result }));
        if (result.status === "ROLLED_BACK") failed = true;
      } catch (error: unknown) {
        // Exact allowlisted codes only; never provider messages or error properties.
        const failure = robottoCatalogFailure(error, phase);
        console.error(
          JSON.stringify({
            shop: target.shop,
            status: "FAILED",
            code: failure.code,
            phase: failure.phase,
            ...(failure.causeCode && { causeCode: failure.causeCode }),
            ...(failure.verification && { verification: failure.verification }),
            reviewRequired: true,
          }),
        );
        failed = true;
      }
    }
  } finally {
    await prisma.$disconnect().catch((error: unknown) => {
      console.error(JSON.stringify(robottoCatalogFailure(error, "disconnect")));
      failed = true;
    });
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify(robottoCatalogFailure(error, phase)));
  process.exitCode = 1;
});
