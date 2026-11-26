/**
 * One resource-eligibility contract (FO-ORCH07.1 / 07.2).
 *
 * Every launch that ForgeOrbit makes on its own authority asks this module the
 * same question about the same router evidence (AccountCore accounts, bindings,
 * model support and quota observations): Employee Execution preflight,
 * Execution Batch starts, Pipeline step starts and the single "Approve &
 * Execute". It lives apart from `employee-execution.ts` so that
 * `project-execution.ts` and `pipeline-runner.ts` can use it without importing
 * the employee layer. It writes nothing, probes no provider and switches
 * nothing.
 */

import { currentFact, routeTask } from "../shared/model-router/route.ts";
import type { CandidateAssessment, OwnerRoutingConstraints, RoutingSnapshot } from "../shared/model-router/types.ts";
import { classifyHarnessEvidence, type EvidenceState } from "../shared/execution/preflight.ts";
import type { ExecutorPreferences } from "../shared/execution/executor-routing.ts";
import { DEFAULT_MODEL, defaultModeFor, type Harness, type Task } from "../shared/types.ts";
import type { ExecutionConfig } from "../shared/project-execution.ts";
import { AccountCore } from "./account-core.ts";
import { agentProfiles, db, harnesses, pipelines } from "./db.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import { buildRoutingSnapshot, projectRoutingInput } from "./model-router.ts";

const unique = (items: string[]) => [...new Set(items)];
void currentFact;
void defaultModeFor;

/** Owner harness allow-list from preferences narrows (never widens) the router's Owner constraints. */
export function withExecutorPreferences(owner: OwnerRoutingConstraints, prefs: ExecutorPreferences): OwnerRoutingConstraints {
  if (!prefs.allowedHarnessIds) return owner;
  const allowed = owner.allowedHarnesses
    ? owner.allowedHarnesses.filter((id) => prefs.allowedHarnessIds!.includes(id))
    : [...prefs.allowedHarnessIds];
  return { ...owner, allowedHarnesses: allowed };
}

export function assessmentsFor(preview: ReturnType<typeof routeTask>): CandidateAssessment[] {
  return [
    ...(preview.recommendedCandidate ? [preview.recommendedCandidate] : []),
    ...preview.alternativeCandidates,
    ...preview.conditionalCandidates,
    ...preview.excludedCandidates,
  ];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * One eligibility decision for a chosen harness + model.
 *
 * Employee preflight and every Execution Batch start ask this same question
 * of the same router evidence (AccountCore accounts, bindings, model support
 * and quota observations). A resource is blocked only by what the router has
 * CONFIRMED for it: a disabled harness, an Owner prohibition, or current
 * verified evidence that every candidate for the launch model (narrowed to the
 * identified account, when a profile names one) is exhausted, denied,
 * unsupported or unavailable. Unknown, stale, unverified, conflicting and
 * percent-only evidence never block and never become "verified": they remain
 * the Owner's call. Another account's or another model's exhaustion is never
 * applied to this one.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ResourceEligibility {
  blocked: boolean;
  code: "harness-disabled" | "owner-policy" | "resource-excluded" | null;
  reasons: string[];
  /** The router's reading of the launch resource. Never upgraded here. */
  evidence: EvidenceState;
  /** False when routing input could not be built; then nothing is blocked and nothing is claimed. */
  evaluated: boolean;
  resource: { harnessId: string; harnessLabel: string; model: string | null; accountId: string | null; accountName: string | null };
  /** Owner-readable sentence naming the affected resource, when blocked. */
  message: string | null;
}

export function decideEligibility(input: {
  harness: Harness;
  model: string | null;
  owner: OwnerRoutingConstraints;
  assessments: readonly CandidateAssessment[];
  identityAccountId: string | null;
  snapshot: RoutingSnapshot;
  now: number;
}): ResourceEligibility {
  const { harness, model, owner, identityAccountId, snapshot, now } = input;
  const mine = input.assessments.filter((a) => a.candidate.harnessId === harness.id && (!identityAccountId || a.candidate.accountId === identityAccountId));
  const named = mine.filter((a) => a.candidate.modelId === model);
  const focused = named.length > 0 ? named : mine;
  const candidates = snapshot.candidates.filter((c) => c.harnessId === harness.id && (!identityAccountId || c.accountId === identityAccountId));
  const evidence: EvidenceState = classifyHarnessEvidence(harness.enabled, focused, candidates, now);
  const accountId = identityAccountId ?? (named.length === 1 ? named[0]!.candidate.accountId : null);
  const accountName = accountId ? snapshot.accounts.find((a) => a.id === accountId)?.displayName ?? null : null;
  const resource = { harnessId: harness.id, harnessLabel: harness.label, model, accountId, accountName };
  const describe = (reasons: string[]) =>
    `${harness.label}${model ? ` · ${model}` : ""}${accountName ? ` · account “${accountName}”` : ""}: ${reasons.join(" ")}`;
  const block = (code: NonNullable<ResourceEligibility["code"]>, reasons: string[]): ResourceEligibility =>
    ({ blocked: true, code, reasons, evidence: "blocked", evaluated: true, resource, message: describe(reasons) });
  if (!harness.enabled) return block("harness-disabled", ["This harness is disabled in Settings."]);
  if (owner.allowedHarnesses && !owner.allowedHarnesses.includes(harness.id)) return block("owner-policy", ["Owner disallows this harness."]);
  if (identityAccountId && owner.allowedAccounts && !owner.allowedAccounts.includes(identityAccountId)) return block("owner-policy", ["Owner disallows this account."]);
  if (named.length > 0 && named.every((a) => a.status === "excluded")) {
    const reasons = unique(named.flatMap((a) => a.reasons));
    return block(reasons.some((r) => /^Owner /.test(r)) ? "owner-policy" : "resource-excluded", reasons.length > 0 ? reasons : ["Existing restrictions exclude this model."]);
  }
  return { blocked: false, code: null, reasons: [], evidence, evaluated: true, resource, message: null };
}

/**
 * The same decision, made from current state, for a launch that is about to
 * happen outside the preflight (Execution Batches). Synchronous on purpose:
 * called inside the transaction that records the run, no other write can
 * interleave. Writes nothing, probes nothing, switches nothing.
 */
export function evaluateResourceEligibility(input: {
  task: Task;
  projectPath: string;
  harness: Harness;
  model: string | null;
  profileId: string | null;
  now?: number;
  snapshot?: () => RoutingSnapshot;
  owner?: (saved: OwnerRoutingConstraints) => OwnerRoutingConstraints;
  preferences?: () => ExecutorPreferences;
}): ResourceEligibility {
  const now = input.now ?? Date.now();
  const resource = { harnessId: input.harness.id, harnessLabel: input.harness.label, model: input.model, accountId: null, accountName: null };
  try {
    const prefs = (input.preferences ?? loadExecutorPreferences)();
    const built = projectRoutingInput(input.projectPath, input.task.id);
    const owner = withExecutorPreferences(input.owner ? input.owner(built.owner) : built.owner, prefs);
    const snapshot = input.snapshot ? input.snapshot() : buildRoutingSnapshot(db, now);
    const preview = routeTask(built.requirements, snapshot, undefined, owner);
    const identity = new AccountCore(db, () => now).resolveIdentity(input.harness.id, input.profileId);
    const decided = decideEligibility({ harness: input.harness, model: input.model, owner, assessments: assessmentsFor(preview), identityAccountId: identity.accountId, snapshot, now });
    // Owner preferences are prohibitions too.
    if (!decided.blocked && input.model && prefs.forbiddenModels.includes(input.model)) {
      const reasons = [`Your preferences forbid the model "${input.model}".`];
      return { ...decided, blocked: true, code: "owner-policy", reasons, evidence: "blocked", message: `${input.harness.label} · ${input.model}: ${reasons[0]}` };
    }
    return decided;
  } catch {
    // Routing input unavailable: nothing is proven either way, so nothing is blocked or called available.
    return { blocked: false, code: null, reasons: [], evidence: "unknown", evaluated: false, resource, message: null };
  }
}


/* ────────────────────────────────────────────────────────────────────────── *
 * A whole execution config: every agent it will run as.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ConfigAgentRef {
  harness: Harness;
  model: string | null;
  profileId: string | null;
}

/** Every agent a config runs as: one, or each pipeline step's. Unknown harnesses are left to the other checks. */
export function configAgents(config: ExecutionConfig, task: Pick<Task, "agentProfileId">): ConfigAgentRef[] {
  const out: ConfigAgentRef[] = [];
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    for (const step of pipeline?.graph.steps ?? []) {
      const profile = step.agentProfileId ? agentProfiles.get(step.agentProfileId) : null;
      const harness = profile ? harnesses.getByIdOrKind(profile.harness) : null;
      if (profile && harness) out.push({ harness, model: profile.model || DEFAULT_MODEL[harness.kind] || null, profileId: profile.id });
    }
    return out;
  }
  const harness = harnesses.getByIdOrKind(config.harness);
  if (harness) out.push({ harness, model: config.model || DEFAULT_MODEL[harness.kind] || null, profileId: config.profileId ?? task.agentProfileId ?? null });
  return out;
}

/** The first blocking verdict among a config's agents, or null. `task` is the board task (a pipeline parent for a pipeline). */
export function configEligibility(input: { task: Task; projectPath: string; config: ExecutionConfig; now?: number }): ResourceEligibility | null {
  for (const agent of configAgents(input.config, input.task)) {
    const verdict = evaluateResourceEligibility({ task: input.task, projectPath: input.projectPath, harness: agent.harness, model: agent.model, profileId: agent.profileId, now: input.now });
    if (verdict.blocked) return verdict;
  }
  return null;
}

/** Owner-readable refusal for a blocked verdict. Nothing was started and nothing was substituted. */
export function eligibilityRefusal(verdict: ResourceEligibility): string {
  return `${verdict.message} Nothing was started, and no other account or model was tried.`;
}
