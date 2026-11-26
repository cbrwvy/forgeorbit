/**
 * Owner-activated autonomy policy engine.
 * Mutations are owner-only. authorizeAction never creates or widens a policy.
 */
import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { AccountCore } from "../account-core.ts";
import { db, harnesses } from "../db.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import {
  evaluateApplicablePolicies,
  normalizePolicyBody,
  policyCoversTarget,
  policyDigest,
  revisionExpands,
  type AutonomyAction,
  type AutonomyPolicyBody,
  type PolicyDecision,
  type PolicyTarget,
} from "../../shared/autonomy-policy.ts";
import { autonomyPolicyStore, type ActivationRow, type PolicyRow } from "./policy-store.ts";

export class AutonomyPolicyError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "AutonomyPolicyError";
  }
}

let clock = () => Date.now();

export function setAutonomyClock(fn: () => number): void {
  clock = fn;
}

export function autonomyNow(): number {
  return clock();
}

function journal(eventType: "autonomy.policy.activated" | "autonomy.policy.paused" | "autonomy.policy.resumed" | "autonomy.policy.revoked" | "autonomy.action.authorized" | "autonomy.action.denied" | "autonomy.emergency.stopped", payload: Record<string, string | number>, idempotencyKey: string, projectPath?: string | null, taskId?: string | null): void {
  try {
    new ActivityJournalCore(db).record({
      eventType,
      projectPath: projectPath ?? null,
      actorType: eventType.startsWith("autonomy.action") ? "system" : "owner",
      actorId: eventType.startsWith("autonomy.action") ? "autonomy-policy" : "owner",
      targetType: eventType === "autonomy.emergency.stopped" ? "company" : "execution",
      targetId: String(payload.activationId ?? payload.policyId ?? "autonomy"),
      taskId: taskId ?? null,
      idempotencyKey,
      payload,
    });
  } catch (error) {
    console.warn("[autonomy] activity journal skipped:", error instanceof Error ? error.message : error);
  }
}

function applicableFromActivation(activation: ActivationRow): { id: string; revision: number; digest: string; body: AutonomyPolicyBody } | null {
  const policy = autonomyPolicyStore.policyRevision(activation.policyId, activation.revision);
  if (!policy || policy.digest !== activation.digest) return null;
  return { id: policy.id, revision: policy.revision, digest: policy.digest, body: policy.body };
}

function livePoliciesFor(target: PolicyTarget): Array<{ id: string; revision: number; digest: string; body: AutonomyPolicyBody }> {
  const rows = [];
  for (const activation of autonomyPolicyStore.listActivations()) {
    const policy = applicableFromActivation(activation);
    if (!policy || !policy.body.projects.includes(target.projectPath)) continue;
    rows.push({ policy, activation });
  }
  const open = rows.filter((row) => row.activation.status === "active" || row.activation.status === "paused");
  const chosen = open.length > 0 ? open : rows.filter((row) => row.activation.status === "revoked" || row.activation.status === "expired");
  return chosen.map((row) => row.policy);
}

export function createAutonomyPolicy(raw: unknown): PolicyRow {
  const body = normalizePolicyBody(raw, autonomyNow());
  const id = randomUUID();
  return autonomyPolicyStore.insertPolicy({
    id,
    revision: 1,
    status: "draft",
    mode: body.mode,
    body,
    digest: policyDigest(body),
  });
}

export function reviseAutonomyPolicy(policyId: string, raw: unknown): { policy: PolicyRow; expandsExisting: string[] } {
  const current = autonomyPolicyStore.latestPolicy(policyId);
  if (!current) throw new AutonomyPolicyError("Policy not found.", 404);
  const incoming = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const body = normalizePolicyBody({ ...incoming, expiresAt: typeof incoming.expiresAt === "number" ? incoming.expiresAt : current.body.expiresAt }, autonomyNow());
  const activation = autonomyPolicyStore.activationForPolicy(policyId, current.revision);
  const expands = activation ? revisionExpands(activation ? autonomyPolicyStore.policyRevision(policyId, activation.revision)!.body : current.body, body) : [];
  const next = autonomyPolicyStore.insertPolicy({
    id: policyId,
    revision: current.revision + 1,
    status: "draft",
    mode: body.mode,
    body,
    digest: policyDigest(body),
  });
  if (current.status === "active" || current.status === "paused") {
    autonomyPolicyStore.setPolicyStatus(policyId, current.revision, current.status);
  }
  return { policy: next, expandsExisting: expands };
}

export function activateAutonomyPolicy(policyId: string, revision?: number): ActivationRow {
  const policy = revision
    ? autonomyPolicyStore.policyRevision(policyId, revision)
    : autonomyPolicyStore.latestPolicy(policyId);
  if (!policy) throw new AutonomyPolicyError("Policy not found.", 404);
  if (policy.digest !== policyDigest(policy.body)) {
    throw new AutonomyPolicyError("Stored policy digest does not match its body.", 409);
  }
  const existing = autonomyPolicyStore.activationForPolicy(policy.id, policy.revision);
  if (existing) {
    if (existing.digest !== policy.digest) throw new AutonomyPolicyError("Activation digest drifted from the policy revision.", 409);
    return existing;
  }
  const now = autonomyNow();
  if (policy.body.expiresAt <= now) throw new AutonomyPolicyError("Policy is already expired.", 409);
  if (policy.body.spending.requireEnforceableCap) {
    throw new AutonomyPolicyError(
      "This policy requires a verified spending cap. Provider billing limits are not enforceable, so automatic execution cannot be activated.",
      409,
    );
  }
  const previous = autonomyPolicyStore.listActivations().find((row) => row.policyId === policy.id && row.status !== "revoked");
  if (previous) {
    const previousBody = autonomyPolicyStore.policyRevision(previous.policyId, previous.revision)?.body;
    if (previousBody) {
      const reasons = revisionExpands(previousBody, policy.body);
      if (reasons.length > 0 && previous.status === "active") {
        throw new AutonomyPolicyError(
          `This revision expands the active authorization (${reasons.join(", ")}). Revoke it and activate the new revision explicitly.`,
          409,
        );
      }
    }
  }
  const id = randomUUID();
  const provenance = {
    actor: "owner",
    source: "owner-api",
    policyId: policy.id,
    revision: policy.revision,
    digest: policy.digest,
    activatedAt: now,
    mode: policy.body.mode,
  };
  const activation: ActivationRow = {
    id,
    policyId: policy.id,
    revision: policy.revision,
    digest: policy.digest,
    activatedBy: "owner",
    activatedAt: now,
    expiresAt: policy.body.expiresAt,
    status: "active",
    provenance,
  };
  autonomyPolicyStore.insertActivation(activation);
  autonomyPolicyStore.setPolicyStatus(policy.id, policy.revision, "active");
  journal(
    "autonomy.policy.activated",
    {
      policyId: policy.id,
      revision: policy.revision,
      activationId: id,
      mode: policy.body.mode,
      digest: policy.digest,
    },
    `autonomy-policy:${id}:activated`,
    policy.body.projects[0] ?? null,
  );
  return activation;
}

export function pauseAutonomyPolicy(policyId: string): ActivationRow {
  const activation = requireOpenActivation(policyId);
  if (activation.status !== "active") throw new AutonomyPolicyError("Only an active policy can be paused.", 409);
  autonomyPolicyStore.setActivationStatus(activation.id, "paused");
  autonomyPolicyStore.setPolicyStatus(activation.policyId, activation.revision, "paused");
  journal("autonomy.policy.paused", { policyId, revision: activation.revision, activationId: activation.id, mode: "paused" }, `autonomy-policy:${activation.id}:paused`);
  return { ...activation, status: "paused" };
}

export function resumeAutonomyPolicy(policyId: string): ActivationRow {
  const activation = requireOpenActivation(policyId);
  if (activation.status === "revoked") throw new AutonomyPolicyError("A revoked policy cannot resume. Activate a new Owner revision.", 409);
  if (activation.status !== "paused") throw new AutonomyPolicyError("Only a paused policy can resume.", 409);
  if (autonomyPolicyStore.readEmergency().active) throw new AutonomyPolicyError("Emergency stop is active.", 409);
  const now = autonomyNow();
  if (now >= activation.expiresAt) {
    autonomyPolicyStore.setActivationStatus(activation.id, "expired");
    autonomyPolicyStore.setPolicyStatus(activation.policyId, activation.revision, "expired");
    throw new AutonomyPolicyError("The policy expired while paused.", 409);
  }
  const policy = autonomyPolicyStore.policyRevision(activation.policyId, activation.revision);
  if (!policy || policy.digest !== activation.digest) throw new AutonomyPolicyError("Policy provenance no longer matches this activation.", 409);
  autonomyPolicyStore.setActivationStatus(activation.id, "active");
  autonomyPolicyStore.setPolicyStatus(activation.policyId, activation.revision, "active");
  journal("autonomy.policy.resumed", { policyId, revision: activation.revision, activationId: activation.id, mode: policy.body.mode }, `autonomy-policy:${activation.id}:resumed`);
  return { ...activation, status: "active" };
}

export function revokeAutonomyPolicy(policyId: string): ActivationRow {
  const activation = requireOpenActivation(policyId);
  if (activation.status === "revoked") return activation;
  autonomyPolicyStore.setActivationStatus(activation.id, "revoked");
  autonomyPolicyStore.setPolicyStatus(activation.policyId, activation.revision, "revoked");
  autonomyPolicyStore.cancelUnclaimed(activation.id);
  journal("autonomy.policy.revoked", { policyId, revision: activation.revision, activationId: activation.id, mode: "revoked" }, `autonomy-policy:${activation.id}:revoked`);
  return { ...activation, status: "revoked" };
}

function requireOpenActivation(policyId: string): ActivationRow {
  const policy = autonomyPolicyStore.latestPolicy(policyId);
  if (!policy) throw new AutonomyPolicyError("Policy not found.", 404);
  const activation = autonomyPolicyStore.listActivations().find((row) => row.policyId === policyId && row.revision === policy.revision)
    ?? autonomyPolicyStore.listActivations().find((row) => row.policyId === policyId);
  if (!activation) throw new AutonomyPolicyError("Policy has no Owner activation.", 409);
  return activation;
}

export interface AuthorizeInput {
  target: PolicyTarget;
  missionId?: string | null;
  reworkUsed?: number;
  targetKey?: string;
  requiredActivationId?: string;
  /** Ignored as authority. Present so a router recommendation cannot be mistaken for a grant. */
  routerRecommended?: boolean;
}

export interface AuthorizeResult {
  decision: PolicyDecision;
  reservationId: string | null;
  replayed: boolean;
  launch: boolean;
}

function hasVerifiedQuota(target: PolicyTarget, now: number): boolean {
  if (!target.accountId || !target.provider || !target.model) return false;
  const core = new AccountCore(db, () => now);
  try {
    const account = core.getAccount(target.accountId);
    const harnessId = account.codexProfile?.harnessId ?? account.claudeProfile?.harnessId;
    const harness = harnessId ? harnesses.get(harnessId) : null;
    if (account.archivedAt !== null || !harness?.enabled ||
        ![harness.id, harness.kind, account.provider].includes(target.provider)) return false;
    return core.hasVerifiedHeadroom(account.id, harness.id, target.model);
  } catch {
    return false;
  }
}

export function authorizeAutonomyAction(input: AuthorizeInput): AuthorizeResult {
  const now = autonomyNow();
  const emergency = autonomyPolicyStore.readEmergency();
  const projectPath = input.target.projectPath;
  const admission = projectPath ? checkProjectLaunchAdmission(projectPath) : { allowed: false, reason: "Target project is required." };
  const policies = livePoliciesFor(input.target).map((policy) => {
    const activation = autonomyPolicyStore.activationForPolicy(policy.id, policy.revision);
    return { policy, activation };
  }).filter((row) => row.activation);
  const activation = input.requiredActivationId
    ? policies.find(row => row.activation?.id === input.requiredActivationId)?.activation ?? null
    : policies.find(row => row.activation!.status === "active")?.activation ?? policies[0]?.activation ?? null;
  const consumes = input.target.action === "launch_task" || input.target.action === "run_qc" || input.target.action === "request_rework" || input.target.action === "complete_task";
  const targetKey = input.targetKey ?? `${input.target.action}:${input.target.taskId ?? projectPath}:0`;
  const existingReservation = activation && consumes ? autonomyPolicyStore.reservationByKey(activation.id, targetKey) : null;
  const counts = activation ? autonomyPolicyStore.countLaunches(activation.id) : { used: 0, inFlight: 0 };
  if (existingReservation && existingReservation.status !== "cancelled") {
    counts.used = Math.max(0, counts.used - 1);
    if (existingReservation.status === "reserved" || existingReservation.status === "consumed") {
      counts.inFlight = Math.max(0, counts.inFlight - 1);
    }
  }
  const coveringPaused = policies.some((row) => row.activation?.status === "paused" && policyCoversTarget(row.policy.body, input.target));
  const decision = evaluateApplicablePolicies(
    policies.map((row) => row.policy),
    input.target,
    {
      launchesUsed: counts.used,
      launchesInFlight: counts.inFlight,
      reworkUsedForTask: input.reworkUsed ?? 0,
      now,
      activatedAt: activation?.activatedAt ?? now,
      lifecycleAllowed: admission.allowed,
      verifiedQuota: (input.target.action === "launch_task" || input.target.action === "run_qc") &&
        policies.some(row => row.policy.body.requireVerifiedQuota && policyCoversTarget(row.policy.body, input.target))
        ? hasVerifiedQuota(input.target, now) : undefined,
      lifecycleReason: admission.reason,
      emergencyStopped: emergency.active,
      paused: coveringPaused || activation?.status === "paused",
      revoked: activation?.status === "revoked",
      expired: activation ? now >= activation.expiresAt : false,
    },
  );
  if (input.requiredActivationId && activation?.status !== "active") {
    decision.allow = false;
    decision.reason = "The mission's exact Owner activation is no longer active.";
  }
  if (input.routerRecommended && !decision.allow) {
    decision.reason = `${decision.reason} A router recommendation is not authority.`;
  }
  autonomyPolicyStore.recordDecision({
    activationId: activation?.id ?? null,
    policyId: decision.policyId,
    revision: decision.revision,
    action: input.target.action,
    target: { ...input.target, routerRecommended: input.routerRecommended === true },
    verdict: decision.allow ? "allowed" : "denied",
    reason: decision.reason,
    missionId: input.missionId,
    taskId: input.target.taskId,
  });
  const eventBase = {
    policyId: decision.policyId ?? "none",
    revision: decision.revision ?? 0,
    activationId: activation?.id ?? "none",
    action: input.target.action,
    missionId: input.missionId ?? "none",
  };
  if (existingReservation) {
    const launch = decision.allow && existingReservation.status === "reserved";
    return { decision, reservationId: existingReservation.id, replayed: true, launch };
  }
  if (!decision.allow || !activation) {
    journal(
      "autonomy.action.denied",
      { ...eventBase, reasonCode: "denied" },
      `autonomy-deny:${activation?.id ?? "none"}:${input.target.action}:${input.target.taskId ?? projectPath}:${input.targetKey ?? "0"}`,
      projectPath,
      input.target.taskId,
    );
    return { decision, reservationId: null, replayed: false, launch: false };
  }
  if (!consumes) {
    journal("autonomy.action.authorized", eventBase, `autonomy-allow:${activation.id}:${input.target.action}:${input.target.taskId ?? projectPath}:${input.targetKey ?? "once"}`, projectPath, input.target.taskId);
    return { decision, reservationId: null, replayed: false, launch: true };
  }
  const reserved = autonomyPolicyStore.insertReservation({
    activationId: activation.id,
    policyId: activation.policyId,
    revision: activation.revision,
    action: input.target.action,
    targetKey,
    missionId: input.missionId ?? null,
    taskId: input.target.taskId ?? null,
    projectPath,
    status: "reserved",
  });
  journal(
    "autonomy.action.authorized",
    eventBase,
    `autonomy-allow:${activation.id}:${targetKey}`,
    projectPath,
    input.target.taskId,
  );
  return { decision, reservationId: reserved.id, replayed: false, launch: true };
}

export function consumeAutonomyReservation(id: string): void {
  autonomyPolicyStore.setReservationStatus(id, "consumed");
}

export function releaseAutonomyReservation(id: string): void {
  autonomyPolicyStore.setReservationStatus(id, "released");
}

export function cancelAutonomyReservation(id: string): void {
  autonomyPolicyStore.setReservationStatus(id, "cancelled");
}

export function autonomyStatus() {
  const emergency = autonomyPolicyStore.readEmergency();
  const policies = autonomyPolicyStore.listPolicies();
  const activations = autonomyPolicyStore.listActivations();
  const activeFull = activations.some((row) => row.status === "active" && autonomyPolicyStore.policyRevision(row.policyId, row.revision)?.body.mode === "full-autonomy" && autonomyNow() < row.expiresAt && !emergency.active);
  const activeAutonomous = activations.some((row) => row.status === "active" && autonomyPolicyStore.policyRevision(row.policyId, row.revision)?.body.mode === "autonomous" && autonomyNow() < row.expiresAt && !emergency.active);
  return {
    emergency,
    policies,
    activations,
    bindings: autonomyPolicyStore.listBindings(),
    decisions: autonomyPolicyStore.listDecisions(40),
    journal: autonomyPolicyStore.listJournal(20),
    enforcement: {
      supervised: !activeFull && !activeAutonomous,
      autonomousActive: activeAutonomous,
      fullAutonomyActive: activeFull,
    },
  };
}

export function expireDuePolicies(): number {
  const now = autonomyNow();
  let changed = 0;
  for (const activation of autonomyPolicyStore.listActivations()) {
    if ((activation.status === "active" || activation.status === "paused") && now >= activation.expiresAt) {
      autonomyPolicyStore.setActivationStatus(activation.id, "expired");
      autonomyPolicyStore.setPolicyStatus(activation.policyId, activation.revision, "expired");
      autonomyPolicyStore.cancelUnclaimed(activation.id);
      changed += 1;
    }
  }
  return changed;
}

export type { AutonomyAction };
