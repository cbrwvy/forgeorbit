# Plan — Cost and time estimation core (FO-006A)

| Field | Value |
| --- | --- |
| Date | 2026-10-24 |
| Source | FO-006A task prompt |
| Branch | task/fo-006a-estimator-core |
| Scope | Pure calculation core. No routes, no UI, no SQLite migration, no harness calls. |

## 1. What this core is

`src/shared/estimation` answers one question: given a structured description of work, accounts, and prices the caller actually has, what can be said about agent time, calendar time, and money — and what cannot.

It does not read the task database, does not start a CLI, and does not contain a provider price list. A later adapter fills `EstimationRequest`. `estimate` and `estimateWhatIf` are pure. `compareEstimateToActual` is a separate pure comparison, shaped so a future table can store it.

## 2. What ForgeOrbit already stores

| Already stored | Usable as | Not usable as |
| --- | --- | --- |
| `Task` column, harness id, model, effort knob, profile snapshot, pipeline ids | Identity and assignment labels | An hour estimate or a dependency edge |
| `Run.startedAt` / `endedAt` / status | An observed duration sample, when both timestamps exist | A prediction for a task that has not run |
| `HarnessQuota.meters[].usedPercent` plus an optional reset | A percent-used window (`QuotaUnit` `percent-used`) | Remaining tokens, requests, or a dollar balance |
| `AccountUsageSummary` token totals (Claude, local JSONL) | Historical volume | Remaining quota or a price |
| `AgentProfile` / pipeline step | Which harness and model a stage expects | A speed, a fee, or a quota |
| Proposal `dependsOn` | A dependency list the caller can copy onto work items | A schedule |
| `task_dependencies` rows (FO-005C, migration 072) | Confirmed dependency edges between a project's tasks | Effort; `task_priorities` is execution order, never hours |

Not stored anywhere today: subscription price, billing period, renewal, overage price, exchange rate, model throughput, machine duty cycle, or a per-stage effort range. Those stay unknown until a person or a future adapter supplies them. Complexity words are labels. They never become hours inside this module.

## 3. Workload

A scope (`task`, `feature`, `milestone`, `backlog`, `project`, `portfolio`) filters items by id, project, and group. Each item is an ordered list of stages (planning, implementation, testing, review, fixes, validation, other). Stages inside one item run one after another. Each stage has its own optional effort range, repetition range, account, model, and consumption.

Optimistic, expected, and conservative are the three fields of those ranges. They are not a percentage of the expected case and they are not a statistical interval. A missing effort stays missing. Observed history changes confidence only.

`requiresReview` / `requiresValidation` without a matching stage does not invent a duration. The agent total becomes incomplete and the calendar is not produced. A blocker with a null wait does the same to the calendar and leaves agent time alone.

Dependencies are a DAG. The critical path is exact when every item duration is known and concurrency is explicitly unbounded (or at least the item count). A numeric cap uses list scheduling by longest remaining path. That result is marked estimated, not exact, unless it collapses to the critical path or the cap is 1. Cycles make the calendar `invalid`. Agent time is still the sum of the stages. A dependency that the scope filter removed is not treated as already finished.

Item concurrency `null` means "not provided". The critical path is then only a lower bound. Account concurrency is not simulated minute by minute. `null` on a referenced account blocks a completion time. A numeric cap below the number of pinned items downgrades the result to an estimate and says so.

Machine availability is one duty-cycle stretch plus a declared pause total. It is not an on/off calendar. Quota reset, when extra spend is off and a reset instant is known, is one delay added on top of the schedule. A finish instant is set only when the calendar is known, exact, and the caller passed a start time.

## 4. Money

Four categories, kept apart:

- **Existing subscription cost.** The full recurring fee of each existing subscription a stage actually references. It is not divided across tasks and it is not additional cash.
- **Additional cash.** Overage and a proposed subscription's purchase price (or one period of its recurring fee when no purchase price was given), and only when the budget allows that kind of spend. Zero is returned in three cases: there is no work; measured remaining quota covers the declared consumption; or paid overage and upgrades are turned off. The third case is basis `policy`. It is not proof the quota covers the work, and the calendar is not treated as proven while coverage is unknown.
- **API-equivalent cost.** Priced only from caller-supplied rates. `apiRates: null` means "not requested". An empty list means "requested, and no rate was supplied", which stays unknown rather than zero. This figure is never added to additional cash.
- **Allocation.** `none`, a fixed share, or usage-weighted. Usage-weighted runs only when every weight is `known` or `observed`. The allocated amount is not additional cash.

A percent-used or opaque meter is never converted into tokens or hours. Credits are not converted through the money exchange table. Exchange rates convert minor units in the supplied direction only. A missing rate yields `mixed-currency`, and the budget guard then reports insufficient data.

The budget verdict is `within-budget`, `over-budget`, `potentially-over-budget`, or `insufficient-data`. Unknown additional cash is never within budget. A priced portion that already exceeds the cap is over budget even when the rest is unpriced. A priced portion inside the cap with an unpriced remainder is potentially over budget. The guard does not start a purchase. A provider outside `allowedPaidServices` fails the guard.

## 5. Confidence

Confidence is a checklist. High means the expected scenario has effort, a proven calendar, measured coverage (or no work), resolved currencies, and observed history that matches the scope. Medium means the headline numbers exist and some checklist rows failed (no history, a policy zero, an unproven calendar). Low means agent time or additional cash is not known. None means the request is malformed. The summary says this is not a statistical interval.

## 6. What-if and estimate versus actual

`applyWhatIf` clones the request and applies a patch: drop or replace items, change effort, reassign a stage, add or replace an account or subscription, change concurrency, budget, allocation, dependencies, rates, or machine availability. `estimateWhatIf` estimates the copy. The original request is not written.

`compareEstimateToActual` subtracts estimate from actual for agent time, calendar time, additional cash, runs, and review rework. A missing side, or two currencies without a rate, stays unknown. The result is plain JSON.

## 7. Limits

At most 2,000 items. Scheduling is critical path plus one list-scheduling pass. There is no search over account assignments. Structural errors (negative durations, inverted ranges, duplicate ids, bad shares, unknown dependency ids, unsafe money) return `ok: false` and no scenarios. Cycles are reported and do not prevent the agent-time sum.

## 8. FO-006B and later

Do this in a follow-up, not in this branch:

1. FO-006B reads `EstimationResult` and renders it on the project dashboard and backlog. It does not calculate. It shows unknown and policy-zero as their own states, including the warning that a policy zero is not coverage.
2. FO-006C is the adapter. It may map `HarnessQuota` percent meters, run durations, and profile labels into this request. It must not invent a token balance from `usedPercent` or a price from a plan name. Effort ranges remain user-provided or explicitly estimated upstream, with that origin preserved.
3. Portfolio Manager can pass several projects, one shared subscription list, and the remaining balances it has already measured. This core does not subtract other projects' usage by itself. The caller passes the remaining amount it wants this forecast to see.
4. No new route, migration, or `src/shared/types.ts` edit is required to import the core. A route, when one is added, should call `estimate` and return the result unchanged.

## 9. Structured dependencies (FO-005C integration)

The Estimates adapter (`adaptProject` in `src/shared/estimation/project-adapter.ts`) takes `structuredDependencies`, read on the server through `taskScheduling.edgesForProject(projectPath)` and returned on `EstimationRecord.structuredDependencies` and on `GET /projects/estimation/dependencies?path=`. A link edit does not change the task rows the board polls, so every write in `src/bun/task-scheduling.ts` that changes a task's links (`updateScheduling`, `linkProposalDependencies`) broadcasts a `task_dependencies` AppEvent (`{projectPath, taskIds}`, ids only) on the existing `/app/events` stream. App forwards it to `lib/dependency-events.ts` (no second EventSource, no poll), and the page re-reads the light route for its own project. A reconnect of that stream (`EventSource.onopen`) publishes a resync, and window focus / becoming visible re-read too, so a lost event is caught up; opening the page or switching project reads the links with the record. Reads take a ticket so an older response never overwrites a newer one. A task delete cascades its links without an event; the task leaves the task list, and the adapter and fingerprint ignore links to it.

- Board links and the edges ticked on the Estimates page are merged per task, board links first, duplicates removed, capped at `ESTIMATION_LIMITS.maxDependenciesPerItem`. An empty manual list never removes a board link; manual edges are kept as they were saved and never written into `task_dependencies`.
- A link is used only when both ends are active, non-step tasks of the same project. Other links are dropped with a note. The "## Depends on" Markdown in prompts is still ignored, and priority is never read.
- `backlogFingerprint(tasks, edges)` adds one line per board link between board tasks. With no links the value is identical to the previous fingerprint, so estimates saved before the integration are not marked stale by the upgrade; adding or removing a link marks a saved estimate stale.
- The estimation core (`estimate`, schedule, forecast) is unchanged.
