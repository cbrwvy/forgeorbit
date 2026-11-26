# Autonomy policy

FO-AUTONOMY-FULL01 adds three operating modes on top of the existing mission scheduler, employee execution, and QC services.

## Modes

**Supervised.** A mission with no autonomy binding keeps today's behavior. The Owner authorizes the plan digest and approves required actions. Head does not auto-dispatch a supervised policy.

**Autonomous.** Inside an activated policy, Head may create and assign tasks, launch permitted workers, run independent QC, request bounded rework, and update mission status. Automatic Done stays off unless the policy explicitly allows it.

**Full Autonomy.** The Owner activates a scope, duration, resource budget, and permission list. Inside those bounds, Head may also complete a task when QC PASS is on the review column and the policy sets automatic completion. This is not operating-system authority.

## What a policy stores

Each policy has an id, a revision, and a SHA-256 digest of its canonical body. Activation is a separate Owner row. It records the actor `owner`, the digest, the expiration, and the provenance. Agents have no API to revise, renew, or elevate a policy.

The body names:

- mode and scope: one task, one project, one cluster, or a bounded workspace
- authorized projects, clusters, and task ids
- permitted actions and the fixed denied list
- specialist roles, providers, models, and accounts
- concurrent workers, launch count, duration, and rework attempts
- QC requirements and the completion rule
- memory approval: owner, propose, or auto-low-risk
- router preset
- expiration
- optional `authorizedTests`: at most eight fixed `bun test ./<relative path>` commands, each bound to one project and 1..8 output paths

An empty `authorizedTests` list is omitted from the canonical body, so a policy stored before that field still has the same digest. Adding a command or an output path is an expansion. A skill-improvement permission does not add a test command. An agent cannot supply a different command at run time.

Mission acceptance suites that import the database each run in their own Bun process (`src/bun/test-support/mission-file-isolation.ts`). The production database still captures its directory on first import. The wrapper does not move that capture or give the suites a shared file.

`spending.enforceable` and `spending.measured` are always false. If the Owner requires an enforceable cap, activation is refused. A dollar limit is advisory.

## How a decision is made

For a privileged action the engine:

1. Resolves the project, task, role, provider, model, and account.
2. Loads every applicable activation. Active and paused policies are considered together. If none are open, a revoked or expired activation still explains the refusal.
3. Intersects permissions, roles, providers, models, and accounts. Limits use the minimum. The effective mode is the most restrictive. Any covering pause denies the action.
4. Checks project lifecycle, expiration, launch budget, concurrency, and rework count.
5. Reserves `launch_task`, `run_qc`, `request_rework`, and `complete_task` on a unique key. A consumed or released key does not start another worker.
6. Calls the existing employee or QC service. The outcome is stored with the policy id and revision.

A model-generated instruction and a router recommendation are not authority. Cursor stays blocked because its required sandbox cannot initialize under the Seatbelt. DeepSeek stays blocked because filesystem containment is not verified. An empty allowlist does not mean "all".

When a Router evaluation sets `envelopeLocked`, a candidate must be named by that evaluation's harness, account, and model allow-lists. An empty list admits nothing. The lock does not add providers, raise filesystem or spending permissions, or turn an estimated budget into an enforceable cap. If a hard cap cannot be enforced, activation stays refused. A fallback proposal still needs a new Owner approval when it leaves the approved envelope.

The live Full Autonomy tick applies that lock itself. `autonomousResourceHold` derives `envelopeLocked` from the activated policy before a Developer or Reviewer launch. The caller does not pass the flag. A registered profile is matched by its harness kind, so a Codex profile satisfies a policy that names `codex` and a Claude profile satisfies `claude-code`. The account id and the model stay exact. A Cursor or DeepSeek kind stays outside that envelope. An empty provider or model envelope holds the stage. A missing account is held unless the policy explicitly allows one unscoped account and names none. A policy change cannot widen a mission that was authorized under a narrower digest. Restart reads the stored policy and does not rebuild a broader envelope. Emergency stop and the existing lifecycle gates still refuse the launch. Supervised missions are not given this automatic envelope.

A broader policy cannot silently override a narrower one. Activating a revision that expands an active grant is rejected until the Owner revokes the current activation and activates the new revision.

## Execution

`prepareAutonomousMission` creates tasks only for projects named by the policy, assigns a worker, and starts a mission. Cluster membership is not expanded into extra projects. The scheduler then ticks that mission. Independent tasks run within the concurrency limit. A dependency waits for QC PASS. `CHANGES_REQUESTED` may schedule one bounded rework. `BLOCKED` does not complete the task.

Before a Developer or Reviewer process is selected, the scheduler negotiates the provider contract for the frozen account, model, mode, and permissions. The production tick uses the recorded transport. A live Codex or Claude launcher name is accepted only by a separate Owner authorization and is still not started by the scheduler. A failed, cancelled, or indeterminate run releases its launch slot and is not retried. QC PASS with automatic completion off waits for the existing Owner Done action.

### FO-AUTO-PRACTICAL01 observed tests

Full Autonomy may run one authorized test only when the active policy lists `run_observed_test`, requires an observed test, and names exactly one command for that project and task. Supervised and Autonomous modes do not run it. The command is not the isolation boundary. The existing offline Seatbelt profile is. The process is `sandbox-exec` with network denied, a private scratch directory, and the task-owned workspace as the only project root. If that profile cannot be built, the attempt is `blocked`, the exit code stays null, and nothing is recorded as a pass.

A pass requires that profile, exit code 0, and an evidence digest of the source fingerprint, command fingerprint, and captured output. The same task, command, source, and rework epoch is not executed twice. A `running` row left by a restart becomes `interrupted` and is not a pass. A failed test or a QC `CHANGES_REQUESTED` can schedule one rework inside `maxReworkAttempts`. The rework prompt carries the original requirements, the prior diff, the observed test output, and the reviewer findings. Provider, account, model, and expired-grant failures stop for the Owner. They are not retried as implementation rework. A start that does not reach a run is not left in `running`.

Automatic Done still requires the existing completion rule. When the policy also requires an observed test, Done is refused until the latest attempt for that task passed.

Automatic Done uses `acceptAuthorizedTaskDone`, which requires the review column and QC PASS, then the same acknowledgement path as an Owner Done.

Brain retrieval is limited to project memories inside the policy. Company memories are not copied into a project mission. Automatic memory persistence is available only for a PASS review with a source-verified observation, and only when the policy says `auto-low-risk`. Credential-like text is rejected.

## Stop and recovery

Pause keeps the activation and does not mint a new permission. Resume requires a paused policy that has not expired, and it is refused while the emergency stop is active. A revoked policy cannot resume.

Emergency stop refuses new autonomous launches, cancels unclaimed reservations, asks live runs to cancel through the existing run cancellation, pauses running missions, and writes a recovery journal. Clearing the stop does not resume missions or recreate permissions.

On backend start, autonomy recovery runs before mission recovery. It does not create an activation and does not relaunch a consumed reservation.

## Self-improvement

A policy may set `selfImprovement.enabled` and `selfImprovement.lowRiskActivation`. Both default to false. Policies created before FO-SELF-IMPROVE01 omit the field, which means disabled. Turning either flag on is an expansion of an active grant.

Supervised mode may observe, prepare, and evaluate. It does not activate. Autonomous and Full Autonomy modes may activate a low-risk, project-scoped instruction revision only when both flags are on and the improvement engine itself is enabled. The engine cannot revise this policy, raise its own hard limits, or treat a fixture pass as global permission.

See [self-improvement](self-improvement.md).

## Account profiles

Full Autonomy may select only account ids listed on the policy. `allowUnscopedAccount` must be true before a launch with no account id is allowed. A disabled, revoked, or mismatched profile is refused. The coordinator does not replace it with another profile. A new policy revision still cannot expand an active grant. See [multiaccount-2](multiaccount-2.md).

## Owner proof

A Full Autonomy policy does not replace Owner identity. `authorizeAutonomyAction` still decides whether the operation is inside the policy envelope, the launch budget, and the concurrency limit. FO-OWNER-TRUST01 adds a separate proof check in front of that decision for provider execution. The proof is bound to the policy revision and the envelope digest. A revoked, expired, paused, or revised policy refuses the operation. Emergency stop and a paused project refuse it too. The Head of PM may prepare a request. It cannot authenticate the Owner or sign the proof. See [owner trust](owner-trust.md).

## Always denied

The policy cannot permit unrestricted filesystem access, credential extraction, unauthorized account switching, deletion of unrelated Owner files, production deployment, destructive infrastructure changes, editing the autonomy policy, editing the sandbox, or changing the self-improvement safety rules. `production_deploy` stays on the always-denied list. A Full Autonomy policy may name staging deployment and other infrastructure actions, but that permission does not authorize a remote adapter. See [infrastructure automation](infrastructure-automation.md).

## Infrastructure actions

FO-INFRA-AUTO01 adds `git_read`, `git_mutate`, `ci_inspect`, `ci_dispatch`, `staging_deploy`, `deployment_health`, `rollback_prepare`, and `rollback_execute`. Supervised mode allows none. Autonomous mode allows Git read, CI inspection, health inspection, and rollback preparation. Git mutation, CI dispatch, staging deployment, and rollback execution require Full Autonomy and still print that independent Owner authorization is required. An autonomy actor cannot mint that grant. Listing `production_deploy` is rejected while the policy is normalized.


## Mission capacity forecasts

An approved mission can be forecast from its frozen plan, remaining tasks, structured dependencies, active reservations and project lifecycle state. Forecasts apply the mission's concurrency and account limits. Missing release times, paused projects and Owner-dependent transitions can leave the completion window unknown. An Owner can inspect conditional scheduling assumptions through Forecasts. A what-if allocation keeps the approved plan intact and a material mission change requires a new authorization. Strict verified-quota admission and the hard monetary-cap refusal remain in the execution policy. The forecast performs no admission or reservation. See [forecast architecture](usage-analytics.md).


## Frozen mission resource reauthorization

Mission Control accepts amendments for authorized or paused missions after the current dispatch settles. The service resolves the exact remaining stage against Router 2.0, the registered account fingerprint, project scope, the original active policy, and the currently available evidence. For a Reviewer after implementation, it requires a settled successful Developer run and preserves that run and its linked review and test records. In-flight, unresolved, completed and independently owned work is held. An unstarted Developer epoch with a consumed grant cannot be reauthorized for another launch.

Each proposal binds the mission and its prior revision, every requested task and stage, the previous and proposed bindings, policy provenance, evidence references, concurrency limits, and the reviewed forecast snapshot. One canonical digest covers the whole amendment. Approval rechecks every stage, the task fingerprints, evidence links, and digest in one SQLite transaction. A failed check writes nothing. Duplicate stages, a stale revision, an in-flight stage, a blocked provider, an incompatible account, a consumed grant, and an expired policy are refused. An amendment cannot widen filesystem, terminal, browser, Computer Use, deployment, git publication, project scope, autonomy, or spending authority. It archives the previous plan and authorization and writes the replacement digest. Rejection changes only the proposal. The Head prepares and settles its drafts through the same service and rechecks its project or cluster scope.

Starting or resuming remains explicit. A revised stage uses the existing employee or QC service, with the mission revision, current policy, and exact binding checked again before submission. The action reservation carries the stage revision and rework epoch. A consumed or released reservation remains spent on restart. Revised Reviewer execution uses the supported read-only contract and acquires its own account slot after Developer execution and applicable practical testing settle. Policy expiration, emergency stop, project lifecycle, resource availability, and stricter overlapping policies still apply.

A proposal cannot extend a policy or broaden its allowlists. Where an amendment cannot safely be applied, a new Owner-authorized mission can cover unstarted work. An eligible successful implementation can instead use the existing QC-only recovery. The original evidence remains on the original task.
