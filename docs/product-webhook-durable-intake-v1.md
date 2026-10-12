# Durable product webhook intake V1

Implementation only. No migration, worker job, scheduler or production change is
performed by this patch. Independent full diff and test certification precedes
commit. Release, migration and worker enablement need a separate authorized plan.

## HTTP contract

Create/update authenticate with the existing Shopify webhook authenticator and
require an admin context and webhook ID. Missing admin remains 503; missing ID
remains 400. A Serializable transaction ensures the shop and inserts one
`WebhookReceipt` with `PENDING`, using the existing unique `(shopId, webhookId)`.
Only metadata (product GID, topic, webhook/event IDs, triggered timestamp) is
stored. There is no payload or token storage and no product/domain GraphQL call.

HTTP 200 means **durably accepted**, including duplicate receipts in any status.
It does not mean product processing has completed. The response awaits commit;
failed intake returns 503. No promise is detached from the request.

Delete stays synchronous. It does not fetch a product or shop domain through
GraphQL and did not participate in the historical throttling burst. Its existing
receipt acquisition, internal queue cancellation and deletion tombstone remain
unchanged. Async create/update still pass through the existing snapshot ordering
guard, which rejects both older product versions and all deletion tombstones.

## Worker and retry policy

The same Docker image includes `workers/product-webhook-worker.ts` and its bundle.
`npm run product-webhook-worker` runs the compiled worker directly; it does not
run setup or migrations. All nine worker bundles are built in CI and Docker.

| Setting | Default | Allowed values |
| --- | --- | --- |
| `PRODUCT_WEBHOOK_WORKER_ENABLED` | false | exactly true or false |
| `PRODUCT_WEBHOOK_WORKER_MAX_ITEMS` | 10 | integer 1–25 |
| `PRODUCT_WEBHOOK_WORKER_INTER_ITEM_DELAY_MS` | 1000 | integer 500–10000 |
| `PRODUCT_WEBHOOK_WORKER_MAX_ATTEMPTS` | 8 | integer 1–12 |
| `PRODUCT_WEBHOOK_WORKER_CLAIM_STALE_MS` | 900000 | integer 300000–3600000 |

Invalid configuration fails closed. Disabled execution does no work queries or
admin acquisition. SIGTERM/SIGINT prevent additional claims and product processing
after a pending admin acquisition returns. An interrupted item can be reclaimed
after its stale threshold. There is no worker busy loop.

An enabled invocation arms a fixed **240000 ms whole-process watchdog before
lease acquisition**, retained through lease release and Prisma disconnect. It
calls `process.exit(1)` on expiry: it does not abandon a still-live SDK promise.
Normal completion clears the timer. This bounds even offline-token refresh,
whose installed SDK path does not accept a cancellation signal. No environment
setting can enlarge this limit. The minimum accepted claim stale threshold and
run lease TTL are 300000 ms: `240000 + 60000 <= claimStaleMs = lease.ttlMs`.
The watchdog starts before the timestamps used for lease acquisition or any
receipt claim; lease renewal can only extend that protection. Thus the process
terminates before normal lease expiry or stale recovery can permit takeover.
A pathological timeout leaves the receipt PROCESSING and lease intact for later
recovery; it does not falsely complete or schedule retry. Attempts still count.
The whole invocation budget may truncate a slow multi-item run, so item/run
settings are upper bounds, not a promise to process every item in one invocation.
As with Node timers and TTL leases generally, this assumes a running event loop
and consistent host/database clocks; it is not an OS real-time execution promise.

A dedicated `product-webhook-worker-v1` lease in the existing lease table excludes
overlapping runs. The name of that table does not cause any provider execution.
Claims select only create/update, due PENDING/RETRY or sufficiently old PROCESSING
rows, with the shop cooldown satisfied. Order is nextAttemptAt, receivedAt, id.
Each run processes at most two items per shop and at most the configured run
bound; it claims one item at a time. This caps noisy shops and lets other due
shops advance. It does not guarantee a fixed latency under unbounded arrivals.

Selection and compare-and-set claim run in a Serializable transaction with the
existing bounded conflict retry. Each claim increments attemptCount and sets
PROCESSING, claimedAt and a fresh opaque token. Completion, retry and failure all
require the exact receipt ID, shop, PROCESSING status, claim timestamp and token,
plus the still-live run lease owner. Releasing an old lease cannot release a newer
owner's lease. Recovery changes the token; an exhausted stale claim becomes FAILED.

The worker obtains `unauthenticated.admin(shopDomain)` using an offline session.
After acquisition, before product processing, a Serializable guard rechecks the
live run lease and exact current receipt claim/token; stop state is checked both
before and after that guard. Lost ownership issues no product GraphQL request.

The claim's cached domain is never authoritative or passed to the product core.
Durable processing reads persisted `Shop.primaryDomain` and a normal update uses
one product GraphQL query, with no domain query. Cache values are never written
back. A missing domain triggers one fallback domain query; its fresh result is
persisted only by a compare-and-set against the missing baseline that justified
the fetch. A concurrent newer database value wins. Inside the fenced Serializable
product transaction, the current persisted domain is reread and used for candidate
URL calculation, including when that CAS loses. Conflict retry rereads without
repeating GraphQL. Authoritative public canonical URLs still come from the
product's onlineStoreUrl, not the cache. Scan/manual domain semantics are unchanged.
Product/domain GraphQL requests have one attempt and a 30-second abort signal;
offline admin refresh is instead protected by the hard process watchdog. Structured response
errors are preserved before the existing fetch helpers can reduce them to text.

Structured THROTTLED/429, upstream 5xx, network timeout/reset/no-response SDK errors,
transient database failures and unavailable offline admin context schedule durable
retry. Arbitrary application/data errors fail terminally. Retry delays by attempt
are 30s, 2m, 5m, 15m and then capped at 30m. Attempts are finite, including attempts
abandoned by crashed workers. At the configured limit, work becomes FAILED.

A retryable failure clears the active claim and persists a shop-wide cooldown to
the same nextAttemptAt, atomically with the receipt transition. This blocks other
pending rows for the throttled shop across subsequent runs. That shop is also
excluded for the rest of the current run. Other shops can continue. The policy
also cools down unavailable admin contexts and other transient failures.

## Product transaction and lifecycle

The shared product core still owns fingerprints, snapshot ordering, indexability,
canonical URLs, IndexEvents and internal queue intent. Durable mode skips legacy
receipt acquisition. Receipt completion and every product/queue/audit mutation
commit in the same Serializable transaction. Completion is checked first inside
that transaction, so a lost owner cannot mutate products, domains or error audits.
A downstream failure rolls completion back. GraphQL reads occur before that
transaction and may repeat after a crash; product/queue effects remain fenced.
Scan/manual paths retain their existing acquisition and error audit behavior.
No webhook worker path invokes IndexNow or other external indexing providers.

Pending work is not cancelled on uninstall: there is no installation generation
that could safely distinguish a delayed uninstall from a newer installation.
Missing/revoked offline sessions retry finitely and ultimately become FAILED.
Work may survive uninstall/reinstall and read the current product after offline
access returns; installation-specific cancellation requires a later generation
design. Product deletion ordering remains protected by existing tombstones.

Operators can identify FAILED receipts by status, topic, attemptCount and safe
lastErrorClass, and inspect receipt identity in an authorized reconciliation task.
Duplicates do not reset FAILED work. No automatic replay or new UI is included.
Any future repair must review the current installation/product state and retain
idempotency and ownership fencing. Monitor pending age, retries and FAILED counts.

## Migration and future deployment boundary

The single additive migration is
`prisma/migrations/20261010170000_add_durable_product_webhooks/migration.sql`.
It retains every historical row, index and unique key. Existing receipts default
to COMPLETED, with receivedAt/completedAt copied from the original processedAt;
processedAt itself is preserved. It becomes nullable for pending work but retains
its now() default for legacy inserts, which still default to COMPLETED. Legacy
inserts after migration may have null completedAt; processedAt remains their
authoritative completion timestamp. No historical receipt is replayed.

The future rollout must coordinate the additive schema, compatible image and a
scheduled, explicitly enabled worker. Deploying durable HTTP intake while leaving
the worker disabled accumulates accepted pending work. The default intentionally
requires an explicit rollout decision. Rolling HTTP back to synchronous legacy
code does not drain already accepted work; retain a compatible drain worker or
perform a separately authorized reconciliation. Do not drop the added schema
while any durable work or compatible worker exists.

Tests use isolated in-memory clients and real bundled route/product modules.
They prove application-level commit ordering, compare-and-set behavior and
rollback contracts; they do not substitute for a later PostgreSQL integration
or production capacity certification. No production connection or migration
execution is part of this implementation task.
