import { quotaFact } from "../../shared/accounts/availability.ts";
import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
/**
 * Presentation and request building for FO-009D preview responses.
 *
 * Nothing here ranks candidates, prices a model, or decides eligibility.
 * Groups, reasons, effort, and quota status are copied from the backend
 * payload. Request bodies contain only the fields POST /model-router/preview
 * already accepts.
 */

import type { EstimationResult, Money } from "../../shared/estimation/types.ts";
import { formatMoney } from "@/i18n/estimation";
import type { QuotaState } from "../../shared/accounts/types.ts";
import { parseMoney } from "./accounts.ts";
import {
  ROUTING_POLICIES,
  type CandidateAssessment,
  type Complexity,
  type OwnerRoutingConstraints,
  type RoutingPolicy,
  type RoutingPreview,
  type TaskRequirements,
} from "../../shared/model-router/types.ts";
import type { SpendingPolicy, TaskPriority } from "../../shared/task-scheduling.ts";

export const PREVIEW_BANNER = "Preview only — no resources reserved, no agents started.";

export const POLICY_COPY: Record<RoutingPolicy, { label: string; explanation: string }> = {
  "quality-first": {
    get label() { return tr("common.quality_first"); },
    get explanation() { return tr("common.among_resources_that_already_pass_the_same_eligibility"); },
  },
  balanced: {
    get label() { return tr("common.balanced"); },
    get explanation() { return tr("common.among_eligible_resources_looks_for_pareto_dominance_across"); },
  },
  "cost-efficient": {
    get label() { return tr("common.cost_efficient"); },
    get explanation() { return tr("common.among_eligible_resources_prefers_a_lower_confirmed_task"); },
  },
  "fastest-eligible": {
    get label() { return tr("common.fastest_eligible"); },
    get explanation() { return tr("common.among_eligible_resources_prefers_a_lower_confirmed_task_28c6a2"); },
  },
  "preserve-limited-resources": {
    get label() { return tr("common.preserve_limited_resources"); },
    get explanation() { return tr("common.among_eligible_resources_prefers_a_higher_confirmed_remaining"); },
  },
};

export const TASK_TYPES: TaskRequirements["type"][] = ["general", "backend", "frontend", "testing", "architecture", "documentation", "devops"];
export const COMPLEXITIES: Complexity[] = ["unknown", "low", "medium", "high", "very-high"];
export const SPENDING_CHOICES: SpendingPolicy[] = ["no-extra", "allow-overage", "allow-paid"];
export const PRIORITY_CHOICES: TaskPriority[] = ["critical", "high", "normal", "low"];

export class PreviewDraftError extends Error {}

export interface PreviewDraft {
  policy: RoutingPolicy;
  type: TaskRequirements["type"];
  complexity: Complexity;
  capabilities: string;
  tools: string;
  requiredPermissions: string;
  limitPermissions: boolean;
  allowedPermissions: string;
  contextTokens: string;
  quotaDemands: { quotaId: string; amount: string }[];
  limitHarnesses: boolean;
  allowedHarnesses: string[];
  limitAccounts: boolean;
  allowedAccounts: string[];
  spending: "" | SpendingPolicy;
  currency: string;
  costAmount: string;
  globalConcurrency: string;
  projectPriority: "" | TaskPriority;
  requiredApprovals: string;
}

export const EMPTY_PREVIEW_DRAFT: PreviewDraft = {
  policy: "balanced",
  type: "general",
  complexity: "unknown",
  capabilities: "",
  tools: "",
  requiredPermissions: "",
  limitPermissions: false,
  allowedPermissions: "",
  contextTokens: "",
  quotaDemands: [],
  limitHarnesses: false,
  allowedHarnesses: [],
  limitAccounts: false,
  allowedAccounts: [],
  spending: "",
  currency: "",
  costAmount: "",
  globalConcurrency: "",
  projectPriority: "",
  requiredApprovals: "",
};

export interface PreviewCatalog {
  harnessIds: readonly string[];
  accountIds: readonly string[];
}

export interface TaskPreviewRequest {
  path: string;
  taskId: string;
  policy: RoutingPolicy;
  requirements?: Partial<Pick<TaskRequirements, "type" | "complexity" | "capabilities" | "tools" | "requiredPermissions" | "allowedPermissions" | "contextTokens" | "quotaDemands">>;
  ownerConstraints?: Partial<Pick<OwnerRoutingConstraints, "allowedHarnesses" | "allowedAccounts" | "spending" | "maxExpectedCost" | "globalConcurrency" | "projectPriority" | "requiredApprovals">>;
}

export interface PortfolioPreviewRequest {
  requests: TaskPreviewRequest[];
}

export interface KnownPortfolioTask {
  path: string;
  taskIds: readonly string[];
}

const IDENTIFIER = /^[^\x00-\x1f]{1,2000}$/;

function identifier(value: string, label: string): string {
  const text = value.trim();
  if (!IDENTIFIER.test(text)) throw new PreviewDraftError(`${label} is not valid.`);
  return text;
}

export function splitTokens(raw: string): string[] {
  const items = raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  if (items.length > 64) throw new PreviewDraftError("At most 64 entries.");
  return items.map((item) => identifier(item, "Entry"));
}

function optionalInt(raw: string, label: string): number | null {
  if (!raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim())) throw new PreviewDraftError(`${label} must be a whole number.`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0) throw new PreviewDraftError(`${label} is out of range.`);
  return value;
}

function allowlist(limit: boolean, ids: readonly string[], catalog: readonly string[], label: string): string[] | undefined {
  if (!limit) return undefined;
  if (catalog.length === 0) throw new PreviewDraftError(`${label} list is not available, so a limit cannot be sent.`);
  const unique = [...new Set(ids)];
  if (unique.length > 64) throw new PreviewDraftError(`At most 64 ${label.toLowerCase()} entries.`);
  for (const id of unique) {
    if (!catalog.includes(id)) throw new PreviewDraftError(`${label} is not in the loaded list.`);
  }
  return unique;
}

function requirementsOf(draft: PreviewDraft): NonNullable<TaskPreviewRequest["requirements"]> {
  const requirements: NonNullable<TaskPreviewRequest["requirements"]> = {
    type: draft.type,
    complexity: draft.complexity,
  };
  const capabilities = splitTokens(draft.capabilities);
  const tools = splitTokens(draft.tools);
  const requiredPermissions = splitTokens(draft.requiredPermissions);
  if (capabilities.length) requirements.capabilities = capabilities;
  if (tools.length) requirements.tools = tools;
  if (requiredPermissions.length) requirements.requiredPermissions = requiredPermissions;
  if (draft.limitPermissions) requirements.allowedPermissions = splitTokens(draft.allowedPermissions);
  const contextTokens = optionalInt(draft.contextTokens, "Context tokens");
  if (contextTokens !== null) requirements.contextTokens = contextTokens;
  const demands = draft.quotaDemands.filter((row) => row.quotaId.trim() || row.amount.trim());
  if (demands.length) {
    if (demands.length > 64) throw new PreviewDraftError("At most 64 quota demands.");
    const seen = new Set<string>();
    requirements.quotaDemands = demands.map((row) => {
      const quotaId = identifier(row.quotaId, "Quota id");
      if (seen.has(quotaId)) throw new PreviewDraftError("Duplicate quota demand.");
      seen.add(quotaId);
      const amount = optionalInt(row.amount, "Quota amount");
      if (amount === null) throw new PreviewDraftError("Quota amount is required.");
      return { quotaId, amount };
    });
  }
  return requirements;
}

function costOf(draft: PreviewDraft): Money | undefined {
  const currency = draft.currency.trim();
  const amount = draft.costAmount.trim();
  if (!currency && !amount) return undefined;
  if (!/^[A-Z]{3}$/.test(currency)) throw new PreviewDraftError("Currency must be three letters, for example USD.");
  if (!amount) throw new PreviewDraftError("Enter a maximum expected cost, or clear the currency.");
  try {
    const minor = parseMoney(amount, currency);
    if (minor === null) throw new PreviewDraftError("Enter a maximum expected cost, or clear the currency.");
    return { currency, minor };
  } catch (error) {
    throw new PreviewDraftError(error instanceof Error ? error.message : tr("common.invalid_cost"));
  }
}

function ownerOf(draft: PreviewDraft, catalog: PreviewCatalog, projectPriority: "" | TaskPriority): TaskPreviewRequest["ownerConstraints"] {
  const owner: NonNullable<TaskPreviewRequest["ownerConstraints"]> = {};
  const harnesses = allowlist(draft.limitHarnesses, draft.allowedHarnesses, catalog.harnessIds, "Harness");
  const accounts = allowlist(draft.limitAccounts, draft.allowedAccounts, catalog.accountIds, "Account");
  if (harnesses) owner.allowedHarnesses = harnesses;
  if (accounts) owner.allowedAccounts = accounts;
  if (draft.spending) owner.spending = draft.spending;
  const cost = costOf(draft);
  if (cost) owner.maxExpectedCost = cost;
  const concurrency = optionalInt(draft.globalConcurrency, "Global concurrency");
  if (concurrency !== null) owner.globalConcurrency = concurrency;
  if (projectPriority) owner.projectPriority = projectPriority;
  const approvals = splitTokens(draft.requiredApprovals);
  if (approvals.length) owner.requiredApprovals = approvals;
  return Object.keys(owner).length ? owner : undefined;
}

export function buildTaskPreviewBody(
  projectPath: string,
  taskId: string,
  draft: PreviewDraft,
  allow: { projectPaths: readonly string[] },
  catalog: PreviewCatalog,
  projectPriority: "" | TaskPriority = draft.projectPriority,
): TaskPreviewRequest {
  if (!allow.projectPaths.includes(projectPath)) throw new PreviewDraftError("Project is not a registered project for this task.");
  const body: TaskPreviewRequest = {
    path: identifier(projectPath, "Project"),
    taskId: identifier(taskId, "Task"),
    policy: draft.policy,
    requirements: requirementsOf(draft),
  };
  const owner = ownerOf(draft, catalog, projectPriority);
  if (owner) body.ownerConstraints = owner;
  return body;
}

export function buildPortfolioPreviewBody(
  selected: readonly { path: string; taskId: string }[],
  draft: PreviewDraft,
  projectPriorities: Readonly<Record<string, "" | TaskPriority>>,
  known: readonly KnownPortfolioTask[],
  catalog: PreviewCatalog,
): PortfolioPreviewRequest {
  if (selected.length < 1 || selected.length > 50) throw new PreviewDraftError("Choose 1 to 50 tasks.");
  const seen = new Set<string>();
  const requests = selected.map((item) => {
    const project = known.find((entry) => entry.path === item.path);
    if (!project || !project.taskIds.includes(item.taskId)) throw new PreviewDraftError("Task is not in the loaded portfolio snapshot.");
    if (seen.has(item.taskId)) throw new PreviewDraftError("Duplicate task.");
    seen.add(item.taskId);
    return buildTaskPreviewBody(item.path, item.taskId, draft, { projectPaths: known.map((entry) => entry.path) }, catalog, projectPriorities[item.path] ?? "");
  });
  return { requests };
}

export function complexityLabel(complexity: Complexity): string {
  if (complexity === "unknown") return tr("common.unknown");
  if (complexity === "very-high") return tr("common.very_high");
  return complexity.slice(0, 1).toUpperCase() + complexity.slice(1);
}

export function requirementRows(requirements: TaskRequirements): { label: string; value: string }[] {
  const list = (items: string[] | null, empty: string) => items == null ? empty : items.length ? items.join(", ") : tr("common.none_dc937b");
  return [
    { label: tr("common.task_id"), value: requirements.taskId },
    { label: tr("common.project_985959"), value: requirements.projectId },
    { label: tr("common.task_type"), value: requirements.type },
    { label: tr("common.complexity"), value: complexityLabel(requirements.complexity) },
    { label: tr("common.task_priority"), value: requirements.priority ?? tr("common.unknown") },
    { label: tr("common.required_capabilities"), value: list(requirements.capabilities, "None") },
    { label: tr("common.required_tools"), value: list(requirements.tools, "None") },
    { label: tr("common.required_permissions"), value: list(requirements.requiredPermissions, "None") },
    { label: tr("common.allowed_permissions"), value: list(requirements.allowedPermissions, "Not limited in this preview") },
    { label: tr("common.context_tokens"), value: requirements.contextTokens == null ? tr("common.unknown") : String(requirements.contextTokens) },
    { label: tr("common.quota_demands"), value: requirements.quotaDemands.length ? requirements.quotaDemands.map((demand) => `${demand.quotaId}: ${demand.amount}`).join(", ") : tr("common.none_dc937b") },
  ];
}

export function ownerRows(owner: OwnerRoutingConstraints): { label: string; value: string }[] {
  return [
    { label: tr("common.allowed_harnesses"), value: owner.allowedHarnesses === null ? tr("common.not_limited_in_this_preview") : owner.allowedHarnesses.join(", ") || tr("common.none_allowed") },
    { label: tr("common.allowed_accounts"), value: owner.allowedAccounts === null ? tr("common.not_limited_in_this_preview") : owner.allowedAccounts.join(", ") || tr("common.none_allowed") },
    { label: tr("common.spending_mode"), value: owner.spending ?? tr("common.unknown") },
    { label: tr("common.maximum_expected_cost"), value: owner.maxExpectedCost ? formatMoney(owner.maxExpectedCost) : tr("common.not_set") },
    { label: tr("common.global_concurrency"), value: owner.globalConcurrency == null ? tr("common.unknown") : String(owner.globalConcurrency) },
    { label: tr("common.project_priority"), value: owner.projectPriority ?? tr("common.unknown") },
    { label: tr("common.required_approvals"), value: owner.requiredApprovals.length ? owner.requiredApprovals.map(staticLabel).join("; ") : tr("common.none_returned") },
  ];
}

export interface CandidateGroups {
  recommended: CandidateAssessment | null;
  alternatives: CandidateAssessment[];
  conditional: CandidateAssessment[];
  excluded: CandidateAssessment[];
}

/** Groups follow the payload. A missing recommendation is never filled from the first card. */
export function groupedCandidates(preview: RoutingPreview): CandidateGroups {
  const recommended = preview.status === "recommended" && preview.recommendedCandidate?.status === "verified" ? preview.recommendedCandidate : null;
  return {
    recommended,
    alternatives: preview.alternativeCandidates,
    conditional: preview.conditionalCandidates,
    excluded: preview.excludedCandidates,
  };
}

export function abstentionReasons(preview: RoutingPreview): string[] {
  if (preview.status === "recommended" && preview.recommendedCandidate) return [];
  return [...new Set([...preview.unknownInformation, ...preview.excludedCandidates.flatMap(card => [...card.reasons, ...card.conflicts])])];
}

export function effortPresentation(effort: CandidateAssessment["thinkingEffort"]): { label: string; detail: string } {
  if (effort.status === "not-applicable") return { label: tr("common.no_effort_parameter"), detail: effort.reason };
  if (effort.status === "verified" && effort.value) return { label: effort.value, detail: effort.reason };
  return { label: tr("common.not_verified_for_this_model"), detail: effort.reason };
}

export function accountLabel(accountId: string | null, accounts: readonly { id: string; displayName: string }[]): string {
  if (!accountId) return tr("common.no_account");
  const found = accounts.find((account) => account.id === accountId);
  return found ? `${found.displayName} · ${accountId}` : accountId;
}

export interface QuotaPresentation {
  quotaId: string;
  label: string;
  observedAt: number | null;
  expiresAt: number | null;
  provenance: string;
  verification: string;
  conflict: boolean;
  resetAt: number | null;
}

export function presentQuota(state: QuotaState, now: number): QuotaPresentation {
  const current = state.current;
  // The time, source and verification describe the reading the row is about: the current one, else the
  // newest stored one, so a past reading still says when it was read and by whom (and never reads as capacity).
  const fact = quotaFact(state, now);
  const shown = fact.reading ?? current;
  const observedAt = shown?.observedAt ?? null;
  const expiresAt = shown?.expiresAt ?? null;
  const provenance = shown?.source || shown?.provenance || "unknown";
  // Verification is the CURRENT reading's: a past reading never reads as verified.
  const verification = current?.verification ?? "unknown";
  const resetAt = shown?.resetAt ?? null;
  const expired = (expiresAt != null && expiresAt <= now) || (resetAt != null && resetAt <= now);
  const fresh = expiresAt !== null && expiresAt > now && observedAt !== null && observedAt <= now && (resetAt === null || resetAt > now);
  let label = "Unknown";
  if (state.status === "conflict") label = "Conflicting";
  else if (state.status === "stale" || (state.status === "current" && expired)) label = expired && state.status === "current" ? tr("common.expired_not_current") : tr("common.stale_not_current");
  else if (state.status === "current" && current && verification === "verified" && fresh) {
    label = current.remaining == null ? tr("common.current_remaining_unknown") : tr("common.current_remaining", { p0: String(current.remaining) });
  } else if (fact.kind === "owner-reported" || fact.kind === "observed") label = tr(`d11.fact.${fact.kind}` as "d11.fact.observed");
  return {
    quotaId: state.definition.id,
    label,
    observedAt,
    expiresAt,
    provenance,
    verification,
    conflict: state.status === "conflict",
    resetAt,
  };
}

/** Local display boundaries only. These never refresh providers or re-run the router. */
export function evidenceBoundaries(previews: readonly RoutingPreview[]): number[] {
  return [...new Set(previews.flatMap(preview => {
    const groups = groupedCandidates(preview);
    return [groups.recommended, ...groups.alternatives, ...groups.conditional, ...groups.excluded]
      .flatMap(card => card?.quotaEvidence.flatMap(q => [q.current, ...q.observations]
        .flatMap(o => o ? [o.expiresAt, o.resetAt] : [])) ?? []);
  }).filter((n): n is number => n !== null && Number.isFinite(n)))].sort((a, b) => a - b);
}

export function hasExpiredQuota(card: CandidateAssessment, now: number): boolean {
  return card.quotaEvidence.some(q => q.status === "current" && q.current !== null
    && ((q.current.expiresAt !== null && q.current.expiresAt <= now) || (q.current.resetAt !== null && q.current.resetAt <= now)));
}

export function formatEvidenceTime(value: number | null): string {
  return value == null ? tr("common.unknown") : new Date(value).toISOString();
}

export function sharedResourceNotes(texts: readonly string[]): string[] {
  return [...new Set(texts.filter((text) => /shared subscription|shared pool|quota pool|cross-project/i.test(text)))].sort();
}

export function concurrencyNotes(texts: readonly string[]): string[] {
  return [...new Set(texts.filter((text) => /concurrency|occupied/i.test(text)))].sort();
}

export interface PlanningNote {
  heading: string;
  lines: string[];
}

/** Saved estimate text. Subscription fees are omitted so they cannot be added across tasks. */
export function planningEstimateNote(estimate: EstimationResult | null): PlanningNote {
  const disclaimer = "Planning estimate only. It is not the cost of a launch and it does not reserve quota.";
  if (!estimate) return { heading: tr("common.no_saved_planning_estimate"), lines: [disclaimer] };
  const cash = estimate.scenarios?.expected?.additionalCash;
  const cashLine = cash?.status === "known" && cash.money
    ? tr("common.saved_planning_additional_cash_this_is_not_a", { p0: String(formatMoney(cash.money)) })
    : tr("common.planning_additional_cash_unknown");
  return {
    heading: tr("common.planning_estimate"),
    lines: [
      estimate.ok ? estimate.confidence.summary : tr("common.the_saved_estimate_could_not_be_completed"),
      cashLine,
      ...estimate.missing.slice(0, 6).map((item) => item.message),
      "Subscription commitments are not summed across tasks.",
      disclaimer,
    ],
  };
}

export function previewBoundary(preview: Pick<RoutingPreview, "readOnly" | "execution" | "revalidation">): { ok: boolean; banner: string } {
  const ok = preview.readOnly === true
    && preview.execution === "preview-only"
    && preview.revalidation?.reservesResources === false
    && preview.revalidation?.requiredBeforeExecution === true;
  return ok
    ? { ok: true, banner: staticLabel(PREVIEW_BANNER) }
    : { ok: false, banner: tr("common.this_response_is_not_a_preview_only_result") };
}

export interface AssignmentInput {
  employeeName: string | null;
  revision: number;
}

export interface EmployeeInput {
  jobTitle: string;
  roleCategory: string;
  projectPath: string | null;
  projectName: string | null;
  projectRegistered: boolean;
}

export type EmployeeRecommendation =
  | { status: "loading"; note: string }
  | { status: "unknown"; note: string }
  | { status: "unassigned"; note: string }
  | { status: "assigned"; name: string; role: string; project: string; revision: number; note: string };

const EMPLOYEE_NOTE = "An employee is an organizational assignment. It is not a harness, account, or model. This preview does not change the assignment.";

export function presentAssignment(
  assignment: "error" | null | AssignmentInput,
  employee: "error" | null | EmployeeInput,
): EmployeeRecommendation {
  if (assignment === "error") return { status: "unknown", note: tr("common.assignment_unknown_no_employee_is_assumed", { p0: String(staticLabel(EMPLOYEE_NOTE)) }) };
  if (assignment == null) return { status: "unassigned", note: tr("common.no_employee_is_assigned_to_this_task", { p0: String(staticLabel(EMPLOYEE_NOTE)) }) };
  const role = employee && employee !== "error" ? `${employee.jobTitle} (${employee.roleCategory})` : tr("common.unknown");
  let project = "Unknown";
  if (employee && employee !== "error") {
    project = !employee.projectPath ? tr("common.no_project") : employee.projectRegistered ? (employee.projectName ?? tr("common.unknown")) : tr("common.project_not_registered");
  }
  return {
    status: "assigned",
    name: assignment.employeeName ?? tr("common.name_unknown"),
    role,
    project,
    revision: assignment.revision,
    note: staticLabel(EMPLOYEE_NOTE),
  };
}

export interface PortfolioTaskRow {
  taskId: string;
  projectId: string;
  projectPriority: string;
  taskPriority: string;
  status: RoutingPreview["status"];
  recommendation: string | null;
  conflicts: string[];
  concurrency: string[];
  unknowns: string[];
  estimate: PlanningNote;
}

export interface PortfolioComparison {
  tasks: PortfolioTaskRow[];
  sharedNotes: string[];
  quotaCompetition: string[];
  unresolved: string[];
  crossProjectAllocationWithheld: boolean;
}

function candidateTexts(preview: RoutingPreview): string[] {
  const groups = groupedCandidates(preview);
  const cards = [groups.recommended, ...groups.alternatives, ...groups.conditional, ...groups.excluded].filter((card): card is CandidateAssessment => card != null);
  return cards.flatMap((card) => [...card.reasons, ...card.unknowns, ...card.conflicts]);
}

export function portfolioComparison(
  previews: readonly RoutingPreview[],
  estimates: readonly { taskId: string; estimate: EstimationResult | null }[],
): PortfolioComparison {
  const tasks = previews.map((preview) => {
    const groups = groupedCandidates(preview);
    const texts = candidateTexts(preview);
    const picked = groups.recommended;
    return {
      taskId: preview.requirements.taskId,
      projectId: preview.requirements.projectId,
      projectPriority: preview.ownerConstraints.projectPriority ?? tr("common.unknown"),
      taskPriority: preview.requirements.priority ?? tr("common.unknown"),
      status: preview.status,
      recommendation: picked ? `${picked.candidate.harnessId} · ${picked.candidate.modelId ?? tr("common.model_unknown")}` : null,
      conflicts: [...new Set(texts.filter((text) => /conflict|exhausted|occupied|disallows|exceeds|forbids/i.test(text)))].sort(),
      concurrency: concurrencyNotes(texts),
      unknowns: [...preview.unknownInformation],
      estimate: planningEstimateNote(estimates.find((item) => item.taskId === preview.requirements.taskId)?.estimate ?? null),
    };
  });
  const all = tasks.flatMap((task) => [...task.conflicts, ...task.unknowns, ...task.concurrency]);
  return {
    tasks,
    sharedNotes: sharedResourceNotes(all),
    quotaCompetition: [...new Set(all.filter((text) => /quota/i.test(text)))].sort(),
    unresolved: [...new Set(tasks.flatMap((task) => task.unknowns))].sort(),
    crossProjectAllocationWithheld: tasks.some((task) => task.unknowns.some((text) => text.includes("Project priorities are incomplete"))),
  };
}

export function policies(): RoutingPolicy[] {
  return [...ROUTING_POLICIES];
}
