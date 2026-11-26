/**
 * Live checks that an Owner proof must still pass.
 * The proof does not replace project, policy, account, or sandbox checks.
 */
import { isBlockedProvider, policyCoversTarget } from "../../shared/autonomy-policy.ts";
import type { OwnerOperation } from "../../shared/owner-trust/protocol.ts";
import { canonicalize, sha256Hex } from "../../shared/owner-trust/protocol.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { authorizeAutonomyAction } from "../autonomy/policy-engine.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { db, tasks } from "../db.ts";
import { missionStore } from "../orchestration/mission-store.ts";
import { taskAvailabilityFor } from "../task-availability.ts";

export interface AdmissionFacts {
  emergencyStopped: boolean;
  projectPaused: boolean;
  missionPaused: boolean;
  missionRevision: string | null;
  taskStateDigest: string | null;
  accountBound: boolean;
  providerBlocked: boolean;
  routerEligible: boolean;
  sandboxAllows: boolean;
  policyStatus: "none" | "active" | "paused" | "revoked" | "expired";
  policyRevision: string | null;
  policyDigest: string | null;
  envelopeAllows: boolean;
  concurrencyAllowed: boolean;
  budgetAllowed: boolean;
  completedRun: boolean;
  scheduledNotYetAvailable?: boolean;
  scheduledAvailableFromUtc?: string | null;
  reason: string;
}

/**
 * Registered by the hands-off authorization module. A project envelope is admitted only when this process built it
 * for the project's saved policy and the policy is still inside it. Registration (not an import) avoids a cycle.
 */
export type EnvelopeAdmission = (operation: OwnerOperation) => { ok: true } | { ok: false; reason: string };
let envelopeAdmission: EnvelopeAdmission | null = null;
export function registerEnvelopeAdmission(fn: EnvelopeAdmission | null): void { envelopeAdmission = fn; }

export function taskBindingDigest(task: { id: string; prompt: string; workdir: string; column: string }): string {
  return sha256Hex(canonicalize({ column: task.column, id: task.id, prompt: task.prompt, workdir: task.workdir }));
}

export function missionBindingDigest(mission: { id: string; planDigest: string }): string {
  return sha256Hex(canonicalize({ id: mission.id, planDigest: mission.planDigest }));
}

export function loadAdmissionFacts(operation: OwnerOperation): AdmissionFacts {
  const emergency = autonomyPolicyStore.readEmergency().active;
  if (operation.kind === "project-envelope") {
    const check = envelopeAdmission ? envelopeAdmission(operation) : { ok: false as const, reason: "Project authorization is not available in this process." };
    return {
      emergencyStopped: emergency, projectPaused: false, missionPaused: false, missionRevision: null, taskStateDigest: null,
      accountBound: true, providerBlocked: false, routerEligible: true, sandboxAllows: true, policyStatus: "none",
      policyRevision: null, policyDigest: null, envelopeAllows: check.ok, concurrencyAllowed: true, budgetAllowed: true,
      completedRun: false, reason: check.ok ? "The project envelope matches the saved policy." : check.reason,
    };
  }
  const project = checkProjectLaunchAdmission(operation.projectPath);
  const mission = operation.missionId ? missionStore.getMission(operation.missionId) : null;
  const task = operation.taskId !== "policy-envelope" ? tasks.get(operation.taskId) : null;
  const blocked = isBlockedProvider(operation.providerId, operation.modelId);
  const binding = operation.providerId === "policy-envelope"
    ? { ok: true as const }
    : explainBinding({
      harnessId: operation.harnessId,
      accountId: operation.accountId,
      modelId: operation.modelId,
      mode: operation.mode,
      provider: operation.providerId,
    });
  const accessAllows = !task
    || (task.accessMode !== "full-computer"
      && (task.accessMode !== "isolated" || (operation.providerId === "codex" && operation.mode !== "full-access" && !task.pipelineId)));
  const sandboxAllows = accessAllows && (operation.kind === "bounded-mission"
    ? !operation.terminalAllowed && !operation.browserAllowed && !operation.computerUseAllowed && !operation.gitPublish && !operation.deploymentAllowed
    : ((operation.role === "reviewer" || operation.role === "head-of-pm") ? operation.filesystem === "read-only" : operation.filesystem === "workspace-write")
      && (operation.role !== "head-of-pm" || !operation.gitRead)
      && !operation.terminalAllowed && !operation.browserAllowed && !operation.computerUseAllowed && !operation.gitPublish && !operation.deploymentAllowed);
  const activations = autonomyPolicyStore.listActivations();
  const covering = operation.kind === "bounded-mission"
    ? activations.flatMap((activation) => {
      const policy = autonomyPolicyStore.policyRevision(activation.policyId, activation.revision);
      if (!policy || policy.digest !== operation.envelopeDigest || String(policy.revision) !== operation.policyRevision) return [];
      return [{ activation, policy }];
    })
    : operation.role === "head-of-pm"
      ? []
      : activations.flatMap((activation) => {
        const policy = autonomyPolicyStore.policyRevision(activation.policyId, activation.revision);
        if (!policy || !policyCoversTarget(policy.body, { projectPath: operation.projectPath, taskId: operation.taskId })) return [];
        return [{ activation, policy }];
      });
  const open = covering.find((row) => row.activation.status === "active") ?? covering[0] ?? null;
  let envelopeAllows = operation.kind !== "bounded-mission";
  let concurrencyAllowed = true;
  let budgetAllowed = true;
  let policyStatus: AdmissionFacts["policyStatus"] = "none";
  let reason = operation.kind === "bounded-mission"
    ? "No active policy matches this bounded mission."
    : "No autonomy policy covers this operation. The Owner proof is the supervised authorization.";
  if (open) {
    policyStatus = open.activation.status === "active" || open.activation.status === "paused" || open.activation.status === "revoked" || open.activation.status === "expired"
      ? open.activation.status
      : "none";
    if (operation.kind !== "bounded-mission" && operation.role !== "head-of-pm") {
      const decision = authorizeAutonomyAction({
        target: {
          projectPath: operation.projectPath,
          taskId: operation.taskId,
          role: operation.role,
          provider: operation.providerId,
          model: operation.modelId,
          accountId: operation.accountId,
          action: operation.role === "reviewer" ? "run_qc" : "launch_task",
        },
        missionId: operation.missionId,
        targetKey: `owner-trust:${operation.requestId}`,
      });
      envelopeAllows = decision.decision.allow;
      concurrencyAllowed = decision.decision.allow || !/concurrency/i.test(decision.decision.reason);
      budgetAllowed = decision.decision.allow || !/budget|spending|cap/i.test(decision.decision.reason);
      reason = decision.decision.reason;
      if (!decision.decision.allow && /concurrency/i.test(decision.decision.reason)) envelopeAllows = true;
      if (!decision.decision.allow && /budget|spending|cap/i.test(decision.decision.reason)) envelopeAllows = true;
    } else if (operation.kind === "bounded-mission") {
      envelopeAllows = open.policy.digest === operation.envelopeDigest && String(open.policy.revision) === operation.policyRevision;
      budgetAllowed = open.policy.body.spending.requireEnforceableCap !== true;
      reason = envelopeAllows ? "The bounded mission matches the active policy." : "The bounded mission does not match the active policy.";
    }
  }
  const run = operation.runId && operation.runId !== "policy-envelope"
    ? db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(operation.runId)
    : null;
  const availability = task && operation.role === "developer" ? taskAvailabilityFor(task) : null;
  return {
    emergencyStopped: emergency,
    projectPaused: !project.allowed,
    missionPaused: mission?.status === "paused" || mission?.status === "cancelled",
    missionRevision: mission ? mission.planDigest : null,
    taskStateDigest: task ? taskBindingDigest({ id: task.id, prompt: task.prompt, workdir: task.workdir, column: task.column }) : null,
    accountBound: binding.ok,
    providerBlocked: Boolean(blocked),
    routerEligible: binding.ok && !blocked,
    sandboxAllows,
    policyStatus,
    policyRevision: open ? String(open.policy.revision) : null,
    policyDigest: open ? open.policy.digest : null,
    envelopeAllows,
    concurrencyAllowed,
    budgetAllowed,
    completedRun: run?.status === "succeeded" || run?.status === "failed" || run?.status === "cancelled",
    scheduledNotYetAvailable: availability ? !availability.available : false,
    scheduledAvailableFromUtc: availability?.availableFromUtc ?? null,
    reason,
  };
}

export function admissionCode(operation: OwnerOperation, facts: AdmissionFacts): { code: string; reason: string } | null {
  if (facts.emergencyStopped) return { code: "owner-emergency-stop", reason: "Emergency stop is active. The Owner proof does not override it." };
  if (facts.projectPaused) return { code: "owner-project-paused", reason: "The project is not running. The Owner proof does not start it." };
  if (facts.scheduledNotYetAvailable) {
    return { code: "scheduled-not-yet-available", reason: `Task is scheduled to be available from ${facts.scheduledAvailableFromUtc ?? "a future time"}. Waiting for scheduled time.` };
  }
  if (facts.missionPaused) return { code: "owner-mission-paused", reason: "The mission is paused or cancelled." };
  if (facts.providerBlocked) return { code: "owner-provider-blocked", reason: "This provider stays blocked." };
  if (!facts.accountBound) return { code: "owner-account-unbound", reason: facts.reason || "The account binding does not match this operation." };
  if (!facts.routerEligible) return { code: "owner-router-ineligible", reason: facts.reason || "The router did not select this account and model." };
  if (!facts.sandboxAllows) return { code: "owner-sandbox", reason: "The operation asks for filesystem or process permissions outside the sandbox." };
  if (facts.completedRun) return { code: "owner-run-completed", reason: "That run id already finished. It is not launched again." };
  if (facts.missionRevision && operation.missionRevision !== facts.missionRevision) {
    return { code: "owner-mission-stale", reason: "The mission revision changed after this approval was signed." };
  }
  if (facts.taskStateDigest && operation.taskStateDigest !== facts.taskStateDigest) {
    return { code: "owner-task-stale", reason: "The task changed after this approval was signed." };
  }
  if (facts.policyStatus === "revoked") return { code: "owner-policy-revoked", reason: "The autonomy policy is revoked." };
  if (facts.policyStatus === "expired") return { code: "owner-policy-expired", reason: "The autonomy policy is expired." };
  if (facts.policyStatus === "paused") return { code: "owner-policy-paused", reason: "The autonomy policy is paused." };
  if (facts.policyRevision && operation.policyRevision !== facts.policyRevision) {
    return { code: "owner-policy-stale", reason: "The policy revision changed after this approval was signed." };
  }
  if (facts.policyDigest && operation.envelopeDigest !== "none" && operation.envelopeDigest !== facts.policyDigest && operation.kind === "bounded-mission") {
    return { code: "owner-policy-stale", reason: "The policy digest changed after this approval was signed." };
  }
  if (!facts.concurrencyAllowed) return { code: "owner-concurrency", reason: "The concurrency limit is full. The Owner proof does not add a slot." };
  if (!facts.budgetAllowed) return { code: "owner-budget", reason: "The launch budget or spending rule refuses this operation." };
  if (!facts.envelopeAllows) return { code: "owner-envelope", reason: facts.reason || "The operation is outside the approved autonomy envelope." };
  return null;
}
