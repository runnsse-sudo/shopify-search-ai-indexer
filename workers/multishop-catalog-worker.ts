import { parseCatalogTargets } from "../app/services/llm-visibility/multishop-catalog-targets.ts";
import { catalogPublisher } from "../app/services/llm-visibility/multishop-catalog-publication.server.ts";
import { catalogStorage } from "../app/services/llm-visibility/multishop-catalog-storage.server.ts";

// Not included in Docker/startup or any scheduler. Activation is a separate operation.
async function main() {
  if (
    process.argv.slice(2).join(" ") !== "--run-enabled-catalogs-once" ||
    !process.env.LLM_CATALOG_TARGETS ||
    !process.env.LLM_CATALOG_BUCKET
  ) {
    throw new Error("CATALOG_WORKER_NOT_ENABLED");
  }
  const targets = parseCatalogTargets(process.env.LLM_CATALOG_TARGETS);
  const bucket = process.env.LLM_CATALOG_BUCKET;
  const { default: prisma } = await import("../app/db.server");
  let failed = false;
  try {
    for (const target of targets) {
      try {
        const result = await catalogPublisher(target).refresh(
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
      } catch {
        // Do not log provider messages, URLs, session details or tokens.
        console.error(
          JSON.stringify({
            shop: target.shop,
            status: "FAILED",
            code: "CATALOG_REFRESH_FAILED",
          }),
        );
        failed = true;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  if (failed) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    JSON.stringify({ status: "FAILED", code: "CATALOG_WORKER_FAILED" }),
  );
  process.exitCode = 1;
});
