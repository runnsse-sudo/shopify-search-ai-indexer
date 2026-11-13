import { runAutomaticRedirectAudit, runMotokoHyperBodyRedirectTest, motokoHyperBodyShop } from "../app/services/redirect-audit/automatic-redirect.server";
import { recheckAutomaticRedirect, runRedirectAudit } from "../app/services/redirect-audit/redirect-audit.server";

async function main() {
  const args = process.argv.slice(2);
  const exactTest = args.length === 1 && args[0] === "--run-motoko-hyper-body-once";
  const shops = (process.env.AUTOMATIC_REDIRECT_SHOPS ?? "").split(",");
  if (
    (!exactTest && args.join(" ") !== "--run-enabled-redirect-audits-once") ||
    (exactTest && (shops.length !== 1 || shops[0] !== motokoHyperBodyShop)) ||
    shops.length > 6 ||
    new Set(shops).size !== shops.length ||
    shops.some((shop) => !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))
  ) throw new Error("AUTOMATIC_REDIRECT_WORKER_NOT_ENABLED");

  const { default: prisma } = await import("../app/db.server");
  try {
    const { unauthenticated } = await import("../app/shopify.server");
    for (const shop of shops) {
      try {
        const { admin, session } = await unauthenticated.admin(shop);
        if (session.shop !== shop || session.isOnline) throw new Error("SESSION_MISMATCH");
        const onCreated = (redirect: { id: string; path: string; target: string }) =>
          console.log(JSON.stringify({ shop, status: "REDIRECT_CREATED", redirect }));
        const result = exactTest
          ? await runMotokoHyperBodyRedirectTest(admin, runRedirectAudit, recheckAutomaticRedirect, onCreated)
          : await runAutomaticRedirectAudit(shop, admin, runRedirectAudit, recheckAutomaticRedirect, onCreated);
        console.log(JSON.stringify({ shop, ...result }));
        if (result.status !== "COMPLETE") process.exitCode = 1;
      } catch {
        console.error(JSON.stringify({ shop, status: "AUTOMATIC_REDIRECT_AUDIT_FAILED" }));
        process.exitCode = 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("AUTOMATIC_REDIRECT_WORKER_FAILED");
  process.exitCode = 1;
});
