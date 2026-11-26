import { quotaApplies } from "../../shared/accounts/resolve.ts";
import { isSyntheticEvidenceSource } from "../../shared/usage-analytics.ts";
import { createHash } from "node:crypto";
import { AccountCore } from "../account-core.ts";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { db, projectRules, projects, tasks } from "../db.ts";
import { ownerProjectOf } from "../project-ownership.ts";
import { missionStore } from "../orchestration/mission-store.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { listProjectAccountPreferences, readExecutionMeta } from "../multiaccount/registry.ts";
import { launchFingerprint } from "../../shared/task-scheduling.ts";
import type { Task } from "../../shared/types.ts";
import type { AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";
import type { MissionPlan, MissionTaskPlan } from "../../shared/orchestration/types.ts";
import type { EvaluatorCandidateInput } from "../../shared/router-v2/evaluator.ts";
import type { ForecastSelection, RunCost, TokenUsage } from "../../shared/usage-analytics.ts";
import type { ProviderRefusalSummary } from "../../shared/provider-refusal.ts";
import { scheduleItems } from "../../shared/estimation/schedule.ts";
import { planCapacity, quotaDemand } from "./capacity.ts";
import { completedPreparationSamples } from "../orchestration/mission-preparation.ts";
import { compareAllocations, type AllocationStage } from "../../shared/orchestration/allocation-search.ts";
import { existingWork, projectClusters } from "./occupancy.ts";
import { type ActualRun, quantile, taskActuals, unionMs } from "./actuals.ts";
import { costFor, pricingAt, quotaFor, type ResourceKey } from "./resources.ts";
import { providerName, scopeFor } from "./scope.ts";
import { nativeQaRoot } from "../native-qa-state.ts";
import { deriveConstraints, firstResourceConstraint } from "./constraints.ts";
import { compareAlternative, type AlternativeComparison } from "./portfolio-comparison.ts";

const MINUTE = 60_000;
const MIN_SAMPLES = 3;
export const FORECAST_MAX_TASKS = 100;
const MAX_OPTIONS = 60;
const scenarioKeys = ["optimistic", "expected", "conservative"] as const;
type Range = Record<typeof scenarioKeys[number], number>;
export const FORECAST_METHOD = "forecast-v2";
type Role = "developer" | "reviewer";
const range = (optimistic: number, expected: number, conservative: number): Range => ({ optimistic, expected, conservative });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function addRanges(...parts: Range[]): Range {
  return range(...scenarioKeys.map(k => parts.reduce((sum, part) => sum + part[k], 0)) as [number, number, number]);
}

function medianTokens(samples: ActualRun[]): TokenUsage {
  const median = (key: keyof TokenUsage) => {
    const values = samples.flatMap(s => s.tokens[key] === null ? [] : [s.tokens[key]]);
    return values.length >= MIN_SAMPLES ? quantile(values, .5) : null;
  };
  return { input: median("input"), output: median("output"), cacheRead: median("cacheRead"), cacheWrite: median("cacheWrite") };
}

interface Option extends ResourceKey {
  provider: string;
  label: string;
  accountLabel: string | null;
  mode: string;
  tier: string;
  score: number;
  auth: boolean | null;
  nativeQuota: ReturnType<typeof quotaFor>;
  eligibility?: "eligible" | "blocked" | "preflight";
  eligibilityReason?: string | null;
  quotaPlan?: ReturnType<typeof compareQuotaDemand>[];
  capacity: number | null;
  simulated?: boolean;
  duration: Range;
  samples: number;
  basis: "historical" | "heuristic";
  specialistSamples: number;
  reworkRisk: number | null;
  pricingEffectiveAt: number | null;
  planningEligible: boolean;
  tokens: TokenUsage;
  cost: RunCost;
}

export const optionKey = (o: Pick<Option, "harnessId" | "accountId" | "modelId" | "mode">) =>
  JSON.stringify([o.harnessId, o.accountId, o.modelId, o.mode]);

export interface TaskForecast {
  taskId: string;
  title: string;
  projectPath: string | null;
  category: string;
  technology: string;
  complexity: "low" | "medium" | "high";
  estimateId: number | null;
  methodology?: string;
  rulesRevision?: string;
  stageEvidence?: { developer: number; reviewer: number; test: number; rework: number; wall: number };
  historicalWall?: Range | null;
  historicalMeasuredWait?: Range | null;
  activeDeveloper?: Range;
  remaining?: Range;
  remainingRoles?: Role[];
  remainingTesting?: Range;
  proposedResource?: Option;
  plannedResource?: { harnessId: string; modelId: string | null; accountId: string | null; mode: string | null };
  schedule?: { elapsed: number | null; wait: number | null; completionAt: number | null; blockers: string[] };
  dependsOn: string[];
  worker: Range;
  completion: Range;
  testing: Range;
  rework: Range;
  qc: Range;
  roles: Role[];
  runs: Range;
  confidence: "low" | "medium";
  developer: Option | null;
  reviewer: Option | null;
  developerOptions: Option[];
  reviewerOptions: Option[];
  pinnedUnavailable: boolean;
  reviewerPinnedUnavailable: boolean;
  optionsTruncated: boolean;
  subscriptionUsage: null;
  expectedBudgetMs: number | null;
  workerId: string | null;
  plannedUsage: ReturnType<typeof forecastCost>;
}

function recentComparableRuns(projectPath: string) {
  const taskIds = db.query<{ task_id: string }, [string]>(`
    SELECT r.task_id FROM runs r JOIN tasks t ON t.id = r.task_id
    WHERE t."column" = 'done' AND r.usage_scope IS NOT NULL AND json_extract(r.usage_scope, '$.projectPath') = ?
    GROUP BY r.task_id ORDER BY MAX(r.started_at) DESC LIMIT 80
  `).all(projectPath);
  return taskIds.flatMap(({ task_id }) => {
    const actual = taskActuals(task_id);
    if (!actual || actual.doneAt === null || !actual.runs.length ||
      actual.runs.some(r => r.execution !== "real-provider" || r.durationMs === null)) return [];
    return [actual];
  });
}

type HistoricalTask = ReturnType<typeof recentComparableRuns>[number];

function observedRange(values: number[]): Range | null {
  return values.length >= MIN_SAMPLES ? range(quantile(values, .25)!, quantile(values, .5)!, quantile(values, .85)!) : null;
}

function stageFallback(role: Role, complexity: TaskForecast["complexity"], technology: string): Range {
  const expected = role === "reviewer" ? { low: 6, medium: 12, high: 22 }[complexity]
    : { low: 18, medium: 40, high: 90 }[complexity];
  const multipleStacks = technology.includes(",") ? 1.25 : 1;
  return range(Math.round(expected * multipleStacks * .55) * MINUTE, Math.round(expected * multipleStacks) * MINUTE, Math.round(expected * multipleStacks * 1.9) * MINUTE);
}

function dependencies(taskId: string): string[] {
  return db.query<{ id: string }, [string, string]>(`
    SELECT d.depends_on_id AS id FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
    WHERE d.task_id = ? AND t."column" <> 'done'
    UNION SELECT missing_id FROM task_dependency_tombstones WHERE task_id = ? AND cleared_at IS NULL
    ORDER BY id
  `).all(taskId, taskId).map(r => r.id);
}

function configuredTest(task: Task, force: boolean): Range {
  const explicit = /\b(test(?:s|ing)?|validation|verify|acceptance|bun test|pytest)\b/i.test(task.prompt);
  if (!explicit && !force) return range(0, 3 * MINUTE, 12 * MINUTE);
  return range(2 * MINUTE, 8 * MINUTE, 25 * MINUTE);
}

export function compareQuotaDemand(q: ReturnType<typeof quotaFor>[number], cost: RunCost, now: number, durationMs: number) {
  const o = q.current ?? q.ownerReported;
  const demand = quotaDemand(q, cost);
  const reset = o?.resetAt == null ? "unknown" : o.resetAt <= now ? "elapsed"
    : o.resetAt <= now + durationMs ? "during-if-started-now" : "after-if-started-now";
  const usable = o?.freshness === "fresh" && q.status !== "conflict" && !isSyntheticEvidenceSource(o.source) &&
    reset !== "during-if-started-now" && (o.expiresAt ?? 0) > now + durationMs;
  const fit = usable && o?.remaining != null && demand !== null ? demand > o.remaining ? "exceeds" : "fits" : "unknown";
  return { id: q.id, demand, fit, reset };
}

function stage(
  task: Task, scope: ReturnType<typeof scopeFor>, role: Role, plan: MissionTaskPlan | undefined,
  candidates: EvaluatorCandidateInput[], history: HistoricalTask[], now: number,
  quotas: Map<string, ReturnType<typeof quotaFor>>, preferred: Option | null, policy: AutonomyPolicyBody | null, specialist: string | null,
) {
  const accountPreference = scope.projectPath ? listProjectAccountPreferences(db).find(p => p.projectPath === scope.projectPath && p.role === role) : null;
  const pin = role === "reviewer" && plan?.reviewerBinding ? plan.reviewerBinding : role === "developer"
    ? { harnessId: plan?.harnessId ?? task.agent, modelId: plan?.modelId ?? task.model, mode: plan?.mode ?? task.mode, accountId: plan ? plan.accountId ?? null : accountPreference?.accountId ?? null }
    : { harnessId: plan?.harnessId ?? null, modelId: plan?.modelId ?? null, mode: null, accountId: plan?.accountId ?? accountPreference?.accountId ?? null };
  const result = routerV2Service.evaluateTaskSync({
    taskId: task.id, projectId: scope.projectPath ?? "global", role, complexity: scope.complexity,
    requestedHarnessId: pin.harnessId, requestedModelId: pin.modelId, requestedAccountId: pin.accountId, requestedMode: pin.mode,
  }, { candidates });
  const inputs = new Map(candidates.map(c => [c.id, c]));
  const fallback = stageFallback(role, scope.complexity, scope.technology);
  const options = [...result.eligible, ...result.ineligible].flatMap((candidate): Option[] => {
    const { harnessId, modelId, accountId, mode, accountLabel } = candidate;
    const input = inputs.get(candidate.candidateId)!;
    const binding = explainBinding({ harnessId, accountId, modelId, mode, provider: input.provider });
    const policyBlocked = policy && (policy.mode === "supervised" || !policy.specialistRoles.includes(role) ||
      ![input.kind, input.provider, harnessId].some(provider => policy.providers.includes(provider)) ||
      !policy.models.includes(modelId) || (accountId ? !policy.accounts.includes(accountId) : !policy.allowUnscopedAccount));
    const provider = providerName(input.provider);
    // A completed task contributes at most one successful observation to a
    // resource cohort. An interrupted attempt is never a successful sample.
    const comparable = history.flatMap(actual => {
      const found = actual.runs.find(run => run.status === "succeeded" && run.durationMs !== null && run.durationMs > 0 &&
        run.scope?.complexity === scope.complexity && run.scope?.technology === scope.technology &&
        run.scope?.category === scope.category && run.role === role && run.provider === provider &&
        run.harnessId === harnessId && run.model === modelId && run.accountId === accountId && run.mode === mode &&
        (role !== "reviewer" || actual.reviews.some(q => q.verdict === "PASS" && q.review_run_id === run.id)));
      return found ? [{ run: found, reworked: actual.reworks > 0 }] : [];
    });
    const specialistCohort = specialist ? comparable.filter(sample => sample.run.specialist === specialist) : [];
    const cohort = specialistCohort.length >= MIN_SAMPLES ? specialistCohort : comparable;
    const samples = cohort.map(sample => sample.run);
    const duration = observedRange(samples.map(run => run.durationMs!)) ?? fallback;
    const tokens = medianTokens(samples);
    const price = pricingAt({ harnessId, modelId, accountId }, now + 1);
    const sources = new Set(samples.map(run => run.tokenSource).filter(Boolean));
    const codex = sources.size === 1 && sources.has("codex-turn");
    const claude = sources.size === 1 && sources.has("claude-bounded-result");
    const canPrice = claude && tokens.cacheWrite !== null || codex && (tokens.cacheWrite === 0 ||
      tokens.cacheWrite === null && !price?.terms.cacheWritePerMillion);
    const billableTokens: TokenUsage = canPrice ? {
      ...tokens, input: claude && tokens.input !== null ? tokens.input - tokens.cacheWrite! : tokens.input,
      cacheWrite: codex ? 0 : tokens.cacheWrite,
    } : { input: null, output: null, cacheRead: null, cacheWrite: null };
    const cost = costFor(price, billableTokens, true);
    if (accountId && !quotas.has(accountId)) quotas.set(accountId, quotaFor(accountId, new AccountCore(db, () => now), false, now));
    const nativeQuota = (accountId ? quotas.get(accountId) ?? [] : []).filter(q => quotaApplies(q, harnessId, modelId))
      .map(q => ({ ...q, observations: [], changes: [],
        ownerReported: q.ownerReported ? { ...q.ownerReported, sourceNote: null, evidenceReference: null } : null }));
    const gate = policy?.requireVerifiedQuota && (!accountId || !new AccountCore(db, () => now).hasVerifiedHeadroom(accountId, harnessId, modelId));
    const reasons = candidate.eliminationReasons;
    const planningEligible = binding.ok && !policyBlocked && !gate && reasons.every(reason =>
      reason.startsWith("concurrency-limit-reached:") || reason.startsWith("quota-exhausted:"));
    // FO-DIRECTION13. Inside the guarded packaged QA build (and nowhere else) every driver is a fake one, so the Router marks
    // every candidate Simulated and a read-only comparison could never be driven. There a simulated candidate that passes every
    // other check is shown as eligible FOR THIS CALCULATION. `nativeQaRoot()` is set only by the QA build's own bootstrap from a
    // build-time constant, never from an environment variable, so an installed build always reads it as unset. Nothing here
    // touches the Router's own verdict, a launch, a preference or a stored resource, and the candidate stays labelled Simulated.
    const previewOnly = Boolean(input.simulated && nativeQaRoot());
    const eligibility = !planningEligible || reasons.length || (input.simulated && !previewOnly) ? "blocked"
      : (input.cliLoggedIn === true && input.cliInstalled === true) || previewOnly ? "eligible" : "preflight";
    const eligibilityReason = !binding.ok ? binding.reason : policyBlocked ? "Excluded by the approved autonomy policy."
      : gate ? "Verified quota is required." : reasons[0] ?? (input.simulated ? (previewOnly ? "Simulated harness (QA preview only)." : "Simulated harness.") : null);
    return [{
      harnessId, accountId, modelId, mode, accountLabel, provider, label: input.harnessLabel,
      tier: input.qualityTier, score: candidate.scores.totalScore, auth: input.isolationType === "child-home" || input.isolationType === "config-dir" ? input.cliLoggedIn : null,
      nativeQuota, eligibility, eligibilityReason, planningEligible, simulated: input.simulated, pricingEffectiveAt: price?.createdAt ?? null,
      basis: samples.length >= MIN_SAMPLES ? "historical" : "heuristic", specialistSamples: specialistCohort.length,
      reworkRisk: cohort.length >= MIN_SAMPLES ? cohort.filter(sample => sample.reworked).length / cohort.length : null,
      quotaPlan: nativeQuota.map(q => compareQuotaDemand(q, cost, now, duration.expected)), capacity: input.concurrency.limit, duration, samples: samples.length, tokens, cost,
    }];
  });
  const matches = options.filter(o => o.planningEligible &&
    (!pin.harnessId || o.harnessId === pin.harnessId) &&
    (!pin.modelId || o.modelId === pin.modelId) &&
    (!pin.mode || o.mode === pin.mode) &&
    (plan && role === "developer" ? o.accountId === (plan.accountId ?? null) : !pin.accountId || o.accountId === pin.accountId));
  const selected = (preferred && !pin.accountId
    ? matches.find(o => o.harnessId === preferred.harnessId && o.accountId === preferred.accountId) : null) ?? matches[0] ?? null;
  const visible = options.slice().sort((a, b) => Number(b.planningEligible) - Number(a.planningEligible)).slice(0, MAX_OPTIONS);
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
  return { selected, visible, fallback, unavailable: !selected, truncated: options.length > MAX_OPTIONS };
}

function makeEstimate(
  task: Task, plan: MissionTaskPlan | undefined, candidates: Record<Role, EvaluatorCandidateInput[]>,
  history: Map<string, HistoricalTask[]>, quotas: Map<string, ReturnType<typeof quotaFor>>, now: number,
  policy: AutonomyPolicyBody | null, alternative?: ForecastSelection["alternative"],
): TaskForecast {
  const projectPath = ownerProjectOf(task.workdir);
  const scope = scopeFor(db, task, projectPath);
  if (projectPath && !history.has(projectPath)) history.set(projectPath, recentComparableRuns(projectPath));
  const samples = projectPath ? history.get(projectPath) ?? [] : [];
  const assignment = db.query<{ employee_id: string }, [string]>(
    "SELECT employee_id FROM employee_task_assignments WHERE task_id = ? AND status = 'active'",
  ).get(task.id);
  const workerId = plan?.assignedEmployeeId ?? assignment?.employee_id ?? null;
  const dev = stage(task, scope, "developer", plan, candidates.developer, samples, now, quotas, null, policy, workerId);
  const proposed = alternative && dev.visible.find(option => optionKey(option) === alternative.optionKey && option.eligibility === "eligible");
  if (alternative && !proposed) throw new Error("The exact alternative is currently unavailable.");
  const chosen = proposed || dev.selected;
  const requiresQc = plan?.qcRequired ?? true;
  const reviewPlan = plan && proposed ? { ...plan, harnessId: proposed.harnessId, modelId: proposed.modelId,
    accountId: proposed.accountId ?? undefined, mode: proposed.mode } : plan;
  const qc = requiresQc ? stage(task, scope, "reviewer", reviewPlan, candidates.reviewer, samples, now, quotas, chosen, policy, null) : null;
  const developer = chosen?.duration ?? dev.fallback;
  const review = qc ? qc.selected?.duration ?? qc.fallback : range(0, 0, 0);
  const cohort = samples.filter(actual => {
    const same = (r: ActualRun, option: Option | null) => !!option && r.harnessId === option.harnessId &&
      r.model === option.modelId && r.accountId === option.accountId && r.mode === option.mode;
    const development = actual.runs.find(r => r.role === "developer");
    const reviewed = actual.runs.filter(r => r.role === "reviewer");
    return development?.scope?.complexity === scope.complexity && development.scope.category === scope.category &&
      development.scope.technology === scope.technology && same(development, chosen) &&
      (requiresQc ? reviewed.length > 0 && reviewed.every(r => same(r, qc?.selected ?? null)) : !reviewed.length);
  });
  const testTimes = cohort.flatMap(actual => actual.testMs === null ? [] : [actual.testMs]);
  const reworkTimes = cohort.map(actual => actual.reworkMs ?? 0);
  const wallTimes = cohort.flatMap(actual => actual.activeWallMs === null ? [] : [actual.activeWallMs]);
  const measuredWaits = cohort.flatMap(actual => actual.waiting.measuredMs > 0 ? [actual.waiting.measuredMs] : []);
  const rules = projectPath ? projectRules.list(projectPath) : [];
  const requiresTest = policy?.qc.requireObservedTest === true || rules.some(rule => rule.enabled &&
    /\b(test|testing|validation|verify|acceptance)\b/i.test(rule.body));
  const separateTests = requiresQc && policy?.mode === "full-autonomy" &&
    (policy.qc.requireObservedTest || policy.completion.conditions.includes("observed_test")) &&
    policy.permittedActions.includes("run_observed_test") &&
    policy.authorizedTests?.filter(grant => grant.projectPath === projectPath && (!grant.taskId || grant.taskId === task.id)).length === 1;
  const testing = observedRange(testTimes) ?? (separateTests ? configuredTest(task, requiresTest) : range(0, 0, 0));
  const allowRework = !policy || policy.maxReworkAttempts > (plan?.reworkEpoch ?? 0) && policy.permittedActions.includes("request_rework");
  const rework = allowRework ? observedRange(reworkTimes) ??
    range(0, Math.round(developer.expected * .25 + review.expected * .25), developer.expected + review.expected) : range(0, 0, 0);
  const worker = addRanges(developer, review, rework);
  const roles: Role[] = requiresQc ? ["developer", "reviewer"] : ["developer"];
  const runs = !allowRework ? range(roles.length, roles.length, roles.length)
    : observedRange(cohort.map(actual => actual.runs.length)) ?? (requiresQc ? range(2, 2.5, 4) : range(1, 1.25, 2));
  const plannedUsage = forecastCost([{ roles, runs, developer: chosen, reviewer: qc?.selected ?? null }]);
  const hasImplementation = plan && (plan.phase === "awaiting_qc" || plan.phase === "qc_running" ||
    task.column === "review" && !!plan.runId && db.query(
      "SELECT 1 FROM runs WHERE id = ? AND task_id = ? AND status = 'succeeded' AND qc_review_id IS NULL",
    ).get(plan.runId, task.id));
  const remainingRoles = hasImplementation ? roles.filter(role => role !== "developer") : roles;
  const observedTest = hasImplementation && db.query(
    "SELECT 1 FROM practical_test_attempts WHERE task_id = ? AND rework_epoch = ? AND status = 'passed'",
  ).get(task.id, plan.reworkEpoch ?? 0);
  const remainingTesting = observedTest || plan?.phase === "qc_running" ? range(0, 0, 0) : testing;
  const completion = addRanges(worker, testing);
  const remaining = remainingRoles === roles ? completion : addRanges(review, remainingTesting, rework);
  const preference = projectPath && listProjectAccountPreferences(db).find(p => p.projectPath === projectPath && p.role === "developer");
  return {
    taskId: task.id, title: task.title, projectPath, category: scope.category,
    technology: scope.technology, complexity: scope.complexity, estimateId: null, dependsOn: dependencies(task.id),
    methodology: FORECAST_METHOD, rulesRevision: hash(rules), stageEvidence: {
      developer: chosen?.samples ?? 0, reviewer: qc?.selected?.samples ?? 0,
      test: testTimes.length, rework: reworkTimes.length, wall: wallTimes.length,
    },
    historicalWall: observedRange(wallTimes), historicalMeasuredWait: observedRange(measuredWaits), activeDeveloper: developer, remaining, remainingRoles, remainingTesting,
    proposedResource: proposed || undefined,
    plannedResource: { harnessId: plan?.harnessId ?? task.agent, modelId: plan?.modelId ?? task.model,
      accountId: plan ? plan.accountId ?? null : preference ? preference.accountId : dev.selected?.accountId ?? null,
      mode: plan?.mode ?? task.mode },
    worker, completion, qc: review, testing, rework,
    roles, runs, plannedUsage,
    confidence: (chosen?.samples ?? 0) >= MIN_SAMPLES && (!qc || (qc.selected?.samples ?? 0) >= MIN_SAMPLES) ? "medium" : "low",
    developer: chosen, reviewer: qc?.selected ?? null,
    developerOptions: dev.visible, reviewerOptions: qc?.visible ?? [],
    pinnedUnavailable: dev.unavailable && !proposed, reviewerPinnedUnavailable: qc?.unavailable ?? false,
    optionsTruncated: dev.truncated || (qc?.truncated ?? false),
    subscriptionUsage: null, expectedBudgetMs: policy?.expectedDurationMs ?? null, workerId,
  };
}

export function originalEstimate(taskId: string): TaskForecast | null {
  const first = db.query<{ id: number }, [string]>(
    "SELECT id FROM usage_task_estimates WHERE task_id = ? ORDER BY id LIMIT 1",
  ).get(taskId);
  return frozenEstimate(first?.id ?? null);
}

/**
 * Supervised Start: make sure an estimate describing the launch the Owner just
 * approved is saved before the first run exists, so the existing run trigger
 * freezes it as the baseline. Reuses `forecast` + `saveTaskEstimate`; an
 * unchanged estimate keeps its revision. Only an unstarted Backlog task is
 * saved (Backlog, Inbox or Ready; a started task is never given a baseline afterwards, and older tasks
 * are not back-filled). Best effort: a failure never blocks or alters a launch.
 */
export function ensureBaselineEstimate(taskId: string, now = Date.now()): number | null {
  try {
    const task = tasks.get(taskId);
    if (!task || !["backlog", "inbox", "ready"].includes(task.column)) return null;
    if (db.query("SELECT 1 FROM runs WHERE task_id = ? LIMIT 1").get(taskId)) return null;
    return forecast({ taskIds: [taskId], save: true, freezeBaseline: true }, now).estimates[0]?.estimateId ?? null;
  } catch {
    return null;
  }
}

export function estimateVersions(taskId: string) {
  return db.query<{ id: number; created_at: number; snapshot: string; superseded: number }, [string]>(
    "SELECT id,created_at,snapshot,superseded FROM usage_task_estimates WHERE task_id = ? ORDER BY id DESC LIMIT 20",
  ).all(taskId).map(row => ({
    id: row.id, at: row.created_at, stale: row.superseded === 1,
    estimate: { ...(JSON.parse(row.snapshot) as TaskForecast), estimateId: row.id },
  }));
}

export function frozenEstimate(id: number | null): TaskForecast | null {
  if (id === null) return null;
  const row = db.query<{ snapshot: string }, [number]>("SELECT snapshot FROM usage_task_estimates WHERE id = ?").get(id);
  return row ? { ...JSON.parse(row.snapshot) as TaskForecast, estimateId: id } : null;
}

function saveTaskEstimate(task: Task, estimate: TaskForecast, now: number, missionId: string | null) {
  const fingerprint = hash([FORECAST_METHOD, launchFingerprint(task), { ...estimate, schedule: undefined }]);
  const previous = db.query<{ id: number; fingerprint: string; superseded: number }, [string, string | null]>(
    "SELECT id,fingerprint,superseded FROM usage_task_estimates WHERE task_id = ? AND mission_id IS ? ORDER BY id DESC LIMIT 1",
  ).get(task.id, missionId);
  if (previous?.fingerprint === fingerprint && previous.superseded === 0) return previous.id;
  db.run("UPDATE usage_task_estimates SET superseded = 1 WHERE task_id = ? AND mission_id IS ? AND superseded = 0", [task.id, missionId]);
  const id = Number(db.run(
    "INSERT INTO usage_task_estimates(task_id,fingerprint,snapshot,created_at,mission_id) VALUES (?,?,?,?,?)",
    [task.id, fingerprint, JSON.stringify(estimate), now, missionId],
  ).lastInsertRowid);
  new ActivityJournalCore(db).record({
    eventType: "usage.estimate.saved", actorType: "owner", actorId: "owner",
    targetType: "task", targetId: task.id, taskId: task.id, projectPath: estimate.projectPath,
    idempotencyKey: `usage-estimate:${id}`, payload: { revision: id, confidence: estimate.confidence },
  });
  return id;
}

export function forecastBase(selection: ForecastSelection, now = Date.now(), planPreview?: MissionPlan) {
  const mission = selection.missionId ? missionStore.getMission(selection.missionId) : null;
  if (selection.missionId && (!mission || !mission.authorization || mission.authorization.digest !== mission.planDigest)) {
    throw new Error("Select an approved mission.");
  }
  if (mission && planPreview) {
    mission.plan = planPreview;
    mission.concurrencyLimits = planPreview.concurrencyLimits;
  }
  const projectPaths = new Set([...(selection.projectPaths ?? []), ...(selection.projectPath ? [selection.projectPath] : [])]);
  if ([...projectPaths].some(path => !projects.get(path))) throw new Error("Project was not found.");
  const memberPaths = selection.clusterId ? new Set(db.query<{ project_path: string }, [string]>(
    "SELECT project_path FROM cluster_project_memberships WHERE cluster_id = ?",
  ).all(selection.clusterId).map(r => r.project_path)) : null;
  if (selection.alternative && selection.save) {
    throw new Error("An alternative is a read-only scenario.");
  }
  const allWork = existingWork();
  const pendingPlans = mission?.plan.tasks.filter(t => t.phase !== "completed") ?? [];
  if (pendingPlans.length > FORECAST_MAX_TASKS) throw new Error("Choose at most 100 tasks per forecast.");
  const planById = new Map(pendingPlans.map(t => [t.taskId, t]));
  const ids = mission ? [...planById.keys()] : selection.taskIds;
  const inputTasks = ids ? [...new Set(ids)].map(id => tasks.get(id)).filter(t => t !== null) : tasks.list();
  const selected = inputTasks.filter(task => {
    if (task.archivedAt != null || task.pipelineId || task.pipelineParentId) return false;
    const unstarted = selection.freezeBaseline && ["backlog", "inbox", "ready"].includes(task.column);
    if (!unstarted && (mission ? task.column === "done" : selection.taskIds || !projectPaths.size && !memberPaths
      ? task.column !== "backlog" : task.column === "done")) return false;
    if (!projectPaths.size && !memberPaths) return true;
    const projectPath = ownerProjectOf(task.workdir);
    return (!projectPaths.size || projectPath !== null && projectPaths.has(projectPath)) &&
      (!memberPaths || (projectPath !== null && memberPaths.has(projectPath)));
  });
  if (selection.alternative && !selected.some(task => task.id === selection.alternative!.taskId &&
    (task.column === "backlog" || mission && ["planned", "authorized", "blocked"].includes(planById.get(task.id)?.phase ?? "")) &&
    !allWork.some(work => work.taskId === task.id) && !db.query("SELECT 1 FROM runs WHERE task_id = ? LIMIT 1").get(task.id))) throw new Error("Choose an alternative for a selected, unstarted task.");
  if (selected.length > FORECAST_MAX_TASKS) throw new Error("Choose at most 100 tasks per forecast.");
  const omitted = ids ? new Set(ids).size - selected.length : 0;
  const policy = mission && db.query<{ body_json: string }, [string]>(`
    SELECT p.body_json FROM autonomy_policies p JOIN autonomy_mission_bindings b ON b.policy_id = p.id
    WHERE b.mission_id = ? AND b.revision = p.revision AND p.status = 'active'
  `).get(mission.id);
  const body = policy ? JSON.parse(policy.body_json) as AutonomyPolicyBody : null;
  const candidates = {
    developer: routerV2Service.gatherCandidatesSync("developer"),
    reviewer: routerV2Service.gatherCandidatesSync("reviewer"),
  };
  const history = new Map<string, HistoricalTask[]>();
  const quotas = new Map<string, ReturnType<typeof quotaFor>>();
  const estimates = selected.map(task => makeEstimate(task, planById.get(task.id), candidates, history, quotas, now,
    body, selection.alternative?.taskId === task.id ? selection.alternative : undefined));
  const missionDependencies = mission ? missionStore.listMissionDependencies(mission.id) : [];
  const completedMissionTasks = new Set(mission?.plan.tasks.filter(t => t.phase === "completed").map(t => t.taskId));
  const ownerGates = new Set<string>();
  for (const estimate of estimates) {
    for (const dep of missionDependencies) {
      if (dep.taskId !== estimate.taskId || dep.satisfiedAt != null || completedMissionTasks.has(dep.dependsOnTaskId)) continue;
      if (dep.condition === "awaiting_owner") ownerGates.add(dep.dependsOnTaskId);
      if (!estimate.dependsOn.includes(dep.dependsOnTaskId)) estimate.dependsOn.push(dep.dependsOnTaskId);
    }
    estimate.dependsOn.sort();
  }
  const selectedIds = estimates.map(e => e.taskId);
  const pending = new Set(selectedIds);
  const outsideDependencies = [...new Set(estimates.flatMap(e => e.dependsOn.filter(id => !pending.has(id))))];
  const requestedConcurrency = selection.concurrency ?? 1;
  const limits = mission?.concurrencyLimits ?? { globalMax: requestedConcurrency, perProjectMax: requestedConcurrency, perAccountMax: 1 };
  const cap = Math.min(limits.globalMax, body?.maxConcurrentWorkers ?? Infinity);
  const keysByItem = new Map<string, string[]>();
  const slots = new Map<string, number>();
  const addSlot = (keys: Set<string>, key: string, limit: number) => {
    keys.add(key);
    slots.set(key, Math.min(limit, slots.get(key) ?? Infinity));
  };
  const sharedLimits = new Map<string, number>();
  for (const account of new AccountCore(db, () => now).listAccounts()) {
    const limit = readExecutionMeta(db, account.id).providerSharedLimit;
    if (limit === null) continue;
    const provider = providerName(account.provider);
    sharedLimits.set(provider, Math.min(limit, sharedLimits.get(provider) ?? Infinity));
  }
  const clustersByProject = new Map([...new Set(estimates.flatMap(e => e.projectPath ? [e.projectPath] : []))]
    .map(path => [path, projectClusters(path)]));
  type StageKind = Role | "preparation" | "testing" | "rework" | "retesting" | "final-review" | "completion";
  const stageId = (taskId: string, kind: StageKind) => JSON.stringify([taskId, kind]);
  const prepSamplesByProject = new Map<string, number[]>();
  const operations = estimates.flatMap(estimate => {
    const taskId = estimate.taskId;
    const remainingRoles = estimate.remainingRoles ?? estimate.roles;
    const operations: { id: string; taskId: string; kind: StageKind; role: Role | null; duration: Range; conditional: boolean; durationKnown: boolean }[] = [];
    const add = (kind: StageKind, role: Role | null, duration: Range, conditional = false, durationKnown = true) => {
      const id = stageId(taskId, kind);
      const keys = new Set<string>();
      if (kind !== "completion" && kind !== "preparation") {
        addSlot(keys, "project/" + (estimate.projectPath ?? "unknown"), limits.perProjectMax);
        if (limits.perClusterMax !== undefined && estimate.projectPath) {
          for (const clusterId of clustersByProject.get(estimate.projectPath) ?? []) addSlot(keys, "cluster/" + clusterId, limits.perClusterMax);
        }
      }
      const resource = role ? estimate[role] : null;
      if (resource?.accountId) {
        addSlot(keys, "account/" + resource.accountId, Math.min(limits.perAccountMax, resource.capacity ?? Infinity));
        const shared = sharedLimits.get(resource.provider);
        if (shared !== undefined) addSlot(keys, "provider/" + resource.provider, shared);
      } else if (role) addSlot(keys, "unknown-account", 1);
      if (role === "developer" && estimate.workerId) addSlot(keys, "specialist/" + estimate.workerId, 1);
      if (kind === "testing" || kind === "retesting") addSlot(keys, "local-testing", 1);
      keysByItem.set(id, [...keys]);
      operations.push({ id, taskId, kind, role, duration, conditional, durationKnown });
    };
    if (remainingRoles.includes("developer")) {
      let samples: number[] = [];
      if (estimate.projectPath) {
        let cached = prepSamplesByProject.get(estimate.projectPath);
        if (!cached) {
          cached = completedPreparationSamples(estimate.projectPath);
          prepSamplesByProject.set(estimate.projectPath, cached);
        }
        samples = cached;
      }
      const known = samples.length > 0;
      const measured = samples.length >= 3 ? observedRange(samples)! : known ? range(samples[0]!, samples[Math.floor(samples.length / 2)]!, samples.at(-1)!) : range(0, 0, 0);
      add("preparation", null, measured, false, known);
      add("developer", "developer", estimate.activeDeveloper!);
    }
    const testing = estimate.remainingTesting ?? estimate.testing;
    if (testing.conservative > 0) add("testing", null, testing);
    if (remainingRoles.includes("reviewer")) add("reviewer", "reviewer", estimate.qc);
    if (estimate.rework.conservative > 0) {
      const shares = scenarioKeys.map(k => {
        const total = estimate.activeDeveloper![k] + estimate.qc[k] + estimate.testing[k];
        const dev = total ? Math.round(estimate.rework[k] * estimate.activeDeveloper![k] / total) : estimate.rework[k];
        const test = total && estimate.roles.includes("reviewer") ? Math.min(estimate.rework[k] - dev, Math.round(estimate.rework[k] * estimate.testing[k] / total)) : 0;
        return estimate.roles.includes("reviewer") ? { dev, test, qc: estimate.rework[k] - dev - test } : { dev: estimate.rework[k], test: 0, qc: 0 };
      });
      const portion = (key: "dev" | "test" | "qc") => range(shares[0]![key], shares[1]![key], shares[2]![key]);
      add("rework", "developer", portion("dev"), true);
      if (estimate.testing.conservative > 0) add("retesting", null, portion("test"), true);
      if (estimate.roles.includes("reviewer")) add("final-review", "reviewer", portion("qc"), true);
    }
    add("completion", null, range(0, 0, 0));
    return operations;
  });
  const operationIds = operations.map(op => op.id);
  const edges = new Map<string, string[]>();
  const firstStage = new Map<string, string>();
  const lastStage = new Map<string, string>();
  const estimatesById = new Map(estimates.map(e => [e.taskId, e]));
  for (const op of operations) {
    const prior = lastStage.get(op.taskId);
    if (!prior) firstStage.set(op.taskId, op.id);
    lastStage.set(op.taskId, op.id);
    edges.set(op.id, prior ? [prior] : estimatesById.get(op.taskId)!.dependsOn
      .filter(id => pending.has(id)).map(id => stageId(id, "completion")));
  }
  const assumptions = selection.assumptions;
  const competing = allWork.filter(work => !pending.has(work.taskId));
  const busyQuota = competing.flatMap(work => {
    if (!work.accountId) return [];
    if (!quotas.has(work.accountId)) quotas.set(work.accountId, quotaFor(work.accountId, new AccountCore(db, () => now), false, now));
    return (quotas.get(work.accountId) ?? []).filter(q => !work.modelId || quotaApplies(q, work.harnessId, work.modelId));
  });
  const strict = body?.requireVerifiedQuota === true ||
    estimates.some(e => routerV2Service.getPolicy(e.projectPath ?? "global").quotaPolicy === "strict");
  const stages = operations.flatMap(op => {
    if (!op.role || !op.duration.expected) return [];
    const estimate = estimatesById.get(op.taskId)!;
    const resource = estimate[op.role];
    return [{
      stageId: op.id, taskId: op.taskId, role: op.role, quotas: resource?.nativeQuota ?? [],
      cost: resource?.cost ?? { kind: "unknown" as const, money: null, pricingId: null, source: null },
      runs: op.conditional ? Math.max(0, estimate.runs.expected / estimate.roles.length - 1) : 1,
    }];
  }).filter(stage => stage.runs > 0);
  const capacity = planCapacity(stages, busyQuota, now, assumptions, strict);
  const releases = new Map<string, number>();
  for (const pool of capacity.rows) {
    if (pool.allocations.length) {
      for (const allocation of pool.allocations) releases.set(allocation.stageId,
        Math.max(releases.get(allocation.stageId) ?? 0, allocation.startsAt - now));
      continue;
    }
    if (pool.status !== "reset-assumed" || pool.resetAt === null) continue;
    for (const id of pool.stageIds) releases.set(id, Math.max(releases.get(id) ?? 0, pool.resetAt - now));
  }
  const selectedActive = allWork.filter(work => pending.has(work.taskId));
  const occupiedUntil = allWork.map(work => ({ keys: work.keys, endMs: assumptions?.activeReleaseMs ?? Infinity }));
  const blockers = new Set<string>();
  if (mission && !["running", "authorized", "completed"].includes(mission.status)) blockers.add("mission-hold");
  if (body?.mode === "supervised" || body?.spending.requireEnforceableCap) blockers.add("policy-hold");
  if (outsideDependencies.length || omitted) blockers.add("dependencies");
  if (ownerGates.size || mission && selection.alternative ||
    body && !body.completion.autoComplete && estimates.some(estimate => (estimate.remainingRoles ?? estimate.roles).includes("reviewer"))) {
    blockers.add("owner-action");
  }
  if (estimates.length && (!mission || mission.status === "authorized") && !assumptions?.startAuthorized) blockers.add("start-approval");
  for (const estimate of estimates) {
    const state = estimate.projectPath && projects.getLifecycleRaw(estimate.projectPath)?.lifecycleState;
    if (state && state !== "running") blockers.add("project-hold");
    const phase = planById.get(estimate.taskId)?.phase;
    if (phase === "awaiting_owner") blockers.add("owner-action");
    if (phase && ["blocked", "failed", "cancelled"].includes(phase)) blockers.add("task-hold");
    const selectedTask = selected.find(t => t.id === estimate.taskId)!;
    if (!mission && selectedTask.column !== "backlog") blockers.add("owner-action");
    if ((estimate.remainingRoles ?? estimate.roles).some(role => !estimate[role]?.planningEligible)) blockers.add("resource-unavailable");
    if ((estimate.remainingRoles ?? estimate.roles).some(role => estimate[role]?.eligibility === "preflight" || estimate[role]?.simulated)) blockers.add("preflight");
  }
  if (selectedActive.length) blockers.add("active-task");
  if (selectedActive.length && assumptions?.activeReleaseMs !== undefined) {
    for (const work of selectedActive) {
      const id = firstStage.get(work.taskId)!;
      releases.set(id, Math.max(releases.get(id) ?? 0, assumptions.activeReleaseMs));
    }
  }
  if (capacity.rows.some(pool => pool.blocker) || capacity.uncoveredStages > 0 && (strict || !assumptions?.unknownCapacity)) blockers.add("capacity");
  const schedule = (constrained: boolean) => scenarioKeys.map(k => scheduleItems(
    operationIds, new Map(operations.map(op => [op.id, op.duration[k]])), edges, cap,
    { keysByItem, limits: slots, ...(constrained ? { occupiedUntil, releaseMs: releases } : {}) },
  ));
  const base = schedule(false);
  const constrained = schedule(true);
  const operationsById = new Map(operations.map(op => [op.id, op]));
  const toRange = (schedules: typeof base) => schedules.every(s => s.scheduleMs !== null)
    ? range(schedules[0]!.scheduleMs!, schedules[1]!.scheduleMs!, schedules[2]!.scheduleMs!) : null;
  const elapsed = toRange(constrained);
  if (!elapsed && competing.length) blockers.add("active-work");
  if (base[1]!.cycles.length) blockers.add("cycle");
  const conservativeStages = new Map(constrained[2]!.intervals?.map(interval => [interval.id, interval.endMs]));
  if (elapsed && capacity.rows.some(pool => pool.status === "fits" && pool.expiresAt !== null &&
    pool.stageIds.some(id => pool.expiresAt! <= now + (conservativeStages.get(id) ?? 0))) &&
    (strict || !assumptions?.unknownCapacity)) blockers.add("capacity-horizon");
  if (elapsed && capacity.rows.some(pool => pool.allocations.some(window =>
    now + (conservativeStages.get(window.stageId) ?? 0) > window.endsAt))) blockers.add("capacity-horizon");
  if (elapsed && body && (now + elapsed.conservative > body.expiresAt || elapsed.conservative > body.maxDurationMs)) blockers.add("policy-window");
  const baseline = toRange(base);
  const resourceWait = elapsed && baseline ? range(
    Math.max(0, elapsed.optimistic - baseline.optimistic), Math.max(0, elapsed.expected - baseline.expected),
    Math.max(0, elapsed.conservative - baseline.conservative),
  ) : null;
  const completionWindow = estimates.length && !blockers.size && elapsed ?
    range(now + elapsed.optimistic, now + elapsed.expected, now + elapsed.conservative) : null;
  const cost = forecastCost(stages.map(stage => {
    const estimate = estimatesById.get(stage.taskId)!;
    return { roles: [stage.role], runs: range(stage.runs, stage.runs, stage.runs), developer: estimate.developer, reviewer: estimate.reviewer };
  }));
  const snapshot = {
    calendar: outsideDependencies.length || ownerGates.size || omitted ? null : baseline,
    elapsed, resourceWait, ownerWaiting: ownerGates.size || blockers.has("owner-action") || blockers.has("start-approval") ? null : 0,
    providerWaiting: null, alternative: selection.alternative ?? null, assumptions: assumptions ?? {}, blockers: [...blockers], capacity,
    active: { competing: competing.length, selected: selectedActive.length, missions: new Set(competing.flatMap(w => w.missionId ? [w.missionId] : [])).size },
    criticalPathMs: base[1]!.criticalPathMs,
    criticalPath: [...new Set(base[1]!.criticalPath.map(id => operationsById.get(id)!.taskId))],
    cycles: base[1]!.cycles.map(cycle => cycle.map(id => operationsById.get(id)!.taskId)), outsideDependencies,
    stages: (constrained[1]!.intervals ?? base[1]!.intervals ?? []).map(interval => {
      const { duration, ...operation } = operationsById.get(interval.id)!;
      return { ...operation, ...interval, resources: keysByItem.get(interval.id) ?? [], duration };
    }),
    stageTimingIsBaseline: constrained[1]!.intervals === undefined,
    activeWall: elapsed ? range(...constrained.map(s => unionMs((s.intervals ?? [])
      .filter(i => operationsById.get(i.id)?.role).map(i => ({ start: i.startMs, end: i.endMs })))) as [number, number, number]) : null,
    ownerGates: [...ownerGates], omitted, concurrency: cap,
    bottlenecks: [...slots].filter(([key]) => (constrained[1]!.intervals ?? base[1]!.intervals ?? []).some(i => i.delayedBy.includes(key))),
    worker: addRanges(...operations.filter(op => op.role).map(op => op.duration)),
    expectedRuns: stages.reduce((sum, stage) => sum + stage.runs, 0),
    unallocated: estimates.filter(e => e.pinnedUnavailable || e.reviewerPinnedUnavailable).length,
    cost, subscriptionUsage: null, budget: body ? {
      expectedMs: body.expectedDurationMs ?? null, maxDurationMs: body.maxDurationMs, maxLaunches: body.maxLaunches,
      apiUsd: body.spending.limitUsd, requireVerifiedQuota: body.requireVerifiedQuota === true,
    } : null, missionId: mission?.id ?? null, missionRevision: mission?.revision ?? null,
  };
  if (estimates.length === 1) estimates[0]!.schedule = {
    elapsed: elapsed?.expected ?? null, wait: resourceWait?.expected ?? null,
    completionAt: completionWindow?.expected ?? null, blockers: snapshot.blockers,
  };
  let revision: number | null = null;
  const taskById = new Map(selected.map(task => [task.id, task]));
  if (selection.save && estimates.length) db.transaction(() => {
    for (const estimate of estimates) {
      const task = taskById.get(estimate.taskId)!;
      if (task.column === "backlog" || mission && !db.query("SELECT 1 FROM runs WHERE task_id = ? LIMIT 1").get(task.id) ||
        selection.freezeBaseline && !db.query("SELECT 1 FROM runs WHERE task_id = ? LIMIT 1").get(task.id)) {
        estimate.estimateId = saveTaskEstimate(task, estimate, now, mission?.id ?? null);
      }
    }
    if (estimates.length > 1 || mission || projectPaths.size || selection.clusterId) {
      const selectionKey = hash([[...projectPaths].sort(), selection.clusterId, selection.missionId, selection.taskIds?.slice().sort()]);
      const digest = hash([snapshot, estimates.map(e => ({ ...e, schedule: undefined }))]);
      const latest = db.query<{ id: number; fingerprint: string }, [string]>(
        "SELECT id,fingerprint FROM usage_group_forecasts WHERE selection_key = ? ORDER BY id DESC LIMIT 1",
      ).get(selectionKey);
      revision = latest?.fingerprint === digest ? latest.id : Number(db.run(
        "INSERT INTO usage_group_forecasts(selection_key,fingerprint,snapshot,created_at) VALUES (?,?,?,?)",
        [selectionKey, digest, JSON.stringify({ ...snapshot, completionWindow, estimates }), now],
      ).lastInsertRowid);
    }
  })();
  const allocationComparison = selection.compareAllocations ? allocationComparisonFor(estimates, strict) : undefined;
  const projectHolds: Record<string, string> = {};
  for (const estimate of estimates) {
    const state = estimate.projectPath && projects.getLifecycleRaw(estimate.projectPath)?.lifecycleState;
    if (estimate.projectPath && state && state !== "running") projectHolds[estimate.projectPath] = state;
  }
  const constraints = deriveConstraints({
    estimates, stages: snapshot.stages, capacity: capacity, ownerGates: snapshot.ownerGates, projectHolds,
  });
  // A recorded provider refusal is shown beside its candidate as evidence that an earlier request was
  // refused. It is read here only for display and never reaches ranking, selection or any estimate.
  const shown = new Set(estimates.flatMap(estimate => [...estimate.developerOptions, ...estimate.reviewerOptions].map(optionKey)));
  const candidateRefusals: Record<string, ProviderRefusalSummary> = {};
  for (const candidate of [...candidates.developer, ...candidates.reviewer]) {
    const key = optionKey({ harnessId: candidate.harnessId, accountId: candidate.accountId, modelId: candidate.modelId, mode: candidate.mode });
    if (candidate.providerRefusal && shown.has(key) && !candidateRefusals[key]) candidateRefusals[key] = candidate.providerRefusal;
  }
  const result = {
    ...snapshot, completionWindow, estimates, revision, constraints, firstConstraint: firstResourceConstraint(constraints), candidateRefusals,
    ...(allocationComparison ? { allocationComparison } : {}),
  };
  return result;
}

/**
 * The forecast service. With an explicit alternative it also lines that alternative up against the
 * current allocation under the same selection and assumptions. Both sides are read-only
 * calculations; nothing is started, selected or authorized.
 */
export function forecast(selection: ForecastSelection, now = Date.now(), planPreview?: MissionPlan) {
  const result = forecastBase(selection, now, planPreview);
  if (!selection.alternative) return { ...result, comparison: null as AlternativeComparison | null };
  const current = forecastBase({ ...selection, alternative: undefined, save: false }, now, planPreview);
  return { ...result, comparison: compareAlternative(current, result, selection.alternative.taskId) as AlternativeComparison | null };
}

function allocationComparisonFor(estimates: TaskForecast[], strict: boolean) {
  const stages: AllocationStage[] = [];
  const pools = new Map<string, { id: string; remaining: number | null }>();
  const included = new Set<string>();
  for (const estimate of estimates) {
    for (const role of estimate.remainingRoles ?? estimate.roles) {
      const options = (role === "developer" ? estimate.developerOptions : estimate.reviewerOptions)
        .filter(option => option.planningEligible && option.eligibility === "eligible" && option.accountId);
      if (!options.length) continue;
      const id = `${estimate.taskId}:${role}`;
      included.add(id);
      stages.push({
        id, dependsOn: role === "reviewer" ? [`${estimate.taskId}:developer`] : estimate.dependsOn.map(dependency => `${dependency}:developer`),
        options: options.slice(0, 4).map(option => {
          const quota = option.nativeQuota.find(item => quotaDemand(item, option.cost) !== null);
          const pool = quota ? JSON.stringify([quota.accountId, quota.id]) : null;
          if (quota && pool && !pools.has(pool)) pools.set(pool, { id: pool, remaining: quota.current?.remaining ?? null });
          return {
            id: optionKey(option), accountId: option.accountId!, durationMs: option.duration.expected,
            charge: option.cost.money?.amount ?? null, waitMs: 0, poolId: pool,
            demand: quota ? quotaDemand(quota, option.cost) : null, concurrency: Math.max(1, option.capacity ?? 1),
          };
        }),
      });
    }
  }
  for (const stage of stages) stage.dependsOn = stage.dependsOn.filter(id => included.has(id));
  return stages.length ? compareAllocations(stages.slice(0, 12), [...pools.values()], strict) : [];
}

export function forecastCost(estimates: Array<Pick<TaskForecast, "roles" | "runs" | "developer" | "reviewer">>) {
  const totals = new Map<string, { kind: RunCost["kind"]; currency: string; amount: number }>();
  let unknown = 0;
  let subscription = 0;
  let input: number | null = null;
  let output: number | null = null;
  let cacheRead: number | null = null;
  let cacheWrite: number | null = null;
  let inputStages = 0;
  let outputStages = 0;
  for (const estimate of estimates) for (const role of estimate.roles) {
    const resource = estimate[role];
    const multiplier = estimate.runs.expected / estimate.roles.length;
    if (resource?.tokens.input != null) {
      input = (input ?? 0) + resource.tokens.input * multiplier;
      inputStages++;
    }
    if (resource?.tokens.output != null) {
      output = (output ?? 0) + resource.tokens.output * multiplier;
      outputStages++;
    }
    if (resource?.tokens.cacheRead != null) cacheRead = (cacheRead ?? 0) + resource.tokens.cacheRead * multiplier;
    if (resource?.tokens.cacheWrite != null) cacheWrite = (cacheWrite ?? 0) + resource.tokens.cacheWrite * multiplier;
    const cost = resource?.cost;
    if (cost?.kind === "subscription") subscription++;
    else if (!cost?.money) unknown++;
    else {
      const key = cost.kind + "/" + cost.money.currency;
      const prior = totals.get(key);
      totals.set(key, { kind: cost.kind, currency: cost.money.currency, amount: (prior?.amount ?? 0) + cost.money.amount * multiplier });
    }
  }
  return { totals: [...totals.values()], unknown, subscription, input, output, cacheRead, cacheWrite, inputStages, outputStages };
}
