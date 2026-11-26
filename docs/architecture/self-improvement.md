# Self-improvement

FO-SELF-IMPROVE01 adds a local engine that turns repeated, verified execution evidence into a versioned instruction or skill, evaluates that text against frozen fixtures, and injects an approved version into later eligible launches.

Instruction changes are not model training. They do not change weights, provider quotas, or Owner permissions.

## What can change

The engine versions these targets:

- specialist role instructions
- system and task prompt templates
- reusable skills
- project implementation guidelines
- coding and debugging procedures
- testing and review checklists
- task decomposition strategies
- error handling and recovery procedures
- context selection and retrieval strategies
- non-security workflow configuration
- reusable research and implementation techniques

A project-scoped version applies only to that project path and role. A global row is visible to every project for that role, and a project row for the same artifact replaces it. Another project's row is never selected.

The engine refuses text that asks for broader permissions, autonomy or security changes, credential handling, disabled QC or evidence checks, prompt injection, another project's path, shell commands, provider-limit bypass, or protected system instructions. Cursor and DeepSeek stay ineligible as evaluation resources.

## Lifecycle

`observed → proposed → evaluating → evaluated → approved → active → monitoring → retained` or `rolled_back`.

`blocked`, `rejected`, and `expired` are terminal. Each candidate stores its id, role, scope, current and proposed versions, diff, evidence, hypothesis, expected result, the fixed evaluation plan, risk, authorization, metrics, decision, and transition history.

Version rows are insert-only. The first use of the engine installs a SQLite trigger that aborts updates. Activation points at a version. Rollback marks that activation `rolled_back` and restores the last known good version. Evaluation rows are kept.

## Discovery and evaluation

Discovery reads verified production observations and repeated QC reviews (`CHANGES_REQUESTED` or `BLOCKED`). Synthetic rows and evaluation rows are ignored. No observations means no candidate. The built-in preparer is a deterministic draft for the repeated validation-step pattern. It remains the offline fallback.

A provider-backed draft uses the existing specialist harness. The fake driver is labeled `synthetic-driver` and `inferenceCompleted: false`. A production driver is not started unless `AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE=1`. Without that flag the deterministic preparer runs and no provider request is sent. Cursor and DeepSeek are refused before any spawn. Generated skill text still passes the existing validator. It cannot grant permissions or change policy.

Evaluation has two paths. The original path scores frozen text fixtures. FO-AUTO-PRACTICAL01 adds a harness path: version A is the current instruction, version B is the proposal, the task text and files are frozen, and both sides use the same model and harness. Each side writes only inside `dataDir/improvement-evals/`, which is kept outside the Owner project. The authorized test is the same Seatbelt `bun test`. A changed frozen file is a security violation. One fixture, no measurable difference, a provider error, a resource problem, a refused real run, or a model change is `inconclusive`. A model change is attributed to model quality, not to the instruction. Quota and cost stay `Unknown`. Router quality tiers are not rewritten. A synthetic comparison is not a provider pass.

A fixture pass cannot activate a global or role-wide version. Automatic activation is project-scoped and low-risk only.

## Runtime

`startTask` freezes the active versions for the task's project and role, wraps them into the launch prompt, and stores the version list on the run. An empty selection leaves the prompt unchanged. Reviewer runs use the `reviewer` role, so a developer skill is not injected into QC. The stored task prompt is not rewritten, and a running agent is not updated. The next launch after rollback resolves the restored version. Rollback updates the instruction snapshot and the activation row. It does not edit files in the Owner project. A later launch may write a different result because it no longer receives the rolled-back text. The FO-AUTO-PRACTICAL01 fixture checks that `return a + b` is still on disk at the moment of rollback, and that `return a - b` appears only after the following fake-driver launch. Evaluation workspaces stay under `dataDir/improvement-evals/` and are refused when they are not disjoint from the project.

## Authorization

The engine is off until the Owner enables it. Head may run the loop only when an active autonomy policy sets `selfImprovement.enabled`. Supervised mode can observe, prepare, and evaluate; activation waits for the Owner. Autonomous and Full Autonomy modes may activate a low-risk project revision only when the policy also sets `lowRiskActivation`. Enabling either flag on an active policy is an expansion and requires a new Owner activation.

Hard limits cover candidates per day, evaluations per candidate, activation attempts, nested depth, concurrent experiments, rework, and duration. A failed evaluation does not create another improvement. An interrupted evaluation is closed as inconclusive on restart and is not run again.

The engine cannot edit the autonomy policy, sandbox, credential store, or these limits above their hard caps.

## Brain, journal, and router

Verified QC patterns and measured evaluation results are stored as Brain extraction candidates. A generated hypothesis is labeled as a hypothesis and is not marked as an established fact. Activity Journal records propose, evaluate, activate, and roll back. Head answers for the week, the skill change, the error delta, rollbacks, and repeated QC roles are read from those rows.

## Owner UI

Mission Control shows candidates, diffs, evidence, metrics, active versions, regressions, the experiment budget, and pause, stop, approve, reject, activate, and roll back. Copy is English and Russian.

## Direction 18 additions

- **Versions and baseline.** A candidate improves the revision in force for its artifact (the baseline, version 1, when none is active). Version numbers only grow, so a rejected or rolled-back number is never reused.
- **Traceable evaluation.** `improvement_evaluations` records the evaluated baseline and candidate version and hash, the sample size and the execution kind (migration 144). Approval and activation require a finished passing evaluation that used a training and a held-out fixture, that names the candidate's own revisions, whose hashes equal the immutable version rows, and whose baseline is still the revision in force. Rows from before the migration are never accepted as evidence.
- **Spent evidence.** An observation a candidate already cited cannot start another candidate. Candidates name each observation's source (`qc-review`, `practical-test`) and source id.
- **Rollback.** Only a revision that was actually in force is "known good". Rolling back a first activation leaves no instruction text (the prompt equals the pre-activation prompt); rolling back a later one restores the earlier activation unchanged. A kept (`retained`) version can still be rolled back; the Owner keeps a monitored version with `POST /api/self-improvement/candidates/:id/retain`.
- **Permission.** An activation past its expiry grants nothing even before the periodic sweep marks it expired.
- **Wording.** Every result says "Fixture evaluation", its sample size and the revisions compared, labels the execution, and says it is not a measure of model quality.
- **Known limits.** Nothing feeds the monitored-outcome rollback from real runs; no production surface registers fixtures, so the Head's automatic loop cannot reach a pass outside tests.
