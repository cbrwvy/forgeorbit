/**
 * Executor routing recommendations (FO-ORCH01).
 *
 * A recommendation list answers one question for the Owner: "which
 * harness/model could run this task, and what do we actually know about it?"
 * It sits ON TOP of the existing Model Router and preflight. It adds no
 * scoring of its own, invents no quality, price or quota figure, and starts
 * nothing. Every option still goes through preflight → Owner Review →
 * Owner confirmation.
 *
 * Classes
 *  - verified-eligible : the router has current verified evidence for every check.
 *  - potential-unknown : supported and not blocked, but availability/quota is Unknown.
 *                        The Owner MAY choose it explicitly; it is never picked automatically.
 *  - blocked           : a confirmed fact forbids it (disabled, exhausted, denied, Owner rule, CLI).
 *  - unsupported       : structurally incompatible (mode, effort or model not offered).
 *
 * Unknown stays Unknown. Percent-used is never turned into remaining capacity;
 * only the router's own verified `remaining` is read, through its assessment.
 */

import { evaluateAccountEligibility, type AccountResourceEvidence, type AccountEligibility, type ResourceRole } from "../model-router/account-eligibility.ts";
import { quotaCapacityLabel } from "../model-router/resource-context.ts";
import type { CandidateAssessment, ResourceCandidate, RoutingPolicy } from "../model-router/types.ts";
import { ROUTING_POLICIES } from "../model-router/types.ts";
import type { EvidenceState, PreflightResult } from "./preflight.ts";
import { classifyHarnessEvidence } from "./preflight.ts";
import type { PermissionDisclosure } from "./permissions.ts";

export const EXECUTOR_PREFERENCES_KEY = "executorRoutingPreferences";
export const EXECUTOR_LIMITS = { identifier: 200, list: 50, bodyBytes: 8 * 1024 } as const;

/** Owner preferences. Every field is optional in effect: null/empty means "no preference". */
export interface ExecutorPreferences {
  preferredHarnessId: string | null;
  preferredAccountId?: string | null;
  avoidUnverified?: boolean;
  preferredModel: string | null;
  /** null = every registered harness is allowed. */
  allowedHarnessIds: string[] | null;
  forbiddenModels: string[];
  /** A harness mode id (e.g. "ask", "auto"). A harness that does not offer it is unsupported. */
  requiredMode: string | null;
  /**
   * Quality vs. resource priority. Only the existing router policies exist, and a policy
   * orders candidates only when comparable verified metrics exist. It never invents data.
   */
  policy: RoutingPolicy | null;
}

export const EMPTY_EXECUTOR_PREFERENCES: ExecutorPreferences = {
  preferredHarnessId: null, preferredModel: null, allowedHarnessIds: null, forbiddenModels: [], requiredMode: null, policy: null,
};

const SAFE = /^[^\x00-\x1f\x7f]+$/;
function text(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > EXECUTOR_LIMITS.identifier || !SAFE.test(value)) throw `Invalid ${label}.`;
  return value.trim();
}
function list(value: unknown, label: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > EXECUTOR_LIMITS.list) throw `Invalid ${label}.`;
  const out = value.map((item) => text(item, label));
  if (out.some((x) => x === null)) throw `Invalid ${label}.`;
  return [...new Set(out as string[])].sort();
}

/** Strict parser. Throws a string message on the first problem, like the preflight parser. */
export function parseExecutorPreferences(value: unknown): ExecutorPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw "Expected an object.";
  const record = value as Record<string, unknown>;
  const allowed = ["preferredHarnessId", "preferredModel", "allowedHarnessIds", "forbiddenModels", "requiredMode", "policy", "preferredAccountId", "avoidUnverified"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw "Unsupported field.";
  const policy = record.policy;
  if (policy !== undefined && policy !== null && (typeof policy !== "string" || !(ROUTING_POLICIES as readonly string[]).includes(policy))) throw "Invalid policy.";
  const allowedHarnessIds = list(record.allowedHarnessIds, "allowedHarnessIds");
  if (allowedHarnessIds !== null && allowedHarnessIds.length === 0) throw "allowedHarnessIds must name at least one harness, or be null for no restriction.";
  if (record.avoidUnverified !== undefined && typeof record.avoidUnverified !== "boolean") throw "Invalid avoidUnverified.";
  return {
    ...(record.preferredAccountId !== undefined ? { preferredAccountId: text(record.preferredAccountId, "preferredAccountId") } : {}),
    ...(record.avoidUnverified !== undefined ? { avoidUnverified: record.avoidUnverified as boolean } : {}),
    preferredHarnessId: text(record.preferredHarnessId, "preferredHarnessId"),
    preferredModel: text(record.preferredModel, "preferredModel"),
    allowedHarnessIds,
    forbiddenModels: list(record.forbiddenModels, "forbiddenModels") ?? [],
    requiredMode: text(record.requiredMode, "requiredMode"),
    policy: (policy as RoutingPolicy | undefined | null) ?? null,
  };
}

/** Tolerant reader for stored JSON: anything unreadable is "no preferences", never a crash. */
export function readStoredExecutorPreferences(raw: string | null): ExecutorPreferences {
  if (!raw) return { ...EMPTY_EXECUTOR_PREFERENCES };
  try {
    return parseExecutorPreferences(JSON.parse(raw));
  } catch {
    return { ...EMPTY_EXECUTOR_PREFERENCES };
  }
}

export const EXECUTOR_CLASSES = ["verified-eligible", "potential-unknown", "blocked", "unsupported"] as const;
export type ExecutorClass = (typeof EXECUTOR_CLASSES)[number];

export type ExecutorAvailability = "verified-available" | "unknown" | "exhausted" | "denied" | "disabled" | "not-installed" | "not-offered";

export interface ExecutorReason {
  code: string;
  message: string;
}

export interface ExecutorOption {
  resource?: AccountEligibility;
  quota?: string[];
  cost?: CandidateAssessment["expectedCost"];
  id: string;
  harnessId: string;
  harnessLabel: string;
  kind: string;
  modelId: string;
  modelLabel: string;
  classification: ExecutorClass;
  availability: ExecutorAvailability;
  evidence: EvidenceState;
  /** Why this option is listed (Owner preference, task configuration, verified evidence, default model). */
  why: ExecutorReason[];
  /** What is blocking, incompatible or Unknown. */
  limitations: ExecutorReason[];
  /** Router provenance only, never credentials. */
  evidenceSources: string[];
  mode: { id: string; label: string } | null;
  permission: PermissionDisclosure | null;
  preferred: { harness: boolean; model: boolean };
  /** Always true: no option is ever started or applied without Owner Review and confirmation. */
  requiresOwnerConfirmation: true;
  /** May the Owner pick it explicitly? False for blocked and unsupported. */
  selectable: boolean;
}

export interface ExecutorModelSource {
  id: string;
  label: string;
}

export interface ExecutorHarnessSource {
  harness: { id: string; kind: string; label: string; enabled: boolean };
  /** Cached or local-path facts only. null = not known. */
  resourceFor?: (modelId: string, modeId: string) => AccountResourceEvidence;
  cli: { available: boolean | null; loggedIn: boolean | null };
  models: ExecutorModelSource[];
  /** Router assessments for this harness (all models). */
  assessments: readonly CandidateAssessment[];
  /** Snapshot rows for this harness. */
  candidates: readonly Pick<ResourceCandidate, "modelId" | "authorization" | "availability" | "support">[];
  modesFor: (modelId: string) => { id: string; label: string }[];
  /** Supported effort ids for the model, or null when the vocabulary is unknown. */
  effortsFor: (modelId: string) => string[] | null;
  /** The mode a confirmed launch would use for this harness/model. */
  launchMode: (modelId: string) => string;
  permissionFor: (modelId: string, modeId: string) => PermissionDisclosure | null;
}

export interface BuildRecommendationsInput {
  role?: ResourceRole;
  now: number;
  preferences: ExecutorPreferences;
  /** The task's current harness id and model, for the "already configured" reason. */
  task: { harnessId: string; model: string | null };
  requestedEffort: string | null;
  sources: ExecutorHarnessSource[];
  /** The router's own pick; only used to order verified options. */
  routerPick: { harnessId: string | null; modelId: string | null };
  /** What the Owner has selected right now, to explain it and offer alternatives. */
  /** `model` is the model a confirmed launch would use (requested, else the task's, else the default). */
  selection: { harnessId: string; model: string } | null;
}

export interface ExecutorRecommendations {
  readOnly: true;
  /** Nothing here starts, applies or approves anything. */
  executionAvailable: false;
  groups: { [K in ExecutorClass]: ExecutorOption[] };
  /** The existing fail-closed automatic router. Unchanged: no verified candidate means no automatic pick. */
  automaticRouter: { status: "recommended" | "no-verified-candidate"; harnessId: string | null; modelId: string | null };
  /** "none" whenever no option is verified; Owner choice is the only path then. */
  automaticSelection: "none" | "router-verified-only";
  ordering: { policy: RoutingPolicy; basis: "owner-preference-then-verified-evidence"; rankedByQualityOrCost: boolean; note: string };
  selection: { optionId: string | null; classification: ExecutorClass | null; alternatives: ExecutorOption[] } | null;
  preferences: ExecutorPreferences;
  capturedAt: number;
}

const reason = (code: string, message: string): ExecutorReason => ({ code, message });
const optionIdOf = (harnessId: string, modelId: string) => JSON.stringify([harnessId, modelId]);

function quotaExhausted(a: CandidateAssessment): boolean {
  return a.quotaEvidence.some((q) => q.current?.verification === "verified" && q.current.remaining !== null && q.current.remaining <= 0);
}

/** Classify one (harness, model) pair. Pure; structural problems win over blocks, blocks over Unknown. */
function classify(source: ExecutorHarnessSource, model: ExecutorModelSource, input: BuildRecommendationsInput): ExecutorOption {
  const { harness } = source;
  const prefs = input.preferences;
  const mine = source.assessments.filter((a) => a.candidate.modelId === model.id);
  const rows = source.candidates.filter((c) => c.modelId === model.id);
  const modes = source.modesFor(model.id);
  const modeId = source.launchMode(model.id);
  const modeLabel = modes.find((m) => m.id === modeId)?.label ?? null;
  const why: ExecutorReason[] = [];
  const limits: ExecutorReason[] = [];
  const preferred = { harness: prefs.preferredHarnessId === harness.id, model: prefs.preferredModel === model.id };
  if (prefs.preferredAccountId && source.resourceFor?.(model.id, modeId).account?.id === prefs.preferredAccountId) why.push(reason("owner-preferred-account", "You marked this configured account as preferred."));
  if (preferred.harness) why.push(reason("owner-preferred-harness", "You marked this harness as preferred."));
  if (preferred.model) why.push(reason("owner-preferred-model", "You marked this model as preferred."));
  if (input.task.harnessId === harness.id && input.task.model === model.id) why.push(reason("task-configured", "The task is already configured with this harness and model."));

  let classification: ExecutorClass;
  let availability: ExecutorAvailability;

  // 1. Structural incompatibility.
  const unsupported: ExecutorReason[] = [];
  if (prefs.requiredMode && !modes.some((m) => m.id === prefs.requiredMode)) {
    unsupported.push(reason("required-mode-unsupported", `This harness and model do not offer the required permission mode "${prefs.requiredMode}".`));
  }
  if (input.requestedEffort) {
    const efforts = source.effortsFor(model.id);
    if (efforts !== null && !efforts.includes(input.requestedEffort)) unsupported.push(reason("effort-unsupported", `The requested effort "${input.requestedEffort}" is not offered for this harness and model.`));
  }
  if (rows.some((c) => c.support && c.support.verification === "verified" && !!c.support.source && c.support.observedAt <= input.now && c.support.expiresAt !== null && c.support.expiresAt > input.now && c.support.support === "unsupported")) {
    unsupported.push(reason("model-unsupported", "Model support is confirmed unsupported for this account."));
  }
  // 2. Confirmed blocks.
  const blocks: ExecutorReason[] = [];
  const permission = source.permissionFor(model.id, modeId);
  if (permission?.launchAllowed === false) blocks.push(reason("permission-owner-decision", permission.blockReason!));
  let blockAvailability: ExecutorAvailability = "denied";
  if (!harness.enabled) { blocks.push(reason("harness-disabled", "This harness is disabled in Settings.")); blockAvailability = "disabled"; }
  if (source.cli.available === false) { blocks.push(reason("cli-not-installed", "The command-line tool is not installed.")); blockAvailability = "not-installed"; }
  if (source.cli.loggedIn === false) blocks.push(reason("cli-logged-out", "The command-line tool is not logged in."));
  if (prefs.allowedHarnessIds && !prefs.allowedHarnessIds.includes(harness.id)) blocks.push(reason("owner-harness-not-allowed", "Your preferences do not allow this harness."));
  if (prefs.forbiddenModels.includes(model.id)) blocks.push(reason("owner-model-forbidden", "You forbade this model."));
  if (mine.length > 0 && mine.every((a) => a.status === "excluded")) {
    const exhausted = mine.some(quotaExhausted);
    const occupied = mine.some((a) => a.conflicts.length > 0);
    if (exhausted) blocks.push(reason("quota-exhausted", "Verified evidence shows the quota is exhausted."));
    else blocks.push(reason("resource-excluded", [...new Set(mine.flatMap((a) => a.reasons))].join(" ") || "Existing restrictions exclude this resource."));
    if (blockAvailability === "denied" && (exhausted || occupied)) blockAvailability = "exhausted";
  }

  const evidence: EvidenceState = blocks.some((b) => b.code === "harness-disabled") ? "blocked"
    : classifyHarnessEvidence(harness.enabled, mine, rows as never, input.now);

  if (unsupported.length > 0) {
    classification = "unsupported";
    availability = "not-offered";
    limits.push(...unsupported, ...blocks);
  } else if (blocks.length > 0) {
    classification = "blocked";
    availability = blockAvailability;
    limits.push(...blocks);
  } else if (mine.some((a) => a.status === "verified")) {
    classification = "verified-eligible";
    availability = "verified-available";
    why.push(reason("verified-evidence", "Current verified evidence covers every router check."));
  } else {
    classification = "potential-unknown";
    availability = "unknown";
    limits.push(reason("availability-unknown", "Availability is Unknown. Nothing proves capacity or access right now."));
    if (mine.length === 0) limits.push(reason("no-resource-evidence", "No account or quota evidence is registered for this model."));
    else {
      if (!mine.some((a) => a.quotaEvidence.some((q) => q.current?.verification === "verified"))) limits.push(reason("quota-unknown", "Quota is Unknown."));
      if (mine.every((a) => a.candidate.accountId === null)) limits.push(reason("account-unidentified", "No account is identified for this harness."));
    }
    if (rows.length === 0 || !rows.some((c) => c.support?.verification === "verified" && c.support.support === "supported")) {
      limits.push(reason("model-support-unverified", "Model support is not verified."));
    }
  }
  const resource = source.resourceFor ? evaluateAccountEligibility({
    evidence: source.resourceFor(model.id, modeId), role: input.role ?? "developer", kind: harness.kind,
    enabled: harness.enabled, installed: source.cli.available, modeSupported: modeLabel !== null,
    policyBlocked: blocks.length > 0 || unsupported.length > 0, permissionBlocked: permission?.launchAllowed === false,
  }) : undefined;
  if (resource?.state === "ineligible" && classification !== "blocked" && classification !== "unsupported") {
    classification = "blocked";
    availability = "denied";
  }
  if (resource?.state === "unknown" && classification === "verified-eligible") {
    classification = "potential-unknown";
    availability = "unknown";
  }
  if (source.launchMode(model.id) === "" || modeLabel === null) {
    limits.push(reason("mode-unresolved", "The permission mode for this launch could not be resolved."));
  }

  return {
    ...(resource ? { resource, quota: [...new Set(mine.flatMap(a => a.quotaEvidence.map(q => quotaCapacityLabel(q, input.now))))],
      cost: mine.length === 1 ? mine[0]!.expectedCost : null } : {}),
    id: resource ? JSON.stringify([harness.id, resource.evidence.account?.id ?? null, model.id, modeId]) : optionIdOf(harness.id, model.id),
    harnessId: harness.id,
    harnessLabel: harness.label,
    kind: harness.kind,
    modelId: model.id,
    modelLabel: model.label,
    classification,
    availability,
    evidence,
    why,
    limitations: limits,
    evidenceSources: [...new Set(mine.flatMap((a) => a.provenance))].sort().slice(0, 5),
    mode: modeLabel ? { id: modeId, label: modeLabel } : null,
    permission,
    preferred,
    requiresOwnerConfirmation: true,
    selectable: (classification === "verified-eligible" || classification === "potential-unknown") && (!prefs.avoidUnverified || resource?.state === "eligible") && !resource?.reasons.some(r => ["reviewer-read-only-required", "developer-write-required", "manager-read-only-required"].includes(r.code)),
  };
}

function orderKey(option: ExecutorOption, input: BuildRecommendationsInput): number {
  if (option.why.some(w => w.code === "owner-preferred-account")) return -1;
  if (option.preferred.harness && option.preferred.model) return 0;
  if (option.preferred.model) return 1;
  if (option.preferred.harness) return 2;
  if (input.routerPick.harnessId === option.harnessId && input.routerPick.modelId === option.modelId) return 3;
  if (option.why.some((w) => w.code === "task-configured")) return 4;
  return 5;
}

/** Build the grouped list. Pure and deterministic for a given input. */
export function buildExecutorRecommendations(input: BuildRecommendationsInput): ExecutorRecommendations {
  const options: ExecutorOption[] = [];
  for (const source of input.sources) {
    for (const model of source.models) options.push(classify(source, model, input));
  }
  const groups: ExecutorRecommendations["groups"] = { "verified-eligible": [], "potential-unknown": [], blocked: [], unsupported: [] };
  for (const option of options) groups[option.classification].push(option);
  for (const group of Object.values(groups)) {
    group.sort((a, b) => orderKey(a, input) - orderKey(b, input) || a.harnessLabel.localeCompare(b.harnessLabel) || a.modelId.localeCompare(b.modelId));
  }
  const policy = input.preferences.policy ?? "balanced";
  const rankedByMetrics = groups["verified-eligible"].some((o) => {
    const a = input.sources.find((s) => s.harness.id === o.harnessId)?.assessments.find((x) => x.candidate.modelId === o.modelId);
    return !!a && (a.ranking.quality !== null || a.expectedCost !== null || a.ranking.duration !== null || a.ranking.reserve !== null);
  });
  const note = policy === "balanced"
    ? "Options are ordered by your preferences and verified evidence only. No model-quality, price or speed data is assumed."
    : rankedByMetrics
      ? "The policy applies only where comparable verified metrics exist; otherwise options keep the preference order."
      : "No comparable verified metric exists for the chosen priority, so it did not change the order.";
  const verifiedPick = groups["verified-eligible"].find((o) => o.harnessId === input.routerPick.harnessId && o.modelId === input.routerPick.modelId);
  let selection: ExecutorRecommendations["selection"] = null;
  if (input.selection) {
    const chosen = options.find((o) => o.harnessId === input.selection!.harnessId && o.modelId === input.selection!.model);
    const failed = chosen !== undefined && !chosen.selectable;
    selection = {
      optionId: chosen?.id ?? null,
      classification: chosen?.classification ?? null,
      alternatives: failed
        ? [...groups["verified-eligible"], ...groups["potential-unknown"]].filter((o) => o.id !== chosen!.id).slice(0, 3)
        : [],
    };
  }
  return {
    readOnly: true,
    executionAvailable: false,
    groups,
    automaticRouter: { status: verifiedPick ? "recommended" : "no-verified-candidate", harnessId: verifiedPick?.harnessId ?? null, modelId: verifiedPick?.modelId ?? null },
    automaticSelection: verifiedPick ? "router-verified-only" : "none",
    ordering: { policy, basis: "owner-preference-then-verified-evidence", rankedByQualityOrCost: rankedByMetrics && policy !== "balanced", note },
    selection,
    preferences: input.preferences,
    capturedAt: input.now,
  };
}

/** What `POST /employee-execution/recommendations` answers. */
export interface RecommendationResponse {
  recommendations: ExecutorRecommendations;
  /** The preflight view the list rests on (no harness chosen unless the request named one). */
  preflight: PreflightResult;
  routingAvailable: boolean;
}

/**
 * The option a PM review or a plan shows first: the router's own pick when it
 * is still eligible, else the first eligible option, plus up to three others.
 * Verified options come before Potential/Unknown ones. Blocked options never
 * qualify. Pure; starts nothing.
 */
export function pickProposedExecutor(recommendations: ExecutorRecommendations): { proposed: ExecutorOption | null; alternatives: ExecutorOption[] } {
  const eligible = [...recommendations.groups["verified-eligible"], ...recommendations.groups["potential-unknown"]].filter(o => o.selectable);
  const pick = recommendations.automaticRouter;
  const proposed = eligible.find((o) => o.harnessId === pick.harnessId && o.modelId === pick.modelId) ?? eligible[0] ?? null;
  return { proposed, alternatives: eligible.filter((o) => o.id !== proposed?.id).slice(0, 3) };
}

/** PM assignment approval never adopts these run settings or starts a Run. */
export interface AssignmentExecutorReview {
  proposed: ExecutorOption | null;
  alternatives: ExecutorOption[];
  automaticSelection: ExecutorRecommendations["automaticSelection"];
  routingAvailable: boolean;
  reviewToken: string;
  expiresAt: number;
  readOnly: true;
  executionAvailable: false;
}
