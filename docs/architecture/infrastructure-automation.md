# Infrastructure automation (FO-INFRA-AUTO01)

Infrastructure operations sit on the existing cluster registry, Head of PM, autonomy policy, and FO-DEPLOY request store. There is no second orchestrator and no general remote shell.

Mappings come from Owner-configured rows. Product names are not compiled into the application. A cluster may list projects, declared servers, environments, workflow file names, application or shared-infrastructure roles, and a dependency on another registered project path.

## Git

`src/bun/infra-auto/git.ts` runs a fixed `git` argument list. The caller cannot supply a shell command. Every invocation sets an empty `core.hooksPath`, an empty `credential.helper`, and `GIT_TERMINAL_PROMPT=0`.

Inspection is allowed on a registered project directory without a deployment grant. It reports the current branch, `HEAD` SHA, upstream, ahead/behind counts, changed files, unmerged paths, the last eight commits, a diff stat, whether a remote exists, and whether a non-forced push would be the next authorized step. Fetch and push are the only mutations. Push uses `remote branch:branch` and rejects a leading dash, `..`, and `--force`. There is no reset and no branch deletion. The configured source branch is checked; ForgeOrbit does not check out a branch for the project.

An unregistered directory is refused before Git runs. A missing path is refused as not a directory.

## CI

Workflow discovery reads file names under `.github/workflows`. It does not return file contents. Recorded runs store the workflow file, SHA, status, conclusion, failed job names, and a redacted log excerpt. A missing record is not a pass.

Live GitHub observation is optional and off unless a `LiveCiPort` is injected. The default reports zero new records and an error. It does not invent a run. `GitHubWorkflowRun` carries `headSha` when the API field is 40 hex characters. Dispatch of a `github-actions` adapter is refused. An agent-supplied workflow name is not authorization. No ForgeOrbit workflow file is created or edited.

## Deployment plans

A plan freezes the cluster, project, environment (`development`, `staging`, `production`, or a labeled `custom`), repository path, branch, 40-character SHA, adapter, dependency list, expected services, health configuration, required checks, rollback note, and digest. Later commits and binding edits do not rewrite that row.

States shown to the Owner are `simulated`, `configuration-verified`, `execution-authorized`, `dispatched`, `running`, `failed`, `succeeded`, `blocked`, `unknown`, and `cancelled`.

CI success moves an otherwise valid plan to `configuration-verified`. It does not dispatch. A failed required check leaves the plan `blocked`.

The only adapter that can be dispatched is `fake`, and only after a synthetic grant. A passing simulated health check records state `simulated` and provenance `fake-adapter`. A failing simulated check records `failed`. An HTTP-only health configuration records `unknown` because an HTTP response is not application health. No configured check records `blocked`. A deferred fake run that passes the 60-second observation budget becomes `unknown`, not success. One attempt row exists per plan. Consuming the grant and inserting the attempt share one SQLite transaction.

A dependency on another project stays blocked until that project's latest attempt is `simulated` or `succeeded` and its health is `passed`. Starting a command is not completion. `infra_task_gates` tells the existing mission scheduler to hold a task until that upstream record exists. The orchestration dependency check constraint is unchanged.

Cancellation closes new prepares and dispatches. Restart reads the same plan and attempt rows.

## Authorization

`TRUSTED_OWNER_CHANNEL.available` is false. See the FO-INFRA-AUTO01 addendum in [FO-DEPLOY04](../FO-DEPLOY04-trusted-owner-authorization.md). The packaged Owner UI reads this same channel. A campaign must not invent a native LocalAuthentication grant or present a synthetic grant as trusted Owner authorization.

Synthetic grants are labeled `synthetic`, expire in five minutes, bind the plan digest, project, environment, and SHA, and are single-use. The database check allows only that channel. Actors `agent` and `head` cannot mint a grant or change a binding. The loopback bearer token is required for the HTTP API and is not Owner intent.

Production policy can name projects, environments, branches, required checks, staging evidence, an adapter, a window, and a concurrency cap. `executionAuthorized` is always false. Preparing a production plan adds the capability blocker. Authorizing or dispatching production returns `production-denied`. Full Autonomy cannot list `production_deploy`.

When a real adapter cannot run, `manualHandoff` returns schema `forgeorbit-infra-review-v1` with `executionAuthorized: false` and no commands.

## Head and Mission Control

`tryAnswerInfraQuestion` answers registered infrastructure questions from these rows before model inference. An unmatched cluster name is reported as unmatched. Deploy and rollback requests create a pending `infra_proposals` row and do not dispatch.

The infrastructure inventory and Mission Control render `InfraOperationsPanel` from `GET /infra-auto/snapshot`. Pause, cancel, and resume call the control route. English and Russian strings live in `src/mainview/i18n/infra-auto.ts`.

## Autonomy

A Full Autonomy policy may name `git_read`, `git_mutate`, `ci_inspect`, `ci_dispatch`, `staging_deploy`, `deployment_health`, `rollback_prepare`, and `rollback_execute`. Supervised mode allows none of them. Autonomous mode allows the read and inspection set. Git mutation, CI dispatch, staging deployment, and rollback execution also require Full Autonomy, and `independentAuthorizationRequired` still demands a separate grant. That grant is the synthetic fake-adapter grant when the trusted channel is unavailable. It is not permission to call GitHub or a server. An agent cannot add projects or widen environments through this API.
