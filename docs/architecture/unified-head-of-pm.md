# Unified Head of PM (FO-ARCH01 / FO-ARCH02)

Phase A baseline: `430177fb` on local `main`. FO-CURSOR03 recorded its single
attempt and stopped. No GitHub workflows were present.

## Boundary and compatibility decision

Owner → one Head of PM → clusters → projects → specialist agents. Clusters
group projects and infrastructure. Projects own the board, settings, workers
and evidence; neither requires a manager identity or its own model setup.

| Existing owner | What it owns | FO-ARCH01 treatment |
| --- | --- | --- |
| Portfolio Manager, migrations 075/086 | Singleton config, messages, decisions, plans, Head binding, turn provenance; legacy delegations | Keep the singleton and consent checks. Scope requests in the Head dock. |
| Project Manager, migrations 070/071/096/099/104/113 | Per-project config, isolated chat, proposals/decisions, intake grants, execution plans, batch and recovery links | Preserve legacy records and gated APIs. Reuse domain operations. Do not copy chat or run a second manager from a scoped turn. |
| Board, scheduling, assignments and employee execution | Backlog admission, project ownership, worker eligibility, durable assignment, independently reviewed launch, results and QC | Call existing services; retain their separate authorization and execution boundaries. |
| Clusters, infrastructure and knowledge | Registry memberships, environment declarations, resource links, scoped Markdown notes, FO-INFRA-AUTO01 plans and attempts | Read selected metadata. Head may prepare a frozen plan and a pending proposal. It does not dispatch. Remote execution stays behind the blocked Owner channel. |
| Brain and portable profiles | Company/project memories, grants, exact revisions, historical provenance and restore | Keep existing storage and one-turn grants; no backup format changes. |
| Browser/native Computer Use | Separate one-turn grants bound to the requesting manager | No new authority or inherited worker access. |

Risk before editing: project manager history is coupled to approval cards,
workflow/batch recovery, and older portfolio delegations. Removing those routes
or converting their rows would break active and historical workflows. Keep the
explicit legacy entrypoint while verifying the new path. Avoid forwarding prior
project replies or privileged observations into another project turn. Freeze and
recheck project ownership and cluster membership at approval; a model response
is never an Owner instruction. The Head proposal flow must not call a worker or
deployment executor by itself. Infrastructure questions are answered by
`tryAnswerInfraQuestion` from registered rows before inference. A deploy
sentence creates an `infra_proposals` row and does not start an adapter.

## Scoped conversation

The Head dock sends all turns to `POST /portfolio-manager/messages` with a
`scope`: workspace, cluster, project, or task. The scope affects retrieval,
not the conversation ID or provider. The selected registry key is saved on
the owner message and reply, with source descriptions on the reply. Retry
keeps the original scope and rejects a changed registration or membership.
The scope selector shows canonical choices; the API also resolves an exact
project name, cluster name or slug and rejects ambiguous names before
preflight. For free text that points elsewhere, Head asks the Owner to select
the target. There is no second inference for scope resolution.

- Workspace supplies counts and a bounded directory of names; it does not
  fetch task titles, repository contents, or project memory bodies.
- Cluster supplies its members' board counts and linked infrastructure
  metadata. Project supplies bounded board titles, active specialists, and
  declared environment/registry metadata. Task supplies the single board
  task, QC status, its assignment, and recent persisted execution outcomes.
  Run logs, secrets, and repo contents are not fetched.
- The model receives only bounded conversation history from that scope.
  Replies informed by attached Brain, knowledge or Computer Use grants are
  excluded from later prompts. Cluster replies are kept in the visible
  transcript but not carried into later prompts because membership may change.
- Brain remains off unless the Owner previews and approves exact revisions
  for a turn. Company memory is allowed with a valid grant; project memories
  must belong to the selected project or cluster. Knowledge grants retain
  their own owner checks. A reply with attached data cannot propose a board
  action for a worker. No grant transfers to a specialist.

Provider, model, effort, account handling, consent, and isolated execution are
the existing singleton Portfolio Manager mechanisms. FO-ARCH01 does not alter
Cursor or any harness. FO-CURSOR04 fixed the short IPC path. FO-CURSOR05's
real request then failed because Cursor's own sandbox cannot start under the
outer Seatbelt. FO-PROVIDERS-READY01 keeps that execution block.

## Board and execution

A scoped turn can save one immutable proposal covering any supported board action:
`create`, `edit`, `prioritize`, `admit`, `stage_ready`, `assign`, `plan_execution`,
`execute`, `request_qc`, `rework`, or `complete`. The proposal records its Head message,
target project, cluster, action type, required permissions, selected specialist and provider,
execution/QC policy, expected side effects, status and result. Approval and rejection
require the existing Owner API boundary and explicit confirmation.

Only observed task and specialist IDs can appear in a proposal; approval rechecks the registered target,
task ownership, lifecycle state (`assertLifecycleAllowsWork`), and current eligibility. Moving a project
to a different cluster invalidates its older proposals.
- `create`: adds a Backlog task through the task service with a reserved ID.
- `edit`: updates task title and prompt specification.
- `prioritize`: updates task scheduling and ordering.
- `admit`: uses the Board's normal intake operation (`canAdmitTaskToInbox`, `admitTaskToInbox`).
- `stage_ready`: stages an admitted Inbox task to Ready after lifecycle verification.
- `assign`: uses `AssignmentCore` to assign a durable specialist employee.
- `plan_execution`: records execution launch parameters via `reviewEmployeeExecution`. It does not start the specialist. Sandboxed Auto on a linked worktree can read the repository and cannot write Git data outside that workspace. The plan stays pending until the Owner approves operation `developer-execution`, scope `task-staging`, for that registered project and the named output paths. That approval prepares the existing task-owned directory and reviews Codex `workspace-write` there. It does not select Full access, create a Git worktree, or copy files back into the project. Rejecting the permission leaves the proposal pending and starts nothing.
- `execute`: starts approved worker workflows via `startEmployeeExecution` without creating duplicate engines.
- `request_qc`: launches independent QC review via `prepareQcReview` and `startQcReview`.
- `rework`: moves task back to Ready after QC changes are requested.
- `complete`: verifies `assertCanMoveTaskToDone`, records `acknowledgeQcOwnerReview`, transitions task to Done, and executes `onOrchestratedOwnerDone`.

This preserves provider selection, project lifecycle, quota and launch checks. Multiple projects
retain independent assignments, runs and results. All executions require explicit Owner approval
in Supervised mode; repeated approvals are idempotent and do not duplicate work or relaunch workers.

When Head of PM is scoped to one registered project, "Brain for the next message" lists that project's active data memories. Each memory checkbox is named with the memory title and can be selected from the keyboard. The selected count is shown before the Owner previews and confirms the set. The confirmed memories stay data for that one message. A memory from another project is not added.

## Migration and legacy access

1. Migration 120 adds one table without rewriting any existing rows or
   changing the portable backup format. An interrupted approval is reconciled
   from persisted state: a created task with the reserved ID is recognized;
   an uncompleted approval is marked failed. State reads never replay an
   approval or relaunch a manager or worker. Historical proposals whose
   project path no longer resolves require a new scoped proposal.
2. FO-ARCH01 made the dock the primary project management surface using the
   workspace Head configuration and labeled the old project tab Legacy Manager.
3. `GET /project-manager` remains the historical reader. Project Manager
   config/message/preflight endpoints and unscoped portfolio turns are
   deprecated for new management work. They remain for old chat, planning,
   legacy delegations and the workflows that still depend on them. Existing
   proposal settlement, batch recovery, and approval APIs remain. No history
   was moved or assigned to the new Head.

### FO-ARCH02 Owner interface

The dock is the only composer for new management messages. Its project
shortcut on each project page sets that project's scope in the same Head
conversation. Adding a project creates no manager identity or per-project
model configuration. Project settings, the Board, task settings and
independent task runs stay in their usual places.

Portfolio's Head settings use the existing singleton configuration and
consent flow. The page also shows the existing transcript and approval
cards. It has no separate composer or unscoped retry. The dock still has
one-turn context controls: Brain follows the selected scope; Knowledge
offers company notes and notes for the selected projects or cluster. Browser
and native grants are offered in workspace scope, clear when switching
scopes or after sending, and never pass to a worker. The server still
checks the granted data and action against its existing rules.

A project's **Legacy Manager** page has conversation history and the
existing proposal, decision, Inbox, plan and run controls. It has no
composer, retry, intake grant, or team recommendation prompt. Its legacy
model settings remain available for an Owner to repair a previously
recorded delegation, for example after provider consent changes. The
Company no longer offers manager provisioning or treats its absence as a
missing project role. Historical identities remain visible. The Head dock
keeps existing initiative and batch records, approvals and recovery links;
it does not offer to create another legacy initiative or delegation.

No schemas, rows, or compatibility routes changed. Previously approved or
pending workflows still use their original project, message, proposal,
execution, batch, and delegation identifiers. Existing delegation approval
or retry may explicitly invoke the old manager. Active legacy turns can
still be cancelled; entering the page or restarting the app does not issue
another turn. Legacy services remain because the scoped protocol does not
replace existing multi-project delegation, proposal settlement, or batch
recovery. A separate migration would be required to retire these services
or give new scoped turns the old cross-project planning protocol.

See [FO-ARCH02 verification](../qa/fo-arch02-results.md) for the separate
native and compiled UI verdicts and the full compatibility inventory.

### FO-HEAD-UNIFIED01 Unified management workflow

FO-HEAD-UNIFIED01 completes the architectural vision allowing the Owner to manage
an entire project lifecycle directly through the single Head of PM conversation:
1. Intake: Task creation, Backlog edits, prioritization, and Inbox admission.
2. Preparation: Specialist assignment (`AssignmentCore`), staging to Ready, and execution planning (`reviewEmployeeExecution`).
3. Execution: Direct worker execution launch (`startEmployeeExecution`), monitoring live runs and specialist status via scoped Head context.
4. Quality Control: Independent QC launching (`prepareQcReview`, `startQcReview`), rework routing back to Ready on changes requested, and Owner completion (`assertCanMoveTaskToDone`, `acknowledgeQcOwnerReview`, `onOrchestratedOwnerDone`).
5. Progress & Oversight: Scoped context surfaces active specialist status, exit codes, recent runs, remaining tasks, blockers, and completed 24h work.

All operations execute through existing underlying services and preserve established
Supervised approval boundaries without creating redundant execution engines or per-project
AI managers. See [FO-HEAD-UNIFIED01 results](../qa/fo-head-unified01-results.md).

### FO-ORCH-SCALE01 Scalable Multi-Project Orchestration

FO-ORCH-SCALE01 scales the coordination layer from two-project bounded initiatives into
a global multi-project orchestration coordinator:
1. **Durable Multi-Project Missions**: Structured plans spanning multiple clusters, 30+ registered projects, and concurrent specialist tasks bound to SHA-256 digests (`orchestration_missions`).
2. **Cross-Project Dependency Engine**: Explicit cross-project DAG dependency resolution (`orchestration_task_dependencies`) with cycle detection before approval, missing reference validation, and condition settlement upon verified QC PASS or Done status.
3. **Concurrent Scheduling Coordinator**: Global, per-project, and per-account concurrency limit enforcement with fair round-robin scheduling to avoid single-project starvation. Integrates AI Router 2.0 recommendations and eliminates blocked providers (Cursor, DeepSeek).
4. **Reliable Restart Recovery**: Atomic task reservations (`orchestration_reservations`) and conservative startup reconciliation (`recoverOrchestrationMissions()`) without duplicate worker launches or silent retries.
5. **Head of PM Multi-Project Integration**: Head of PM context scope expanded to 64 projects, answering factual multi-project progress, blocker, specialist, parallel feasibility, and summary queries directly from database records.
6. **Owner Mission Control**: Unified dashboard (`MissionControlPage.tsx`) with cluster/project grouping, concurrency slot gauges, queue management, and lifecycle controls under Supervised authorization.

See [FO-ORCH-SCALE01 results](../qa/fo-orch-scale01-results.md).

### FO-AUTONOMY-FULL01 Bounded autonomous execution

Head of PM can run a mission without a routine approval on every step when the Owner has activated a policy for that scope. The policy names the mode, projects, roles, providers, models, launch budget, duration, QC rules, and completion rule. The coordinator prepares tasks from the Owner's proposals, asks Router 2.0 for an eligible resource inside that allowlist, and then uses the existing mission scheduler.

Unbound missions stay supervised. The scheduler asks the policy gate before a launch, a review, a rework, or automatic Done. QC BLOCKED never completes a task. A paused, revoked, expired, or emergency-stopped policy refuses new work. Head cannot edit the policy that authorizes it.

See [autonomy policy](autonomy-policy.md) and [FO-AUTONOMY-FULL01 results](../qa/fo-autonomy-full01-results.md).

### FO-SELF-IMPROVE01 Versioned instruction and skill improvement

When the Owner enables the engine and an active policy permits self-improvement, Head can turn a repeated verified QC finding into a project-scoped skill revision. Supervised mode still waits for Owner approval before activation. Autonomous and Full Autonomy modes may activate only a low-risk project revision that passed a held-out fixture check. The next eligible Developer launch uses that frozen version. A monitored regression restores the last known good version.

Head answers improvement questions from stored candidates, evaluations, and observations. A generated hypothesis stays a hypothesis until a measured evaluation records it.

See [self-improvement](self-improvement.md) and [FO-SELF-IMPROVE01 results](../qa/fo-self-improve01-results.md).

### FO-AUTO-PRACTICAL01 Connected development cycle

A Full Autonomy mission can implement in the existing task-owned workspace, run one policy-named Bun test under the offline Seatbelt, record the observed exit, and request one bounded rework when the test or QC asks for a change. Done still follows the existing completion policy, and a dependency waits for that Done. Repeated verified test failures can become one skill candidate. The harness comparison runs the same frozen tasks for the current and proposed instructions. Activation and rollback stay on the existing self-improvement rules. Mission Control shows the test, the rework epoch, and whether the implementation driver was synthetic.

See [FO-AUTO-PRACTICAL01 results](../qa/fo-auto-practical01-results.md).

### FO-NATIVE-INTEGRATION01 Packaged runtime

The same Head, Mission Control, Brain, Router, and autonomy controls ship in the ordinary Electrobun bundle. Semantic search uses `Xenova/paraphrase-multilingual-MiniLM-L12-v2` from `Contents/Resources/app/models`. The ONNX runtime is copied beside it and left external so the native binding loads from the bundle. If that model is not running, the status says semantic embeddings are unavailable and a semantic query does not return lexical hits. See [brain embeddings](brain-embeddings.md).

### FO-NATIVE-WORKFLOW01 Packaged Owner workflow

Mission Control keeps the mode buttons as a draft. Saving a draft stores the server digest and does not activate it. Activate posts that saved revision. The mission form calls the existing prepare route only after a non-supervised policy is active, and it does not widen the policy. The practical panel polls the selected mission and shows each observed attempt. A Head board proposal still has to be approved; a git project task stays on worktree isolation and is not the observed-test task. Search results use the same memory row as the list, including scope and origin. The project Brain tab is named “Brain for this project” so it is distinct from the company Brain control. A finished index rebuild says how many memories were embedded. See [FO-NATIVE-WORKFLOW01 results](../qa/fo-native-workflow01-results.md).


## Mission resource proposals

Analytics questions are read-only. The Head calls the same company analytics service as the Analytics view. Calendar presets in that answer are UTC and say so. A missing amount stays Unknown. An unattributed pool change is not reported as a task expense. Comparable employee and model rows require three genuine outcomes in one category. Synthetic history is excluded. The answer carries omitted counts when a list is capped, and it does not start inference, execution, quota refresh, or an account change.

Routing questions from the Owner use the same Router 2.0 evaluation as Settings. The answer includes the active policy, the recommendation boundary, and the measured-versus-configured quality note. A question is not an approval, and the Head does not apply a fallback or start a run from that text.

A Head turn can propose one exact Developer or Reviewer change, or one atomic set of remaining-stage changes, for an eligible frozen mission. An objective such as minimum wait or lowest comparable charge is expanded by the shared planner into exact resources before the draft is saved. The model text is untrusted until that validation. Scoped mission and Router evidence supply the identifiers. The existing board proposal stores the draft and displays the shared reauthorization review. The Head cannot settle its own draft. The Owner confirms the digest, after which the regular mission Start or Resume action controls dispatch. See [Frozen mission resource reauthorization](autonomy-policy.md#frozen-mission-resource-reauthorization).
