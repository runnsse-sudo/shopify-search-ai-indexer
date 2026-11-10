# Felkodsläsare: content-addressed catalog candidate

Local implementation based on main 7ac0af91f7de8917cf85eb38af00c52dc3f2d138.
No deployment, real file creation, link change, cleanup or activation was performed.

`felkCatalogAddress` derives `llms-full-<full SHA256>.txt` from exact UTF-8
catalog bytes. The SHA is part of the path, not merely a cache query parameter.
The future Shopify file creation must use the returned filename and
`duplicateResolutionMode: RAISE_ERROR`, never REPLACE or APPEND_UUID.
The publication adapter supplies a validated staged originalSource. Its new
fileCreate mutation is schema-validated for API 2026-10, not executed against
a store by local tests.

`felkCatalogUrls` rejects a reused legacy file ID, wrong tenant, processing
file, changed filename, unexpected host and nonexact version query.
`verifyFelkCatalogAddress` requires identical expected SHA256 and byte count
from BOTH the canonical CDN and shop-domain download, with stable READY
metadata before/after. A unique filename does not excuse failed readback.
These pure functions have no network or storage side effects.

## Future integration and unchanged safety gates

The existing publisher now has an explicit `felk-sha-candidate` mode, exposed
by the worker's separate `--publish-felk-candidate-once` command. The deployed
job and normal `--run-enabled-catalogs-once` command have not been changed.
The candidate command filters configured targets to Felkodsläsare and enforces
its exact existing shop, domain, GenericFile ID and CDN directory before I/O.
It shares the existing daily interval, identity, complete-catalog generation,
strict legacy metadata identity, catalogue validation and durable backup gates.

For coherent legacy bytes, unchanged product links still skip candidate creation.
For divergent legacy deliveries, each variant must be a valid own-store catalogue.
The candidate branch stores both exact byte variants through persistBackup under
the existing lock. Identical hashes share one content-addressed backup; differing
hashes require two verified durable backups. Each returned backup is hash/size
checked again. Any failed or corrupt backup stops before staging/fileCreate.

Both legacy endpoints are read again after backup; their metadata/version and
each side's SHA must still match the original snapshot. Drift stops before
candidate creation, including same-version byte changes or propagation into
agreement. The helper rechecks READY, legacy URL/ID and write_files before staging.
One-sided link equality or differing bytes with identical product sets never
produce an UNCHANGED result for a divergent delivery snapshot.

Only this separate candidate operation permits unequal old delivery hashes. The
ordinary existing-file replacement keeps its strict equality/retry/rollback gates.
Neither old variant is accepted as the correct baseline. The candidate comes
from the unchanged complete Online Store generator, not either old delivery.
The returned legacy evidence identifies both hashes, byte sizes, observation
time, version, distinct backup count and UNKNOWN_NOT_ADOPTED provenance.
Preserving two variants does not certify either old public URL as a consistent
rollback target. Any later discovery-link change or restoration still needs its
own fresh target verification and explicit approval; this path selects neither
legacy variant for publication or rollback.

After all guards pass, at most one staged upload and one fileCreate are attempted.
Duplicate filenames raise an error; no automatic rename, overwrite or retry.
Metadata/bytes may be read up to six times with the existing three-second
propagation wait; READY or version drift fails immediately. Creation failures
and uncertain readback throw through the existing storage lock, retaining it.
There is no delete, update, template write or checkpoint write in the candidate
adapter. A verified candidate returns CANDIDATE_READY, never PUBLISHED, and does
not advance the daily checkpoint. A retained orphan candidate after uncertain
failure requires read-only investigation and separately approved cleanup;
never rerun creation automatically. Unchanged links create no candidate.

Use the existing shop lock `shops/94d715-94.myshopify.com/llms-full/publication.lock`.
Do not acquire an alternate lock or remove the preserved failed-publication lock.
Before any mutation, verify the current baseline and persist/read back the
exact rollback bytes through existing durable backup storage. The observed
divergent 357/359-link baseline is not silently adopted. Ordinary replacement
remains BLOCKED on that mismatch. Separate candidate creation can proceed only
after both variants pass preservation and stability checks.

Create a NEW GenericFile for the SHA filename; retain the existing file and
discovery link. Verify new metadata and both byte paths before proposing a
separately authorized theme link switch. `felkCatalogLinkChange` prepares only
an exact literal URL replacement in templates/llms-full.txt.liquid: the caller
must supply actual theme text, its full SHA and the exact previous versioned
download URL. Absent/duplicate links or hash drift stop preparation. The patch
retains original bytes, before/after SHA, expected new URL and rollback bytes.
`restoreFelkCatalogLink` refuses rollback if any intervening template edit exists.
This is review data, not a theme API caller or proof of root publication. Persist
and verify the exact original template in durable backup before any future edit.
Never modify /agents.md or /llms.txt. On uncertain writes
or verification failure, preserve the lock and report uncertainty; no automatic
retry, deletion or garbage collection. Restoring the old pointer must not
depend on recreating overwritten content.

The root /llms-full.txt URL is not proven current by candidate verification.
It requires its own post-switch check. Shopify can still mutate a file by ID;
the SHA filename is a content-address contract, not provider-enforced immutability.

## Remaining release boundary

The installed old-file daily publication is not converted to content-addressed
publication by this package. It must not silently create a new file each day
without advancing the discovery link. A live candidate test needs fresh baseline,
lock, complete Online Store selection, durable rollback and explicit execution
approval. Divergence alone is allowed only for a separately created candidate
after both old variants are preserved. Malformed content, identity/version/byte
drift, failed backup, lock contention and new-file readback failures remain BLOCKED.
The preserved production lock was not read or modified by this local package.

Automated theme changes require write_themes AND Shopify's theme-file exemption;
existing write_files does not establish either. This package requests neither
and adds no permissions. A reviewed manual link change is possible separately.
A long-term automatic discovery-link strategy remains necessary before switching
daily publication to SHA filenames. Do not mark daily SHA publication ready or
enable it on the basis of local/synthetic success.

The original f2c1b948 validation remains historical: 706 pure tests passed. This
local correction adds regression coverage for distinct dual backups, the 359/357
case, failed/corrupt backups, same-version byte drift, version/READY/scope drift,
one-sided link equality, immutable-candidate failure and unchanged ordinary
replacement gates. New local results are recorded in the package FINAL.json.
No GraphQL operation, storage API, worker activation, DB contract or permissions
were changed. Existing schema-validation evidence applies to unchanged operations;
PostgreSQL and real provider verification are not run by this local package.

API contract references (2026-10):
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/FileCreateInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/enums/FileCreateInputDuplicateResolutionMode
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fileCreate
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/themeFilesUpsert
