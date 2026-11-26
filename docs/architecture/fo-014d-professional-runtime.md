# FO-014D — Professional Prompt Runtime Integration

## A. Existing Runtime Architecture

Audited base: `0659143e3e3f05d897ac42594604641789a2611f`, branch
`task/fo-014d-professional-runtime`.

`EmployeeCore` owns organizational UUIDs, lifecycle and project membership.
`EmployeeProfileCore` owns active professional roles and numbered prompt revisions
(migration 087). Neither is a launcher. AssignmentCore (081) supplies the current
Owner-approved primary worker and assignment revision. AccountCore is independent.

The existing employee path is:

```text
prepareEmployeeExecution (read-only facts)
  → reviewEmployeeExecution (expiring, single-use review in employee_executions / 085)
  → startEmployeeExecution (explicit Owner confirmation + atomic claim)
  → launchEmployeeTask / launchApproved (existing project checks + configuration)
  → canonical startTask (harness checks, workdir preparation, run transaction)
  → spawnAgentOrFail → spawnAgent → existing CLI/ACP adapter
```

`startTask` is the actual first-prompt construction point. It resolves the separate
execution Agent Profile, expands task `@` references, composes its user-authored
preamble, appends file references, and passes the resulting string as
`SpawnAgentArgs.prompt`. That same payload is echoed into existing user transcript
persistence. Run events, sessions, results and terminal state remain in the existing
`runs`/event infrastructure. No second engine, session store or poller was added.

## B. Professional Prompt Resolution

At review, `resolveProfessionalBinding` resolves the assigned employee UUID through
EmployeeProfileCore, reads the exact active revision, and checks revision/profile
employee, revision number, role, title and division consistency. SHA-256 is computed
from the exact saved UTF-8 Markdown and compared with its recorded hash. Empty text,
invalid Unicode, disallowed control characters, and prompts over the shared
`MAX_PROMPT_BYTES` (512 KiB, bytes rather than characters) are refused.

The snapshot copies Markdown, employee UUID, revision UUID/number, catalog slug,
professional title, prompt SHA, verified original catalog template SHA, catalog
source commit and binding timestamp. Template SHA refers to the verified vendored
original for that role **at review**; 087 did not record a template hash at initial
profile creation, so historical creation-time template provenance is not invented.
Catalog files themselves are never modified. Customizations come from the saved
revision, never from a newly substituted template.

Review insertion and final profile consistency verification share a write
transaction. A profile changed during asynchronous checks rolls back that review.
The idempotency key contains profile bytes/metadata but excludes binding time, so
an identical repeated review reuses its original snapshot.

## C. Trust Boundary

Professional Markdown is Owner-managed, potentially hostile **user content**.
`composeProfessionalPrompt` serializes the guidance and identifying metadata as
JSON within the ordinary task prompt. The Markdown is not expanded as file
references, parsed as runtime configuration, written into AGENTS.md/system files,
or sent via system/developer messages or privilege-bearing CLI options.

A fixed preface explains that guidance grants no authority over platform/security
rules, Owner/task approvals, project/filesystem scope, sandbox, or model/account
policies. JSON serialization prevents embedded Markdown from changing the JSON
structure. This textual notice is not a security sandbox or a guarantee that a
model will resist prompt injection. Enforcement remains in the existing pipeline,
project checks, runtime configuration and CLI permission mechanisms.

The feature never changes those mechanisms or selects broader CLI permissions.
Historical Markdown is rendered as escaped plain text in the UI.

## D. Owner Approval

The Owner sees the historical professional title, revision, hashes and exact
Markdown in the existing review dialog before confirming. Only the existing
strict confirmation request (`confirm: true`, matching review revision and usage
acknowledgement where required) claims the attempt.

**Policy: any active professional profile edit, role reassignment, or newly added
profile between review and run recording requires a new review and confirmation.**
No silent upgrade to newer instructions occurs. Verification runs at claim, at
launch checks, at canonical start, and again in the Run-recording transaction after
asynchronous preparation. Existing assignment, employee status, Owner restrictions,
harness enablement, scope, expiry and applied-task fingerprint checks still apply.

Board/direct `startTask` for an assigned professional employee refuses without a
claimed employee attempt. A claimed attempt cannot mint another Run once its
Run ID has been recorded, including across separate SQLite connections. Employees
with no professional profile retain legacy starts and byte-identical prompts.

## E. Execution Payload Construction

```text
existing Agent Profile user preamble, when configured
  + JSON-encoded professional guidance from the frozen snapshot
  + approved task prompt (existing @ expansion)
  + existing appended file references
  → SpawnAgentArgs.prompt
```

Existing adapters retain their user-input transports:

| Harness | Existing user-prompt transport |
| --- | --- |
| Claude Code | Positional prompt after option terminator, or deferred composer paste |
| Codex | `promptText` delivered through the existing stdin transport |
| Cursor | `promptText` passed by the existing driver |
| Gemini | Existing prompt argv argument |
| FX | ACP session user prompt |
| Antigravity | `promptText` passed by the existing driver |

All six paths have fake-driver payload assertions, beyond transcript/UI echoes.
The Gemini launch budget is checked on the complete composed payload; an oversized
professional payload produces an explicit error without a Run or driver call.
The runtime preserves that bounded error through supervised bookkeeping instead
of dropping the guidance or reporting integration success.

## F. Immutable Revision Binding

Each new review carries `professional_json` (`professional` snapshot or explicit
`legacy` marker). Migration-085 employee/task/assignment identity and Run/Attempt
IDs remain the canonical links. No current-profile lookup is used to display an
old attempt. The frozen Markdown remains available even if the source revision is
later unavailable or the active role changes.

The Run transaction atomically consumes the attempt's Run slot, records SHA-256
of the **whole exact execution payload**, marks it `prepared`, inserts the Run,
updates the task, and persists the existing supervised-proposal Run link. A failure
rolls these changes back before spawning.

| Payload status | Evidence |
| --- | --- |
| `bound` | Review snapshot exists; no payload acceptance evidence |
| `prepared` | Run and payload hash committed; adapter outcome unconfirmed |
| `included` | Existing execution adapter returned an agent handle for that payload |
| `failed` | Adapter failed to return a handle; delivery is not confirmed |

`professional_payload_at` records adapter outcome observation time, separately
from snapshot `boundAt` and existing Owner `approved_at`. `included` does not prove
provider receipt, model identity, task success or model compliance. A timeout/crash
that leaves `prepared` is never upgraded to `included` by reconciliation.

## G. Migration

New migration `090_professional_runtime` adds four employee_executions columns:
`professional_json`, `professional_payload_status`, `professional_payload_at`,
`professional_payload_sha256`. Historical rows retain NULL snapshot/hash and show
Unknown rather than inferred professional attribution. There is no production
migration or profile/run backfill.

SQLite triggers prohibit snapshot/employee/task rewrites, deletion or replacement
of new snapshot-bearing attempts, changes to an established Run link or payload
hash, and rewriting final adapter-outcome evidence. Idempotent same-value updates
remain possible for reconciliation. Complete trigger statements use the existing
versioned TypeScript migration hook because the SQL splitter splits on semicolons
inside trigger bodies. Schema and triggers still commit in the runner's single
transaction. Applied migrations 085–089 are untouched.

Older 088/089 compatibility tests explicitly exercise their historical registry
prefix; generic migration-tail expectations now include 090. Fresh, populated
upgrade, reopen, rerun, trigger invariants and injected migration rollback are
covered by the new targeted migration tests.

## H. Retry / Resume Semantics

| Situation | Rule |
| --- | --- |
| Double confirmation / replay | Return the existing attempt; never launch again |
| Failed terminal attempt | New review and Owner confirmation; bind current verified revision |
| Profile unchanged on retry | Same saved revision, newly authorized attempt |
| Profile edited between attempts | New review explicitly authorizes the new revision |
| Role reassigned before start | Reject old approval; new review required |
| Worker reassigned | Reject old approval; new attempt uses new UUID/profile |
| Employee archived/inactive | Refuse new start; preserve old attribution |
| No professional profile | Explicit legacy marker; ordinary legacy payload |
| Assigned profile broken/missing active revision | Fail closed; no silent legacy/template fallback |
| Stale/expired approval | Refuse; new review required |
| Run transaction interrupted | Roll back Run, slot and payload evidence together |
| Crash after claim without exact Run link | Existing indeterminate protection blocks relaunch |
| Crash after exact Run recording | Reconcile exact Run; preserve snapshot and payload evidence |
| Existing interrupted Run reattached | Existing session recovery retains original Run/snapshot; no new prompt resolution |
| New-process resume or follow-up of professional execution | Explicitly unsupported on ordinary continuation endpoints; new employee review and canonical start required |

A newly authorized canonical start is a new attempt, not a claim that the old
conversation was resumed. Ordinary legacy continuation behavior remains covered
by Codex, Claude and FX regression tests. A last gate at `spawnAgentOrFail` also
refuses queued/unattributed continuation spawns when a professional assignment
appears during preparation. Hiring/profile changes alone never launch work.

## I. Employee / Account Separation

Employee UUID identifies organizational responsibility. It is never a provider
account ID, credential, agent profile, model selector or CLI selector. Professional
guidance is composed only after the Owner-controlled harness/model/mode choices.
Requested settings and runtime-confirmed account/model evidence retain their
existing separation; Unknown remains Unknown. No account switching, quota refresh,
provider request, new CLI discovery path or hidden execution was added.

## J. Audit History

Employee Card displays active profession, prompt revision and SHA. Review, task
execution status/history and Employee Execution History display the frozen
profession/revision, UUIDs, original/prompt/payload hashes, binding/outcome times,
exact historical Markdown, and actual adapter status. Current profile edits do
not rewrite old entries. Normal run events/transcripts/results keep their existing
storage and reconciliation rules. These views add no execution authority.

## K. Backward Compatibility

No-profile prompts remain byte-identical. Old attempts without snapshots show
professional attribution Unknown. A pre-090 approval can continue only while its
employee still has no professional profile; assigning one requires a new review.
Existing canonical runtime, adapters, assignment approval, AccountCore,
Head/Portfolio, transcript persistence and Native Safety bootstrap remain intact.

## L. Targeted Tests

All execution checks used fake drivers, stub binaries (including availability
probes), temporary projects, isolated HOME and SQLite. Targeted unit files were
run in separate Bun processes where they own singleton backend/API state.

New tests: `src/bun/professional-runtime.test.ts` and
`src/bun/professional-runtime-migration.test.ts` cover exact payloads for six
adapters, legacy paths, revision/hash/template identity, pre/post execution edits,
role/employee reassignment, corrupt/missing/oversized/malformed prompts, approval,
harness/Owner restrictions, scope, expiry, concurrent claims/replay, rollback,
retry, recovery, explicit unsupported continuation, and immutable SQL evidence.

Related checks include employee-run, employee-reconciliation, employee-execution,
assignment-core/migration, Head/Portfolio binding/runtime, profile-core,
catalog/integration/legacy-hiring upgrades, migration runner, execution UI helpers,
execution polling, existing Agent Profile composition, Codex continuation, Claude
plan handling and FX recovery/auto-resume. The full suite was not run.

Validation completed:

| Check | Result |
| --- | --- |
| New professional runtime + 090 migration tests | 34 PASS |
| Employee execution/preflight/reconciliation | 78 PASS |
| Assignment core/migration | 22 PASS |
| Head/Portfolio binding/runtime | 23 PASS |
| Profile/catalog/upgrade/migration runner | 74 PASS |
| Execution UI/polling helpers + existing Agent Profiles | 29 PASS |
| Codex + Claude plan + FX runtime regressions | 65 PASS |
| **Targeted Bun total** | **325 PASS, 0 failures in final selections** |
| Existing employee run/reconciliation Playwright | 9 PASS |
| New professional runtime Playwright | 2 PASS |
| Typecheck | PASS |
| Vite build | PASS (existing large-chunk advisory) |
| `git diff --check` | PASS |

Bun files with singleton backend state were run in separate processes; combining
those files in one Bun process produced shared-state/token interference and was
not used as acceptance evidence. Historical migration-tail expectations were
updated/scoped before their successful reruns.

Chromium initially could not launch under the macOS tool sandbox (Mach port
permission); the successful targeted runs used an approved browser launch outside
that sandbox with the same isolated fake backend fixtures. The browser cache path
was explicit so isolated HOME did not hide Chromium. A local font dependency copy
kept the final new UI checks within Vite's workspace allow list. Two new test
locator/navigation issues were fixed before their passing rerun.

The new UI checks verify review content, no-run-before-confirmation, actual adapter
status, stale-profile refusal, active revision 2 versus historical revision 1,
full historical SHA/Markdown, and no horizontal overflow at 390px. Desktop/mobile
screenshots were inspected under the ignored `test-results/professional-runtime-*/`
folder. These browser/build results are separate from native evidence.

## M. Limitations

- No real CLI, provider, account, native app or production migration validation.
- `included` is adapter acceptance evidence only. Partial failures do not prove a
  provider never received input; terminal task status comes from the existing Run.
- New-process professional session continuation requires a new review/canonical
  start; ordinary resume/follow-up endpoints return a clear refusal. In-place
  existing-Run reconciliation/reattachment does not create new attribution.
- Gemini cannot accept a composed payload above its existing 4096-byte argv cap.
- Template provenance is verified catalog-at-review provenance, not an invented
  creation-time hash for legacy profile revisions.
- Historical snapshots retain Owner-authored text in local SQLite and authenticated
  history responses, bounded by the existing profile prompt cap.
- Prompt injection resistance ultimately depends on the model and the existing
  external permission boundaries; user guidance never becomes platform authority.

## N. Integration Readiness

Implementation and offline validation are local to the requested branch. No push,
merge, rebase, native launch, real AI CLI/version probe, provider API, credentials,
Keychain, account switch, user `~/.agetor` access or production SQLite was used.
NATIVE-005 remains **BLOCKED**. Passing fake/browser/build checks does not clear
native, provider, production or release acceptance.

## O. Commit SHA

Base SHA: `0659143e3e3f05d897ac42594604641789a2611f`.
Implementation commit subject:
`feat(runtime): bind employee professional profiles to task execution`.

The enclosing implementation commit can be resolved without a self-referential
hash inside its own tree:

```sh
git log -1 --format=%H -- docs/architecture/fo-014d-professional-runtime.md
```

The exact resulting local commit SHA is also reported in the completion message.
