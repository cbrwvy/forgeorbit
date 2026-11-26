# FO-014E — Owner-approved professional Turns and Gemini stdin

Date: 2026-10-26 (UTC). Worktree: `forgeorbit-multiturn`.
Branch: `task/fo-014e-multiturn`. Base: `853eba47aa13e2afe63877c400501f60c03621b6`.

## A. Existing continuation architecture

The initial path remains EmployeeCore → AssignmentCore → Employee Execution
review → Owner confirmation → supervised launch → canonical `startTask` →
existing `spawnAgentOrFail` / `spawnAgent` → existing CLI or ACP driver.
Migration 090 owns the frozen professional snapshot and initial payload hash.
Employee reconciliation adopts only the existing exact Attempt/Run link.

Before 014E, `sendInput` minted a new Run for each idle Claude turn and each
Codex/Cursor/Gemini/Antigravity/FX follow-up. Claude's busy-session path pasted
into its active Run. `professionalContinuationProblem` blocked all professional
calls to ordinary `sendInput`, FX manual/automatic recovery, and unattributed
continuation spawns. These gates remain; they now direct the Owner to Turn review.

The new path is:

```text
initial Review → Owner approval → canonical Run + initial Turn → Session
  → Turn review → single-use Owner approval/CAS → prepared
  → existing adapter (exact Session, same Run)
  → adapter evidence → existing Run settlement/reconciliation
```

There is no second launcher, Run store, employee registry, account registry,
scheduler or autonomous follow-up queue. The Turn service authorizes the
existing orchestrator's delivery operation. The existing active/start guards,
chunk handler, Run completion handler and CLI/ACP drivers perform execution.

## B. Turn model

`employee_execution_turns` references the existing employee UUID, Task, Run,
Execution Attempt, immutable profile revision ID and SHA-256 of the exact original snapshot JSON.
The snapshot hash covers metadata and Markdown; the separate existing prompt SHA covers Markdown alone.
It stores ordered sequence/parent, exact session ID, approved user bytes and
SHA-256, Owner authorization reference, facts/authority fingerprint, single-use
CAS revision, persistent idempotency key and creation/expiry/approval/submission/
settlement times. The 512 KiB professional Markdown stays in 090's attempt row.

The initial Turn commits in canonical `startTask`'s Run transaction. It references
the initial attempt's Owner approval and full composed-payload SHA; its `prompt`
is NULL, avoiding another large Markdown copy. Subsequent rows contain only the
new approved user message. There is no automatic backfill or invented attribution.

A Turn denotes an approved user submission. In-flight Claude messages can be
folded into the same CLI response, as with its existing paste contract. Turn
sequence proves submission ordering, not a separate model response per message.

## C. Owner authorization

Authenticated endpoints, under the existing bearer-only Employee Execution API:

- `GET /employee-execution/runs/:runId/turns`: history and session capability.
- `POST /employee-execution/runs/:runId/turn-reviews`: exact `prompt` and `idempotencyKey`.
- `POST /employee-execution/turns/:id/submit`: matching revision/key, literal
  `confirm: true` and `acknowledgeUsage: true`.
- `POST /employee-execution/turns/:id/cancel`: withdraw the exact unapproved revision.

Authorization precedes body reading. Requests reject extra fields, client
permissions, paths, sessions, employee IDs, model/account overrides and query
parameters. Reviews expire after five minutes. A transaction with `BEGIN
IMMEDIATE` and optimistic revision/status CAS consumes each review once.

Review and delivery recheck active employee, original assignment ID/revision,
project ownership/scope, exact current Run, original execution configuration,
harness identity/configuration/enablement and current Owner restrictions.
Professional profile edits do not enter this fingerprint. Permission/assignment/
scope changes invalidate approval; archived employees cannot send.

Checks repeat at actual adapter submission after asynchronous preparation:
before tmux `new-session`, queued Claude paste/Enter, or FX `session/prompt`.
They include expiry, exact session and single-use Turn state. They grant no
additional CLI permission, sandbox, account, model or tool authority.

## D. Immutable professional context

Only `readProfessionalBinding` reads the frozen original snapshot. Follow-up
never resolves the active professional profile, reinjects its Markdown, expands
`@` references or composes new agent-profile instructions. Current profession
edits leave old sessions on their approved revision. Applying a new revision
requires a separately reviewed canonical execution attempt.

Follow-up content remains a user message. Slash commands and attachment-reference
syntax are refused because the external CLI could interpret them as local
operations instead of ordinary content. Initial starts retain existing behavior.

## E. Session and Run identity

A follow-up neither creates a Run nor another execution attempt. Successful
terminal Runs can resume their exact recorded session. Claude can also receive
messages through its attached active session. Other one-shot adapters refuse
new user delivery while a response is active. Missing, `latest`, mismatched,
orphaned, cancelled or uncertain sessions fail closed without a fresh fallback.

The same Run represents the session aggregate. Starting another approved Turn
reopens its running state and existing attempt's aggregate completion fields.
Each submitted Turn separately retains the first observed subsequent Run terminal
status/time; these observations cannot be rewritten. They describe Run settlement,
not proof that a model executed that message. Initial payload evidence is unchanged.

One-shot adapters use the Turn UUID for transport filenames. Their line UUIDs and paired tool-use/result IDs are
namespaced by Turn before existing Run-event deduplication, so resumed files do
not truncate or collide with previous turns. Boot reattachment chooses that same
transport ID while retaining the canonical Run ID. Persisted event keys are mapped
back to the current Turn's native keys before driver replay deduplication. Claude retains native JSONL
UUIDs and exact session JSONL; its existing resume offset avoids replaying old
completion markers. An adapter reporting a different session is killed/blocked.

## F. Migration 091

`091_professional_execution_turns` is new; migrations 085–090 are unchanged.
091 also binds a write-once whole-snapshot hash on the existing attempt, without historical backfill.
The existing runner atomically applies table/index SQL, complete trigger
statements and `_migrations` ledger stamp. Constraints enforce unique Run/sequence,
Run/idempotency key and one open/uncertain Turn per Run. Insert triggers correlate
Run/Task/employee/attempt/profile/hash/parent against 090's Owner-approved row.
Run/Task references follow 085's soft audit-reference contract: correlation is verified on insertion, while later task deletion retains immutable history. Attempt/parent references remain foreign keys.
Triggers prohibit replacement, deletion, payload/link/approval rewrites, illegal
state transitions and replacement of terminal delivery/observed-outcome evidence.

Fresh installation, populated 090 upgrade, repeat startup, failed-application
rollback, WAL reopen and simultaneous independent-process CAS are tested.
Deployment is forward-only: removing this audit table is not a supported rollback.
Use a separately reviewed backup/restore plan if an installed DB must be restored.

## G. Idempotency

Keys persist per Run. Repeating a review with identical bytes returns its row;
reusing the key for other bytes is a conflict. Replaying a consumed confirmation
returns existing evidence without dispatch, even with its original CAS revision.
Different reviews cannot race an unresolved/open Turn. Each successor references
the previous durable sequence. There is no in-memory-only deduplication promise.

## H. Delivery and crashes

```text
reviewed → approved → claimed → prepared → included
    ↘ failed       ↘ failed          ↘ indeterminate
```

Approval and claim commit atomically. Preparation commits before a possible send.
At startup, approved/claimed follow-ups become confirmed pre-submission failures;
prepared follow-ups become Unknown/Indeterminate. Nothing is automatically resent.
Initial prepared payload evidence is preserved as unconfirmed, per 014D semantics.

`included` means local adapter acceptance: a returned process/ACP handle or a
confirmed Claude paste outcome. It does not prove provider receipt, model identity,
execution, compliance or success. FX can still fail handshake after returning a
handle; its Run records that outcome. Failed/withheld sends after preparation are
conservatively Indeterminate. Unknown delivery blocks another Turn; a new attempt
requires fresh canonical Owner review and existing unresolved-process safeguards.
SQLite atomicity cannot provide exactly-once delivery to an external process.

## I. Adapter matrix (source contract + offline fake proof)

| Adapter | Existing live delivery | Exact new-process resume | Reattach after backend restart |
| --- | --- | --- | --- |
| Claude Code | Guarded paste to active Run; idle `sendTurn` when attached | `--resume <same session ID>` | Existing exact JSONL/session watcher |
| Codex | Refused while response active | `exec resume <same thread ID>` | Existing tmux/log, current Turn filename |
| Cursor | Refused while response active | `--resume <same session ID>` | Existing tmux/log, current Turn filename |
| Antigravity | Refused while response active | `--conversation <same conversation ID>` | Existing tmux/log, current Turn filename |
| Gemini | No persistent interactive composer | Headless `--resume <same UUID>` + stdin | Existing tmux/log, current Turn filename |
| FX ACP | Refused while response active | `session/resume`, existing same-ID `session/load` compatibility path, then guarded user `session/prompt` | Existing stdio process is not reattachable; uncertain process fate is refused |

These are adapter contracts, not real-provider acceptance. No exact ID means no
resume. FX autonomous checkpoint recovery remains blocked for professional tasks;
this implementation authorizes new user messages only, one review at a time.

## J. Gemini contract

Audited upstream source is tagged **v0.54.0**, matching the driver contract:
[headless detection](https://github.com/google-gemini/gemini-cli/blob/v0.54.0/packages/core/src/utils/headless.ts),
[input composition and sandbox relaunch](https://github.com/google-gemini/gemini-cli/blob/v0.54.0/packages/cli/src/gemini.tsx),
[stdin reader](https://github.com/google-gemini/gemini-cli/blob/v0.54.0/packages/cli/src/utils/readStdin.ts),
[CLI configuration](https://github.com/google-gemini/gemini-cli/blob/v0.54.0/packages/cli/src/config/config.ts),
[settings paths](https://github.com/google-gemini/gemini-cli/blob/v0.54.0/packages/cli/src/config/settings.ts).

Non-TTY input/output and `-p` select headless operation. An empty `-p` value adds
no text: stdin supplies the whole prompt. The audited reader decodes UTF-8 and
has an 8 MiB truncation threshold; ForgeOrbit refuses complete composed payloads
above 4 MiB first. Headless exits after each response; continuation is an explicit
new process resuming the exact UUID, not an interactive REPL claim.

The upstream sandbox relaunch can serialize stdin into argv. ForgeOrbit refuses
sandbox/debug/interactive flags and unsafe known settings/environment overrides
rather than turning sandbox protection off. JSONC/unreadable configuration and
dotenv files are unsupported: dotenv presence is detected without reading
possible credentials. Prompt telemetry is refused when it cannot be shown off.
No settings, credentials or account selection are changed.

## K. Large prompt transport

Gemini `buildCommand` returns empty `-p` plus the full separate stdin payload.
A private 0700 temporary directory and exclusive 0600 manifest carry bytes to a
fixed Bun transport supervisor inside the existing tmux driver. The supervisor
unlinks input before spawning the one CLI invocation, writes exact bytes to its
stdin, drains output, drops user-echo records and withholds raw stdout diagnostics
and stderr. The recoverable log is 0600. No prompt interpolation, `$(cat ...)`,
large argv, shell history entry, truncation or pipe-error retry is used.

This is transport-log protection, not an encryption boundary against the OS user
or a promise that third-party CLI session history/model output never contains its
own conversation. Session persistence is needed for resume. Models/tools can quote
user content in their outputs. Hooks/extensions and arbitrary changed CLI builds
are outside offline proof. The helper requires a Bun-capable `process.execPath`;
packaged/native availability is unverified under NATIVE-005.

## L. UI

The existing Employee Run panel adds Run-local Turn history, immutable revision/
SHA/session/approval/payload evidence, delivery status and observed Run settlement.
Owner review displays employee, project, Run/session, original professional
revision/SHA, exact message, restrictions, execution mode, expiry and explicit
usage acknowledgement. Supported states offer Follow-up; unsupported states show
a reason. Pending reviews can be reopened/withdrawn; history can be refreshed.
Historical Markdown remains accessible in existing professional attribution.
Desktop/mobile styling follows the current panel; no global redesign was made.

## M. Backward compatibility and entry points

No-profile legacy continuation retains its new-Run behavior. Historical pre-091
attempts are readable but receive no fabricated initial Turn/session evidence;
they require a new reviewed canonical start for 014E continuation.

Ordinary HTTP/CLI/project-manager/plan/reminder follow-ups converge on `sendInput`
and retain the professional refusal. FX manual/automatic recovery retains its
gate. Unattributed queued process spawns retain the final runtime refusal.
Task-scoped raw terminal creation, WebSocket writes and Open-in-tmux are blocked
for professional tasks, including terminals created before a profession was
assigned. Professional free-text question answers also require Turn review;
fixed modal choices retain their existing Owner Authority. Native IPC supplies no separate prompt endpoint. Existing permission
and modal decision interactions remain separate Owner Authority paths; they do
not grant a Turn review reusable execution permission. An Owner's external OS
shell is outside this application-level authorization boundary.

## N. Targeted verification

All backend files run in separate Bun processes with temporary HOME/data/SQLite,
fake drivers, explicitly inert binaries, offline usage and synthetic harness homes.
No full suite is run. New checks cover six-adapter initial/resume receipt, ordered
Turns, approval/expiry/revocation/archive/CAS/idempotency, immutable profiles,
exact session mismatch, crash states, migration/WAL/reopen/rollback, simultaneous
SQLite processes, legacy refusal and Gemini large UTF-8/injection/pipe/log behavior.

Related checks cover 014D, Employee Execution/reconciliation, assignments,
Head/Portfolio and PM execution, adapter/session recovery, existing profiles and
references, migration runner, UI helpers and targeted Chromium workflows.
Final acceptance (distinct tests, without counting repeated runs):

| Check | Result |
| --- | --- |
| New Turn/091/Gemini transport tests | 41 PASS |
| FO-014D regression | 34 PASS |
| Employee Execution/preflight/reconciliation | 78 PASS |
| Assignment core/migration | 22 PASS |
| All selected Bun files, including builders/adapters/recovery/PM/Portfolio/UI helpers | **908 PASS, 0 failures; 40 files** |
| Targeted Chromium workflows | **12 PASS, 0 failures** |
| Typecheck | PASS |
| Vite build | PASS; existing chunk-size advisory |
| `git diff --check` | PASS |

The exact file/count manifest is [fo-014e-validation.json](../qa/fo-014e-validation.json).
Desktop/mobile Owner review and Turn history screenshots were visually inspected.
Initial Chromium launch was denied by the macOS tool sandbox's MachPort policy;
the successful runs used approved browser execution outside that sandbox with the
same isolated fake fixtures. A pre-existing queue test's fixed teardown delay
raced subprocess startup; it now waits for recorded paste completion before
teardown, retaining the trailing-Enter safety assertion.

Reproduction uses `isolatedCoreEnv` and `writeFxStubBin` from
`e2e/isolated-env.ts`, one fresh directory/process per file. Tests that set their
own legacy `AGETOR_DATA_DIR`/`AGETOR_API_PORT` must not inherit conflicting
`FORGEORBIT_*` twins. HOME remains temporary, all binary/driver overrides remain
inert/fake, usage stays offline, and Gemini system/default settings paths point
inside the fixture. Run only the manifest's files, then `bun run typecheck`,
`bunx --no-install vite build` and the four named Playwright files (one worker,
separate API port offset, explicit cached Chromium path).

## O. Unsupported behavior

- Autonomous or blanket multi-turn authorization; hidden new attempts/Runs.
- `resume latest`, missing/mismatched/uncertain sessions, unsafe automatic replay.
- New one-shot user input while its response is active; cancelled/orphaned resume.
- Professional pipeline follow-up, FX automatic checkpoint continuation, raw
  professional terminals, slash commands or attachment-reference expansion.
- Gemini interactive continuation, sandbox relaunch and configuration that cannot
  preserve stdin/argv/log boundaries; payloads above 4 MiB.
- Real-provider, installed-CLI-version, native, packaging or production acceptance.

## P. Security review

Immutable source guidance remains untrusted user content. Organizational employee
identity stays separate from provider accounts. Follow-up never broadens tools,
mode, sandbox, project scope, account access or CLI configuration. Guards repeat
after asynchronous preparation. Indeterminate delivery stays Unknown. Raw terminal
input cannot substitute for approval through app-mediated task endpoints.
No account switch, quota/provider poller, credential/Keychain read or CLI discovery
path was added. Test stubs are installed before backend imports.

## Q. Integration readiness

Local implementation/offline acceptance only. **NATIVE-005 remains BLOCKED**.
Native ForgeOrbit, real AI CLI (including `--version`), provider APIs, production
migration and user SQLite/WAL/SHM were not used. Networked tests use local fixture
HTTP servers only. Browser and Vite results are not native/provider evidence.
An independent review should evaluate this commit before integration/release.

## R. Git status

Only the requested worktree/branch is changed. No push, merge, rebase, reset,
remote modification or worktree deletion. Local implementation commits are allowed.
Resolve the enclosing implementation commit without a self-referential hash:

```sh
git log -1 --format=%H -- docs/architecture/fo-014e-multiturn-runtime.md
```
