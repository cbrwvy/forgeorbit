# FO-010D — Organization delegation and employee assignment proposals

## Goal
Let a project manager (or the owner) *suggest* which worker should take an existing task, show the suggestion to the owner, and let only the owner turn it into a FO-010C assignment. Approval is not execution permission.

## Entities (not interchangeable)
| Entity | Where | Meaning |
| --- | --- | --- |
| Employee identity | `ai_employees` (FO-010A) | a named position; no harness/account/model |
| Assignment proposal | `assignment_proposals` (084) | an unreviewed suggestion |
| Task assignment | `employee_task_assignments` (FO-010C) | who is responsible; owner provenance |
| Resource recommendation | Model Router preview | untouched |
| Execution approval / run | supervised execution | untouched |

## Why a new table
FO-010C's tables are the authoritative, owner-only record (`provenance = 'owner'` CHECK, one active row per task). Putting drafts there would blur "suggested" and "assigned" and break its invariants. A proposal needs its own revision, status and audit trail, so migration `084_organization_assignment_proposals` adds two tables. 083 is left free for FO-009F; merging both later only needs the two files in order (the runner records ids, not positions).

## Lifecycle
`pending → approved | rejected | cancelled | stale`. All terminal. Every change appends a row to `assignment_proposal_events` (`created`, `approved`, `rejected`, `cancelled`, `stale`) with actor `owner | project-manager | system`.

* **create** — owner API (`POST /assignment-proposals`) or manager reply. Validated: task exists, open (not archived/done/pipeline step), unambiguously owned by a registered project; employee exists, is an active unarchived **worker of that same project**; not already assigned to that worker; no other pending proposal for the task; ≤ 50 pending per project. The project comes from the task, never from the caller.
* **approve** — body `{expectedRevision, expectedAssignmentRevision, allowReassign}`. One immediate transaction: replay check → revision check → stale check → assignment-revision check → consent check → `AssignmentCore.assign/reassign` → proposal row update + event. A failure anywhere rolls everything back. A stale finding is committed (the proposal becomes `stale`) and answered 409 with the proposal.
* **reject / cancel** — `{expectedRevision}`; change only the proposal.
* **replay** — repeating a decision at the revision it was decided from returns the stored result (`alreadyApplied: true`); no second assignment, no second event.

## Stale rules
Evaluated with fresh ownership on every list/get/approve: task deleted, archived, done or turned into a pipeline step; project unregistered; task moved to another project / now ambiguous / unattributed; worker deleted, archived, inactive, not a worker, unassigned or moved; the task's active assignment differs from the one recorded at proposal time; the task is already assigned to the proposed worker. A cluster move changes none of these inputs. Staleness only moves `pending → stale`; it never assigns, unassigns or reassigns, and never rewrites FO-010C history.

## Manager protocol
When the project has active workers, the manager prompt includes a team block (inside the untrusted-data fence: refs `w:<8hex>`, name, title, specializations, open count) and each backlog line shows `assigned to <name>`. The reply may contain `<assignment_proposals>{"proposals":[{"task":"#1a2b3c4d","worker":"w:0a1b2c3d","rationale":"…"}]}</assignment_proposals>`. Treated as untrusted input: refs must be 8 hex, entries without a reason or repeating a task are dropped, ≤ 10 per reply, reasons are redacted and capped; the core resolves refs inside this project only and applies the owner-path checks again. Free text is never an instruction. Dropped entries are reported in the reply's `proposalError`.

## Head / Portfolio
No second Portfolio Manager and no runtime binding for the Head. The Head's recommendation travels through the existing owner-approved delegation to the project manager; if that turn produces proposals they record the `delegation_id`. The Portfolio shows a read-only per-project summary of pending proposals and links to the project; it cannot approve.

## Security boundaries (verified by tests)
No run start, CLI call, provider call, account switch, quota refresh, router call, path read or credential access. Bearer auth on every route, query tokens rejected, strict body schemas, 8 KB body cap. A source-scan test pins that the modules import no orchestrator/agents/router code.

## Limitations
* Proposals are created by an owner action or a manager reply the owner asked for; nothing proposes in the background.
* The portfolio manager's own prompt does not yet list pending proposals.
* The manager sees only workers' labels (name, title, specializations) — not evidence of ability. No scores are stored.
* Stale detection is lazy (on read/approve), not event-driven.
* `083` is absent in this branch; FO-009F will add it.

## Integration with FO-009F (merged)
* `083` stays unused: FO-009F added no migration, and the runner records ids, so the applied order is `… 081 → 082 → 084`. Do not add a placeholder `083`.
* `e2e/organization-integration.spec.ts` covers the whole chain on fake drivers: manager suggestion → pending in Project and Company → owner approval (FO-010C assignment) → explicit reassign → model-router preview leaves the assignment unchanged → Codex source stays Unassigned / Unverified, with no run, start, CLI or quota/account request.
* `e2e/portfolio-dashboard.spec.ts` ("empty portfolio") uses the worker-shared backend and fails when run late in a long single-worker batch with other specs; it passes alone and is unrelated to proposals.
