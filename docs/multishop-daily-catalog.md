# Daily llms-full.txt for six stores — local implementation, inactive

The shared publisher supports exactly the six merchant shop domains in
`multishop-catalog-targets.ts`. The development store is excluded. Existing
Robotto routes, workers and configuration remain unchanged.

## Configuration before activation

`LLM_CATALOG_TARGETS` is a JSON array of explicitly enabled targets. Each target
requires `shop`, `primaryDomain` (hostname only), `fileId` (existing GenericFile)
and `cdnPath` (verified Shopify CDN path ending in `/files/llms-full.txt`). The
parser rejects duplicate shops, domains, file IDs and CDN paths. No values are
inferred from brand names. Unconfigured stores are not accessed.

`LLM_CATALOG_BUCKET` must name an existing qualified bucket. Future invocation:
bundle `workers/multishop-catalog-worker.ts` with the existing esbuild toolchain,
then explicitly run its output with `--run-enabled-catalogs-once`. No package,
Docker, route or scheduler change activates this worker. It processes stores
sequentially; a failed store does not redirect work to another store's session.

## Behavior and isolation

Each target checks its offline Shopify session, API shop identity and primary
domain, exact Online Store count and complete strict catalogue generation.
Catalogues contain only public product titles and links, not private inventory
or customer data. Price and stock require fresh Shopify product data.

Robotto uses the existing `robotto/llms-full/` prefix to share exclusion with the
old worker. Others use `shops/<myshopify-domain>/llms-full/`. Objects:

- `publication.lock`: create-if-absent, release only its acquired generation.
- `backup/<sha256>.txt`: immutable backup; generation-bound SHA256 readback.
- `daily-state.json`: shop-bound successful check time/hash, generation-CAS
  replacement and readback while holding the lock.

Successful checks occur at most once per UTC calendar day, including across
worker restarts. A fixed daily schedule therefore remains eligible on the next
UTC day even when the previous check finished after its scheduled start. This
is a calendar-day rule, not a rolling 24-hour interval; the configured schedule
must use UTC. Future checkpoint timestamps still block as clock drift.
`NOT_DUE` skips Shopify reads. Unchanged product-link sets skip all staged uploads
and file updates (title-only changes intentionally follow the existing policy).
Changed links require verified backup before staging and updating only the pinned
file. Canonical and versioned public CDN bytes must match; unversioned caches are
never trusted. Rollback only follows a confirmed candidate, with backup readback.
An ambiguous result, corrupt state, lost checkpoint, or provider error retains
the lock for reconciliation, without automatic retries or lock stealing.
`ROLLED_BACK` is a failed run and does not advance the daily checkpoint.

This is a maximum-frequency gate, not a running schedule or a guarantee that a
scheduled execution will succeed. Zero-product/empty catalogues stop pending a
separate explicit empty-catalogue policy.

## Required before production use

Verify each store's primary domain, existing file ID/CDN path, public template
and discovery links, granted `write_files`, appropriate offline session and
scoped bucket permissions. New stores need separately approved initial file and
template provisioning. State-object create/read/replace permissions are needed;
Robotto's earlier backup/lock-only IAM does not establish them. No IAM change,
resource creation, publication or scheduling is performed by this local task.

Before rollout: review/commit/CI, build and deployment approval, per-store
read-only qualification and publication pilot, then explicit daily activation.
Preserve existing Shopify-managed `/agents.md` and `/llms.txt`, Observer,
REVIEW_REQUIRED and settingsVersion gates.
