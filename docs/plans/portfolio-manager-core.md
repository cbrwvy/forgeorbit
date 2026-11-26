# Portfolio manager core (FO-008A)

Pure domain for a single global Portfolio Manager. It answers from a caller-built snapshot. It does not read SQLite, call a model, start an agent, or write a project.

Owner → Portfolio Manager → Project Managers → harness agents. This core is the Portfolio Manager's calculator. A Project Manager still owns the tasks inside one project. FO-008A only suggests focus across projects.

## Boundary

- Input is `PortfolioSnapshotInput` (`src/shared/portfolio/types.ts`).
- Output is `PortfolioAnalysis`. `execution` is always `"proposal-only"` and `runningAgents` is always `"unchanged"`.
- Every proposal has `readOnly: true`. Nothing here edits a task, batch, account, profile, or harness.
- Columns, run statuses, batch statuses, pipeline statuses, environment phases, and task priorities are the existing ForgeOrbit unions.
- A card in `review` is not Done. Done is the `done` column only.
- A pipeline step (`pipelineParentId` set) is not a board task.
- A batch names task ids. Those ids are not a second copy of the task.
- Duplicate task ids are counted once. The first occurrence is kept.
- `task_priorities` missing row is not Normal. `priorityOf` in `db.ts` returns `"normal"` for that gap. The adapter must pass origin `unknown` and a null value.
- A percent-used quota meter is not remaining capacity, including at 100%.
- A subscription fee is counted once per subscription id.
- Project calendars are not added together to invent a portfolio finish time when accounts are shared.
- No exchange rate means mixed currencies stay uncombined.
- A stale snapshot is history. It is not the current portfolio.
- There is no numeric health score. Signals overlap. Missing data stays unknown.

## Modules

| File | Role |
| --- | --- |
| `types.ts` | Snapshot, facts, conflicts, proposals, FO-008B notes |
| `validate.ts` | Rejects malformed input. Does not invent a replacement value |
| `snapshot.ts` | Index, dedupe, freshness, counts |
| `health.ts` | Overlapping signals with evidence |
| `resources.ts` | Capacity and conflict detection only |
| `priorities.ts` | Declared priority, unblock counts, confirmed deadlines |
| `planning.ts` | Read-only proposals |
| `estimation.ts` | Sums FO-006A forecasts. Does not estimate |
| `what-if.ts` | `structuredClone` plus a patch. The caller's object is not written |
| `index.ts` | `analyzePortfolio`, `analyzeWhatIf` |

`analyzePortfolio` is synchronous and does not read the clock. The caller passes `capturedAtMs`.

## Freshness

`stalenessAfterMs == null`, or `observedAtMs` after the capture instant, is `unproven`. Age greater than the window is `stale`. Anything else is `current`.

Current totals skip stale and unproven projects. Those projects still appear in the summary, with `countsAreCurrent: false`, and their health signal for "now" is `unknown`. Findings from the old snapshot are returned as `historicalFindings`.

## Health signals

`active`, `idle`, `blocked`, `waiting-for-owner`, `degraded`, `needs-attention`, `unknown`.

Idle means the observed board is not running, blocked, or in review, and no run or batch is in motion. An empty board is idle. It is not a finished project.

`waiting-for-owner` covers the review column, a paused batch, and an approved batch that the owner has not started. A failed or orphaned run is `needs-attention`, not Done.

## Resources and conflicts

Conflict class is `confirmed`, `potential`, or `insufficient-data`.

- Confirmed: observed occupancy over a known limit, an approved plan over that limit, an exclusive resource held twice, an unavailable harness, a model outside a known supported list, a remaining count of 0 or an explicit exhausted flag, a permission the resource does not grant, extra spending the resource forbids.
- Potential: ready tasks would exceed a known limit, or occupancy evidence disagrees.
- Insufficient data: unknown quota, a percent-used meter, unknown concurrency, an ambiguous account, a resource the snapshot does not list.

`allowWorkWithUnknownLimits` turns insufficient-data into a warning that does not block automatic execution. It does not waive a confirmed safety conflict. FO-008A still does not execute.

## Priority

Tasks in projects the owner prioritized are ordered by that declaration, then by the task's own declared priority, then by how many not-done tasks they unblock. A deadline orders two tasks only when both deadlines were confirmed. A task with no deadline is not overdue and is not treated as due now.

Projects with no declared priority are listed in `taskPriorityOnly`. They are not placed under Low.

A proposal may ask the project manager to take a blocker earlier. It does not change the priority.

## Estimation

The snapshot carries the FO-006A `DurationForecast`, `CalendarForecast`, and `CashForecast` plus itemized subscription refs. This core does not call `estimate()`.

- Agent time sums known pieces. A missing project is not zero. The headline is null when any current project is incomplete.
- One current project keeps that project's calendar.
- Several projects with no shared constrained account use the caller's rule: `serial` or `concurrent-if-uncontended` (slowest project). Null rule means the portfolio calendar is unknown.
- A shared account whose concurrency is not an explicit `unbounded` makes the portfolio calendar unknown. The project numbers are not summed.
- Additional cash is not summed when two projects report positive extra spend against the same subscription.
- API-equivalent cost is a separate figure. It is not additional cash.
- Existing subscription fees use the itemized refs, one row per id. Disagreeing fees publish no total.
- Confidence is the weakest current project, and `none` when any current estimate is missing or incomplete.
- "What fits in the time left today" stays unknown until a caller supplies a window and per-task durations.

## What-if

`applyPortfolioWhatIf` copies the snapshot, then may change project priority, drop or replace resources, set concurrency, keep a task subset, drop projects, overlay policy, or hypothetically point a task at another resource. `analyzeWhatIf` analyzes the copy. No account is switched and no task starts.

## FO-008B integration

FO-008A does not edit these files. FO-008B may add a read-only adapter and a read-only route. It must not start work from a proposal. Confirmation and execution are FO-008C.

New code, not edits to the runners:

- `src/bun/portfolio-adapter.ts` builds `PortfolioSnapshotInput`.
- A `GET` route, if one is added, lives in `src/bun/server.ts` and returns `analyzePortfolio` output. That is the shared-file change this core cannot make by itself.

Read, do not write:

| Source | Map to |
| --- | --- |
| `projects.list()` | Project id and path. The path is the registry key. Name origin is `user-provided` |
| Board tasks for that path, `pipelineParentId == null` | `tasks`. Step rows are included only with `pipelineParentId` set |
| `task_dependencies` | `dependencies`, and only when the read succeeded. Set `coverage.dependencies` |
| `task_priorities` row present | priority fact, origin `user-provided` |
| no `task_priorities` row | `{ value: null, origin: "unknown" }`. Do not copy `priorityOf`'s Normal default |
| `runs` | `runs`. Active is `status === "running"` only |
| `project_execution_batches` | `batches`. Membership is task ids |
| pipeline run state | `pipelines` using `PipelineRunStatus` |
| environment runtime | `environment.phase` from `EnvironmentPhase`. No profile means configured `false`, not a guessed phase |
| `project_managers` row | `managerConfigured`. Availability only from a real probe; otherwise `unknown` |
| `adaptProject` + `estimate()` | `estimate` fields copied from the FO-006A result, plus subscription refs |
| harness row + `HarnessQuota` | `resources`. `usedPercent` becomes `{ kind: "percent-used" }` and nothing else |
| owner-typed project priority and deadlines | `projectPriorities`, `deadlines`, origin `user-provided` only |

`coverage.*: false` means that collection was not read. Pass an empty array with it. Do not pass an empty array with `coverage.board: true` unless the board was actually listed.

Pass `capturedAtMs` from the adapter clock and a staleness window the owner chose. Do not leave `stalenessAfterMs` null and then describe the result as live.

The questions the future manager may ask are `PORTFOLIO_QUESTION_CONTRACTS`. Unknown stays unknown. The manager quotes `explanation`, `reasons`, and `note`. It does not fill a dashboard with a placeholder number.

## Out of scope here

UI, HTTP, migrations, model calls, a global queue, account switching, and any write to a project, task, batch, or profile.
