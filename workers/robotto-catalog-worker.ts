import { ROBOTTO_SHOP } from "../app/services/llm-visibility/llm-delivery";
import { refreshRobottoOnlineStoreCatalog } from "../app/services/llm-visibility/robotto-catalog-publication.server";
import { robottoCatalogStorage } from "../app/services/llm-visibility/robotto-catalog-storage.server";

async function main() {
  const bucket = process.env.ROBOTTO_CATALOG_BUCKET;
  if (process.argv.slice(2).join(" ") !== "--run-robotto-catalog-once" || !bucket) {
    throw new Error("ROBOTTO_CATALOG_NOT_ENABLED");
  }
  const { default: prisma } = await import("../app/db.server");
  try {
    const result = await refreshRobottoOnlineStoreCatalog(robottoCatalogStorage(bucket), ROBOTTO_SHOP, async () => {
      const { unauthenticated } = await import("../app/shopify.server");
      const { admin, session } = await unauthenticated.admin(ROBOTTO_SHOP);
      if (session.isOnline || session.shop !== ROBOTTO_SHOP) throw new Error("INVALID_ROBOTTO_SESSION");
      return admin;
    });
    console.log(JSON.stringify(result));
    if (result.status === "ROLLED_BACK") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ status: "REVIEW_REQUIRED" }));
  process.exitCode = 1;
});
