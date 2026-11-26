/**
 * FO-SELF-IMPROVE01 runtime.
 *
 * Discovers repeated weaknesses, prepares a validated text revision, evaluates
 * it on frozen fixtures, and activates only inside an explicit policy.
 * Generated text is never executed and never grants permissions.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { autonomyNow } from "../autonomy/policy-engine.ts";
import type { ActivityEventType } from "../../shared/activity/types.ts";
import { isBlockedProvider, type AutonomyMode } from "../../shared/autonomy-policy.ts";
import {
  FIXED_EVALUATION_PLAN,
  IMPROVEMENT_HARD_LIMITS,
  canTransition,
  classifyRisk,
  clampLimit,
  compareBaselineToCandidate,
  composeImprovementGuidance,
  contentDiff,
  contentSha,
  describeSample,
  deterministicImprovementDraft,
  emptySnapshot,
  headReport,
  repeatedWeaknesses,
  sampleSizeOf,
  scoreAgainstFixture,
  snapshotSha,
  type FixtureScore,
  validateImprovementContent,
  type FrozenImprovementVersion,
  type HeadReportFacts,
  type ImprovementSnapshot,
  type ImprovementStatus,
  type ImprovementTarget,
} from "../../shared/self-improve/logic.ts";
import { improvementStore, type CandidateRow, type ControlRow } from "./store.ts";

export class SelfImprovementError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SelfImprovementError";
  }
}

let clock = () => Date.now();
export function setImprovementClock(fn: () => number): void {
  clock = fn;
}

export function composeRunImprovementGuidance(snapshot: ImprovementSnapshot | null, taskPrompt: string): string {
  return composeImprovementGuidance(snapshot, taskPrompt);
}

const BASELINE_TEXT = "Implement the requested change and describe the result.";

function now(): number {
  return clock();
}

function ensure(): ControlRow {
  const control = improvementStore.ensureControl(now());
  if (now() - control.periodStartedAt >= IMPROVEMENT_HARD_LIMITS.periodMs) {
    improvementStore.saveControl({
      ...control,
      periodStartedAt: now(),
      candidatesInPeriod: 0,
      activationAttempts: 0,
      updatedAt: now(),
    });
    return improvementStore.control();
  }
  return control;
}

function limits(control: ControlRow) {
  return {
    maxCandidatesPerPeriod: clampLimit(control.maxCandidatesPerPeriod, IMPROVEMENT_HARD_LIMITS.maxCandidatesPerPeriod, IMPROVEMENT_HARD_LIMITS.maxCandidatesPerPeriod),
    maxEvaluationsPerCandidate: clampLimit(control.maxEvaluationsPerCandidate, IMPROVEMENT_HARD_LIMITS.maxEvaluationsPerCandidate, IMPROVEMENT_HARD_LIMITS.maxEvaluationsPerCandidate),
    maxActivationAttempts: clampLimit(control.maxActivationAttempts, IMPROVEMENT_HARD_LIMITS.maxActivationAttempts, IMPROVEMENT_HARD_LIMITS.maxActivationAttempts),
    maxNestedDepth: clampLimit(control.maxNestedDepth, IMPROVEMENT_HARD_LIMITS.maxNestedDepth, IMPROVEMENT_HARD_LIMITS.maxNestedDepth),
    maxConcurrent: clampLimit(control.maxConcurrent, IMPROVEMENT_HARD_LIMITS.maxConcurrentExperiments, IMPROVEMENT_HARD_LIMITS.maxConcurrentExperiments),
    maxRework: clampLimit(control.maxRework, IMPROVEMENT_HARD_LIMITS.maxReworkIterations, IMPROVEMENT_HARD_LIMITS.maxReworkIterations),
    maxDurationMs: Math.min(control.maxDurationMs, IMPROVEMENT_HARD_LIMITS.maxDurationMs),
  };
}

function requireEnabled(control: ControlRow): void {
  if (!control.enabled) throw new SelfImprovementError("Self-improvement is off until the Owner enables it.", 403);
  if (control.stopped) throw new SelfImprovementError("Self-improvement is stopped.", 409);
}

interface PolicyPermission {
  mode: AutonomyMode | null;
  enabled: boolean;
  lowRiskActivation: boolean;
  emergency: boolean;
  policyIds: string[];
}

export function improvementPermissionForProject(projectPath: string): PolicyPermission {
  const emergency = autonomyPolicyStore.readEmergency().active;
  const covering = autonomyPolicyStore.listActivations()
    // An activation past its expiry grants nothing even before the periodic sweep marks it expired.
    .filter((row) => row.status === "active" && row.expiresAt > autonomyNow())
    .map((row) => autonomyPolicyStore.policyRevision(row.policyId, row.revision))
    .filter((policy): policy is NonNullable<typeof policy> => Boolean(policy && policy.body.projects.includes(projectPath)));
  if (covering.length === 0) {
    return { mode: null, enabled: false, lowRiskActivation: false, emergency, policyIds: [] };
  }
  const rank: Record<AutonomyMode, number> = { supervised: 0, autonomous: 1, "full-autonomy": 2 };
  const mode = covering.reduce<AutonomyMode>((min, policy) => (rank[policy.body.mode] < rank[min] ? policy.body.mode : min), covering[0]!.body.mode);
  return {
    mode,
    enabled: covering.every((policy) => policy.body.selfImprovement?.enabled === true),
    lowRiskActivation: covering.every((policy) => policy.body.selfImprovement?.lowRiskActivation === true),
    emergency,
    policyIds: covering.map((policy) => policy.id),
  };
}

function foreignProjects(projectPath: string | null): string[] {
  const paths = new Set<string>();
  for (const observation of improvementStore.listObservations()) paths.add(observation.projectPath);
  for (const candidate of improvementStore.listCandidates()) {
    if (candidate.projectPath) paths.add(candidate.projectPath);
  }
  if (projectPath) paths.delete(projectPath);
  return [...paths];
}

function move(candidate: CandidateRow, to: ImprovementStatus, reason: string, at: number): CandidateRow {
  if (!canTransition(candidate.status, to)) {
    throw new SelfImprovementError(`Cannot move ${candidate.status} to ${to}.`, 409);
  }
  improvementStore.transition(candidate.id, candidate.status, to, reason, at);
  return improvementStore.updateCandidate(candidate.id, { status: to, decisionReason: reason, updatedAt: at });
}

function journal(eventType: ActivityEventType, candidate: CandidateRow, actor: "owner" | "project-manager" | "system"): void {
  const core = new ActivityJournalCore(db);
  core.record({
    eventType,
    actorType: actor,
    actorId: actor,
    targetType: "proposal",
    targetId: candidate.id,
    projectPath: candidate.projectPath,
    idempotencyKey: `${eventType}:${candidate.id}:${candidate.proposedVersion ?? 0}:${candidate.decision ?? "none"}`,
    payload: {
      candidateId: candidate.id,
      role: candidate.role,
      scope: candidate.scope,
      verdict: candidate.decision ?? "none",
      version: candidate.proposedVersion ?? candidate.currentVersion ?? 0,
    },
  });
}

function remember(input: {
  sourceEventId: string;
  projectPath: string;
  title: string;
  content: string;
  verified: boolean;
  /** Overrides the default label. A fixture evaluation is never labeled as an established measurement of model quality. */
  label?: string;
}): void {
  const existing = db.query<{ id: string }, [string, string]>(
    "SELECT id FROM brain_extraction_candidates WHERE source_event_kind = ? AND source_event_id = ?",
  ).get("head_decision", input.sourceEventId);
  if (existing) return;
  const at = now();
  const label = input.label ?? (input.verified ? "Measured record" : "Hypothesis (not an established fact)");
  db.run(
    `INSERT INTO brain_extraction_candidates (
      id, status, source_event_kind, source_event_id, source_record_ids_json, scope_kind, scope_id,
      title, kind, content, confidence, extraction_method, provenance_json, quality_json,
      related_memory_ids_json, created_at, updated_at
    ) VALUES (?, 'candidate', 'head_decision', ?, ?, 'project', ?, ?, 'observation', ?, ?, 'self-improvement', ?, ?, '[]', ?, ?)`,
    [
      randomUUID(),
      input.sourceEventId,
      JSON.stringify([input.sourceEventId]),
      input.projectPath,
      input.title.slice(0, 180),
      `${label}: ${input.content}`.slice(0, 2000),
      input.verified ? 0.8 : 0.4,
      JSON.stringify({
        source: "self-improvement",
        verified: input.verified,
        establishedFact: input.verified,
        note: input.verified
          ? "Stored metrics from the independent checker. This is not a model self-assessment."
          : "A generated hypothesis. It is not an established fact.",
      }),
      JSON.stringify({ pass: true, issues: [], duplicateType: "none", relationship: "new", confidence: input.verified ? 0.8 : 0.4 }),
      at,
      at,
    ],
  );
}

export function setImprovementControl(patch: {
  enabled?: boolean;
  paused?: boolean;
  stopped?: boolean;
  maxCandidatesPerPeriod?: number;
  maxEvaluationsPerCandidate?: number;
  maxActivationAttempts?: number;
  maxNestedDepth?: number;
  maxConcurrent?: number;
  maxRework?: number;
  maxDurationMs?: number;
}): ControlRow {
  const control = ensure();
  const hard = IMPROVEMENT_HARD_LIMITS;
  const reenabled = patch.enabled === true;
  improvementStore.saveControl({
    ...control,
    enabled: patch.enabled ?? control.enabled,
    paused: patch.paused ?? control.paused,
    stopped: patch.stopped ?? control.stopped,
    consecutiveFailures: reenabled ? 0 : control.consecutiveFailures,
    consecutiveNoGain: reenabled ? 0 : control.consecutiveNoGain,
    cooldownUntil: reenabled ? null : control.cooldownUntil,
    maxCandidatesPerPeriod: clampLimit(patch.maxCandidatesPerPeriod ?? control.maxCandidatesPerPeriod, hard.maxCandidatesPerPeriod, control.maxCandidatesPerPeriod),
    maxEvaluationsPerCandidate: clampLimit(patch.maxEvaluationsPerCandidate ?? control.maxEvaluationsPerCandidate, hard.maxEvaluationsPerCandidate, control.maxEvaluationsPerCandidate),
    maxActivationAttempts: clampLimit(patch.maxActivationAttempts ?? control.maxActivationAttempts, hard.maxActivationAttempts, control.maxActivationAttempts),
    maxNestedDepth: clampLimit(patch.maxNestedDepth ?? control.maxNestedDepth, hard.maxNestedDepth, control.maxNestedDepth),
    maxConcurrent: clampLimit(patch.maxConcurrent ?? control.maxConcurrent, hard.maxConcurrentExperiments, control.maxConcurrent),
    maxRework: clampLimit(patch.maxRework ?? control.maxRework, hard.maxReworkIterations, control.maxRework),
    maxDurationMs: Math.min(patch.maxDurationMs ?? control.maxDurationMs, hard.maxDurationMs),
    updatedAt: now(),
  });
  return improvementStore.control();
}

export function recordImprovementObservation(input: {
  role: string;
  projectPath: string;
  fingerprint: string;
  summary: string;
  verified: boolean;
  synthetic?: boolean;
  origin?: "production" | "evaluation";
  source: string;
  sourceId: string;
  evidence?: unknown;
}): { id: string; created: boolean } {
  ensure();
  return improvementStore.insertObservation({
    role: input.role.toLowerCase(),
    projectPath: input.projectPath,
    fingerprint: input.fingerprint,
    summary: input.summary,
    verified: input.verified,
    synthetic: input.synthetic === true,
    origin: input.origin ?? "production",
    source: input.source,
    sourceId: input.sourceId,
    evidence: input.evidence ?? { summary: input.summary },
    createdAt: now(),
  });
}

export function importRepeatedQcFindings(): number {
  ensure();
  const rows = db.query<{
    id: string;
    project_path: string;
    summary: string | null;
    verdict: string | null;
  }, []>(
    `SELECT id, project_path, summary, verdict FROM task_quality_reviews
     WHERE verdict IN ('CHANGES_REQUESTED', 'BLOCKED') AND summary IS NOT NULL`,
  ).all();
  let created = 0;
  for (const row of rows) {
    const summary = (row.summary ?? "").trim();
    if (summary.length < 8) continue;
    const fingerprint = summary.toLowerCase().replace(/\s+/g, " ").slice(0, 180);
    const saved = recordImprovementObservation({
      role: "developer",
      projectPath: row.project_path,
      fingerprint,
      summary,
      verified: true,
      synthetic: false,
      origin: "production",
      source: "qc-review",
      sourceId: row.id,
      evidence: { reviewId: row.id, verdict: row.verdict },
    });
    if (saved.created) {
      created += 1;
      remember({
        sourceEventId: `qc-pattern:${row.id}`,
        projectPath: row.project_path,
        title: `Verified QC failure pattern`,
        content: summary,
        verified: true,
      });
    }
  }
  return created;
}

export function discoverImprovementCandidates(): CandidateRow[] {
  const control = ensure();
  requireEnabled(control);
  if (control.paused) throw new SelfImprovementError("Self-improvement is paused.", 409);
  if (control.cooldownUntil && now() < control.cooldownUntil) {
    throw new SelfImprovementError("Self-improvement is in a cooldown after repeated failures.", 409);
  }
  if (control.consecutiveNoGain >= 2) {
    throw new SelfImprovementError("Self-improvement stopped after no measurable improvement.", 409);
  }
  importRepeatedQcFindings();
  const cap = limits(control);
  const created: CandidateRow[] = [];
  const observations = improvementStore.listObservations();
  for (const weakness of repeatedWeaknesses(observations)) {
    const artifactKey = `skill:${weakness.role}:project:${weakness.projectPath}:validation`;
    const history = improvementStore.listCandidates().filter((candidate) => candidate.artifactKey === artifactKey);
    if (history.some((candidate) => !["rejected", "expired", "rolled_back", "retained"].includes(candidate.status))) continue;
    // Evidence that already produced a candidate (rejected, failed, rolled back or kept) is spent. The same two
    // observations never start another candidate; only evidence not cited before can.
    const spent = new Set(history.flatMap((candidate) => (candidate.evidence as Array<{ observationId?: string }>).map((item) => item.observationId)));
    if (weakness.evidenceIds.every((id) => spent.has(id))) continue;
    if (control.candidatesInPeriod + created.length >= cap.maxCandidatesPerPeriod) break;
    const at = now();
    if (!improvementStore.version(artifactKey, 1)) {
      improvementStore.insertVersion({
        artifactKey,
        version: 1,
        scope: "project",
        projectPath: weakness.projectPath,
        role: weakness.role,
        targetKind: "skill",
        content: BASELINE_TEXT,
        contentSha: contentSha(BASELINE_TEXT),
        parentVersion: null,
        source: "baseline",
        createdAt: at,
      });
    }
    // A candidate improves what is in force: the active revision, or the baseline when none is active.
    const currentVersion = improvementStore.activeVersionFor(artifactKey, weakness.role, "project", weakness.projectPath) ?? 1;
    const current = improvementStore.version(artifactKey, currentVersion);
    const bySource = new Map(observations.map((observation) => [observation.id, observation]));
    const candidate = improvementStore.insertCandidate({
      status: "observed",
      targetKind: "skill",
      role: weakness.role,
      scope: "project",
      projectPath: weakness.projectPath,
      artifactKey,
      currentVersion,
      proposedVersion: null,
      currentContent: current?.content ?? BASELINE_TEXT,
      proposedContent: null,
      diffText: null,
      evidence: weakness.evidenceIds.map((id) => ({
        observationId: id,
        source: bySource.get(id)?.source ?? "unknown",
        sourceId: bySource.get(id)?.sourceId ?? null,
        summary: weakness.summary,
        verified: true,
      })),
      hypothesis: null,
      expectedResult: null,
      evaluationPlan: FIXED_EVALUATION_PLAN,
      risk: "low",
      authorization: "none",
      metrics: null,
      decision: null,
      decisionReason: null,
      depth: 0,
      parentCandidateId: null,
      synthetic: false,
      expiresAt: at + 7 * 24 * 60 * 60 * 1000,
      createdAt: at,
      updatedAt: at,
    });
    created.push(candidate);
  }
  if (created.length > 0) {
    improvementStore.saveControl({ ...improvementStore.control(), candidatesInPeriod: control.candidatesInPeriod + created.length, updatedAt: now() });
  }
  return created;
}

function writeProposal(candidate: CandidateRow, proposedContent: string, hypothesis: string, expectedResult: string): CandidateRow {
  const verdict = validateImprovementContent({
    currentContent: candidate.currentContent,
    proposedContent,
    projectPath: candidate.projectPath,
    foreignProjectPaths: foreignProjects(candidate.projectPath),
    targetKind: candidate.targetKind,
  });
  if (!verdict.ok) {
    const rejected = move(candidate, "rejected", verdict.reason, now());
    return improvementStore.updateCandidate(rejected.id, { decision: "rejected", decisionReason: verdict.reason, updatedAt: now() });
  }
  const diff = contentDiff(candidate.currentContent, proposedContent.trim());
  const risk = classifyRisk(candidate.targetKind, diff);
  // Version numbers only grow: a rejected or rolled-back revision keeps its number, and the next one never reuses it.
  const version = improvementStore.maxVersion(candidate.artifactKey) + 1;
  const at = now();
  improvementStore.insertVersion({
    artifactKey: candidate.artifactKey,
    version,
    scope: candidate.scope,
    projectPath: candidate.projectPath,
    role: candidate.role,
    targetKind: candidate.targetKind,
    content: proposedContent.trim(),
    contentSha: contentSha(proposedContent.trim()),
    parentVersion: candidate.currentVersion,
    source: "candidate",
    createdAt: at,
  });
  const moved = move(candidate, "proposed", "Prepared a validated revision.", at);
  const saved = improvementStore.updateCandidate(moved.id, {
    proposedVersion: version,
    proposedContent: proposedContent.trim(),
    diffText: diff,
    hypothesis,
    expectedResult,
    evaluationPlan: FIXED_EVALUATION_PLAN,
    risk,
    authorization: risk === "low" ? "policy-low-risk" : "owner",
    updatedAt: at,
  });
  journal("improvement.candidate.proposed", saved, "project-manager");
  remember({
    sourceEventId: `hypothesis:${saved.id}`,
    projectPath: saved.projectPath ?? "company",
    title: "Improvement hypothesis",
    content: hypothesis,
    verified: false,
  });
  return saved;
}

export function prepareImprovementCandidate(id: string): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "observed") throw new SelfImprovementError("Only an observed candidate can be prepared.", 409);
  const draft = deterministicImprovementDraft({
    currentContent: candidate.currentContent,
    weakness: candidate.evidence.map((item) => JSON.stringify(item)).join(" "),
  });
  if ("error" in draft) {
    return move(candidate, "rejected", draft.error, now());
  }
  return writeProposal(candidate, draft.proposedContent, draft.hypothesis, draft.expectedResult);
}

export async function prepareImprovementFromHarness(id: string, resource: {
  provider: string;
  model: string;
  accountId?: string | null;
}): Promise<CandidateRow> {
  const control = ensure();
  requireEnabled(control);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "observed") throw new SelfImprovementError("Only an observed candidate can be prepared.", 409);
  const { requestImprovementDraft } = await import("./harness-eval.ts");
  const draft = await requestImprovementDraft({
    currentContent: candidate.currentContent,
    weakness: candidate.evidence.map((item) => JSON.stringify(item)).join(" "),
    provider: resource.provider,
    model: resource.model,
    accountId: resource.accountId ?? null,
  });
  if ("error" in draft) return move(candidate, "rejected", draft.error, now());
  const saved = writeProposal(candidate, draft.proposedContent, draft.hypothesis, draft.expectedResult);
  return improvementStore.updateCandidate(saved.id, {
    metrics: {
      ...(saved.metrics ?? {}),
      generation: draft.generation,
      inferenceCompleted: draft.inferenceCompleted,
      provider: resource.provider,
      model: resource.model,
      accountId: resource.accountId ?? null,
      quota: "unknown",
      costUsd: null,
    },
    updatedAt: now(),
  });
}

export async function evaluateImprovementWithHarness(id: string, resource: {
  provider: string;
  model: string;
  accountId?: string | null;
  tasks: Array<{ name: string; requirements: string; files: Record<string, string>; outputPath: string; testPath: string; heldOut?: boolean }>;
}): Promise<CandidateRow> {
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  const { executeHarnessComparison } = await import("./harness-eval.ts");
  const measured = await executeHarnessComparison({
    candidateId: id,
    projectPath: candidate.projectPath,
    baselineContent: candidate.currentContent,
    candidateContent: candidate.proposedContent ?? "",
    provider: resource.provider,
    model: resource.model,
    accountId: resource.accountId ?? null,
    tasks: resource.tasks,
  });
  return evaluateImprovementCandidate(id, {
    provider: resource.provider,
    model: resource.model,
    accountId: resource.accountId,
    measured,
  });
}

function authorizedTestGrant(projectPath: string) {
  for (const activation of autonomyPolicyStore.listActivations()) {
    if (activation.status !== "active") continue;
    const policy = autonomyPolicyStore.policyRevision(activation.policyId, activation.revision);
    if (!policy?.body.permittedActions.includes("run_observed_test")) continue;
    const grant = policy.body.authorizedTests?.find((item) => item.projectPath === projectPath);
    if (grant) return grant;
  }
  return null;
}

/** Compares a proposed skill on the Owner's already-authorized Bun test. It does not activate the skill. */
export async function evaluateCandidateOnAuthorizedTest(id: string, resource: {
  provider: string;
  model: string;
  accountId?: string | null;
}): Promise<CandidateRow> {
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (!candidate.projectPath) throw new SelfImprovementError("The candidate is not bound to a project.", 409);
  const grant = authorizedTestGrant(candidate.projectPath);
  if (!grant) throw new SelfImprovementError("No active Owner policy authorizes a fixed test for this project.", 409);
  const testPath = grant.command.startsWith("bun test ./") ? grant.command.slice("bun test ./".length) : "";
  if (!testPath || testPath.split("/").includes("..")) throw new SelfImprovementError("The authorized test path is not usable.", 409);
  let source = "";
  try {
    source = readFileSync(path.join(candidate.projectPath, testPath), "utf8");
  } catch {
    throw new SelfImprovementError("The authorized test file could not be read.", 409);
  }
  const outputPath = grant.outputPaths[0];
  if (!outputPath) throw new SelfImprovementError("The authorized test has no output path.", 409);
  const files = { [testPath]: source };
  const requirements = "Satisfy the Owner-approved test. Do not invent another command.";
  return evaluateImprovementWithHarness(id, {
    provider: resource.provider,
    model: resource.model,
    accountId: resource.accountId,
    tasks: [
      { name: "train", requirements, files, outputPath, testPath, heldOut: false },
      { name: "held", requirements, files, outputPath, testPath, heldOut: true },
    ],
  });
}

export function proposeImprovementContent(id: string, proposedContent: string): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "observed") throw new SelfImprovementError("Only an observed candidate can be prepared.", 409);
  return writeProposal(
    candidate,
    proposedContent,
    "Hypothesis (not an established fact): the supplied revision addresses the observed weakness.",
    "Measured by the independent fixture checker, not by text inside the proposal.",
  );
}

export function registerImprovementFixture(input: {
  name: string;
  role: string;
  projectPath?: string | null;
  heldOut: boolean;
  fingerprint: string;
  mustInclude: string[];
  mustNotInclude: string[];
}): string {
  ensure();
  return improvementStore.insertFixture({
    name: input.name,
    role: input.role.toLowerCase(),
    projectPath: input.projectPath ?? null,
    heldOut: input.heldOut,
    fingerprint: input.fingerprint,
    mustInclude: input.mustInclude,
    mustNotInclude: input.mustNotInclude,
    createdAt: now(),
  });
}

export function evaluateImprovementCandidate(id: string, resource: {
  provider: string;
  model: string;
  baselineModel?: string;
  accountId?: string | null;
  providerError?: boolean;
  resourceUnavailable?: boolean;
  measured?: {
    execution: "synthetic-driver" | "provider" | "refused-real" | "deterministic-text";
    inferenceCompleted: boolean;
    note?: string;
    fixtures?: Array<{ heldOut: boolean; baseline: FixtureScore; candidate: FixtureScore }>;
  };
} ): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  if (control.paused) throw new SelfImprovementError("Self-improvement is paused.", 409);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "proposed") throw new SelfImprovementError("Only a proposed candidate can be evaluated.", 409);
  const blocked = isBlockedProvider(resource.provider, resource.model);
  if (blocked) throw new SelfImprovementError(blocked, 403);
  const cap = limits(control);
  const attempts = improvementStore.evaluationAttempts(id);
  if (attempts >= cap.maxEvaluationsPerCandidate) {
    throw new SelfImprovementError("The evaluation budget for this candidate is exhausted.", 409);
  }
  if (improvementStore.countRunningEvaluations() >= cap.maxConcurrent) {
    throw new SelfImprovementError("The concurrent experiment limit is full.", 409);
  }
  const permission = improvementPermissionForProject(candidate.projectPath ?? "");
  if (permission.emergency) throw new SelfImprovementError("Emergency stop is active.", 409);
  const baselineRow = candidate.currentVersion == null ? null : improvementStore.version(candidate.artifactKey, candidate.currentVersion);
  const candidateRow = candidate.proposedVersion == null ? null : improvementStore.version(candidate.artifactKey, candidate.proposedVersion);
  if (!baselineRow || !candidateRow || baselineRow.content !== candidate.currentContent || candidateRow.content !== (candidate.proposedContent ?? "")) {
    throw new SelfImprovementError("The candidate text does not match its stored revisions, so it cannot be evaluated.", 409);
  }
  const started = now();
  const running = move(candidate, "evaluating", "Evaluation started.", started);
  const permissionKey = `evaluate:${id}:${attempts + 1}`;
  const fixtures = improvementStore.fixturesFor(candidate.role, candidate.projectPath);
  const evaluationId = improvementStore.insertEvaluation({
    candidateId: id,
    attempt: attempts + 1,
    fixtureIds: fixtures.map((fixture) => fixture.id),
    provider: resource.provider,
    model: resource.model,
    baselineModel: resource.baselineModel ?? resource.model,
    accountId: resource.accountId ?? null,
    permissionKey,
    startedAt: started,
    baselineVersion: baselineRow.version,
    baselineSha: baselineRow.contentSha,
    candidateVersion: candidateRow.version,
    candidateSha: candidateRow.contentSha,
  });
  const elapsed = now() - started;
  if (elapsed > cap.maxDurationMs) {
    return finishInconclusive(running, evaluationId, "The evaluation exceeded its duration limit.");
  }
  if (resource.measured?.execution === "refused-real" || (resource.measured && !resource.measured.fixtures)) {
    return finishInconclusive(running, evaluationId, resource.measured?.note ?? "Real inference was not authorized. No provider request was sent.");
  }
  const proposed = candidate.proposedContent ?? "";
  const scored = resource.measured?.fixtures ?? fixtures.map((fixture) => ({
    heldOut: fixture.heldOut,
    baseline: scoreAgainstFixture(candidate.currentContent, fixture),
    candidate: scoreAgainstFixture(proposed, fixture),
  }));
  const comparison = compareBaselineToCandidate({
    baselineModel: resource.baselineModel ?? resource.model,
    candidateModel: resource.model,
    providerError: resource.providerError === true,
    resourceUnavailable: resource.resourceUnavailable === true,
    fixtures: scored,
  });
  const finishedAt = now();
  improvementStore.finishEvaluation(evaluationId, {
    status: comparison.verdict === "inconclusive" ? "inconclusive" : "finished",
    baseline: scored.map((item) => item.baseline),
    candidate: scored.map((item) => item.candidate),
    verdict: comparison.verdict,
    attribution: comparison.attribution,
    finishedAt,
    sampleSize: scored.length,
    execution: resource.measured?.execution ?? "deterministic-text",
  });
  const sample = sampleSizeOf(scored);
  const reason = `${describeSample(sample)}: ${comparison.reason}`;
  let next = move(running, "evaluated", reason, finishedAt);
  const baselineErrors = scored.reduce((sum, item) => sum + item.baseline.errors, 0);
  const candidateErrors = scored.reduce((sum, item) => sum + item.candidate.errors, 0);
  next = improvementStore.updateCandidate(next.id, {
    decision: comparison.verdict,
    decisionReason: reason,
    metrics: {
      evaluationKind: "fixture-evaluation",
      evaluationId,
      sampleSize: sample,
      baselineVersion: baselineRow.version,
      candidateVersion: candidateRow.version,
      baselineSha: baselineRow.contentSha,
      candidateSha: candidateRow.contentSha,
      provider: resource.provider,
      model: resource.model,
      baselineModel: resource.baselineModel ?? resource.model,
      accountId: resource.accountId ?? null,
      quota: "unknown",
      costUsd: null,
      tokens: null,
      attribution: comparison.attribution,
      baselineErrors,
      candidateErrors,
      fixtures: scored,
      execution: resource.measured?.execution ?? "deterministic-text",
      inferenceCompleted: resource.measured?.inferenceCompleted === true,
    },
    updatedAt: finishedAt,
  });
  if (comparison.verdict === "fail") {
    next = move(next, "rejected", reason, finishedAt);
    const fresh = improvementStore.control();
    const failures = fresh.consecutiveFailures + 1;
    improvementStore.saveControl({
      ...fresh,
      consecutiveFailures: failures,
      cooldownUntil: failures >= 3 ? finishedAt + 60 * 60 * 1000 : fresh.cooldownUntil,
      updatedAt: finishedAt,
    });
  } else if (comparison.verdict === "inconclusive") {
    const fresh = improvementStore.control();
    improvementStore.saveControl({ ...fresh, consecutiveNoGain: fresh.consecutiveNoGain + 1, updatedAt: finishedAt });
  } else {
    const fresh = improvementStore.control();
    improvementStore.saveControl({ ...fresh, consecutiveFailures: 0, consecutiveNoGain: 0, cooldownUntil: null, updatedAt: finishedAt });
  }
  journal("improvement.evaluated", next, "project-manager");
  remember({
    sourceEventId: `evaluation:${next.id}:${attempts + 1}`,
    projectPath: next.projectPath ?? "company",
    title: `Improvement evaluation ${comparison.verdict}`,
    content: `${reason} Baseline errors ${baselineErrors}. Candidate errors ${candidateErrors}. Attribution ${comparison.attribution}. Quota Unknown. Execution ${resource.measured?.execution ?? "deterministic-text"}${resource.measured?.inferenceCompleted ? "" : ", no model completed"}.`,
    verified: resource.measured?.execution === "provider" && resource.measured.inferenceCompleted === true,
    label: resource.measured?.execution === "provider" && resource.measured.inferenceCompleted === true
      ? "Fixture evaluation record (provider run)"
      : "Fixture evaluation record (synthetic or text check; not evidence of model quality)",
  });
  return next;
}

function finishInconclusive(candidate: CandidateRow, evaluationId: string, reason: string): CandidateRow {
  const at = now();
  improvementStore.finishEvaluation(evaluationId, {
    status: "inconclusive",
    baseline: [],
    candidate: [],
    verdict: "inconclusive",
    attribution: "instruction-quality",
    finishedAt: at,
    sampleSize: 0,
  });
  const evaluated = move(candidate, "evaluated", reason, at);
  return improvementStore.updateCandidate(evaluated.id, { decision: "inconclusive", decisionReason: reason, updatedAt: at });
}

/**
 * A "pass" counts only when a finished evaluation recorded it for exactly these revisions: the evaluated baseline is
 * the revision still in force, the evaluated candidate is the stored proposed revision, both hashes match the
 * immutable version rows, and the sample held a training and a held-out fixture.
 */
function requireTraceableEvaluation(candidate: CandidateRow): void {
  const evaluation = improvementStore.latestFinishedEvaluation(candidate.id);
  if (!evaluation || evaluation.verdict !== "pass" || evaluation.status !== "finished") {
    throw new SelfImprovementError("No finished passing evaluation is recorded for this candidate.", 409);
  }
  if ((evaluation.sampleSize ?? 0) < 2) {
    throw new SelfImprovementError("The passing evaluation did not use a training and a held-out fixture.", 409);
  }
  if (candidate.proposedVersion == null || candidate.currentVersion == null
    || evaluation.candidateVersion !== candidate.proposedVersion || evaluation.baselineVersion !== candidate.currentVersion) {
    throw new SelfImprovementError("The evaluation belongs to other revisions than this candidate.", 409);
  }
  const proposed = improvementStore.version(candidate.artifactKey, candidate.proposedVersion);
  const baseline = improvementStore.version(candidate.artifactKey, candidate.currentVersion);
  if (!proposed || !baseline || proposed.contentSha !== evaluation.candidateSha || baseline.contentSha !== evaluation.baselineSha) {
    throw new SelfImprovementError("The evaluated text no longer matches the stored revisions.", 409);
  }
  const inForce = improvementStore.activeVersionFor(candidate.artifactKey, candidate.role, candidate.scope, candidate.projectPath) ?? 1;
  if (inForce !== candidate.currentVersion) {
    throw new SelfImprovementError("The revision in force changed after this evaluation. Reject the candidate and start from current evidence.", 409);
  }
}

export function approveImprovementCandidate(id: string, actor: "owner" | "head"): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.decision !== "pass") throw new SelfImprovementError("Only a passing evaluation can be approved.", 409);
  if (candidate.status === "evaluated") requireTraceableEvaluation(candidate);
  if (actor === "head") {
    const permission = improvementPermissionForProject(candidate.projectPath ?? "");
    if (!permission.enabled || permission.mode === "supervised" || permission.mode == null) {
      throw new SelfImprovementError("Head cannot approve an improvement without an Owner self-improvement policy.", 403);
    }
    if (candidate.risk !== "low" || !permission.lowRiskActivation) {
      throw new SelfImprovementError("This improvement needs Owner approval.", 403);
    }
  }
  return move(candidate, "approved", actor === "owner" ? "Owner approved the improvement." : "Policy approved a low-risk improvement.", now());
}

export function rejectImprovementCandidate(id: string, reason = "Owner rejected the improvement."): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (!["observed", "proposed", "evaluated", "approved"].includes(candidate.status)) {
    throw new SelfImprovementError("This candidate can no longer be rejected.", 409);
  }
  const rejected = move(candidate, "rejected", reason, now());
  return improvementStore.updateCandidate(rejected.id, { decision: "rejected", decisionReason: reason, updatedAt: now() });
}

export function activateImprovementCandidate(id: string, input: {
  actor: "owner" | "head";
  strategy?: "manual" | "policy-low-risk" | "canary" | "project" | "role" | "full";
  allowGlobal?: boolean;
}): CandidateRow {
  const control = ensure();
  requireEnabled(control);
  if (control.paused && input.actor === "head") throw new SelfImprovementError("Self-improvement is paused.", 409);
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.decision !== "pass") throw new SelfImprovementError("A candidate that did not pass cannot be activated.", 409);
  if (candidate.status === "evaluated" || candidate.status === "approved") requireTraceableEvaluation(candidate);
  const permission = improvementPermissionForProject(candidate.projectPath ?? "");
  if (permission.emergency) throw new SelfImprovementError("Emergency stop is active.", 409);
  const cap = limits(control);
  if (control.activationAttempts >= cap.maxActivationAttempts) {
    throw new SelfImprovementError("The activation attempt budget is exhausted.", 409);
  }
  let strategy = input.strategy ?? (input.actor === "head" ? "policy-low-risk" : "project");
  if (strategy === "full" || strategy === "role" || candidate.scope === "global") {
    throw new SelfImprovementError("A fixture evaluation cannot activate an improvement outside its project.", 403);
  }
  if (input.allowGlobal) {
    throw new SelfImprovementError("Global activation is not granted by a synthetic evaluation.", 403);
  }
  if (input.actor === "head") {
    if (!permission.enabled || !permission.lowRiskActivation || permission.mode === "supervised" || permission.mode == null) {
      throw new SelfImprovementError("The Owner policy does not allow automatic activation.", 403);
    }
    if (candidate.risk !== "low") throw new SelfImprovementError("Automatic activation is limited to low-risk revisions.", 403);
    strategy = "policy-low-risk";
  }
  let current = candidate;
  if (current.status === "evaluated") {
    if (input.actor !== "owner" && input.actor !== "head") throw new SelfImprovementError("Approval is required.", 403);
    current = approveImprovementCandidate(id, input.actor);
  }
  if (current.status !== "approved") throw new SelfImprovementError("The candidate is not approved.", 409);
  const at = now();
  const previous = improvementStore.supersedeActive(current.artifactKey, current.role, current.scope, current.projectPath);
  improvementStore.insertActivation({
    candidateId: current.id,
    artifactKey: current.artifactKey,
    version: current.proposedVersion ?? 1,
    scope: current.scope,
    projectPath: current.projectPath,
    role: current.role,
    strategy,
    // Only a revision that was actually in force is "known good". With none active before, rollback restores nothing.
    lastKnownGoodVersion: previous,
    canaryLimit: strategy === "canary" ? 1 : null,
    activatedAt: at,
  });
  const active = move(current, "active", `Activated with strategy ${strategy}.`, at);
  const monitoring = move(active, "monitoring", "Monitoring subsequent eligible runs.", at);
  improvementStore.saveControl({ ...improvementStore.control(), activationAttempts: control.activationAttempts + 1, updatedAt: at });
  journal("improvement.activated", monitoring, input.actor === "owner" ? "owner" : "project-manager");
  remember({
    sourceEventId: `activation:${monitoring.id}`,
    projectPath: monitoring.projectPath ?? "company",
    title: "Improvement activated",
    content: `${monitoring.artifactKey} version ${monitoring.proposedVersion} is active for ${monitoring.projectPath} role ${monitoring.role}. Strategy ${strategy}.`,
    verified: true,
  });
  return monitoring;
}

export function rollbackImprovementCandidate(id: string, reason: string, actor: "owner" | "head" = "owner"): CandidateRow {
  ensure();
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "monitoring" && candidate.status !== "active" && candidate.status !== "retained") {
    throw new SelfImprovementError("Only an active improvement can be rolled back.", 409);
  }
  if (actor === "head") {
    const permission = improvementPermissionForProject(candidate.projectPath ?? "");
    if (!permission.enabled || permission.mode === "supervised" || permission.mode == null) {
      throw new SelfImprovementError("Head cannot roll back without an Owner self-improvement policy.", 403);
    }
  }
  const activation = improvementStore.latestActivation(id);
  if (!activation || activation.status !== "active") throw new SelfImprovementError("No active version is recorded.", 409);
  const at = now();
  improvementStore.rollbackActivation(activation.id, reason, at);
  if (activation.lastKnownGoodVersion != null) {
    // Puts the earlier activation back exactly as it was. It never mints an activation for text nobody activated.
    improvementStore.reactivateVersion(
      activation.artifactKey,
      activation.role,
      activation.scope,
      activation.projectPath,
      activation.lastKnownGoodVersion,
    );
  }
  const rolled = move(candidate, "rolled_back", reason, at);
  const saved = improvementStore.updateCandidate(rolled.id, { decision: "rolled_back", decisionReason: reason, updatedAt: at });
  journal("improvement.rolled_back", saved, actor === "owner" ? "owner" : "project-manager");
  remember({
    sourceEventId: `rollback:${saved.id}`,
    projectPath: saved.projectPath ?? "company",
    title: "Improvement rolled back",
    content: reason,
    verified: true,
  });
  return saved;
}

export function recordMonitoredOutcome(id: string, errors: number): CandidateRow {
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  if (candidate.status !== "monitoring") throw new SelfImprovementError("The candidate is not being monitored.", 409);
  const metrics = candidate.metrics as { baselineErrors?: number } | null;
  const baseline = metrics?.baselineErrors ?? 0;
  if (errors > baseline) {
    return rollbackImprovementCandidate(id, `Monitored errors ${errors} exceeded the baseline ${baseline}.`, "head");
  }
  return candidate;
}

export function retainImprovementCandidate(id: string): CandidateRow {
  const candidate = improvementStore.candidate(id);
  if (!candidate) throw new SelfImprovementError("Improvement candidate not found.", 404);
  return move(candidate, "retained", "Monitoring found no regression. The version stays active.", now());
}

export function refuseRecursiveImprovement(parentId: string): { created: false; reason: string } {
  const parent = improvementStore.candidate(parentId);
  const control = ensure();
  const depth = (parent?.depth ?? 0) + 1;
  if (!parent || parent.decision === "fail" || parent.decision === "inconclusive" || parent.status === "rejected" || depth > limits(control).maxNestedDepth) {
    return { created: false, reason: "A failed or inconclusive evaluation does not create another improvement." };
  }
  return { created: false, reason: "Nested improvement generation is not automatic." };
}

export function runImprovementCycle(projectPath: string): { candidates: CandidateRow[]; activated: string[]; stopped: string | null } {
  const control = ensure();
  requireEnabled(control);
  if (control.paused) return { candidates: [], activated: [], stopped: "paused" };
  if (control.stopped) return { candidates: [], activated: [], stopped: "stopped" };
  const permission = improvementPermissionForProject(projectPath);
  if (permission.emergency) return { candidates: [], activated: [], stopped: "emergency-stop" };
  if (!permission.enabled) return { candidates: [], activated: [], stopped: "policy-disabled" };
  const discovered = discoverImprovementCandidates().filter((candidate) => candidate.projectPath === projectPath);
  const activated: string[] = [];
  const touched: CandidateRow[] = [];
  for (const candidate of discovered) {
    const prepared = prepareImprovementCandidate(candidate.id);
    touched.push(prepared);
    if (prepared.status !== "proposed") continue;
    const evaluated = evaluateImprovementCandidate(prepared.id, {
      provider: "fake",
      model: "fake-driver",
      accountId: null,
    });
    touched.push(evaluated);
    if (evaluated.decision !== "pass") {
      refuseRecursiveImprovement(evaluated.id);
      continue;
    }
    if (permission.mode === "supervised" || !permission.lowRiskActivation || evaluated.risk !== "low") continue;
    const live = activateImprovementCandidate(evaluated.id, { actor: "head" });
    touched.push(live);
    activated.push(live.id);
  }
  return { candidates: touched, activated, stopped: improvementStore.control().consecutiveNoGain >= 2 ? "no-measurable-improvement" : null };
}

export function reconcileSelfImprovement(): { closed: number } {
  ensure();
  let closed = 0;
  for (const evaluation of improvementStore.unfinishedEvaluations()) {
    const at = now();
    improvementStore.finishEvaluation(evaluation.id, {
      status: "inconclusive",
      baseline: [],
      candidate: [],
      verdict: "inconclusive",
      attribution: "instruction-quality",
      finishedAt: at,
    });
    const candidate = improvementStore.candidate(evaluation.candidateId);
    if (candidate && candidate.status === "evaluating") {
      const evaluated = move(candidate, "evaluated", "An interrupted evaluation was closed on restart and was not run again.", at);
      improvementStore.updateCandidate(evaluated.id, { decision: "inconclusive", decisionReason: evaluated.decisionReason, updatedAt: at });
    }
    closed += 1;
  }
  for (const candidate of improvementStore.listCandidates()) {
    if (candidate.expiresAt && candidate.expiresAt <= now() && ["observed", "proposed", "evaluated"].includes(candidate.status)) {
      move(candidate, "expired", "The candidate expired before activation.", now());
      closed += 1;
    }
  }
  return { closed };
}

export function activeImprovementSnapshot(input: { projectPath: string; role: string }): ImprovementSnapshot {
  ensure();
  const rows = improvementStore.activeActivations(input.role.toLowerCase(), input.projectPath);
  const byKey = new Map<string, FrozenImprovementVersion>();
  for (const row of rows) {
    if (row.scope === "project" && row.projectPath !== input.projectPath) continue;
    if (row.strategy === "canary" && row.canaryLimit != null && row.runsConsumed >= row.canaryLimit) continue;
    const version = improvementStore.version(row.artifactKey, row.version);
    if (!version) continue;
    const frozen: FrozenImprovementVersion = {
      artifactKey: version.artifactKey,
      version: version.version,
      sha256: version.contentSha,
      scope: version.scope,
      projectPath: version.projectPath,
      role: version.role,
      targetKind: version.targetKind,
      content: version.content,
    };
    const existing = byKey.get(version.artifactKey);
    if (existing?.scope === "project" && frozen.scope === "global") continue;
    byKey.set(version.artifactKey, frozen);
  }
  const versions = [...byKey.values()];
  return { versions, sha256: snapshotSha(versions) };
}

export function recordRunImprovementProvenance(input: {
  runId: string;
  taskId: string;
  projectPath: string;
  role: string;
  snapshot: ImprovementSnapshot;
  frozenAt: number;
}): void {
  improvementStore.recordProvenance({
    runId: input.runId,
    taskId: input.taskId,
    projectPath: input.projectPath,
    role: input.role,
    versionsJson: JSON.stringify(input.snapshot.versions.map((version) => ({
      artifactKey: version.artifactKey,
      version: version.version,
      sha256: version.sha256,
      scope: version.scope,
      projectPath: version.projectPath,
      role: version.role,
      targetKind: version.targetKind,
    }))),
    snapshotSha: input.snapshot.sha256,
    frozenAt: input.frozenAt,
  });
  const active = improvementStore.activeActivations(input.role, input.projectPath);
  for (const row of active) {
    if (row.strategy === "canary" && input.snapshot.versions.some((version) => version.artifactKey === row.artifactKey)) {
      improvementStore.consumeCanary(row.id);
    }
  }
}

export function runImprovementProvenance(runId: string) {
  return improvementStore.provenance(runId);
}

export function answerImprovementQuestion(question: string): string {
  ensure();
  const since = now() - 7 * 24 * 60 * 60 * 1000;
  const candidates = improvementStore.listCandidates();
  const facts: HeadReportFacts = {
    since,
    activated: candidates
      .filter((candidate) => ["monitoring", "active", "retained"].includes(candidate.status) && candidate.updatedAt >= since)
      .map((candidate) => ({
        id: candidate.id,
        role: candidate.role,
        version: candidate.proposedVersion ?? 0,
        projectPath: candidate.projectPath,
        at: candidate.updatedAt,
      })),
    rolledBack: candidates
      .filter((candidate) => candidate.status === "rolled_back")
      .map((candidate) => ({ id: candidate.id, role: candidate.role, reason: candidate.decisionReason ?? "", at: candidate.updatedAt })),
    skillChanges: candidates
      .filter((candidate) => candidate.proposedVersion != null && candidate.decisionReason)
      .map((candidate) => ({ artifactKey: candidate.artifactKey, version: candidate.proposedVersion ?? 0, reason: candidate.decisionReason ?? "" })),
    errorDeltas: candidates
      .filter((candidate) => candidate.metrics && typeof candidate.metrics === "object")
      .map((candidate) => {
        const metrics = candidate.metrics as { baselineErrors?: number; candidateErrors?: number; sampleSize?: { fixtures: number; training: number; heldOut: number } };
        return {
          id: candidate.id,
          baselineErrors: metrics.baselineErrors ?? 0,
          candidateErrors: metrics.candidateErrors ?? 0,
          verdict: candidate.decision ?? "unknown",
          sample: metrics.sampleSize ? describeSample(metrics.sampleSize) : undefined,
        };
      }),
    qcByRole: qcRoleCounts(),
  };
  return headReport(question, facts);
}

function qcRoleCounts(): Array<{ role: string; count: number }> {
  const counts = new Map<string, number>();
  for (const weakness of repeatedWeaknesses(improvementStore.listObservations(), 1)) {
    counts.set(weakness.role, (counts.get(weakness.role) ?? 0) + weakness.evidenceIds.length);
  }
  return [...counts.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count);
}

export function selfImprovementStatus() {
  const control = ensure();
  reconcileSelfImprovement();
  const fresh = improvementStore.control();
  const cap = limits(fresh);
  return {
    control: fresh,
    limits: cap,
    budget: {
      candidatesUsed: fresh.candidatesInPeriod,
      candidatesMax: cap.maxCandidatesPerPeriod,
      activationAttempts: fresh.activationAttempts,
      activationMax: cap.maxActivationAttempts,
      cooldownUntil: fresh.cooldownUntil,
      consecutiveFailures: fresh.consecutiveFailures,
      consecutiveNoGain: fresh.consecutiveNoGain,
      quota: "unknown" as const,
    },
    candidates: improvementStore.listCandidates(),
    activeVersions: improvementStore.listActive(),
    launches: improvementStore.listProvenance(),
    regressions: improvementStore.listCandidates().filter((candidate) => candidate.status === "rolled_back"),
    autonomy: autonomyImprovementSummary(),
  };
}

function autonomyImprovementSummary(): { permitting: number; lowRisk: number } {
  const active = autonomyPolicyStore.listActivations().filter((row) => row.status === "active");
  let permitting = 0;
  let lowRisk = 0;
  for (const row of active) {
    const policy = autonomyPolicyStore.policyRevision(row.policyId, row.revision);
    if (policy?.body.selfImprovement?.enabled) permitting += 1;
    if (policy?.body.selfImprovement?.lowRiskActivation) lowRisk += 1;
  }
  return { permitting, lowRisk };
}

export { emptySnapshot };
