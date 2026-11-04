# Installing AI Indexer across owned stores

One installation must authenticate independently per Shopify store. The existing
Shop model keys domain uniquely and Prisma session storage keeps each store's
session. LLM requests use the authenticated shop to read its own primaryDomain;
no Robotto domain or caller-provided target is used as a universal default. A shop
without a discovered domain is shown as not ready, never assigned another shop's
domain. No shared cached LLM results are introduced.

The LLM audit workflow needs no theme writes or file publishing permission.
Each store retains Shopify-managed discovery information and receives its own
read-only findings/report. Existing product and queue activation gates continue
to apply per deployment/store; installation must not start workers automatically.

## Distribution is separate from multi-tenant code

Verify the app's actual distribution choice in Shopify Dev Dashboard before
promising an install link. Custom distribution supports one production store or
multiple stores within the same Shopify Plus organization. Stores outside that
organization require a separately verified supported distribution model, such as
public distribution with applicable Shopify review, or separately registered
custom apps. Do not change distribution, register apps, copy credentials or
change runtime identity automatically.

Collect the exact myshopify domains and organization/Plus membership, then verify
the existing app's distribution and permitted target set. The SDK's local
AppDistribution setting alone is not proof of dashboard install eligibility.

For each approved installation, verify store identity, requested scopes,
per-store session, primary domain, isolation and uninstall behavior. These real
installation checks are NOT RUN by the synthetic multi-store test. No new cloud
service or app registration is assumed necessary or authorized.

Reference: https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
