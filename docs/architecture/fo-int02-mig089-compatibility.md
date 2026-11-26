# FO-INT02-MIG089 — Legacy hiring compatibility

Date: 2026-10-26 (UTC). Baseline: `0bca1abbac9fcd9f312d0ee5a505a2294d3f9fcb`.
Worktree: `/path/to/forgeorbit-int02`; branch: `task/fo-int02-integration`.

## A. Root cause

088 permitted duplicate pending project/role pairs and duplicate project/message/role
triples. 089 adds two unique indexes over those keys and consequently failed on
legal legacy data. The original failure controls are retained in
`integration-upgrade.test.ts`, explicitly running the historical registry without
new preparation. Both still reject duplicates non-destructively.

## B. Existing 088 data contract

`hiring_proposals` has 23 columns: id, project_path, proposed_name, kind,
professional_title, catalog_role_slug, template_sha256, prompt_markdown,
justification, competencies, related_tasks, proposed_by_kind,
proposed_by_employee_id, source_message_id, status, revision, created_at,
updated_at, decided_at, decided_from_revision, decision_note, stale_reason,
created_employee_id. (The authoritative list is the unchanged 088 source.)
References to employees, projects, source messages and events are soft references;
neither hiring table declares foreign keys. Events contain their own integer id,
proposal/project, action, actor, revision, employee, note and timestamp. The existing
CHECK vocabulary admits `stale`/`updated` events and `system` actors; it does not
admit a new action called `legacy_duplicate_normalization`.

## C. 089 constraints

The pending index covers only pending rows. The replay index covers non-null
source_message_id across **all** statuses. Staling a row alone cannot solve replay
collisions. Neither historical SQL file nor either index definition is changed.

## D. Compatibility policy

A separately versioned synchronous migration, `088a_legacy_hiring_compatibility`,
is registered immediately between 088 and 089. For each pending project/role
collision, the earliest submitted row by `(created_at ASC, id COLLATE BINARY ASC)`
remains pending. Later alternatives are parked as Stale for Owner review, not
approved, rejected, withdrawn or deleted. Distinct prompts are never merged or
ranked for quality. This queue policy retains the first outstanding request and
makes no hiring decision. Owner can inspect every alternative before deciding.

Source-message collision groups independently retain the first row by the same
ordering as the replay anchor, regardless of its status. Other rows detach their
indexed source_message_id only after a permanent original snapshot is inserted.
The anchor may be a historical decided row: replay must return history rather
than reopen a rejected decision or create a new proposal.

## E. Normalization algorithm

Inside one synchronous SQLite writer transaction:

1. Create provenance table, lookup index and immutable-record triggers.
2. Read proposals in the canonical order and group exact keys (JSON tuple keys
   avoid delimiter collisions). Refuse values that cannot be serialized losslessly.
3. For every participant in either collision group, including anchors, persist
   its complete original proposal row and original events as JSON, plus original
   source ID/status, project/role, canonical pending/message UUIDs, reason and time.
4. Detach only non-anchor source-message fields. Park only non-anchor **pending**
   rows as stale, set the required stale reason/system timestamp, and increment
   revision so old pending CAS approvals cannot succeed.
5. Append a `system` event (`stale` or `updated`) whose note identifies
   `legacy_duplicate_normalization`. Preserve all prior events.
6. Execute unchanged 089 SQL and insert both migration ledger entries; commit.

No proposal or original event is deleted. Normalization does not update any
Employee, assignment, profile, task or run. No asynchronous work occurs in the
write transaction. SQLite values outside safe JSON integer/type representation,
including null proposal UUIDs, fail closed with an Owner-review diagnostic. Their
transaction is rolled back; they require a separately reviewed lossless handling
policy, not manual SQL edits or rounding. This exceptional path remains BLOCKED
if encountered; no such real data was inspected in this work.

## F. Provenance preservation and Owner visibility

`hiring_legacy_provenance` stores original proposal UUID, message, project/role,
status, both anchor IDs, reason/time, **all original row fields**, and original
event records. This includes distinct names, full prompts, justification,
competencies/task references, author, decision fields and createdEmployeeId.
BEFORE UPDATE, DELETE and replacement INSERT triggers prevent mutating an existing
provenance record, including INSERT OR REPLACE. As with other local schema guards,
a database administrator capable of dropping schema objects is outside this guard.

Hiring API responses expose `legacyNormalization` with the snapshots and anchor
IDs, and sourceMessageId resolves to the original attribution even when its indexed
storage field is null. Existing proposal UUID endpoints remain valid. Proposal
cards offer an expandable “Legacy proposal preserved for review” disclosure with
original source, anchor and full audit context. All/Stale filters retain access to
parked alternatives; decided proposals stay in their original status filters.
No UI choice silently selects a different proposal for approval.

To prefer a parked alternative, Owner reviews its original prompt, resolves the
remaining pending request explicitly (for example withdraws it through the existing
CAS API), then submits the desired content as a new proposal for normal approval.
The original UUID, original decision and migration snapshots stay available.
There is no automatic reactivation or automatic employee creation.

## G. Owner decisions

Approved, rejected, withdrawn and previously stale rows keep status, revision,
all decision fields, original timestamps, prompts and employee links unchanged.
Only a duplicate's indexed source field can detach, with original attribution
preserved permanently and exposed through the API. Added system audit events are
separate from existing Owner events. Pending normalization does not populate
Owner decision_note or decided_from_revision; decided_at is required by 088's
pending/stale CHECK and represents the system normalization timestamp in this case.

## H. Transaction boundaries

The migrator adds synchronous `apply` and explicit `atomicWithNext` metadata.
Compatibility preparation and 089 share `BEGIN IMMEDIATE`, including snapshots,
audit changes, indexes and both ledger entries. Missing/reordered partner fails
before preparation. Existing migrations still retain their individual boundaries.
Ledger presence is re-read inside the write lock to avoid two connections applying
the same pending migration from a stale pre-lock snapshot. Busy errors remain
retryable failures; the runner does not fabricate completion or reset the ledger.

Injected failure after index creation rolls everything in the group back. A real
child-process exit inside preparation also leaves the original WAL state after
reopen. Prior migrations remain committed, as before. A DB already at 089 gains
only the new empty provenance schema/ledger entry; its proposal rows/indexes remain
unchanged. Repeated startup/runner calls are no-ops.

## I. Registry

`088_employee_hiring_proposals` → `088a_legacy_hiring_compatibility` →
`089_hiring_proposal_dedup`. The TypeScript preparation is deliberate: it snapshots
all original fields, performs synchronous data normalization and creates complete
trigger statements without extending the historical SQL splitter's grammar.
088/089 SQL bytes are unchanged. There is no downgrade or DROP TABLE recovery.
A failed grouped transaction needs rollback/retry, not destructive reconstruction.

## J. Existing 089 / runtime replay

Existing 089 databases accept preparation alone without dropping constraints.
PM replay finds the retained indexed anchor and never creates replacements for
legacy history. Source-only detached rows are reachable under their original UUID
and expose original source attribution. Replay lookup now precedes the pending
capacity check, so a full pending queue cannot suppress an idempotent historical
response. Fresh proposals still pass capacity, pending-unique and replay-unique
constraints. Existing Owner approval and profile CAS code is unchanged.

## K. Test matrix

214 passing targeted Bun cases across 22 separate file processes, zero final
failures/skips. Full suite not run. The 12 new compatibility cases cover:

- Pending-only, source-only and combined collisions, including all five statuses;
  distinct UUIDs, names, prompts, timestamps, decisions and employee references.
- Full original proposal/event snapshot comparison, unchanged employee/profile
  rows, API source provenance, immutable mapping including replacement inserts.
- Reopen/rerun, both unique constraints after upgrade, canonical replay.
- Fault injected after 089 index creation with full data/schema/ledger rollback.
- Existing 089, missing atomic partner, timestamp ties and unsafe-integer refusal.
- Two-connection writer contention and retry; actual abrupt process exit/WAL reopen.
- Approval CAS and idempotent employee identity after normalization; replay at capacity.

The 7 existing integration-upgrade cases still cover fresh, 086, 087, clean 088,
populated 088 and both retained original failure controls. Regressions include
Hiring core/endpoints/concurrency, two-process approval races, Profiles, PM hiring,
Employee, Assignment, Head, migration registry and affected historical boundaries.
Raw logs: `/private/tmp/fo-mig089/` (temporary, not a release archive).

## L. Snapshot comparison

For every collision participant the original snapshot equals its pre-upgrade row,
and original_events equals the pre-upgrade events for that UUID. Current prompts,
names and UUIDs are unchanged; decided states preserve original Owner decisions.
Old event rows remain a prefix of the event ledger, with system events appended.
Current profile/revision/employee snapshots remain identical. Exception and crash
probes prove original rows and migration ledger are restored before successful retry.

## M. Concurrent SQLite results

Writer lock contention leaves 088 data unchanged; a later retry succeeds from a
second connection and the first observes an idempotent no-op. The existing two
independent process approval races pass: one employee/profile/approval event, the
competing approval conflicts, and no task run is created. Constraints remain active.

## N. Typecheck / build

`bun run typecheck`, Vite build and `git diff --check`: PASS. Vite retains existing
chunk-size/config-loader warnings. Five stale expectations in `migrate.test.ts`
also failed against the exact baseline migrator/registry in a temporary copy.
They are updated by explicit boundaries/current migration suffixes, retaining data,
claim, alias and restart assertions. No test was deleted or disabled.

## O. Remaining risks and boundaries

Only synthetic temporary HOME/SQLite, offline usage and fake/stub drivers were
used. No user SQLite/WAL/SHM, credentials, provider API, real AI CLI, Keychain,
backup, Native .app or production recovery was accessed. No capacity/performance
claim for arbitrarily large legacy stores is made; snapshots duplicate audit data
and need disk space. Disk-full errors roll back the group. Unsupported SQLite
value representation fails closed and requires a reviewed policy before that data
can upgrade. Real production upgrade safety was not established or applied.

## P. Integration verdict

**FO-INT02-MIG089: synthetic compatibility acceptance PASS; READY FOR OWNER REVIEW.**
The confirmed duplicate-key upgrade blocker is resolved for supported legacy
values with preserved history. Exceptional preflight failures remain BLOCKED for
the affected database pending Owner-reviewed lossless resolution. No main merge
or application to user data is authorized by this implementation or test result.

## Q. Native QA

NATIVE-005 remains **BLOCKED**. The original SQLite incident consequences remain
unknown. No native application was launched.

## R. Commit

Local commit: `fix(migrations): preserve legacy hiring proposals before unique indexes`.
The resulting SHA is recorded in the delivery message.

## S. Git status

Baseline branch/HEAD/status verified: `task/fo-int02-integration`, `0bca1ab`, clean.
Only migration compatibility, provenance presentation, targeted tests and reports
are included. Main remains `430c498a7cfbcd4f77e0e370ffaaf9ae0262faf9`. Final status is
verified after the local commit and recorded in the delivery message. No push,
main merge, rebase, force operation, remote change or manual .git edit occurred.
