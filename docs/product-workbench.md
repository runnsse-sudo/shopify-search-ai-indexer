# Product workspace

`/app/products` shows persisted product eligibility and the latest queue outcome.
Search matches title, handle or Shopify product GID; eligibility filters and stable
creation-time/ID pagination return at most 25 products. Detail pages show at most
10 recent requests and link to the existing attempt-history pages. Stored provider
bodies, raw errors, credentials, content hashes and arbitrary URLs are not returned.
No polling or Shopify API calls are introduced. Recorded indexing is not proof of
search engine inclusion.

## Prepared queue actions

`PRODUCT_WORKBENCH_QUEUE_ACTIONS_ENABLED` must equal `true` at the server boundary.
It is absent/off by default. Shipping this code does not approve enabling it.
Enabling queue writes and downstream execution in production requires separate
operational approval. No worker, provider, Observer or baseline is enabled here.
An existing permitted worker may later process newly created INTERNAL work;
INTERNAL completion can produce provider work under existing provider settings.
Review those settings and downstream budgets before any production activation.

The authenticated shop and staff subject come only from the Shopify SDK. An
offline session may be shared by staff: its ID is deliberately **not** ownership.
An irreversible hash of shop and SDK-verified staff subject marks new requests.
Neither staff IDs nor markers are exposed to the browser. Token payloads are not
logged. Missing staff identity fails closed.

POST requires same-origin Origin and a bounded URL-encoded body (16 KiB). The
server allows 1–20 raw selections, deduplicates identical IDs/versions, rejects
unknown fields and conflicting versions, and rechecks all products atomically.
Each must still be active, published, INDEXABLE, undeleted, and have a canonical
HTTPS `/products/...` URL on the persisted primary domain. No candidate URL or
client URL is trusted. Selection is restricted to the current page and cleared
when its versions no longer match.

A single SERIALIZABLE transaction inserts only INTERNAL/INDEX/PENDING rows.
The existing pending-intent key prevents duplicate pending slots. Any active work
for the product is skipped, including provider and manifest work. Existing rows,
retry counters, schedules, reasons and errors are never refreshed by this action.
A deterministic per-request/per-product ID also prevents replay after completion
or cancellation. A deliberate new submission after a refreshed page has a new
request key. Serialization/uniqueness conflicts return409 with no automatic retry.
Unconfirmed errors request queue review rather than claiming success.

Cancellation uses a conditional update scoped to authenticated shop and staff,
the `manual_` namespace/ownership marker, INTERNAL/INDEX, PENDING, exact updatedAt,
retryCount0, no claim and no attempts. It changes only status, completion time and
releases the pending dedupe slot. Claimed/retried/provider/foreign/manifest work
cannot be cancelled. Old manual requests outside the latest10 are still visible
through the existing queue overview but are not given a cancellation button here.

## Validation and release separation

Pure service, actual route/action and SSR tests run under the repository's network
denial harness. Real PostgreSQL concurrency, claim/cancellation and rollback
semantics are prepared in `product-workbench-postgres.integration.mjs` for the
existing hosted PostgreSQL17 job. It accepts only explicit opt-in, GitHub Actions,
the disposable loopback `webhook_ci` database and password-free fixture role;
it creates and removes its own randomized schema. Do not run against production.
The guard self-test needs no database and creates no Docker resources.

The release archive for main0241e867 is constructed from Git blobs, not this
worktree. None of these feature files or CI changes belongs to that release.
Schema, migrations, dependencies, worker files, Observer, REVIEW_REQUIRED and
settingsVersion remain unchanged. Commit/push/PR/hosted execution, action
activation, build and deployment are separate approval boundaries.
