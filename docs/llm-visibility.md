# AI / LLM Visibility

## Delivered behavior

Shopify supplies the default agent-discovery information. AI Indexer audits the
published storefront: AI crawler policy, /agents.md and its optional llms compatibility files, sitemap visibility,
canonical mismatches and noindex findings. It recommends improvements rather than
replacing Shopify's files. Custom theme overrides may exist; the audit does not
claim to know which component generated a public response.

Merchants run an authenticated, bounded read-only audit. The screen explains its
sample coverage, technical score and recommendations. A timestamped JSON report
can be downloaded from the existing result without another network request.
Reports explicitly project fields, identify AUDIT_ONLY/SHOPIFY_MANAGED_BASE and
mark custom-template ownership NOT_VERIFIED. No candidate file or publication
plan is offered in this workflow. Existing internal preview helpers are retained
for compatibility only and are not exported in the report or shown in the UI.

Customers maintain normal product descriptions, SEO titles and verified company
information in Shopify. They do not need to hand-write llms files. Shopify's
managed information is not overwritten by this app. Missing optional files
produce informational review suggestions, not instructions to replace agents.md.

## Verification and boundaries

Audit submissions accept only the fixed read-only intent, authenticated same-origin
URL-encoded POST and a streamed maximum 1024-byte body. Errors never expose raw
provider exception payloads. Responses remain private/no-store. Existing DNS/SSRF,
redirect, body-size, timeout and sitemap indexability protections are unchanged.

This is technical readiness, not actual AI mentions, ranking, guaranteed indexing
or recommendations in ChatGPT. Results are ephemeral. Scheduled audits, permanent
history and automatic file publication are outside this version. No theme
permissions or hosting changes are needed for this read-only workflow.

New installations without stored primary-domain metadata use the existing authenticated ShopPrimaryDomain read query as fallback. This requires no prior catalog scan, no supplied target domain and no database write. Lookup failure stays unavailable rather than using another shop.

## Research update 2026-11-04

Shopify manages /agents.md as canonical discovery, with /llms.txt and /llms-full.txt
as compatibility paths. Identical content is expected and needs no replacement.
Shopify Catalog is a separate product feed: check eligibility and product data mapping
under Shopify admin > Sales channels > Agentic > Sources > Shopify Catalog.
Crawler blocks alone do not disable Catalog syndication. Eligibility is not verified by this audit.
The llms.txt v2 proposal requires only a leading H1; summaries and links are optional.
HTML error pages no longer count as discovery availability. Format detection is heuristic.
Readiness scores include optional discovery availability and are not Google eligibility tests
or guarantees of AI mentions. No theme overrides or publication are performed.

Sources:
- https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/products
- https://shopify.dev/docs/storefronts/themes/architecture/templates/llms-txt-liquid
- https://llmstxt.org/
- https://developers.google.com/search/docs/appearance/ai-features

## Robotto catalog refresh worker

The worker reads Robotto's active Online Store products through the existing offline Shopify session. It requires an exact product count and complete pagination. It compares the set of product links with the existing Shopify Files catalog and skips publication when those links are unchanged, even if titles or introductory text differ.

Build with npm run build:robotto-catalog-worker. A future authorized invocation uses node build-workers/robotto-catalog-worker.mjs --run-robotto-catalog-once and ROBOTTO_CATALOG_BUCKET. This code creates no scheduler.

The Cloud Storage adapter uses the fixed robotto/llms-full/ prefix. The shared lock uses create-if-absent and generation-conditional deletion. Backups use immutable SHA256-based names and generation-specific binary readback. Runtime callers must use the same approved bucket and lock path. An interrupted or uncertain run retains its lock for reconciliation. Successful rollback is reported as ROLLED_BACK and makes the worker exit unsuccessfully.

The publication adapter targets only Robotto GenericFile gid://shopify/GenericFile/62861370655066. It verifies the shop and write_files scope, saves the verified backup before replacement, and verifies public bytes after replacement. It restores the backup on an error only when the candidate is confirmed at the public URL. Unrecognized content requires review.

Local tests use synthetic providers. Activation, a job or scheduler, runtime configuration and Shopify publication require separate authorization.
