import { runAutomaticRedirectAudit, runMotokoHyperBodyRedirectTest, motokoHyperBodyShop } from "../app/services/redirect-audit/automatic-redirect.server";
import { recheckAutomaticRedirect, runRedirectAudit } from "../app/services/redirect-audit/redirect-audit.server";

import {
  checkStoredRedirectTargets,
  recordScheduledRedirectAudit,
  type CreatedRedirect,
} from "../app/services/redirect-audit/redirect-history.server";

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
        const logCreated = (redirect: CreatedRedirect) =>
          console.log(JSON.stringify({ shop, status: "REDIRECT_CREATED", redirect }));
        const getAdmin = async () => {
          const { admin, session } = await unauthenticated.admin(shop);
          if (session.shop !== shop || session.isOnline) throw new Error("SESSION_MISMATCH");
          return admin;
        };
        const result = exactTest
          ? await runMotokoHyperBodyRedirectTest(await getAdmin(), runRedirectAudit, recheckAutomaticRedirect, logCreated)
          : await recordScheduledRedirectAudit(prisma, shop, async (saveCreated, saveDiagnostics) => {
              const admin = await getAdmin();
              return runAutomaticRedirectAudit(shop, admin, runRedirectAudit, recheckAutomaticRedirect, async (redirect) => {
                logCreated(redirect);
                await saveCreated(redirect);
              }, undefined, saveDiagnostics);
            });
        console.log(JSON.stringify({ shop, ...result }));
        if (result.status !== "COMPLETE") process.exitCode = 1;
        if (!exactTest && result.status !== "MISSING_SCOPE") {
          try {
            const storefront = await prisma.shop.findUnique({
              where: { domain: shop }, select: { primaryDomain: true },
            });
            if (storefront?.primaryDomain) await checkStoredRedirectTargets(prisma, shop, storefront.primaryDomain);
          } catch {
            console.error(JSON.stringify({ shop, status: "REDIRECT_TARGET_CHECK_FAILED" }));
          }
        }
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
