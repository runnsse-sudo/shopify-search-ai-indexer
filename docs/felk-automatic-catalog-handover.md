# Felkodsläsare: automatic SHA discovery handover (local, disabled)

Base: main ec2b45855aae450093cd4ffef9d4f4c4d00e9e32.
No store, GCP, credentials, schedule or journal was changed by this implementation.
The other five stores retain the original publisher and target format.

## Definition, value and retrieval

The version-controlled `[shop.metafields.app.felk_catalog_pointer]` definition in
shopify.app.toml is app-owned JSON, merchant-read-only, with public storefront
read access. Deploying/installing this definition requires separate authorization.
No definition is created by the daily worker, and missing/wrong definitions stop.

A separate bootstrap must create exactly one verified pointer value, using
metafieldsSet with compareDigest:null for absent-only creation, or an explicitly
approved existing digest for replacement. That bootstrap is NOT automated here.
The JSON contains schema FELK_CATALOG_POINTER_V1, shop, fileId, sha256, canonical
and download, all checked against Felkodsläsare's exact host/path and file identity.
Read it via shop.metafield(namespace: <actual app-reserved namespace>,
key: "felk_catalog_pointer") with compareDigest. Never guess the app namespace
from client_id; qualify it from the actual App GID and definition after installation.
This key is distinct from the existing AppInstallation config_v1 settings.

`felkCatalogDiscoveryTemplate` prepares the one-time Liquid template text using
that verified namespace and current verified pointer. It reads the JSON value
from shop.metafields and retains the current SHA file as a static fallback.
Installation in the active theme is a separately approved one-time action through
a supported authorized channel. No theme writer or platform-exemption workaround
is implemented. /agents.md, /llms.txt, menus and the other stores are untouched.

## Disabled by default and production prerequisites

The worker uses the new path only when LLM_FELK_LINK_HANDOVER is explicitly set to
JSON with exactly enabled:true, shop:"94d715-94.myshopify.com", actual ownerId
(gid://shopify/Shop/<verified id>) and namespace (app--<verified App id>).
Missing configuration preserves the existing LINK_UPDATE_REQUIRED behavior.
A candidate-only invocation never activates the pointer publisher.

Before activation: install/verify the definition and absent-only initial value;
verify this installation really permits Shop metafield writes; install/verify the
one-time template against the active theme; verify public readback, actual app and
shop IDs, offline write_files, existing GCS backup/lock permissions, rollback and
cost/admission. No new write scopes are assumed or requested by this package.
A synthetically accepted Shop write is NOT evidence of real granted permissions.
Retain the old file, template backup and exact initial pointer.

## Coherent daily transaction

One existing per-shop GCS exclusive lock encloses all operations. Its checkpoint
uses the effective pointer target, not the stale bootstrap file in the job env.
This allows successive generations without reconfiguring Cloud Run each day.
Pointer ownership/definition, actual file metadata, both public SHA deliveries
and the root discovery link must pass before any catalog generation mutation.
The existing complete Online Store selection/count and UTC-day gate remain.

Unchanged product links cause no upload or pointer write; the normal checkpoint
is written and the own lock released. A same-day repeat returns NOT_DUE.
Changed links first preserve/read back the current file and exact pointer/owner/
compareDigest as content-addressed durable backups in the existing backup prefix.
Create at most one new SHA GenericFile with RAISE_ERROR, never replace/delete an
old file. Verify metadata stability and matching bytes at both delivery URLs.
Re-prove the old file and discovery link; then switch only the one pointer using
metafieldsSet with its exact compareDigest. Verify the mutation result and an
independent reread, then the public root and both new deliveries. Public discovery
propagation waits are bounded to six reads, three seconds apart.
Only then save a checkpoint bound to the NEW target and report PUBLISHED.

## Failure, rollback and recovery

Creation or mutation uncertainty never triggers a second creation, blind pointer
write or automatic deletion. A confirmed pointer change whose public verification
fails is restored only with the confirmed new compareDigest, after re-verifying
the old retained file. A concurrent merchant/app change blocks rollback; it is
never overwritten. Verify restored public discovery. A rollback does NOT mark the
new generation completed; failure preserves the lock and leaves checkpoint
unchanged for separately reviewed recovery.

Checkpoint failure after a verified pointer commit also preserves the lock and
requires reconciliation; the Shopify/GCS boundary is deliberately fail-closed,
not falsely atomic. Existing checkpoint target drift remains blocked. No reset,
lock cleanup, retry, old-file garbage collection or automatic financial release
is provided. Previous versions and UNKNOWN provenance remain historical evidence.

## Contracts checked against Shopify documentation (API 2026-10)

- https://shopify.dev/docs/apps/build/metafields/definitions
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/metafieldsSet
- https://shopify.dev/docs/api/liquid/objects/metafield

Local tests inject only synthetic Admin, file delivery and storage adapters. The
pure-test runner disables network and DATABASE_URL. Real Shop write authorization,
public propagation, PostgreSQL, installed definition and activation remain NOT RUN.
