# FO-010E3 — Employee execution recovery, reconciliation and history

Builds on FO-010E1/E2, FO-010A/B/C and FO-005B. Uses the same Task Runtime,
`runs`, supervised proposals and migration 085 `employee_executions`. No new
migration, history table, launcher, scheduler, account selection or CLI probe.

## Durable proof before spawn

`launchEmployeeTask` still delegates to `launchApproved` → `startTask`.
For an employee start only, an internal `onRunRecorded` callback saves the exact
Run ID on its existing supervised proposal **inside the transaction that inserts
the run and changes the task**, before spawn. A callback failure rolls back both.
Other launch origins retain their existing behavior.

Reconciliation accepts an existing attempt's Run ID or its exact supervised
proposal link. The proposal must match execution ID, employee attempt ID, source,
task and project. The Run must belong to the task and follow the approval claim.
A run near the claim's timestamp, the task's latest run, a matching harness, or a
later follow-up is never enough to adopt it. Historical run rows are not backfilled.
The employee branch of supervised recovery also refuses the old time heuristic.
Its exact linked proposal is settled once so a completed recovery does not leave
a permanent open-proposal blocker.

## Reconcile API and outcomes

`POST /employee-execution/attempts/:id/reconcile` with exactly `{}`.
Bearer authentication runs before parsing; body cap 4 KB; no query string;
`Cache-Control: no-store`. Client Run IDs, statuses, commands, paths and account
choices are rejected. Current task ownership must still match the recorded
project (`ownershipOf` fresh + `verifyLaunchScope`), or reconciliation returns
409 `ownership-changed`. Historical employee snapshots remain readable.
Renaming, archiving or reassigning an employee never rewrites attribution.

The operation uses a synchronous SQLite immediate transaction. It does not call
`startTask`, spawn, cancel, signal, switch accounts, or mutate a Run.

| Outcome | Required server evidence |
| --- | --- |
| `running` | Exact linked Run and canonical `active` handle in this process |
| `terminal` | Exact linked Run with succeeded/failed/cancelled status and actual `endedAt` |
| `start-failed` | Previously recorded refusal, or an exact supervised `start-refused` event written after a structured Runtime start error before any Run was recorded |
| `indeterminate` | No exact link, missing Run, conflicting link, orphaned Run, or running row without a current Runtime handle |

A bounded pending spawn is displayed as **Starting** only while the existing
Runtime holds the exact pending claim (`startingTaskIds` plus the task's Run ID).
A persisted `running` row alone does not prove a live process. Raw launch
exceptions are not stored; employee start-error diagnostics are neutral sentences.
The existing proposal history records exact-link recovery once. `Reconciled` is
an operation result, not a fictional new terminal status in migration 085.

## Uncertainty and Owner controls

Boot calls the same recovery after canonical Runtime recovery. A lost Starting
claim with no exact link becomes indeterminate. Known orphaned Runs keep their
canonical orphaned result and bookkeeping end time, but the UI calls their
outcome Unknown and explicitly warns that process fate is unknown.

`acknowledgeUnconfirmed` remains parse-compatible for older clients; it does not
release any guard. Review creation and start claim both check unresolved earlier
attempts, atomically at their write boundary. An indeterminate attempt, an
unfinished accepted start, or an orphaned result blocks another employee start.
A later start cannot erase an older unresolved attempt. The canonical `startTask`
also checks this guard, so the ordinary Run Task entry cannot bypass it. Only
its own internal, Owner-approved Starting claim is excluded for employee launch.

The Task panel and each uncertain employee-history entry expose **Reconcile
Status**, the recorded reason, Run ID when known, requested/actual resources,
approval provenance and times. No manual force-release action is provided. A
legacy attempt with no provable link can therefore remain blocked indefinitely;
there is deliberately no un-audited override hidden in a warning checkbox.

Completion copies the actual Run end time/result once with a guarded UPDATE.
Missing `endedAt` never becomes `Date.now()`. Repeated reconciliation leaves
terminal attribution, run events and proposal recovery history unchanged.

## Employee Details → Execution History

Uses the existing `GET /employee-execution/attempts?employeeId=` API and immutable
attempt snapshots: Task, Project path, assignment UUID/revision, Run ID,
requested harness/model/effort, actual harness, actual model/account or Unknown,
Owner approval provenance/ID/time, started/finished time, phase and reason.
Expandable rows link into the existing Task / Run panel; there is no new Run
viewer. The underlying RunsList continues to display the task's complete history.
Employee identity changes and archive do not remove this history. Deleted tasks
retain their snapshot, although their existing Task Details can no longer open.

`limit` is 1–100 (default 50). Employee history supports an opaque attempt-ID
`before` cursor, scoped to the same employee, ordered by `(created_at, rowid)`
descending. The UI fetches 21 rows, displays 20, and uses the last displayed
attempt for the next page. Inserts between pages do not duplicate or skip old
rows. Unknown/cross-employee cursors yield an empty page, not foreign rows.
Refresh restarts at page one. Loading/error/retry/empty states are explicit.
Long lists scroll within the existing Liquid Glass card, with nonshrinking rows.
No cost, token, quality, or performance metrics are fabricated.

## Mounted polling only

Task status polling uses an abortable, non-overlapping 2-second timeout while
an observed attempt is Starting/Running. Terminal/unknown phases schedule no
next timeout. Cleanup aborts outstanding fetches, cancels the timeout and ignores
late responses on section close, task change and unmount. No global background
polling was added. The Company history refreshes on demand; it does not poll.

## Follow-up attribution boundary

The code in `orchestrator.ts` uses a new `runs` row for queued Codex, Cursor,
Gemini, Antigravity and fx turns. Idle/resumed Claude turns also mint a new Run.
Claude messages folded into a busy turn (`pasteFollowUp`) append user events to
that existing active Run; they naturally remain visible through its Run ID.
No extra Employee Execution row is invented for messages within the same Run.

New follow-up Run IDs are **not** automatically attributed to the employee
currently assigned to the task. A future implementation needs a fresh, expiring
Owner execution review for that turn, current ownership and employee/assignment
revision checks under its claim, and an exact transactional link at the relevant
follow-up Run factory. It must not retroactively attribute old Runs or reuse the
first turn's approval. That Runtime change is outside FO-010E3. Existing follow-up
execution semantics are unchanged; this stage's additional canonical guard covers
new `startTask` launches, not a redesign of `sendInput` approval semantics.

## Validation scope

New coverage: `employee-reconciliation.test.ts` and `employee-execution-poll.test.ts`.
The backend file covers exact active/terminal/error proof, missing/conflicting/
foreign links, repeated/concurrent reconcile, lost Starting and Running claims,
a separate recovery process, unresolved/orphan guards, ordinary-start bypass,
stale assignment, rename/archive, ownership changes, stable pagination, Unknown
resources, Run History compatibility, absent end timestamps, follow-up boundaries,
strict bearer schemas, no CLI calls, secret-free diagnostics, atomic callback
rollback, and bounded pending spawn.

Backend suites run in separate sequential Bun processes with isolated temporary
HOME/data/SQLite, all drivers fake, CLI binaries stubbed and usage offline. No
full suite or real Codex/Claude/Antigravity command (including version probes).
Playwright must run through Bun because existing `e2e/helpers.ts` imports
`bun:sqlite`: `CI=1 bun --bun node_modules/@playwright/test/cli.js test …`.
Chromium needs a macOS sandbox exception for MachPortRendezvous in this workspace.
The optional validated `FORGEORBIT_E2E_API_PORT_OFFSET` isolates fixture backend
and GitHub stub ports across worktrees; it leaves the default ranges unchanged.

See `fo-010e3-validation.md` for final counters, browser checks and limitations.
Native Electrobun, provider/paid execution and Organization End-to-End readiness
are outside these checks. Organization End-to-End and Final QA are not started.
