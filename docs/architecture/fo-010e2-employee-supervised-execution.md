# FO-010E2 — Employee supervised execution and run attribution

Status: implemented. Builds on FO-010E1 (preflight), FO-010C (assignment core) and FO-005B/C (supervised execution).
Migration `085_employee_execution_attribution` (083 stays absent).

Recovery, unresolved-process guards and Employee Details history are strengthened
by [FO-010E3](fo-010e3-employee-recovery-history.md); its exact-link rules supersede
the original recovery/acknowledgement behavior below.

## One runtime

An employee run is a controlled new entry into the existing runtime, not a second one:
`employee-run.ts` → `launchEmployeeTask` (`project-execution.ts`, the same body `launchBatchTask` uses) →
`applyConfig` → the board's `startTask`. No new spawn, shell, scheduler, or approval engine.
The supervised proposal row it writes has `source: "employee"` and `employeeRunId`; the FO-005B approve/edit routes refuse it.

## Flow (two owner actions)

1. `POST /employee-execution/reviews` — runs the FO-010E1 preflight plus the supervised checks (`runChecks`) and stores
   ONE pending record (`awaiting-approval`, 5 min) describing exactly the run that would start. Same inputs → same record
   (idempotent); a newer review from another tab supersedes the older one. Blockers return `attempt: null` and write nothing.
   Needs an explicit `harnessId`; pipeline tasks and tasks with an open supervised proposal are refused.
2. `POST /employee-execution/attempts/:id/start` `{revision, confirm: true, acknowledgeUsage?, acknowledgeUnconfirmed?}` — the owner's
   confirmation, single use, bound to task, project, employee, assignment id + revision, harness, requested model/effort,
   permission mode, and the supervised checks the owner saw.
   * **validate + claim** in one `BEGIN IMMEDIATE` transaction: the preflight is recomputed from server state (ownership,
     `verifyLaunchScope`, assignment id/revision, active worker of the same project, harness enabled, Owner policy, no live run)
     and compared with the record; then a compare-and-set `awaiting-approval → starting`. A mismatch marks the record
     `rejected` in the same transaction. No await and no spawn inside it.
   * **invoke** the existing runtime (`launchEmployeeTask`), which re-runs the checks and re-verifies the employee state
     (`verify`) before it writes anything onto the task.
   * **persist** the real outcome: `started` (run id), `start-failed`, `rejected`, or `indeterminate`.
   Repeating the request returns the same record with `replayed: true` and launches nothing.
3. `POST …/cancel` withdraws an unconfirmed review. `GET /employee-execution/attempts?taskId=|employeeId=` and `GET …/attempts/:id` read.

All routes are bearer-only, 4 KB body, strict schemas (identifiers and flags; a path, command, account, or token is a 400).

## Not permissions

The confirmation is not an FO-010D assignment approval, not an FO-011E knowledge grant, and not a standing grant.
Assigning, proposing, Model Router preview, and preflight never start anything. Nothing the AI managers can call reaches `/start`.

## Requested, CLI-reported, and actual

`requested.*`: harness, model (the owner's choice, else the task's own), effort, permission mode, complexity.
`actual.harnessId`: the run row's `agent` (the adapter that was launched) — provenance `runtime`.

Model attribution has three slots:

* **Requested model** — the owner's explicit choice, otherwise the task's own model. This is what the launch asks for.
* **CLI-reported model** — a model id the running CLI prints in its own stream. Antigravity `init.model` and Claude Code's session JSONL `model` field are this kind of report. In the checked live runs both matched the `--model` flag ForgeOrbit had already placed on argv. Antigravity's same `init` object reported `permission_mode: request-review` while the process was started with `--mode accept-edits` and wrote the file without a permission card, so an init field is not proof of what the process did.
* **Actual observed model** — `actual.model` stays `null` (Unknown) unless runtime evidence shows which model served the turn, independent of the owner's selection and independent of a CLI field that echoes the launch flag. A successful spawn, the argv this process built, and that echo are not that evidence.

`actual.accountId` stays `null` for the same reason: a successful spawn is not proof of an account. The router recommendation is never copied. No credential, email, or external identity is stored or returned.
Unknown account/quota never block a manual start; disabled harnesses, Owner restrictions, concurrency and safety checks still do.

## Concurrency and recovery

* `employee_executions_one_open` (unique, `awaiting-approval|starting` per task) + CAS on `status` + `revision`.
  Two tabs, a double click, or two SQLite connections can claim an approval at most once.
* In-memory `startingTasks` (supervised) still refuses a second start from the board.
* A thrown error mid-start is `indeterminate`, never retried. FO-010E3 blocks another launch until reliable reconciliation; acknowledgement cannot release the guard.
* Boot: `recoverEmployeeExecutions()` — a `starting` row with no claim in this process adopts only its exact durably linked run, else becomes
  `indeterminate`. It never launches. Finished runs get `finished_at`/`result` from the run row (also on every `run-status` event).

## History

`employee_executions` is the durable Employee → Assignment revision → Task → Run link (soft references, no foreign keys).
Existing runs are not back-filled. `finished_at/result/reason` are copied once from the run row; run events stay in `runs`.
No cost or performance metric is computed.

## UI

Task details → Employee Execution: **Run Employee** appears for a fresh, prepared, unblocked preflight. It opens the review dialog
(task, project, worker, assignment revision, harness, requested model, permissions, account/quota status, Owner restrictions,
warnings, "resources are not verified"). Cancel/Escape withdraws. After Confirm the section shows the attributed run with its phase
(Starting / Running / Completed / Failed / Cancelled / Unknown outcome) and a link to the existing run history.

## Tests

`src/bun/employee-run.test.ts` (29), `employee-run-migration.test.ts` (4), `src/shared/execution/run.test.ts` (4),
`src/mainview/lib/employee-execution.test.ts` (9), `e2e/employee-run.spec.ts` (4). Older migration tests were extended with 085.

## Provider runtime gate (FO-PROVIDERS-RUNTIME01)

Developer and Reviewer launches that go through `executeRecordedProviderRun` keep the AccountCore binding and then negotiate the harness contract. A recorded fixture can produce a receipt. It does not spawn the provider, does not mark the run `real-provider`, and does not move a task to Done. QC still controls Done. Cancellation, timeout, and a missing structured result are not success and are not retried. Process supervision records descendant pids before the parent exits and closes extra file descriptors on contained spawns. Cursor and DeepSeek still refuse before any model process. See [provider runtime](provider-runtime.md).

FO-PROVIDERS-PIPELINE01 attaches that same negotiation to the production mission scheduler. After the workspace is prepared, `gateMissionProviderLaunch` checks the frozen account and opens a recorded lease. `startEmployeeExecution` remains the Developer launcher. `startQcReview` remains the Reviewer launcher. A failed, cancelled, or orphaned provider run releases the autonomy launch slot and is not relaunched. The Reviewer lease is read-only and uses the approved Reviewer account, not the Developer account.

FO-PROVIDERS-LIVE-READY01 binds that gate to `spawnCodexViaTmux` and `spawnClaudeViaTmux`. FO-OWNER-TRUST01 verifies a native Owner proof before either function runs. This unsigned process reports `application-identity-unestablished`, so a mission tick does not call them. Recorded Developer and Reviewer runs keep the same employee and QC services. `CHANGES_REQUESTED` still prevents Done. QC PASS still waits for `acceptAuthorizedTaskDone` when automatic completion is off.
