# FO-010E1 — Employee execution preflight

Status: implemented. Execution itself is FO-010E2 and is **not** part of this stage.

## What it is

A read-only calculation that describes a *future* run of an assigned task by its worker:

`POST /employee-execution/preflight` (bearer only, 4 KB body cap, no query string, `cache-control: no-store`).

It starts no agent, creates no run, changes no task, employee, assignment, account, binding or quota row,
probes no CLI or provider, switches no account and reads no credential. The banner in every result is
**"Preflight only — no agent started."** and `executionAvailable` is always `false`.

No migration. Last migration stays 084; 083 stays absent.

## Request (strict schema)

`{ taskId, harnessId?, model?, effort?, complexity?, policy?, expectedAssignmentRevision? }`

Identifiers and choices only. A path, command, account, token, or unknown field is a 400.
`complexity` is the owner's statement (`low|medium|high|very-high`); omitted it stays Unknown.
`model`/`effort` are accepted only when the harness offers them (`AGENT_OPTIONS`, registry candidates,
`supportedEfforts`); they are echoed as *requested* and never stored.

## Checks (all read from current server state, in one read transaction)

1. Task exists (404 otherwise), is not a pipeline step, not archived, not live (`isTaskRunLive`, pipeline running),
   in a runnable column (`columnBlockReason`), and has no supervised start in progress (`isExecutionStarting`).
2. Ownership is decided now (`ownershipOf(..., { fresh: true })`) and `verifyLaunchScope` is applied
   (ambiguous, symlink escape, foreign worktree, missing folder, other project). Nested projects and git worktrees use the
   existing classifier; nothing is re-implemented.
3. The project is registered.
4. An active assignment exists (`AssignmentCore.forTask`). Never created here. The assignment's project must equal the
   task's current project. `expectedAssignmentRevision` mismatch → `stale-assignment`; the answer already carries the fresh
   worker so the next click proceeds.
5. The employee exists, is a `worker`, `active`, not archived, and belongs to the same registered project.
6. Harness: must be a registered local harness. Disabled → `harness-disabled`. Router `excluded` (including Owner
   disallow) → `owner-policy` / `resource-excluded`. A manual choice never bypasses these.

## Evidence states

`verified | conditional | unknown | blocked | conflicting`, from the existing Model Router assessments
(`classifyHarnessEvidence`). Unknown is never shown as Ready/Available. Verified requires the router's own `verified`
status (which needs a stated task complexity, an Owner spending policy, current authorization, model support, quota and
concurrency facts). Exhausted capacity is `blocked`; disagreeing sources are `conflicting`.

* **Account**: `Account Unknown` unless an explicit agent-profile association identifies it
  (`AccountCore.resolveIdentity`). Bound accounts are only *listed* (display name, provider); never chosen, never matched by
  email/plan/name, and `externalIdentity` is never returned.
* **Quota** and **model capability** are summarized from router evidence; stale/missing → Unknown.

## Router compatibility

Preview stays independent: preflight reuses `projectRoutingInput` + `buildRoutingSnapshot` + `routeTask` and returns the
recommendation as *reference only*. Nothing is written back; a recommendation is never recorded as the model used.
Per-harness `notRecommendedBecause` explains why a resource cannot be recommended automatically.

## Approval boundary

* FO-010D approval confirms the assignment only.
* FO-011E knowledge grant covers notes for a manager message only. The service does not read grant tables.
* Preflight stores no permission. `startContract` in every result lists what FO-010E2 must re-check.

## Consistency

Stateless. Two tabs get the same `stateKey` for the same state. The UI marks a result **Stale** when the task
(`column`, `updatedAt`, `archivedAt`, owner project, agent), the draft, or `validUntil` (30 s) changes. The server never
trusts a client timestamp; start must re-check atomically under a lock.

## Future run attribution (FO-010E2 contract; types in `src/shared/execution/attribution.ts`)

| Field | Source at start | Rule |
|---|---|---|
| employeeId, assignmentId, assignmentRevision | read under the start lock | not from the client |
| requested harness/model/effort | confirmed preflight inputs | |
| actual harness/model/account | runtime facts only | `null` = Unknown, never filled from *requested* or the router |
| ownerExecutionApprovalId | existing supervised approval | explicit, immediately before start |
| startedAt / finishedAt / result | run lifecycle | |
| provenance | `runtime` / `owner` / `unknown` | |

Existing `runs` rows are never back-filled; no fake runs. A durable table/columns should be added by FO-010E2
(next free migration after 084; do not invent 083).

## Plan for FO-010E2

1. Migration for a run-attribution record (employee, assignment revision, requested/actual, approval id).
2. Start endpoint that, under one write lock, repeats every item of `startContract.recheckAtStart`.
3. Route through existing `approveExecution`/`startTask`; no second runtime.
4. Record `actual.*` only after the CLI confirms; leave Unknown otherwise.
5. UI: a Run Employee action that requires fresh owner confirmation and is disabled for stale preflight.

## Tests

`src/bun/employee-execution.test.ts` (21), `src/shared/execution/preflight.test.ts` (4),
`src/mainview/lib/employee-execution.test.ts` (5), `e2e/employee-execution.spec.ts` (3).
