# FO-012B — Head identity on the existing Portfolio Manager

## Audit and decision (before implementation)

Baseline main: 7bf70cfeaa3ca900824564e92cec71d698f245d0, clean, no merge/rebase/sequencer.
EmployeeCore.setHead creates an owner-named UUID. Migration 079's partial unique
index permits one unarchived Head; kind is immutable through EmployeeCore.
Head job title can change; its role category cannot. Employee events retain changes.
Portfolio configuration is the singleton `portfolio_manager.id = global`; messages,
plans, decisions and delegation JSON have separate existing tables (075).
`sendPortfolioMessage` claims one in-memory turn before awaiting preflight, resolves
agentChoice from existing config/profile, obtains existing agent consent and spends
an optional independent knowledge grant. runIsolatedTurn is the existing runtime.
There is no durable CLI session for the global manager: each management request is
an isolated turn. `global` is the logical manager session; the existing turn UUID
identifies the runtime invocation. Do not invent a provider session or create one.
Delegation uses an existing persisted proposal, revision/CAS and Owner approval,
then calls sendManagerMessage under the target project's own config and consent.
PM assignment proposals already retain delegationId. This exact durable chain can
identify the source Head without changing assignment authority or its schema.
Restart retains config/history; existing pending-message/delegation recovery marks
interrupted work failed and never automatically invokes AI.

## Binding and lifecycle

Migration 086 adds one singleton binding, append-only Owner binding events, and
immutable snapshots of new turns. No old message or migration is rewritten.
Owner confirms `{employeeId: UUID | null, revision, confirm: true}` over the existing
bearer-authenticated local Owner API. Bearer possession is the existing Owner
boundary; there is no separate employee authentication role in this application.
The immediate transaction validates the employee and compares revision. A replay
at the current revision is a no-op; stale revisions return 409. No account/model,
path, prompt, secret or credentials are accepted by the binding API.

A binding is Bound only for the same active, unarchived `head` UUID and confirmed
job title/role. Archive, inactivity or a title change invalidates it permanently
until explicit Owner re-confirmation (employee event watermark prevents revival
on unarchive or restoring a former title). Renaming leaves UUID and binding intact.
Invalid/Unbound retain the legacy manager, with no attributed Head for new turns.
A replacement is appointed using existing archive + setHead, then explicitly bound.
Binding changes refuse while a portfolio turn (including preflight) or delegation
send is in progress. Archiving an employee remains possible; the in-flight snapshot
stays immutable. Pending proposals retain their original Head even if approved later.

## Runtime evidence and permissions

After all asynchronous gates, immediately before persistence/invocation, the existing
turn captures current binding revision/status, Head UUID/name/title, global logical
session, existing turn UUID, canonical portfolio project scope and time. The prompt,
owner/manager messages, turn response and delegation carry that same snapshot.
A durable turn row records the resolved harness/model/effort/mode requested of the
existing runner; those are configuration inputs, not provider-confirmed facts.
Actual account/model remain Unknown. No employee identity supplies execution resources.
Retries are new invocations: durable snapshots preserve every attempt; the original
owner message's attribution is not rewritten, and each new reply/delegation uses the
fresh turn snapshot. Legacy messages stay unattributed, including on retry.

Delegated PM messages receive server-internal snapshot provenance; assignment
proposals keep their existing exact delegationId link. No new delegation engine,
approval, worker assignment/start, knowledge permission, scope or Owner authority.
Short SQLite transactions end before AI work; the existing single local backend
owns runtime claims, while SQLite revision CAS serializes binding writers across
connections. No new runtime scheduler or multi-process AI executor is introduced.
