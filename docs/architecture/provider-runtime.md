# Provider runtime

FO-PROVIDERS-RUNTIME01 is the execution contract between Router 2.0, AccountCore, and the supported harnesses. It does not replace those services. A recorded fixture can be parsed. A live provider process is not started by opening AI Resources or Settings.

## Capability states

Each capability is `supported`, `unsupported`, or `unknown`. Unsupported is reported. It is not emulated. Installation, authentication, model entitlement, account identity, and a completed inference are separate facts.

| Harness | Binding | Developer | Reviewer | Parallel accounts | Identity | Live execution |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Exact `CODEX_HOME` | `workspace-write` when authorized later | `read-only` | Distinct directories | Unknown | Not authorized |
| Claude Code | `CLAUDE_CONFIG_DIR` after HOME-access acceptance | Bounded edit tools | Read, Glob, Grep | Serialized | Unknown | Not authorized |
| Cursor | Ambient Keychain only | Blocked | Blocked | Unsupported | Unknown | Not authorized |
| Antigravity | ACP session | Recorded fixture | Read tools only | Serialized while subjects are unproven | Unknown | Not authorized |
| Gemini CLI | Headless JSON | Recorded fixture, including when the CLI is missing | Read tools only | Serialized while subjects are unproven | Unknown | Not authorized |
| fx | Gateway account, not the upstream account | Recorded ACP fixture | Read tools only | Same gateway serializes | Upstream Unknown | Not authorized |
| DeepSeek DSH | No admitted account adapter | Blocked | Blocked | Unsupported | Unknown | Not authorized |

The API balance at `https://api-docs.deepseek.com/api/get-user-balance/` describes DeepSeek API credit. It does not identify the DSH harness account. This milestone does not call it.

## Codex and Claude

Codex plans use `codex exec --sandbox workspace-write` for Developer and `read-only` for Reviewer. `danger-full-access` is refused. Turn token counts are attributable. A cumulative total without a previous baseline stays Unknown. `usedPercent` is not a remaining-request count. Reset credits are not redeemed.

Claude plans use `--permission-mode dontAsk` with an allow-list. `--dangerously-skip-permissions` and `bypassPermissions` are refused. `~/.claude.json`, HOME, and the macOS credential store are not isolated by `CLAUDE_CONFIG_DIR`. Concurrent Claude profiles take one credential-store lock. A session from another profile cannot resume.

## Cursor

Cursor's CLI checks that `/usr/bin/sandbox-exec` is executable and then applies a nested seatbelt. ForgeOrbit's outer Seatbelt returns `EPERM` for that check. Allowing the helper still returns `sandbox_apply: Operation not permitted`. A successful nested apply would also be rejected, because a replacement profile could drop ForgeOrbit's file rules. The production profile does not grant `sandbox-exec`.

The contract records an escalation proposal. `authorizesExecution` is false. Full Computer is not granted. `--force` and `--sandbox disabled` are not a way through this block. The legacy kanban argv for Cursor `auto` still contains those flags, and the real spawn throws `cursorRealExecutionBlock()` before that argv runs.

## DeepSeek DSH

Assessed versions 0.2.1-rc.5 and 0.2.2-rc.1 stay `execution-unsupported`. A path Seatbelt allows a pre-existing hard link inside the project to read an outside inode. `workspaceHardLinkPreflight` refuses that tree. `killOwnedTree` records descendant pids, including a `setsid` child, while the parent is alive and then signals that set. Contained spawns use only stdin, stdout, and stderr. These controls do not admit DSH: component boot and unconfined reads remain. No `dsh` process is started.

## Receipts and recovery

Missing token fields stay null. Subscription runs do not inherit a calculated API price as a bill. A shared pool delta is assigned to a task only when a receipt names the run. Fixture and synthetic execution types are excluded from genuine model rankings, including a row that says `real-provider` but carries a synthetic source. Cancellation, timeout, and a missing structured result are not success and are not retried. A consumed grant and a completed run id are not launched again. QC PASS is what allows Done.

## Production pipeline (FO-PROVIDERS-PIPELINE01)

The mission scheduler calls `gateMissionProviderLaunch` after it has admitted the task, reserved the exact Router binding, and prepared the task workspace. The gate resolves the registered account through AccountCore, then calls `selectProductionTransport`. The default transport is the recorded fixture. A matching operation can name `spawnCodexViaTmux` or `spawnClaudeViaTmux`.

## Production launch binding (FO-PROVIDERS-LIVE-READY01)

`productionCodexLauncher` is `spawnCodexViaTmux`. `productionClaudeLauncher` is `spawnClaudeViaTmux`. `invokeAuthorizedLiveLauncher` calls those functions only after `assessTrustedLiveAuthorization`. That assessment now verifies a native Owner proof for the exact operation. On this unsigned process the result is method `native-owner-proof`, `executionReady` false, and code `application-identity-unestablished`. A bearer token, an `approved` field, a forged authorization object, and `AGETOR_PROVIDER_LIVE_SPAWN` do not change it. Deployment and infrastructure authorization stay on the separate unsupported channel. The protocol, enrollment, and restore rules are in [owner trust](owner-trust.md).

A test may bind a fixture transport. That fixture reports provenance `qa-fixture`, launcher `none`, and `processStarted` false. A synthetic proof may reach `admitVerifiedFixture` only. That path also reports `processStarted` false and refuses if `executionReady` is true, so it cannot become a way to call the production launcher. It is not the production launcher.

FO-OWNER-TRUST02 embeds the helper and keeps that assessment closed on an ad-hoc or QA process. FO-OWNER-LOCAL01 keeps it closed until the bundle is signed by the pinned local Owner certificate and a real Owner authentication exists. Public Apple distribution requirements are not part of the product. A mission tick that somehow observed an execution-ready proof returns `live-lease-withheld` and still does not open a lease. The test spy `observeAuthorizedTransportForTest` runs after `admit` and does not call either launcher.

The mission gate therefore refuses a live selection before it opens a lease and before employee execution. The recorded lease remains the path a mission tick can run. `spawnAgent` still reaches the real spawn functions when a live lease is present and the trusted channel reports execution ready. This process cannot present a production application identity, so that report stays closed and the live lease does not start a process. After that tick reconciles a finished review, it recounts reservations before the next dispatch. A slot released by `CHANGES_REQUESTED` or by Owner acceptance is available to the next recorded run in the same tick.

Codex authentication for an inert QA stub plus a `synthetic-authenticated` marker is a recorded-fixture diagnostic. It is not a verified OpenAI subject. The same stub prints `0.0.0-qa`. That text parses as an old CLI, so a model floor would refuse GPT-6.1 Sol before the recorded driver starts. The floor stays in force for every other binary. It is skipped only when the Codex driver is `fake` and the executable bytes are exactly the inert QA stub, because that file is not Codex and the recorded driver does not query the model catalog. Claude keeps the same identity rule. `CLAUDE_CONFIG_DIR` still does not isolate HOME, `~/.claude.json`, or the macOS credential store. Concurrent Claude profiles stay serialized. Identity stays Unknown. No credential file is read to prove otherwise.

Durable run rows remain the result contract. A recorded dispatch event carries provenance `recorded-fixture` and phase `running`. Missing structured success is not success. A failed, cancelled, timed-out, or indeterminate result is not retried. A completed run id and a consumed grant are refused. Owner-facing labels distinguish Developer completion, QC PASS, changes requested, rework, Owner acceptance, and task DONE. A task is not shown as provider-running unless its mission phase is actually running.

Analytics reads one run record. Task, employee, provider, model, account, project, cluster, mission, and company views are filters over that record. Synthetic and fixture execution stay out of genuine token totals and model rankings. Subscription consumption stays Unknown unless a genuine receipt names the run. Calculated API rates are not subscription bills.

The Owner approval surface lists the provider, account, model, task, workspace, role, mode, filesystem, terminal, git, browser, and Computer Use limits. It states that an external process will not start. Ordinary navigation does not call the launcher. Cursor and DeepSeek stay blocked. Antigravity, Gemini CLI, and fx still have recorded fixtures only and no authorized production transport. Genuine provider execution is not verified.

Developer work still enters through `reviewEmployeeExecution` and `startEmployeeExecution`. Reviewer work still enters through `prepareQcReview` and `startQcReview`. The Reviewer plan is read-only: Codex `read-only`, Claude tools `Read,Glob,Grep`. `CHANGES_REQUESTED` uses the existing rework decision. Done uses `acceptAuthorizedTaskDone` and still requires the review column plus QC PASS. A provider text result does not create files and does not mark Done.

A recorded lease is in memory for one launch. `spawnAgent` consumes it, attributes the run to that account, writes `executionType` `synthetic` when the fake driver is on, and stores token counts with source `recorded-fixture`. A provider error, timeout, or indeterminate result exits non-zero and is not retried. Cancellation releases the autonomy launch slot and leaves the run cancelled. A paused mission checkpoint is recovered by the existing mission recovery path. Finished run ids and usage-accounting rows are not created again.

Opening Settings, AI Resources, Analytics, or a forecast does not open a lease and does not start a provider. Cursor and DeepSeek remain blocked. Antigravity, Gemini CLI, and fx still have recorded fixtures only. Genuine provider execution is not verified.

## Owner checklist for a later live acceptance

A later run needs a separate explicit Owner action. Opening this dashboard must not start it.

1. Name the provider, harness, and registered account.
2. Name the model and the execution mode.
3. Name the project and the task-owned workspace.
4. State the permitted actions and the filesystem, terminal, browser, and git limits.
5. State the maximum scope and the possible quota or API cost.
6. Show the cancellation control before the process starts.
7. Keep Cursor and DeepSeek excluded until their blockers change.
8. Do not treat a synthetic profile as a verified provider subject.

## Launch target (Direction 9)

What a launch will run is stated by one classifier (`src/shared/provider-launch-target.ts`) from the same executable resolution the launch uses. The only enforced compatibility rule is a model-specific minimum CLI version from `MODEL_MIN_CLI_VERSION` (today Codex's GPT-6 rows); there is no provider-wide floor, and Claude Code has none. A model that has a minimum is refused on an executable that printed no version when the driver is real; the recorded fixture driver shows a warning. A passive screen never starts a CLI: it shows a version only if an earlier explicit probe read the identical file. A compatible result is not sign-in, entitlement or capacity. See [the Direction 9 report](../qa/fo-direction9-results.md).
