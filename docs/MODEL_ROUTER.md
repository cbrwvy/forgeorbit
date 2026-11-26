# FO-009D Model Router

The router recommends a resource for an assignment. It does not define an AI employee, select the actual execution account, modify a task, or start a harness.

## Architecture and evidence

- src/shared/model-router/requirements.ts: structured requirements, preserving unknown complexity. Titles, prompts, priorities and model names do not imply complexity or capability.
- src/shared/model-router/route.ts: pure capability, tool, permission, context, login, quota, concurrency, spending, effort and policy checks; ranked alternatives, exclusions, provenance, approvals and unknowns.
- src/bun/model-router.ts: read-only SQLite snapshot using canonical AccountCore; existing project ownership helpers shared by Project Manager and Portfolio; existing Estimation Engine for saved planning inputs.
- src/bun/model-router-http.ts: bounded and strictly validated calculation requests behind the server's exact bearer check.

No schema changes or new account registry. Migration 078 is untouched. FO-010 employee identity and Task Runtime remain independent.

A verified registry identity does not prove CLI authorization. A profile association supplies only an explicit candidate account/model link. Manually declared model support and profile effort values never become verified capability evidence.

Internal VerifiedFact values require a source, observation time, explicit future expiry and verified acquisition. They must describe the exact candidate and, for duration/cost, the task under evaluation. HTTP clients can submit requirements and Owner restrictions, never verified resource facts. No production login/model/effort/billing verification source is added here; real candidates therefore remain conditional until safe sources exist. This abstention is intentional.

## Task requirements and effort

Requirements include Backend, Frontend, Testing, Architecture, Documentation, DevOps or General; Low, Medium, High, Very High or Unknown complexity; explicit capabilities/tools, required and allowed permissions, context tokens, quota demands and priority.

Unspecified type stays General. Unspecified complexity stays Unknown. Explicit task priority is read from its structured row; absence stays null. Project priority is explicit preview input because the current registry does not persist it.

The confirmed effort vocabulary is ordered from least to most, separately for each harness/model. Complexity selects the corresponding position (0, 1/3, 2/3 or 1 of the ordered range, rounded). No universal effort spelling is emitted. Unknown vocabulary/complexity gives a conditional null recommendation. A confirmed empty vocabulary means no effort parameter.

## Eligibility, quotas and concurrency

AccountCore resolves every quota source's latest observations at the snapshot instant. Reset, expiry, undated freshness, conflicts, missing counts and percent-only meters cannot establish remaining capacity. Independent scope/unit/window definitions stay separate. Unrelated known model/harness quotas are ignored; an unrecognized scope stays conditional.

A non-concurrency quota needs an explicit task demand against its exact definition. No requests-to-tokens conversion is attempted. Shared subscriptions are metadata relationships, not evidence that balances can be summed. Shared pool equality requires confirmed provider, pool ID, scope, window and unit. Reports for the same verified pool are resolved together, exposing conflicting evidence across accounts. Shared subscription quota without verified pool identity stays conditional.

Concurrency is evaluated at global, account, harness, subscription and verified pool scopes. An account cap is represented once regardless of harness count. Global SQLite occupancy includes runs outside the project registry. Account occupancy is not reconstructed from historical runs' current profile bindings. Absence of local runs does not establish zero provider usage; current trusted account occupancy is required. With unattributable active runs, account occupancy stays unknown.

Portfolio preview orders explicit project priorities, then task priorities, simulates occupancy and quota consumption in a cloned snapshot, and returns conflicts for later contenders. Unknown project priorities withhold multi-task cross-project allocation. Nothing is reserved or persisted.

## Policies and ranking

All policies first enforce the same eligibility and Owner restrictions.

| Policy | Comparison between eligible resources |
| --- | --- |
| Quality-first | Higher confirmed score on the same benchmark |
| Balanced | Pareto dominance across quality, incremental cost and duration; no invented weights |
| Cost-efficient | Lower confirmed task cost on the same basis and currency |
| Fastest-eligible | Lower confirmed task duration on the same basis |
| Preserve-limited-resources | Higher minimum confirmed remaining/limit fraction |

There are no built-in model quality tables, prices or speed claims. Missing values do not become zero. A unique verified candidate can be recommended. Multiple candidates need a strict winner from comparable policy evidence; ties and tradeoffs return no-verified-candidate with verified alternatives. IDs stabilize presentation only.

Owner harness/account allowlists, permission limits, spending, cost ceilings, global concurrency, project priority and approvals survive into the result. Spending semantics reuse spendingChecks: allowing subscription overage does not permit per-request API billing. HTTP restrictions cannot loosen saved estimation spending mode or budget.

Saved task estimates are returned separately as planningEstimate, with existing provenance and missing-data reports. They are not promoted into verified candidate prices; subscription commitments and API-equivalent figures are not actual task spending.

## Read-only API

Both endpoints require Authorization: Bearer <API_TOKEN>. Query tokens cannot authorize them. POST carries calculation inputs only; GET and mutation/launch/switch/shell routes are not implemented. Responses use Cache-Control: no-store.

POST /model-router/preview accepts:

    {
      "path": "/exact/registered/project",
      "taskId": "existing-task-id",
      "policy": "balanced",
      "requirements": {
        "type": "backend",
        "complexity": "high",
        "capabilities": ["backend"],
        "tools": ["sqlite"],
        "requiredPermissions": ["read"],
        "allowedPermissions": ["read"],
        "contextTokens": 8000,
        "quotaDemands": [{"quotaId": "existing-quota-id", "amount": 5}]
      },
      "ownerConstraints": {
        "allowedHarnesses": ["codex"],
        "allowedAccounts": ["existing-account-id"],
        "spending": "no-extra",
        "globalConcurrency": 2,
        "projectPriority": "high",
        "requiredApprovals": ["Owner execution approval"]
      }
    }

Only path and taskId are required. Optional maxExpectedCost uses { "currency": "USD", "minor": 100 }. Requests are bounded to 64 KiB and lists to 64 entries. Preview restrictions are ephemeral; they never grant execution authority.

POST /model-router/portfolio-preview accepts { "requests": [ ...same task requests... ] }, up to 50 unique tasks. All requests share one snapshot and the strictest submitted global concurrency cap. Results contain priority-ordered previews and task-scoped planningEstimates.

Exact registration is checked before inspecting the requested path. Existing project ownership rules then reject foreign tasks. Prompts, instructions, harness environment/binary/home settings and credentials are not projected into router responses.

## Validation and limits

Targeted tests use fake resource facts, temporary SQLite/HOME, blocked process/network acquisition in new endpoint/adapter tests, and byte-for-byte database checks. They cover complexity, multiple harnesses/accounts, declared versus verified support, tools/context/permissions, model and effort uncertainty, quota availability/exhaustion/staleness/conflicts, subscription and pool identity, shared occupancy, project priorities, all policies, fallback and abstention.

Regression scope: AccountCore/migration/trusted quota/API; Portfolio core/adapter/manager; Project Manager shared/backend; Estimation core/adapter/API. Each backend regression file runs in a separate process with temporary HOME/data and fake or absent binaries. No complete suite, live AI CLI/provider calls or Playwright runs are needed for this backend-only change.

Future execution integration must acquire fresh authorized evidence for the exact harness/account/model, validate the selected profile's actual config, re-read Owner policies/approvals, and atomically recheck/reserve global/account/subscription/pool capacity immediately before calling the existing supervised execution path. Capture actual resource identity on the resulting run only after execution confirms it. Preview output never proves that a resource was used or reserved.

Validation on the implementation: 45 new router tests and 268 targeted existing regressions passed (313 total, zero failures). The TypeScript check and whitespace check passed. Regression groups: AccountCore 58, Portfolio 94, Project Manager 51, Estimation 65. No UI changes; no Playwright run.

---

## AI Router 2.0 (FO-ROUTING04)

FO-ROUTING04 advances ForgeOrbit's routing from static advisory checks to a functional, explainable, deterministic selection engine supporting the single Owner architecture: Owner → One Head of PM → Clusters / Projects → Specialist Agents.

### Key Architecture Components

1. **Deterministic Two-Stage Selection Engine (`src/shared/router-v2/evaluator.ts`)**:
   - **Stage 1 (Elimination)**: Candidates failing strict requirements are eliminated with explicit reasons:
     - Reviewer/Head/Research roles require read-only execution mode (`ask`, `bounded-print`, `plan`). Write modes are rejected.
     - Developer/DevOps roles require workspace write mode.
     - Blocked providers: Cursor real execution stays blocked because its required sandbox cannot initialize under ForgeOrbit's Seatbelt (`cursor-internal-sandbox-unavailable`). An escalation proposal is not a grant, and `--force` / `--sandbox disabled` are not used to force a launch. DeepSeek stays blocked because a path Seatbelt does not stop a pre-existing hard link (`deepseek-containment-blocked`). FO-PROVIDERS-RUNTIME01 adds a hard-link preflight and a descendant reaper; those controls do not admit DSH while component boot and unconfined reads remain. Neither block is lifted by a model catalog or a CLI login.
     - Quota exhaustion: verified exhausted quotas eliminated. Strict policy eliminates unknown quota; permissive policy permits with warning.
     - Active concurrency cap and Owner allowlist/denylist constraints.
   - **Stage 2 (Scoring & Ranking)**:
     - Multi-attribute scoring across Quality (tier/benchmark), Cost (minor units/tokens), Latency (measured ms), Quota (remaining fraction), and History (success and QC pass rates).
     - Deterministic sorting: Manual override first, total weighted score descending, harness label, model ID, account ID.

2. **Routing Policies**:
   - `best-quality`: Emphasizes model capability and quality tier.
   - `lowest-cost`: Emphasizes token and monetary cost efficiency.
   - `balanced`: Balanced trade-off across quality, cost, latency, and history.
   - `fastest`: Prioritizes lowest measured latency.
   - `quota-saver`: Conserves limited verified subscription/request quotas.
   - `custom`: Owner-configured weights and constraints.

3. **Quota Evidence & Generic Adapters (`src/bun/router-v2/router-v2-quota-adapters.ts`)**:
   - Pluggable `QuotaSourceAdapter` interface (`AccountCoreQuotaAdapter`, `SyntheticVerifiedQuotaAdapter`).
   - Strict separation of evidence classes: `verified`, `estimated`, `configured`, `unknown`.
   - Unknown quota is never fabricated.

4. **Genuine Execution History Learning (`src/bun/router-v2/router-v2-history.ts`)**:
   - Queries `run_events` for `{"kind":"execution-identity","executionType":"real-provider"}`.
   - Synthetic drivers and test fixtures are strictly excluded from router performance metrics.
   - Company analytics uses this same genuine-history rule for employee and model comparisons.

5. **Head of PM Integration (`src/bun/head-pm-scope.ts`, `src/bun/head-board-proposals.ts`)**:
   - Injects active policy and recommended Developer/Reviewer candidates into `gatherScopedHeadContext`.
   - Records decisions upon Owner approval of `plan_execution` board proposals without starting workers.

6. **Multi-Project Planning (`src/shared/router-v2/multi-project-planner.ts`)**:
   - Cross-project allocation with starvation avoidance (fair-share round-robin).
   - SHA-256 plan digest freeze and fingerprint freshness verification.

7. **Owner UI (`src/mainview/components/router/AiRouterDashboard.tsx`)**:
   - Settings tab with policy selection, score breakdowns, candidate readiness indicators, and history logs in English and Russian.

## Smart Router resource decisions (FO-ROUTER-COMPLETE01)

FO-ROUTER-COMPLETE01 keeps the same Router 2.0 service, AccountCore, forecast planner, mission reauthorization, analytics history, and Head. It does not add a second router or account store.

Eligibility still runs before scoring. A high quality score cannot make Cursor or DeepSeek executable. Those providers stay blocked for the existing sandbox and containment reasons. A pinned resource that fails eligibility is reported as unavailable and is not replaced.

Capacity is classified before a policy may admit it: verified sufficient, verified insufficient, Owner-reported, stale, configured but unverified, or Unknown. Strict policy admits only verified sufficient capacity. Permissive policy may show uncertain capacity with a warning. A shared pool is one balance, keyed by its pool id, and is not copied onto every account or model. A local planning reservation is not a reservation in the provider billing system. Subscription coverage is scored as an unknown API cost and is not treated as free. Costs in different currencies are not compared. Unknown quota stays Unknown.

Historical quality is measured only from genuine `real-provider` executions with at least three comparable samples for the same role. Three to seven samples are low confidence. Eight or more are high confidence. Configured quality tiers remain planning labels. Synthetic and fixture runs do not train the ranking. Developer and Reviewer samples are not mixed. Forecast error stays Unknown below the sample minimum.

The six presets keep these weights. Best Quality is quality 60, history 20, latency 10, cost 10, quota 0. Lowest Cost is cost 60, quota 20, history 10, quality 10, latency 0. Balanced is quality 30, cost 30, latency 20, history 20, quota 0. Fastest is expected completion 60, history 20, quality 10, cost 10, quota 0, and expected completion includes queue wait and rework overhead. Quota Saver is verified remaining capacity 60, comparable cost 20, quality 10, history 10, latency 0. Custom weights are integers from 0 to 100, and at least one must be positive. Invalid custom weights do not replace a saved policy. Ties break by harness label, model id, then account id.

Portfolio allocation reuses the bounded search. More than twelve stages, or a search that hits its node limit, keeps the fair round-robin candidate and says global optimality is unproven. Later tasks in a project depend on that project's first planned task so one project does not take every slot. A recommendation has `authorizesExecution: false`. Decision rows record authority as `recommendation`, `approval`, or `fallback-proposal`. Migration 135 adds that column and does not rewrite older decision types.

Safe Fallback records the failed resource, proposes one eligible replacement, and stores a digest of the failed resource, the replacement, and the evidence. It does not apply the change, retry the provider, or start a run. A digest mismatch or a changed source plan refuses the proposal. Applying an approved plan still goes through the existing Owner approval path.

`envelopeLocked` refuses any harness, account, or model outside the supplied allow-lists. An empty allow-list refuses every resource. The flag is explicit. It does not silently enlarge an activated Full Autonomy policy, and an unenforceable hard spending cap still refuses activation. Head questions that ask about routing read this same service and include the recommendation boundary. Head text is not approval.

## Fail-closed admission (FO-ROUTER-COMPLETE02)

Mission admission by task id keeps the requested harness, model, account, and mode. Evaluation runs before a plan row is stored. A thrown evaluation, a blocked Cursor or DeepSeek selection, a missing explicit resource, or a selected candidate that does not match the request refuses the mission. The refusal names the reason. No Claude, Sonnet, Codex, default account, or default model is substituted, including when the evaluator returns a different eligible candidate.

Full Autonomy does not wait for a caller to set `envelopeLocked`. `autonomyEnvelopeOverride` builds the lock from the activated policy, and `autonomousResourceHold` runs it at developer and reviewer admission. An empty provider or model list holds the launch for Owner review. An empty account list does not mean every account. An unscoped account is admitted only when the policy sets `allowUnscopedAccount` and names no accounts. A revoked, expired, or emergency-stopped policy fails closed. A recommendation is not a grant. Supervised mode is not converted into Full Autonomy. An older mission whose exact resource is still inside its approved policy keeps that resource.

The bounded search models global slots, cluster concurrency, project concurrency, role concurrency, and one account's concurrency as shared interval pools. A shared quota pool is one remaining balance, not one balance per model. Occupied work and paused or draining stages are inputs. A search that stops at its node limit, or that has more than twelve active stages, is the best feasible candidate found so far and is not labeled globally optimal. A cap the caller cannot measure is listed as a limitation.

Safe Fallback records one of the named failures, keeps the original run, and proposes one eligible replacement through the existing mission resource proposal. Developer and Reviewer proposals stay separate. The proposal is read-only until the Owner approves its digest. A changed mission, task, or evidence digest is refused. Approval writes a new revision and leaves completed runs on their original resource. Head can prepare the proposal from recorded evidence and cannot approve it. If no eligible replacement exists, the answer says so and invents nothing.

## Company admission and disposable profiles (FO-ROUTER-FINAL01)

A registered Codex or Claude profile is that provider. Mission admission and the Full Autonomy envelope compare the harness kind (`codex`, `claude-code`) plus the exact account, model, and mode. The profile id is not a different provider and is not rewritten to a built-in harness. A Cursor or DeepSeek selection is still refused before scoring. A pinned account stays on that account when a slot is busy; the scheduler records the wait instead of choosing another account. That wait reason is cleared when the task actually starts.

A competing mission that is already authorized waits when the global or project slot is taken. The plan reason is `Waiting for a global, cluster, or project worker slot.` Account capacity uses the same shared occupancy. A paused project is refused by the existing lifecycle check and does not start a run. Rejecting a proposal leaves the revision and the binding unchanged. Approving one writes the next revision and stores the previous plan. A second process that reopens the same database and ticks a paused mission does not create another run.

The packaged QA gate still refuses harness homes, binaries, task directories, and project directories outside the baked disposable root. A stored harness environment is allowed only for a registered profile row: `codex-profile-*` may store exactly `CODEX_HOME`, and `claude-profile-*` may store exactly `CLAUDE_CONFIG_DIR`. That path must be a private, user-owned, non-symlink subdirectory of the disposable home and of the baked QA root. `HOME`, `PATH`, a built-in harness id, a world-writable directory, a symlink, or any path outside that root is still refused. The profile row does not also store a harness home. Empty environment rows still receive a generated home under the disposable profile. This does not trust a path because a QA manifest names it.


## Plan apply authority (Direction 16)

`POST /api/router-v2/plans/apply` applies an Owner-reviewed initial allocation and starts nothing. A plan travels through the client, so the service accepts only a plan whose exact contents it issued (`planMultiProject`, `planPortfolio` record the digest in `router_v2_issued_plans`), once, and only if every stage's exact resource is still eligible and the task is not running, archived, bound to an agent profile, part of a pipeline or carried by an unfinished mission. One refused stage refuses the whole plan. A replacement of a resource something already owns is not a plan apply: a mission changes through its sealed, Owner-approved resource proposal. Issuing a plan authorizes nothing.
