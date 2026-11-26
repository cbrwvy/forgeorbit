import { listProjectAccountPreferences } from "../multiaccount/registry.ts";
import { db, projects, tasks } from "../db.ts";
import { missionResourceOptions } from "../orchestration/mission-replan.ts";
import { missionStore } from "../orchestration/mission-store.ts";
import { ownerProjectOf } from "../project-ownership.ts";
import type { HeadScopeSnapshot } from "../../shared/head-pm-scope.ts";
import { rangeBounds } from "../../shared/company-analytics.ts";
import { isSyntheticEvidenceSource, type AnalyticsFilter, type ForecastSelection } from "../../shared/usage-analytics.ts";
import { analytics, taskBreakdown } from "./analytics.ts";
import { forecast, optionKey, type TaskForecast } from "./forecast.ts";
import { usageResources } from "./resources.ts";

const usageQuestion = /replan|reallocat|mission|reviewer|developer|employee|specialist|переплан|мисс|estimat|forecast|budget|quota|reset|capacity|account|model|profile|blocked|cost|money|consume|spend|spent|usage|token|project|cluster|completed|yesterday|today|week|month|first-pass|economical|cheaper|critical path|concurrency|rework|longer|how long|duration|how much time|how many|оцен|прогноз|бюджет|квот|лимит|аккаунт|профил|модел|ресурс|сброс|блокир|стоим|затрат|денег|потрат|переработ|дольше|сколько|расход|заверш|сотруд|токен|вчера|сегодня|недел|месяц|проект/i;
const forecastQuestion = /estimat|forecast|how long|economical|backlog|will|could|which models|which account should|critical path|concurrency|cheaper|lower.cost|capacity|schedule|mission|longer|rework|finish|оцен|прогноз|займ|дешев|бэклог/i;
const quotaQuestion = /quota|limit|account|reset|model|profile|capacity|blocked|квот|лимит|аккаунт|модел|сброс|ресурс|блокир/i;

export function headUsageEvidence(
  question: string, scope: HeadScopeSnapshot | undefined, includesProject: (path: string) => boolean,
  now = Date.now(),
): string[] {
  if (!usageQuestion.test(question)) return [];
  const filter: AnalyticsFilter = {};
  const selection: ForecastSelection = {};
  if (scope?.scope.kind === "task") {
    filter.taskId = scope.scope.id;
    selection.taskIds = [scope.scope.id];
  }
  if (scope?.scope.kind === "project") selection.projectPath = filter.projectPath = scope.scope.path;
  if (scope?.scope.kind === "cluster") selection.clusterId = filter.clusterId = scope.scope.id;

  const normalized = question.toLowerCase();
  const mentioned = [...new Set(question.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? [])].slice(0, 30);
  const inScope = (id: string) => {
    const task = tasks.get(id);
    if (!task) return false;
    const path = ownerProjectOf(task.workdir);
    return (!scope || scope.scope.kind === "workspace") || !!path && includesProject(path);
  };
  const taskIds = mentioned.filter(inScope);
  if (!selection.projectPath && !selection.taskIds && !taskIds.length && !selection.clusterId) {
    const paths = projects.list().filter(p => includesProject(p.path) && p.name.length >= 4 && normalized.includes(p.name.toLowerCase()))
      .map(p => p.path).slice(0, 32);
    if (paths.length) selection.projectPaths = paths;
  }
  if (!selection.taskIds && taskIds.length) selection.taskIds = taskIds;
  if (!filter.taskId && taskIds.length === 1) filter.taskId = taskIds[0];
  const workspace = !scope || scope.scope.kind === "workspace";
  const mission = missionStore.listMissions().find(m => m.projects.every(path => workspace || includesProject(path)) &&
    (!filter.taskId || m.plan.tasks.some(t => t.taskId === filter.taskId)) && (mentioned.includes(m.id) ||
      /mission|мисс/i.test(question) && m.title.length >= 4 && normalized.includes(m.title.toLowerCase()) ||
      !!filter.taskId && ["paused", "authorized"].includes(m.status)));

  if (mission) filter.missionId = mission.id;
  const scopedAccounts = new Set(listProjectAccountPreferences(db).filter(p => includesProject(p.projectPath)).map(p => p.accountId));
  for (const r of mission ? mission.plan.tasks : []) if (r.accountId) scopedAccounts.add(r.accountId);
  const scopedHarnesses = new Set((selection.taskIds ?? []).flatMap(id => {
    const task = tasks.get(id);
    return task ? [task.agent] : [];
  }));
  const preset = /yesterday|вчера/i.test(question) ? "yesterday" as const
    : /today|сегодня/i.test(question) ? "today" as const
    : /this month|в этом месяце|за месяц/i.test(question) ? "month" as const
    : /30 day|30 дн/i.test(question) ? "last30" as const
    : /week|недел|7 day|7 дн/i.test(question) ? "last7" as const : null;
  if (preset) Object.assign(filter, rangeBounds(preset, now, "UTC"));

  const lines = [
    "Usage Analytics evidence. Forecasts are informational; they never authorize execution. Report Unknown when coverage is missing. Current quota can describe a balance only; it cannot establish how much this task will use.",
  ];
  if (mission && /replan|reallocat|switch|resource|reviewer|переплан|ресурс|замен/i.test(question)) {
    const candidates = mission.plan.tasks.filter(t => (!filter.taskId || t.taskId === filter.taskId) &&
      t.phase !== "completed").slice(0, 4);
    lines.push(JSON.stringify({ missionId: mission.id, revision: mission.revision, status: mission.status,
      tasks: candidates.map(task => ({ taskId: task.taskId, projectPath: task.projectPath, phase: task.phase,
        options: (["developer", "reviewer"] as const).flatMap(role => {
          try {
            return missionResourceOptions(mission.id, task.taskId, role).slice(0, 5).map(c => ({
              role, harnessId: c.harnessId, modelId: c.modelId, accountId: c.accountId, mode: c.mode,
            }));
          } catch { return []; }
        }),
      })),
    }));
  }
  const summary = analytics(filter, now, scope && scope.scope.kind !== "workspace" ? includesProject : undefined);
  lines.push(JSON.stringify({
    filter, completed: summary.completed, legacyDoneWithoutTimestamp: summary.legacyDoneWithoutTimestamp,
    elapsedMs: summary.elapsedMs, averageMs: summary.averageMs, medianMs: summary.medianMs, usage: summary.usage,
    developer: summary.developer, reviewer: summary.reviewer, firstPass: summary.firstPass,
    tasksWithRework: summary.tasksWithRework, accuracy: summary.accuracy.slice(0, 5), truncated: summary.truncated,
    recentRework: summary.tasks.filter(t => t.reworks > 0).sort((a, b) => b.reworks - a.reworks).slice(0, 5)
      .map(t => ({ taskId: t.id, title: t.title.slice(0, 120), reworks: t.reworks })),
    accuracyOmitted: Math.max(0, summary.accuracy.length - 5),
  }));
  const company = summary.company;
  lines.push("Company analytics answer. Calendar presets use UTC and are labeled. A missing amount is Unknown, not zero. An unattributed pool delta is not a per-task quota expense. Synthetic rows are excluded from comparison. " + JSON.stringify({
    timezone: "UTC", preset, readOnly: true, completed: company.counts, durations: company.durations, time: company.time,
    costs: company.costs, forecast: company.forecast, truncated: summary.truncated,
    tokensByProject: company.projects.slice(0, 20).map(row => ({ project: row.projectPath, input: row.tokens.input, output: row.tokens.output, realRuns: row.realRuns })),
    omittedProjects: Math.max(0, company.projects.length - 20),
    quota: company.quota.pools.slice(0, 20).map(pool => ({
      accountId: pool.accountId, unit: pool.unit, window: pool.window, synthetic: pool.synthetic, ownerReported: pool.ownerReported,
      poolDelta: pool.poolDelta, attributed: pool.attributed, unattributed: pool.unattributed, resets: pool.resets, statement: pool.statement,
    })),
    omittedPools: Math.max(0, company.quota.pools.length - 20),
    perTaskSubscriptionQuota: "Unknown",
  }));
  if (/first-pass|перв/i.test(question) && /developer|разработ/i.test(question)) {
    const comparable = company.employees.filter(row => row.developerFirstPass.comparison === "comparable");
    lines.push(comparable.length ? JSON.stringify({
      developerFirstPass: comparable.map(row => ({ name: row.name, rate: row.developerFirstPass.rate, samples: row.developerFirstPass.samples, categories: row.categories })),
    }) : "Insufficient data for a Developer QC first-pass comparison. Three genuine outcomes in one task category are required. Synthetic runs are excluded. Reviewer participation is not an implemented task.");
  }
  if (/lowest|cheapest|дешев/i.test(question) && /model|модел/i.test(question)) {
    const hint = /laravel|react|python|typescript|swift|django/i.exec(question)?.[0]?.toLowerCase() ?? null;
    const priced = company.models.filter(row => row.role === "developer" && row.comparison === "comparable" && row.averageCharge &&
      (!hint || row.technologies.some(item => item.toLowerCase().includes(hint))));
    lines.push(priced.length ? JSON.stringify({ comparableModels: priced.slice(0, 12).map(row => ({ provider: row.provider, model: row.model, accountId: row.accountId, averageCharge: row.averageCharge, samples: row.genuineRuns, categories: row.categories })) })
      : "Insufficient data for a comparable model cost ranking. Three genuine runs in one category are required, with exact account attribution and a complete same-currency charge.");
  }
  const warnings = summary.quotas.flatMap(account => account.quota.filter(quota => quota.warning).map(quota => ({ account: account.label, unit: quota.unit, window: quota.window })));
  if (/approaching|near.{0,12}limit|приближа/i.test(question)) {
    lines.push(warnings.length ? JSON.stringify({ approachingConfiguredThreshold: warnings.slice(0, 20), omitted: Math.max(0, warnings.length - 20) })
      : "No stored fresh reading is at or below its configured remaining threshold. This did not refresh a provider.");
  }
  if (filter.taskId) {
    const detail = taskBreakdown(filter.taskId);
    if (detail) {
      const a = detail.actual;
      lines.push(JSON.stringify({
        taskId: a.id, originalEstimate: detail.original?.estimateId ?? null, remaining: detail.remaining, deviation: detail.deviation, frozenEstimate: detail.estimate?.estimateId ?? null, sameResources: detail.sameResources,
        expectedWorkerMs: detail.estimate?.worker.expected ?? null, workerDeltaMs: detail.workMs, completionDeltaMs: detail.completionDeltaMs, costDelta: detail.costDelta,
        actual: { elapsedMs: a.executionElapsedMs, queueMs: a.queueMs, measuredWaiting: a.waiting, workerMs: a.workerMs, testMs: a.testMs,
          qcMs: a.qcMs, reworkMs: a.reworkMs, reworks: a.reworks, failed: a.failed, interrupted: a.interrupted, humanMs: null,
          lifecycle: a.lifecycle, subscriptionQuota: a.subscriptionQuota },
        delayEvidence: detail.forecastComparison.delayEvidence, errors: detail.forecastComparison.errors,
        ownerAdjustments: detail.adjustments.current.map(row => ({ amount: row.amount, currency: row.currency, label: row.label })),
      }));
    }
  }
  if (forecastQuestion.test(question)) {
    try {
      const input = mission ? { missionId: mission.id } : selection;
      const estimate = forecast(input, now);
      const requested = /(?:concurrency|workers|slots|слотов)\s*(?:of|to|до|=|:)?\s*(\d{1,2})/i.exec(question);
      const n = requested ? Number(requested[1]) : 0;
      const whatIf = !mission && n > 0 && n <= 32 && n !== estimate.concurrency ? forecast({ ...input, concurrency: n }, now) : null;
      const visibleOption = (option: TaskForecast["developerOptions"][number], current: TaskForecast["developer"]) =>
        workspace || option.accountId !== null && scopedAccounts.has(option.accountId) ||
        option.harnessId === current?.harnessId && option.accountId === current.accountId;
      const focus = estimate.estimates.length === 1 ? estimate.estimates[0] : null;
      if (focus && /alternative|cheaper|lower.cost|faster|fallback|альтернатив|дешев|быстр/i.test(question)) {
        const priced = (option: TaskForecast["developer"]) => option?.cost.kind === "calculated-api" ? option.cost.money : null;
        const price = priced(focus.developer);
        const cheaper = /cheaper|lower.cost|дешев/i.test(question);
        const alternatives = focus.developerOptions.filter(o => o.eligibility === "eligible" && visibleOption(o, focus.developer) &&
          (!focus.developer || optionKey(o) !== optionKey(focus.developer)) && (!cheaper ||
            (price && priced(o)?.currency === price.currency && priced(o)!.amount < price.amount)));
        const option = alternatives.sort((a, b) => cheaper ? priced(a)!.amount - priced(b)!.amount
          : a.duration.expected - b.duration.expected || b.score - a.score)[0];
        if (option) {
          try {
            const proposed = forecast({ ...input, alternative: { taskId: focus.taskId, optionKey: optionKey(option) } }, now);
            lines.push(JSON.stringify({ taskId: focus.taskId, alternative: {
              harness: option.harnessId, model: option.modelId, account: option.accountId, elapsed: proposed.elapsed,
              cost: proposed.cost, blockers: proposed.blockers, confidence: proposed.estimates[0]?.confidence,
              capacity: proposed.capacity.rows.slice(0, 6).map(pool => ({ window: pool.window, status: pool.status })),
            }, approval: "Planning preview. Review resource changes in Forecasts. Frozen mission changes require new Owner authorization." }));
          } catch {
            lines.push("No read-only alternative can be scheduled for this task in its current state.");
          }
        } else if (cheaper) lines.push("No eligible lower-cost alternative has comparable API pricing in this scope.");
      }
      lines.push(JSON.stringify({
        scope: mission ? { missionId: mission.id } : selection, tasks: estimate.estimates.length, baseline: estimate.calendar,
        elapsed: estimate.elapsed, resourceWait: estimate.resourceWait, completionWindow: estimate.completionWindow,
        blockers: estimate.blockers, criticalPath: estimate.criticalPath.slice(0, 30),
        competingWork: estimate.active, whatIf: whatIf ? { concurrency: n, baseline: whatIf.calendar, elapsed: whatIf.elapsed, blockers: whatIf.blockers } : null,
        capacity: { uncoveredStages: estimate.capacity.uncoveredStages, pools: estimate.capacity.rows.slice(0, 10).map(p => ({
          shared: p.shared, window: p.window, unit: p.unit, evidence: p.evidence, freshness: p.freshness, demand: p.knownDemand,
          unknownStages: p.unknownStages, remaining: p.remaining, status: p.status, resetAt: p.resetAt, competingWork: p.active,
        })) },
        criticalPathMs: estimate.criticalPathMs, concurrency: estimate.concurrency, outsideDependencies: workspace ? estimate.outsideDependencies.slice(0, 12) : estimate.outsideDependencies.length,
        bottlenecks: workspace ? estimate.bottlenecks.slice(0, 12) : estimate.bottlenecks.length, cost: estimate.cost, unallocated: estimate.unallocated,
        assumptions: "Stages hold only their own planning slots. Rework is conditional. Completion dates require resolved resource and Owner constraints. Subscription demand is Unknown. Resource alternatives require separate Owner approval.",
        ownerAssumptions: estimate.assumptions,
        details: estimate.estimates.slice(0, 12).map(e => ({
          taskId: e.taskId, title: e.title.slice(0, 120), confidence: e.confidence, methodology: e.methodology, stageEvidence: e.stageEvidence, worker: e.worker, test: e.testing,
          qc: e.qc, rework: e.rework, roles: e.roles, runs: e.runs, completion: e.completion,
          options: e.developerOptions.filter(o => visibleOption(o, e.developer)).sort((a, b) => {
            const priced = (r: typeof a) => r.cost.kind === "calculated-api" && r.cost.money?.currency === "USD" ? r.cost.money.amount : Infinity;
            return priced(a) - priced(b) || b.score - a.score;
          }).slice(0, estimate.estimates.length > 1 ? 2 : 8).map(o => ({
            provider: o.provider, model: o.modelId, account: o.accountId, duration: o.duration, samples: o.samples, cost: o.cost, tier: o.tier,
            eligibility: o.eligibility, eligibilityReason: o.eligibilityReason, quotaComparison: o.quotaPlan,
            quota: o.nativeQuota.slice(0, 5).map(q => ({ unit: q.unit, status: q.status,
              verified: q.current && !isSyntheticEvidenceSource(q.current.source) ? q.current : null,
              ownerReported: q.ownerReported })),
          })),
        })),
        omittedEstimates: Math.max(0, estimate.estimates.length - 12),
      }));
    } catch {
      lines.push("No forecast was produced for this selection. Use the task ID, an approved mission, or a smaller backlog selection.");
    }
  }
  if (quotaQuestion.test(question)) {
    const { accounts, resources, inventory } = usageResources();
    for (const r of resources) if (r.binding === "exact" && r.accountId && scopedHarnesses.has(r.harnessId)) scopedAccounts.add(r.accountId);
    const requested = accounts.filter(a => mentioned.includes(a.id) ||
      a.label.length >= 4 && normalized.includes(a.label.toLowerCase()));
    const scoped = accounts.filter(a => workspace || scopedAccounts.has(a.id));
    const visible = requested.length ? scoped.filter(a => requested.includes(a)) : scoped;
    const observation = (o: NonNullable<(typeof accounts)[number]["quota"][number]["current"]>) => ({
      used: o.used, remaining: o.remaining, indicator: o.indicator, resetAt: o.resetAt, observedAt: o.observedAt,
      freshness: o.freshness, source: o.source,
    });
    const evidence = visible.slice(0, 20).map(a => ({
      id: a.id, label: a.label.slice(0, 80), provider: a.provider, identity: a.identity, archived: a.archived,
      concurrencyLimit: a.profileLimit,
      resources: resources.filter(r => r.accountId === a.id).slice(0, 12).map(r => ({
        model: r.modelId, installed: r.installed, authenticated: r.auth, binding: r.binding, mode: r.mode, blocks: r.blocks,
      })),
      quota: a.quota.slice(0, 5).map(q => ({
        unit: q.unit, scope: q.scope, window: q.window, status: q.status, threshold: q.threshold,
        verified: q.current && !isSyntheticEvidenceSource(q.current.source) ? observation(q.current) : null,
        synthetic: isSyntheticEvidenceSource(q.current?.source) ? observation(q.current!) : null,
        ownerReported: q.ownerReported ? observation(q.ownerReported) : null,
        recentChange: q.changes[0] ?? null,
      })),
    }));
    lines.push("Registered accounts in this scope. Missing balances, resets, identity, and billing are Unknown. Owner-reported observations and their reset times are unverified. A synthetic source is a fixture, not a live provider balance. Never sum windows, models sharing a pool, or different units. A quota change is not task consumption. " +
      JSON.stringify({ accounts: evidence, omittedAccounts: Math.max(0, visible.length - evidence.length) }));
    if (workspace) lines.push(JSON.stringify({ providers: inventory.map(p => ({ provider: p.provider, harness: p.kind, installed: p.installed,
      blockers: p.blockers, modelDiscovery: p.harnesses.some(h => h.discoveredModels.length > 0) })) }));
  }
  return lines;
}
