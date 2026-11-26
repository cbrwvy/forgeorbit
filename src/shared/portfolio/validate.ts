/**
 * Structural checks for a portfolio snapshot. A failed check is an issue.
 * Nothing is repaired into a plausible value.
 */

import { isCurrencyCode } from "../estimation/money.ts";
import type { DataOrigin } from "../estimation/types.ts";
import {
  AGENT_KINDS,
  BATCH_STATUSES,
  COLUMN_IDS,
  DATA_ORIGINS,
  ENVIRONMENT_PHASES,
  PIPELINE_STATUSES,
  PORTFOLIO_LIMITS,
  RUN_STATUSES,
  TASK_PRIORITY_IDS,
  type DeadlineInput,
  type Fact,
  type PortfolioIssue,
  type PortfolioSnapshotInput,
  type ProjectPriorityInput,
  type ProjectSnapshotInput,
  type QuotaKnowledge,
  type ResourceSnapshotInput,
  type TaskFactInput,
} from "./types.ts";

const CONFIRMED_ORIGINS = new Set(["user-provided", "known"]);

export function validatePortfolio(input: unknown): { issues: PortfolioIssue[]; value: PortfolioSnapshotInput | null } {
  const issues: PortfolioIssue[] = [];
  if (!isRecord(input)) {
    return { issues: [issue("error", "type", "", "Portfolio snapshot must be an object.")], value: null };
  }
  const capturedAtMs = readInstant(input.capturedAtMs, "capturedAtMs", issues);
  const stalenessAfterMs = readOptionalInstant(input.stalenessAfterMs, "stalenessAfterMs", issues);
  const reportCurrency = readCurrency(input.reportCurrency, "reportCurrency", issues);
  const exchangeRates = readExchangeRates(input.exchangeRates, issues);
  const policy = readPolicy(input.policy, "policy", issues);
  const projects = readArray(input.projects, "projects", PORTFOLIO_LIMITS.maxProjects, issues);
  const resources = readArray(input.resources, "resources", PORTFOLIO_LIMITS.maxResources, issues);
  const projectPriorities = readArray(input.projectPriorities, "projectPriorities", PORTFOLIO_LIMITS.maxProjects, issues);
  const deadlines = readArray(input.deadlines, "deadlines", PORTFOLIO_LIMITS.maxDeadlines, issues);

  if (issues.some((entry) => entry.severity === "error")) return { issues: cap(issues), value: null };

  const projectValues: ProjectSnapshotInput[] = [];
  const projectIds = new Set<string>();
  let taskTotal = 0;
  let runTotal = 0;
  let dependencyTotal = 0;
  let batchTotal = 0;
  let pipelineTotal = 0;
  for (let i = 0; i < (projects?.length ?? 0); i++) {
    const project = readProject(projects![i], `projects[${i}]`, issues);
    if (!project) continue;
    if (projectIds.has(project.id)) {
      issues.push(issue("error", "duplicate-project", `projects[${i}].id`, `Project id ${project.id} is repeated.`));
      continue;
    }
    projectIds.add(project.id);
    taskTotal += project.tasks.length;
    runTotal += project.runs.length;
    dependencyTotal += project.dependencies.length;
    batchTotal += project.batches.length;
    pipelineTotal += project.pipelines.length;
    projectValues.push(project);
  }
  if (taskTotal > PORTFOLIO_LIMITS.maxTasks) {
    issues.push(issue("error", "limit", "projects", `A portfolio can carry at most ${PORTFOLIO_LIMITS.maxTasks} task rows.`));
  }
  if (runTotal > PORTFOLIO_LIMITS.maxRuns) {
    issues.push(issue("error", "limit", "projects", `A portfolio can carry at most ${PORTFOLIO_LIMITS.maxRuns} runs.`));
  }
  if (dependencyTotal > PORTFOLIO_LIMITS.maxDependencies) {
    issues.push(issue("error", "limit", "projects", `A portfolio can carry at most ${PORTFOLIO_LIMITS.maxDependencies} dependencies.`));
  }
  if (batchTotal > PORTFOLIO_LIMITS.maxBatches) {
    issues.push(issue("error", "limit", "projects", `A portfolio can carry at most ${PORTFOLIO_LIMITS.maxBatches} batches.`));
  }
  if (pipelineTotal > PORTFOLIO_LIMITS.maxPipelines) {
    issues.push(issue("error", "limit", "projects", `A portfolio can carry at most ${PORTFOLIO_LIMITS.maxPipelines} pipelines.`));
  }

  const resourceValues: ResourceSnapshotInput[] = [];
  const resourceIds = new Set<string>();
  for (let i = 0; i < (resources?.length ?? 0); i++) {
    const resource = readResource(resources![i], `resources[${i}]`, issues);
    if (!resource) continue;
    if (resourceIds.has(resource.id)) {
      issues.push(issue("error", "duplicate-resource", `resources[${i}].id`, `Resource id ${resource.id} is repeated.`));
      continue;
    }
    resourceIds.add(resource.id);
    resourceValues.push(resource);
  }

  const priorityValues: ProjectPriorityInput[] = [];
  for (let i = 0; i < (projectPriorities?.length ?? 0); i++) {
    const priority = readProjectPriority(projectPriorities![i], `projectPriorities[${i}]`, projectIds, issues);
    if (priority) priorityValues.push(priority);
  }
  const deadlineValues: DeadlineInput[] = [];
  for (let i = 0; i < (deadlines?.length ?? 0); i++) {
    const deadline = readDeadline(deadlines![i], `deadlines[${i}]`, projectIds, issues);
    if (deadline) deadlineValues.push(deadline);
  }

  if (
    capturedAtMs == null ||
    stalenessAfterMs === undefined ||
    reportCurrency === undefined ||
    !exchangeRates ||
    !policy ||
    issues.some((entry) => entry.severity === "error")
  ) {
    return { issues: cap(issues), value: null };
  }

  return {
    issues: cap(issues),
    value: {
      capturedAtMs,
      stalenessAfterMs,
      reportCurrency,
      exchangeRates,
      projects: projectValues,
      resources: resourceValues,
      projectPriorities: priorityValues,
      deadlines: deadlineValues,
      policy,
    },
  };
}

function readProject(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Project snapshot must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const projectPath = readId(value.path, `${path}.path`, issues);
  const name = readFact(value.name, `${path}.name`, (entry, entryPath) => readOptionalString(entry, entryPath, issues), issues);
  const description = readFact(value.description, `${path}.description`, (entry, entryPath) => readOptionalString(entry, entryPath, issues), issues);
  const stack = readFact(value.stack, `${path}.stack`, (entry, entryPath) => readStringList(entry, entryPath, issues), issues);
  const managerConfigured = readFact(value.managerConfigured, `${path}.managerConfigured`, (entry, entryPath) => readOptionalBoolean(entry, entryPath, issues), issues);
  const managerAvailable = readFact(value.managerAvailable, `${path}.managerAvailable`, (entry, entryPath) => readOptionalBoolean(entry, entryPath, issues), issues);
  const observedAtMs = readInstant(value.observedAtMs, `${path}.observedAtMs`, issues);
  const coverage = readCoverage(value.coverage, `${path}.coverage`, issues);
  const tasks = readRows(value.tasks, `${path}.tasks`, (row, rowPath) => readTask(row, rowPath, issues), issues);
  const dependencies = readRows(value.dependencies, `${path}.dependencies`, (row, rowPath) => readDependency(row, rowPath, issues), issues);
  const runs = readRows(value.runs, `${path}.runs`, (row, rowPath) => readRun(row, rowPath, issues), issues);
  const pipelines = readRows(value.pipelines, `${path}.pipelines`, (row, rowPath) => readPipeline(row, rowPath, issues), issues);
  const batches = readRows(value.batches, `${path}.batches`, (row, rowPath) => readBatch(row, rowPath, issues), issues);
  const environment = readEnvironment(value.environment, `${path}.environment`, issues);
  let estimate: ProjectSnapshotInput["estimate"] = null;
  if (value.estimate != null) {
    const parsed = readEstimate(value.estimate, `${path}.estimate`, issues);
    if (parsed == null) return null;
    estimate = parsed;
  }

  if (!coverage) return null;
  if (!coverage.board && tasks && tasks.length > 0) {
    issues.push(issue("error", "coverage", `${path}.tasks`, "Tasks were supplied but the board was not marked observed."));
  }
  if (!coverage.runs && runs && runs.length > 0) {
    issues.push(issue("error", "coverage", `${path}.runs`, "Runs were supplied but runs were not marked observed."));
  }
  if (!coverage.batches && batches && batches.length > 0) {
    issues.push(issue("error", "coverage", `${path}.batches`, "Batches were supplied but batches were not marked observed."));
  }
  if (!coverage.pipelines && pipelines && pipelines.length > 0) {
    issues.push(issue("error", "coverage", `${path}.pipelines`, "Pipelines were supplied but pipelines were not marked observed."));
  }
  if (!coverage.dependencies && dependencies && dependencies.length > 0) {
    issues.push(issue("error", "coverage", `${path}.dependencies`, "Dependencies were supplied but dependencies were not marked observed."));
  }
  if (
    !id ||
    !projectPath ||
    !name ||
    !description ||
    !stack ||
    !managerConfigured ||
    !managerAvailable ||
    observedAtMs == null ||
    !tasks ||
    !dependencies ||
    !runs ||
    !pipelines ||
    !batches ||
    !environment
  ) {
    return null;
  }
  return {
    id,
    path: projectPath,
    name,
    description,
    stack,
    managerConfigured,
    managerAvailable,
    observedAtMs,
    coverage,
    tasks,
    dependencies,
    runs,
    pipelines,
    batches,
    environment,
    estimate,
  };
}

function readTask(value: unknown, path: string, issues: PortfolioIssue[]): TaskFactInput | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Task fact must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const title = readText(value.title, `${path}.title`, issues);
  const column = readEnum(value.column, COLUMN_IDS, `${path}.column`, "column", issues);
  const archived = readBoolean(value.archived, `${path}.archived`, issues);
  const pipelineParentId = readNullableId(value.pipelineParentId, `${path}.pipelineParentId`, issues);
  const priority = readFact(value.priority, `${path}.priority`, (entry, entryPath) => readEnum(entry, TASK_PRIORITY_IDS, entryPath, "priority", issues), issues);
  const harnessId = readNullableId(value.harnessId, `${path}.harnessId`, issues);
  const accountId = readNullableId(value.accountId, `${path}.accountId`, issues);
  const modelId = readNullableId(value.modelId, `${path}.modelId`, issues);
  const agentProfileId = readNullableId(value.agentProfileId, `${path}.agentProfileId`, issues);
  const requiredPermissions = readStringList(value.requiredPermissions, `${path}.requiredPermissions`, issues);
  const spending = value.spending == null
    ? null
    : readEnum(value.spending, ["no-extra", "allow-overage", "allow-paid"] as const, `${path}.spending`, "spending", issues);
  if (!id || title == null || !column || archived == null || pipelineParentId === undefined || !priority || harnessId === undefined || accountId === undefined || modelId === undefined || agentProfileId === undefined || !requiredPermissions || spending === undefined) {
    return null;
  }
  return {
    id,
    title,
    column,
    archived,
    pipelineParentId,
    priority,
    harnessId,
    accountId,
    modelId,
    agentProfileId,
    requiredPermissions,
    spending,
  };
}

function readDependency(value: unknown, path: string, issues: PortfolioIssue[]): { taskId: string; dependsOn: string } | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Dependency must be an object."));
    return null;
  }
  const taskId = readId(value.taskId, `${path}.taskId`, issues);
  const dependsOn = readId(value.dependsOn, `${path}.dependsOn`, issues);
  if (!taskId || !dependsOn) return null;
  if (taskId === dependsOn) {
    issues.push(issue("error", "self-dependency", path, "A task cannot depend on itself."));
    return null;
  }
  return { taskId, dependsOn };
}

function readRun(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["runs"][number] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Run fact must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const taskId = readId(value.taskId, `${path}.taskId`, issues);
  const harnessId = readId(value.harnessId, `${path}.harnessId`, issues);
  const accountId = readNullableId(value.accountId, `${path}.accountId`, issues);
  const status = readEnum(value.status, RUN_STATUSES, `${path}.status`, "run status", issues);
  const modelId = readNullableId(value.modelId, `${path}.modelId`, issues);
  const agentProfileId = readNullableId(value.agentProfileId, `${path}.agentProfileId`, issues);
  if (!id || !taskId || !harnessId || accountId === undefined || !status || modelId === undefined || agentProfileId === undefined) return null;
  return { id, taskId, harnessId, accountId, status, modelId, agentProfileId };
}

function readPipeline(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["pipelines"][number] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Pipeline fact must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const status = readEnum(value.status, PIPELINE_STATUSES, `${path}.status`, "pipeline status", issues);
  const parentTaskId = readNullableId(value.parentTaskId, `${path}.parentTaskId`, issues);
  if (!id || !status || parentTaskId === undefined) return null;
  return { id, status, parentTaskId };
}

function readBatch(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["batches"][number] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Batch fact must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const status = readEnum(value.status, BATCH_STATUSES, `${path}.status`, "batch status", issues);
  const taskIds = readIdList(value.taskIds, `${path}.taskIds`, issues);
  if (!id || !status || !taskIds) return null;
  return { id, status, taskIds };
}

function readEnvironment(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["environment"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Environment fact must be an object."));
    return null;
  }
  const configured = readFact(value.configured, `${path}.configured`, (entry, entryPath) => readOptionalBoolean(entry, entryPath, issues), issues);
  const phase = readFact(
    value.phase,
    `${path}.phase`,
    (entry, entryPath) => readEnum(entry, ENVIRONMENT_PHASES, entryPath, "environment phase", issues),
    issues,
  );
  if (!configured || !phase) return null;
  return { configured, phase };
}

function readEstimate(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["estimate"] | null | undefined {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Estimate fact must be an object."));
    return undefined;
  }
  const scenario = readEnum(value.scenario, ["optimistic", "expected", "conservative"] as const, `${path}.scenario`, "scenario", issues);
  const agent = readDuration(value.agent, `${path}.agent`, issues);
  const calendar = readCalendar(value.calendar, `${path}.calendar`, issues);
  const additionalCash = readCash(value.additionalCash, `${path}.additionalCash`, issues);
  const apiEquivalent = readCash(value.apiEquivalent, `${path}.apiEquivalent`, issues);
  const subscriptionFees = readCash(value.subscriptionFees, `${path}.subscriptionFees`, issues);
  const subscriptions = readSubscriptionRefs(value.subscriptions, `${path}.subscriptions`, issues);
  const confidence = readEnum(value.confidence, ["high", "medium", "low", "none"] as const, `${path}.confidence`, "confidence", issues);
  const missing = readStringList(value.missing, `${path}.missing`, issues);
  const coverageStatus = value.coverageStatus == null
    ? null
    : readEnum(
        value.coverageStatus,
        ["sufficient", "insufficient", "unknown", "no-work", "no-subscription"] as const,
        `${path}.coverageStatus`,
        "coverage",
        issues,
      );
  const observedAtMs = readInstant(value.observedAtMs, `${path}.observedAtMs`, issues);
  if (!scenario || !agent || !calendar || !additionalCash || !apiEquivalent || !subscriptionFees || !subscriptions || !confidence || !missing || coverageStatus === undefined || observedAtMs == null) {
    return undefined;
  }
  return {
    scenario,
    agent,
    calendar,
    additionalCash,
    apiEquivalent,
    subscriptionFees,
    subscriptions,
    confidence,
    missing,
    coverageStatus,
    observedAtMs,
  };
}

function readDuration(value: unknown, path: string, issues: PortfolioIssue[]): NonNullable<ProjectSnapshotInput["estimate"]>["agent"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Duration forecast must be an object."));
    return null;
  }
  const status = readEnum(value.status, ["known", "estimated", "incomplete", "unknown", "invalid"] as const, `${path}.status`, "duration status", issues);
  const ms = readNullableNumber(value.ms, `${path}.ms`, issues);
  const knownMs = readNullableNumber(value.knownMs, `${path}.knownMs`, issues);
  const unknownStageIds = readStringList(value.unknownStageIds, `${path}.unknownStageIds`, issues);
  const origin = readOrigin(value.origin, `${path}.origin`, issues);
  const note = readNullableText(value.note, `${path}.note`, issues);
  if (!status || ms === undefined || knownMs === undefined || !unknownStageIds || !origin || note === undefined) return null;
  if (status === "invalid") {
    issues.push(issue("error", "estimate", path, "An invalid duration forecast cannot enter the portfolio."));
    return null;
  }
  return { status, ms, knownMs, unknownStageIds, origin, note };
}

function readCalendar(value: unknown, path: string, issues: PortfolioIssue[]): NonNullable<ProjectSnapshotInput["estimate"]>["calendar"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Calendar forecast must be an object."));
    return null;
  }
  const status = readEnum(value.status, ["known", "estimated", "incomplete", "unknown", "invalid"] as const, `${path}.status`, "calendar status", issues);
  const ms = readNullableNumber(value.ms, `${path}.ms`, issues);
  const scheduleMs = readNullableNumber(value.scheduleMs, `${path}.scheduleMs`, issues);
  const criticalPathMs = readNullableNumber(value.criticalPathMs, `${path}.criticalPathMs`, issues);
  const serialUpperBoundMs = readNullableNumber(value.serialUpperBoundMs, `${path}.serialUpperBoundMs`, issues);
  const method = readEnum(value.method, ["critical-path", "list-scheduling", "none"] as const, `${path}.method`, "calendar method", issues);
  const exact = readBoolean(value.exact, `${path}.exact`, issues);
  const startAtMs = readNullableInstant(value.startAtMs, `${path}.startAtMs`, issues);
  const finishAtMs = readNullableInstant(value.finishAtMs, `${path}.finishAtMs`, issues);
  const simplifications = readStringList(value.simplifications, `${path}.simplifications`, issues);
  const unknownItemIds = readStringList(value.unknownItemIds, `${path}.unknownItemIds`, issues);
  const note = readNullableText(value.note, `${path}.note`, issues);
  if (!status || ms === undefined || scheduleMs === undefined || criticalPathMs === undefined || serialUpperBoundMs === undefined || !method || exact == null || startAtMs === undefined || finishAtMs === undefined || !simplifications || !unknownItemIds || note === undefined) {
    return null;
  }
  if (status === "invalid") {
    issues.push(issue("error", "estimate", path, "An invalid calendar forecast cannot enter the portfolio."));
    return null;
  }
  return {
    status,
    ms,
    scheduleMs,
    criticalPathMs,
    serialUpperBoundMs,
    method,
    exact,
    startAtMs,
    finishAtMs,
    simplifications,
    unknownItemIds,
    note,
  };
}

function readCash(value: unknown, path: string, issues: PortfolioIssue[]): NonNullable<ProjectSnapshotInput["estimate"]>["additionalCash"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Cash forecast must be an object."));
    return null;
  }
  const status = readEnum(value.status, ["known", "incomplete", "unknown", "not-requested", "mixed-currency"] as const, `${path}.status`, "cash status", issues);
  const money = readNullableMoney(value.money, `${path}.money`, issues);
  const knownPortion = readNullableMoney(value.knownPortion, `${path}.knownPortion`, issues);
  const origin = readOrigin(value.origin, `${path}.origin`, issues);
  const basis = readEnum(value.basis, ["capacity", "policy", "priced", "none", "unpriced"] as const, `${path}.basis`, "cash basis", issues);
  const countsAsAdditionalCash = readBoolean(value.countsAsAdditionalCash, `${path}.countsAsAdditionalCash`, issues);
  const note = readNullableText(value.note, `${path}.note`, issues);
  if (!status || money === undefined || knownPortion === undefined || !origin || !basis || countsAsAdditionalCash == null || note === undefined) return null;
  return { status, money, knownPortion, origin, basis, countsAsAdditionalCash, note };
}

function readSubscriptionRefs(value: unknown, path: string, issues: PortfolioIssue[]): NonNullable<ProjectSnapshotInput["estimate"]>["subscriptions"] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "type", path, "Subscription refs must be a list."));
    return null;
  }
  const out: NonNullable<ProjectSnapshotInput["estimate"]>["subscriptions"] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    const rowPath = `${path}[${i}]`;
    if (!isRecord(row)) {
      issues.push(issue("error", "type", rowPath, "Subscription ref must be an object."));
      return null;
    }
    const id = readId(row.id, `${rowPath}.id`, issues);
    const commitment = readEnum(row.commitment, ["existing", "proposed"] as const, `${rowPath}.commitment`, "commitment", issues);
    const recurringFee = readNullableMoney(row.recurringFee, `${rowPath}.recurringFee`, issues);
    const priceOrigin = readOrigin(row.priceOrigin, `${rowPath}.priceOrigin`, issues);
    if (!id || !commitment || recurringFee === undefined || !priceOrigin) return null;
    out.push({ id, commitment, recurringFee, priceOrigin });
  }
  return out;
}

function readResource(value: unknown, path: string, issues: PortfolioIssue[]): ResourceSnapshotInput | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Resource snapshot must be an object."));
    return null;
  }
  const id = readId(value.id, `${path}.id`, issues);
  const harnessId = readId(value.harnessId, `${path}.harnessId`, issues);
  const harnessKind = value.harnessKind == null
    ? null
    : readEnum(value.harnessKind, AGENT_KINDS, `${path}.harnessKind`, "harness kind", issues);
  const accountId = readNullableId(value.accountId, `${path}.accountId`, issues);
  const agentProfileIds = readIdList(value.agentProfileIds, `${path}.agentProfileIds`, issues);
  const supportedModels = readFact(value.supportedModels, `${path}.supportedModels`, (entry, entryPath) => readStringList(entry, entryPath, issues), issues);
  const availability = readFact(
    value.availability,
    `${path}.availability`,
    (entry, entryPath) => readEnum(entry, ["available", "unavailable"] as const, entryPath, "availability", issues),
    issues,
  );
  const concurrencyLimit = readFact(value.concurrencyLimit, `${path}.concurrencyLimit`, (entry, entryPath) => readConcurrency(entry, entryPath, issues), issues);
  const occupiedSlots = readFact(value.occupiedSlots, `${path}.occupiedSlots`, (entry, entryPath) => readCount(entry, entryPath, issues), issues);
  const exclusive = readBoolean(value.exclusive, `${path}.exclusive`, issues);
  const quota = readQuota(value.quota, `${path}.quota`, issues);
  const quotaOrigin = readOrigin(value.quotaOrigin, `${path}.quotaOrigin`, issues);
  const extraSpending = readFact(
    value.extraSpending,
    `${path}.extraSpending`,
    (entry, entryPath) => readEnum(entry, ["forbidden", "allowed"] as const, entryPath, "extra spending", issues),
    issues,
  );
  const permissions = readFact(value.permissions, `${path}.permissions`, (entry, entryPath) => readStringList(entry, entryPath, issues), issues);
  const subscriptionId = readNullableId(value.subscriptionId, `${path}.subscriptionId`, issues);
  if (!id || !harnessId || harnessKind === undefined || accountId === undefined || !agentProfileIds || !supportedModels || !availability || !concurrencyLimit || !occupiedSlots || exclusive == null || !quota || !quotaOrigin || !extraSpending || !permissions || subscriptionId === undefined) {
    return null;
  }
  return {
    id,
    harnessId,
    harnessKind,
    accountId,
    agentProfileIds,
    supportedModels,
    availability,
    concurrencyLimit,
    occupiedSlots,
    exclusive,
    quota,
    quotaOrigin,
    extraSpending,
    permissions,
    subscriptionId,
  };
}

function readQuota(value: unknown, path: string, issues: PortfolioIssue[]): QuotaKnowledge | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    issues.push(issue("error", "type", path, "Quota must be an object with a kind."));
    return null;
  }
  if (value.kind === "unknown") {
    const reason = readText(value.reason, `${path}.reason`, issues);
    return reason == null ? null : { kind: "unknown", reason };
  }
  if (value.kind === "percent-used") {
    const usedPercent = readPercent(value.usedPercent, `${path}.usedPercent`, issues);
    const resetsAtMs = readNullableInstant(value.resetsAtMs, `${path}.resetsAtMs`, issues);
    if (usedPercent == null || resetsAtMs === undefined) return null;
    return { kind: "percent-used", usedPercent, resetsAtMs };
  }
  if (value.kind === "remaining") {
    const unit = readEnum(value.unit, ["requests", "tokens", "credits"] as const, `${path}.unit`, "quota unit", issues);
    const remaining = readCount(value.remaining, `${path}.remaining`, issues);
    const limit = value.limit == null ? null : readCount(value.limit, `${path}.limit`, issues);
    const resetsAtMs = readNullableInstant(value.resetsAtMs, `${path}.resetsAtMs`, issues);
    const currency = readNullableText(value.currency, `${path}.currency`, issues);
    if (!unit || remaining == null || limit === undefined || resetsAtMs === undefined || currency === undefined) return null;
    return { kind: "remaining", unit, remaining, limit, resetsAtMs, currency };
  }
  if (value.kind === "exhausted") {
    const resetsAtMs = readNullableInstant(value.resetsAtMs, `${path}.resetsAtMs`, issues);
    const evidence = readText(value.evidence, `${path}.evidence`, issues);
    if (resetsAtMs === undefined || evidence == null) return null;
    return { kind: "exhausted", resetsAtMs, evidence };
  }
  if (value.kind === "opaque") {
    const label = readText(value.label, `${path}.label`, issues);
    const note = readText(value.note, `${path}.note`, issues);
    if (label == null || note == null) return null;
    return { kind: "opaque", label, note };
  }
  issues.push(issue("error", "enum", `${path}.kind`, "Quota kind is not recognized."));
  return null;
}

function readProjectPriority(value: unknown, path: string, projectIds: ReadonlySet<string>, issues: PortfolioIssue[]): ProjectPriorityInput | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Project priority must be an object."));
    return null;
  }
  const projectId = readId(value.projectId, `${path}.projectId`, issues);
  const priority = readEnum(value.priority, TASK_PRIORITY_IDS, `${path}.priority`, "project priority", issues);
  const origin = readConfirmedOrigin(value.origin, `${path}.origin`, issues);
  if (!projectId || !priority || !origin) return null;
  if (!projectIds.has(projectId)) {
    issues.push(issue("error", "missing-project", path, `Project priority refers to unknown project ${projectId}.`));
    return null;
  }
  return { projectId, priority, origin };
}

function readDeadline(value: unknown, path: string, projectIds: ReadonlySet<string>, issues: PortfolioIssue[]): DeadlineInput | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Deadline must be an object."));
    return null;
  }
  const projectId = readId(value.projectId, `${path}.projectId`, issues);
  const taskId = readId(value.taskId, `${path}.taskId`, issues);
  const atMs = readInstant(value.atMs, `${path}.atMs`, issues);
  const origin = readConfirmedOrigin(value.origin, `${path}.origin`, issues);
  if (!projectId || !taskId || atMs == null || !origin) return null;
  if (!projectIds.has(projectId)) {
    issues.push(issue("error", "missing-project", path, `Deadline refers to unknown project ${projectId}.`));
    return null;
  }
  return { projectId, taskId, atMs, origin };
}

function readPolicy(value: unknown, path: string, issues: PortfolioIssue[]): PortfolioSnapshotInput["policy"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", "policy", "Policy must be an object."));
    return null;
  }
  void path;
  const allowWorkWithUnknownLimits = readBoolean(value.allowWorkWithUnknownLimits, "policy.allowWorkWithUnknownLimits", issues);
  const enforceSafetyForAutomaticExecution = readBoolean(value.enforceSafetyForAutomaticExecution, "policy.enforceSafetyForAutomaticExecution", issues);
  const calendarCombination = value.calendarCombination == null
    ? null
    : readEnum(
        value.calendarCombination,
        ["concurrent-if-uncontended", "serial"] as const,
        "policy.calendarCombination",
        "calendar combination",
        issues,
      );
  if (allowWorkWithUnknownLimits == null || enforceSafetyForAutomaticExecution == null || calendarCombination === undefined) return null;
  return { allowWorkWithUnknownLimits, enforceSafetyForAutomaticExecution, calendarCombination };
}

function readCoverage(value: unknown, path: string, issues: PortfolioIssue[]): ProjectSnapshotInput["coverage"] | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Coverage must be an object."));
    return null;
  }
  const board = readBoolean(value.board, `${path}.board`, issues);
  const runs = readBoolean(value.runs, `${path}.runs`, issues);
  const batches = readBoolean(value.batches, `${path}.batches`, issues);
  const pipelines = readBoolean(value.pipelines, `${path}.pipelines`, issues);
  const dependencies = readBoolean(value.dependencies, `${path}.dependencies`, issues);
  if (board == null || runs == null || batches == null || pipelines == null || dependencies == null) return null;
  return { board, runs, batches, pipelines, dependencies };
}

function readExchangeRates(value: unknown, issues: PortfolioIssue[]): PortfolioSnapshotInput["exchangeRates"] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "type", "exchangeRates", "Exchange rates must be a list."));
    return null;
  }
  const rates: PortfolioSnapshotInput["exchangeRates"] = [];
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    const path = `exchangeRates[${i}]`;
    if (!isRecord(row)) {
      issues.push(issue("error", "type", path, "Exchange rate must be an object."));
      return null;
    }
    const from = readCurrency(row.from, `${path}.from`, issues);
    const to = readCurrency(row.to, `${path}.to`, issues);
    const rate = typeof row.rate === "number" && Number.isFinite(row.rate) && row.rate > 0 ? row.rate : null;
    const origin = readOrigin(row.origin, `${path}.origin`, issues);
    if (!rate) issues.push(issue("error", "rate", `${path}.rate`, "Exchange rate must be a positive finite number."));
    if (from == null || to == null || !rate || !origin) return null;
    if (origin === "unknown") {
      issues.push(issue("error", "origin", `${path}.origin`, "An exchange rate needs a confirmed origin. An unknown rate is not a rate."));
      return null;
    }
    rates.push({ from, to, rate, origin });
  }
  return rates;
}

function readFact<T>(
  value: unknown,
  path: string,
  readValue: (entry: unknown, entryPath: string) => T | null | undefined,
  issues: PortfolioIssue[],
): Fact<T> | null {
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Fact must be an object with value and origin."));
    return null;
  }
  const origin = readOrigin(value.origin, `${path}.origin`, issues);
  const observedAtMs = readNullableInstant(value.observedAtMs, `${path}.observedAtMs`, issues);
  if (!origin || observedAtMs === undefined) return null;
  if (origin === "unknown") {
    if (value.value != null) {
      issues.push(issue("error", "origin", path, "An unknown fact cannot carry a value."));
      return null;
    }
    const detail = readOptionalDetail(value.detail, `${path}.detail`, issues);
    if (detail === undefined) return null;
    return detail ? { value: null, origin, observedAtMs, detail } : { value: null, origin, observedAtMs };
  }
  const parsed = readValue(value.value, `${path}.value`);
  if (parsed === undefined) return null;
  const detail = readOptionalDetail(value.detail, `${path}.detail`, issues);
  if (detail === undefined) return null;
  const fact: Fact<T> = { value: parsed, origin, observedAtMs };
  if (detail) fact.detail = detail;
  return fact;
}

function readConcurrency(value: unknown, path: string, issues: PortfolioIssue[]): number | "unbounded" | null | undefined {
  if (value == null) return null;
  if (value === "unbounded") return "unbounded";
  return readCount(value, path, issues);
}

function readCount(value: unknown, path: string, issues: PortfolioIssue[]): number | null | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(issue("error", "number", path, "Expected a non-negative safe integer."));
    return undefined;
  }
  return value;
}

function readPercent(value: unknown, path: string, issues: PortfolioIssue[]): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    issues.push(issue("error", "number", path, "usedPercent must be a finite number from 0 to 100."));
    return null;
  }
  return value;
}

function readOptionalBoolean(value: unknown, path: string, issues: PortfolioIssue[]): boolean | null | undefined {
  if (value == null) return null;
  return readBoolean(value, path, issues);
}

function readOptionalString(value: unknown, path: string, issues: PortfolioIssue[]): string | null | undefined {
  if (value == null) return null;
  return readText(value, path, issues);
}

function readStringList(value: unknown, path: string, issues: PortfolioIssue[]): string[] | null {
  if (value == null) return null;
  return readIdList(value, path, issues);
}

function readIdList(value: unknown, path: string, issues: PortfolioIssue[]): string[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "type", path, "Expected a list of strings."));
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const id = readText(value[i], `${path}[${i}]`, issues);
    if (id == null) return null;
    out.push(id);
  }
  return out;
}

function readRows<T>(value: unknown, path: string, readRow: (row: unknown, rowPath: string) => T | null, issues: PortfolioIssue[]): T[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "type", path, "Expected a list."));
    return null;
  }
  const out: T[] = [];
  for (let i = 0; i < value.length; i++) {
    const row = readRow(value[i], `${path}[${i}]`);
    if (!row) return null;
    out.push(row);
  }
  return out;
}

function readArray(value: unknown, path: string, max: number, issues: PortfolioIssue[]): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.push(issue("error", "type", path, "Expected a list."));
    return null;
  }
  if (value.length > max) {
    issues.push(issue("error", "limit", path, `At most ${max} entries are accepted.`));
    return null;
  }
  return value;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, label: string, issues: PortfolioIssue[]): T | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.push(issue("error", "enum", path, `${label} must be one of ${allowed.join(", ")}.`));
    return undefined;
  }
  return value as T;
}

function readOrigin(value: unknown, path: string, issues: PortfolioIssue[]): DataOrigin | null {
  if (typeof value !== "string" || !(DATA_ORIGINS as readonly string[]).includes(value)) {
    issues.push(issue("error", "origin", path, `Origin must be one of ${DATA_ORIGINS.join(", ")}.`));
    return null;
  }
  return value as DataOrigin;
}

function readConfirmedOrigin(value: unknown, path: string, issues: PortfolioIssue[]): "user-provided" | "known" | null {
  const origin = readOrigin(value, path, issues);
  if (!origin) return null;
  if (!CONFIRMED_ORIGINS.has(origin)) {
    issues.push(issue("error", "origin", path, "This fact is accepted only when the owner or a stored row confirmed it."));
    return null;
  }
  return origin as "user-provided" | "known";
}

function readBoolean(value: unknown, path: string, issues: PortfolioIssue[]): boolean | null {
  if (typeof value !== "boolean") {
    issues.push(issue("error", "type", path, "Expected a boolean."));
    return null;
  }
  return value;
}

function readId(value: unknown, path: string, issues: PortfolioIssue[]): string | null {
  const text = readText(value, path, issues);
  if (text == null) return null;
  if (!text.trim()) {
    issues.push(issue("error", "id", path, "Id must not be empty."));
    return null;
  }
  return text;
}

function readNullableId(value: unknown, path: string, issues: PortfolioIssue[]): string | null | undefined {
  if (value == null) return null;
  return readId(value, path, issues) ?? undefined;
}

function readText(value: unknown, path: string, issues: PortfolioIssue[]): string | null {
  if (typeof value !== "string") {
    issues.push(issue("error", "type", path, "Expected a string."));
    return null;
  }
  if (value.length > PORTFOLIO_LIMITS.maxTextLength) {
    issues.push(issue("error", "limit", path, `Text is longer than ${PORTFOLIO_LIMITS.maxTextLength} characters.`));
    return null;
  }
  return value;
}

function readNullableText(value: unknown, path: string, issues: PortfolioIssue[]): string | null | undefined {
  if (value == null) return null;
  return readText(value, path, issues);
}

function readOptionalDetail(value: unknown, path: string, issues: PortfolioIssue[]): string | undefined {
  if (value == null) return "";
  return readText(value, path, issues) ?? undefined;
}

function readInstant(value: unknown, path: string, issues: PortfolioIssue[]): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(issue("error", "time", path, "Expected an epoch millisecond instant."));
    return null;
  }
  return value;
}

function readNullableInstant(value: unknown, path: string, issues: PortfolioIssue[]): number | null | undefined {
  if (value == null) return null;
  return readInstant(value, path, issues) ?? undefined;
}

function readOptionalInstant(value: unknown, path: string, issues: PortfolioIssue[]): number | null | undefined {
  if (value == null) return null;
  return readInstant(value, path, issues) ?? undefined;
}

function readNullableNumber(value: unknown, path: string, issues: PortfolioIssue[]): number | null | undefined {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(issue("error", "number", path, "Expected a non-negative safe integer or null."));
    return undefined;
  }
  return value;
}

function readCurrency(value: unknown, path: string, issues: PortfolioIssue[]): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || !isCurrencyCode(value)) {
    issues.push(issue("error", "currency", path, "Currency must be a three-letter uppercase code."));
    return undefined;
  }
  return value;
}

function readNullableMoney(value: unknown, path: string, issues: PortfolioIssue[]): { currency: string; minor: number } | null | undefined {
  if (value == null) return null;
  if (!isRecord(value)) {
    issues.push(issue("error", "type", path, "Money must be an object."));
    return undefined;
  }
  const currency = readCurrency(value.currency, `${path}.currency`, issues);
  const minor = readCount(value.minor, `${path}.minor`, issues);
  if (currency == null || minor == null) return undefined;
  return { currency, minor };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function issue(severity: "error" | "warning", code: string, path: string, message: string): PortfolioIssue {
  return { severity, code, path, message };
}

function cap(issues: PortfolioIssue[]): PortfolioIssue[] {
  if (issues.length <= PORTFOLIO_LIMITS.maxIssues) return issues;
  return [
    ...issues.slice(0, PORTFOLIO_LIMITS.maxIssues),
    issue("warning", "truncated", "", `${issues.length - PORTFOLIO_LIMITS.maxIssues} further issues were omitted.`),
  ];
}
