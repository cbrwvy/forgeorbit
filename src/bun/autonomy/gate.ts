/**
 * Admission hook used by the existing mission scheduler.
 * Missions with no autonomy binding keep today's supervised behavior.
 */
import type { MissionRecord, MissionTaskPlan } from "../../shared/orchestration/types.ts";
import type { QcVerdict } from "../../shared/task-quality-control.ts";
import { buildLowRiskMemoryCandidate } from "../../shared/autonomy-policy.ts";
import { hasPassingPracticalTest } from "./observed-test.ts";
import { proposalFingerprint } from "../../shared/brain/proposals.ts";
import { harnesses } from "../db.ts";
import { autonomyPolicyStore } from "./policy-store.ts";
import {
  authorizeAutonomyAction,
  cancelAutonomyReservation,
  consumeAutonomyReservation,
  releaseAutonomyReservation,
} from "./policy-engine.ts";

export type LaunchGate =
  | { kind: "legacy" }
  | { kind: "allow"; reservationId: string }
  | { kind: "skip"; reason: string }
  | { kind: "deny"; reason: string };

export type QcGate =
  | { kind: "legacy" }
  | { kind: "complete"; reason: string }
  | { kind: "await-owner"; reason: string }
  | { kind: "rework"; reason: string }
  | { kind: "block"; reason: string };

function bindingOf(mission: MissionRecord) {
  return autonomyPolicyStore.getBinding(mission.id);
}

/** Policy envelopes name a provider kind. A registered profile keeps that kind
 * and its own account; the profile id is not a different provider. */
function envelopeProvider(harnessId: string): string {
  return harnesses.get(harnessId)?.kind ?? harnessId;
}

export function autonomyLaunchDecision(mission: MissionRecord, task: MissionTaskPlan): LaunchGate {
  const binding = bindingOf(mission);
  if (!binding || binding.outcome === "supervised") return { kind: "legacy" };
  if (binding.emergencyTaskIds.includes(task.taskId)) {
    return { kind: "deny", reason: "Emergency stop cancelled this task. It will not restart under the same activation." };
  }
  const epoch = task.reworkEpoch ?? 0;
  const result = authorizeAutonomyAction({
    missionId: mission.id,
    reworkUsed: epoch,
    targetKey: developerLaunchKey(task),
    // A bound mission is held to its OWN activation for every action. Without this an expired, revoked or narrower
    // mission policy could be replaced, silently, by any other active policy that happens to cover the project.
    requiredActivationId: binding.activationId,
    target: {
      action: "launch_task",
      projectPath: task.projectPath,
      taskId: task.taskId,
      clusterId: task.clusterId,
      role: task.specialistRole,
      provider: envelopeProvider(task.harnessId),
      model: task.modelId,
      accountId: task.accountId,
    },
  });
  if (!result.decision.allow) {
    if (result.decision.reason.includes("concurrency limit")) return { kind: "skip", reason: result.decision.reason };
    return { kind: "deny", reason: result.decision.reason };
  }
  if (result.replayed && !result.launch) {
    return { kind: "deny", reason: "This launch was already consumed. Restart will not start a duplicate worker." };
  }
  if (!result.reservationId) return { kind: "deny", reason: "Launch reservation was not recorded." };
  return { kind: "allow", reservationId: result.reservationId };
}

export function noteAutonomousLaunchStarted(reservationId: string): void {
  consumeAutonomyReservation(reservationId);
}

function developerLaunchKey(task: MissionTaskPlan) {
  const key = `launch_task:${task.taskId}:${task.reworkEpoch ?? 0}`;
  return task.developerBinding ? `${key}:r${task.developerBinding.revision}` : key;
}

function reviewerLaunchKey(task: MissionTaskPlan) {
  const key = `run_qc:${task.taskId}:${task.reworkEpoch ?? 0}`;
  return task.reviewerBinding ? `${key}:r${task.reviewerBinding.revision}` : `run_qc:${task.taskId}:${task.qcReviewId ?? task.reworkEpoch ?? 0}`;
}

export function noteAutonomousReviewFinished(mission: MissionRecord, task: MissionTaskPlan): void {
  const binding = bindingOf(mission);
  if (!binding || !task.reviewerBinding) return;
  const row = autonomyPolicyStore.reservationByKey(binding.activationId, reviewerLaunchKey(task));
  if (row?.status === "consumed") releaseAutonomyReservation(row.id);
}

export function noteAutonomousLaunchFinished(mission: MissionRecord, task: MissionTaskPlan): void {
  const binding = bindingOf(mission);
  if (!binding) return;
  const row = autonomyPolicyStore.reservationByKey(binding.activationId, developerLaunchKey(task));
  if (row && (row.status === "reserved" || row.status === "consumed")) releaseAutonomyReservation(row.id);
}

export function noteAutonomousLaunchFailed(reservationId: string): void {
  cancelAutonomyReservation(reservationId);
}

export function autonomyReviewDecision(mission: MissionRecord, task: MissionTaskPlan): LaunchGate {
  const binding = bindingOf(mission);
  if (!binding) return { kind: "legacy" };
  const resource = task.reviewerBinding;
  const result = authorizeAutonomyAction({
    missionId: mission.id,
    targetKey: reviewerLaunchKey(task),
    requiredActivationId: binding.activationId,
    target: {
      action: "run_qc",
      projectPath: task.projectPath,
      taskId: task.taskId,
      clusterId: task.clusterId,
      role: "reviewer",
      provider: envelopeProvider(resource?.harnessId ?? task.harnessId),
      model: resource?.modelId ?? task.modelId,
      accountId: resource?.accountId ?? task.accountId,
    },
  });
  if (!result.decision.allow) return { kind: "deny", reason: result.decision.reason };
  if (result.replayed && !result.launch) return { kind: "deny", reason: "This QC launch was already consumed." };
  if (result.reservationId && result.launch && !result.replayed) consumeAutonomyReservation(result.reservationId);
  return { kind: "allow", reservationId: result.reservationId ?? "recorded" };
}

export function autonomyReworkDecision(mission: MissionRecord, task: MissionTaskPlan): QcGate {
  const binding = bindingOf(mission);
  if (!binding) return { kind: "legacy" };
  const epoch = task.reworkEpoch ?? 0;
  const rework = authorizeAutonomyAction({
    missionId: mission.id,
    reworkUsed: epoch,
    targetKey: `request_rework:${task.taskId}:${epoch}`,
    requiredActivationId: binding.activationId,
    target: {
      action: "request_rework",
      projectPath: task.projectPath,
      taskId: task.taskId,
      clusterId: task.clusterId,
      role: "developer",
      provider: envelopeProvider(task.harnessId),
      model: task.modelId,
      accountId: task.accountId,
    },
  });
  if (rework.decision.allow && rework.launch) {
    if (rework.reservationId) consumeAutonomyReservation(rework.reservationId);
    return { kind: "rework", reason: rework.decision.reason };
  }
  return { kind: "block", reason: rework.decision.reason };
}

export function autonomyQcDecision(mission: MissionRecord, task: MissionTaskPlan, verdict: QcVerdict | null): QcGate {
  const binding = bindingOf(mission);
  if (!binding) return { kind: "legacy" };
  const policy = autonomyPolicyStore.policyRevision(binding.policyId, binding.revision);
  if (!policy) return { kind: "block", reason: "The mission policy revision is missing." };
  if (verdict === "BLOCKED") {
    return { kind: "block", reason: "QC BLOCKED. The task was not completed." };
  }
  if (verdict === "CHANGES_REQUESTED") return autonomyReworkDecision(mission, task);
  if (verdict !== "PASS") return { kind: "block", reason: "QC did not pass." };
  if ((policy.body.qc.requireObservedTest || policy.body.completion.conditions.includes("observed_test")) && !hasPassingPracticalTest(task.taskId)) {
    return { kind: "await-owner", reason: "Observed test evidence is required and was not recorded. Completion was not invented." };
  }
  const complete = authorizeAutonomyAction({
    missionId: mission.id,
    targetKey: `complete_task:${task.taskId}`,
    requiredActivationId: binding.activationId,
    target: {
      action: "complete_task",
      projectPath: task.projectPath,
      taskId: task.taskId,
      clusterId: task.clusterId,
      role: "reviewer",
      provider: envelopeProvider(task.reviewerBinding?.harnessId ?? task.harnessId),
      model: task.reviewerBinding?.modelId ?? task.modelId,
      accountId: task.reviewerBinding?.accountId ?? task.accountId,
    },
  });
  if (!complete.decision.allow) return { kind: "await-owner", reason: complete.decision.reason };
  if (complete.reservationId) consumeAutonomyReservation(complete.reservationId);
  return { kind: "complete", reason: complete.decision.reason };
}

export async function recordAutonomousObservation(input: {
  missionId: string;
  taskTitle: string;
  projectPath: string;
  reviewId: string;
  verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED" | null;
  summary: string | null;
}): Promise<void> {
  const binding = autonomyPolicyStore.getBinding(input.missionId);
  if (!binding) return;
  const policy = autonomyPolicyStore.policyRevision(binding.policyId, binding.revision);
  if (!policy) return;
  const candidate = buildLowRiskMemoryCandidate(input);
  if (!candidate.ok) return;
  const approval = policy.body.memory.approval;
  if (policy.body.mode === "supervised" || approval === "owner") return;
  const allowed = authorizeAutonomyAction({
    missionId: input.missionId,
    targetKey: `memory:${input.reviewId}`,
    requiredActivationId: binding.activationId,
    target: {
      action: approval === "auto-low-risk" ? "persist_memory" : "save_observation",
      projectPath: input.projectPath,
      role: "head",
      provider: policy.body.providers[0],
      model: policy.body.models[0],
    },
  });
  if (!allowed.decision.allow) return;
  const { recordMemoryProposals, approveMemoryProposal, readMemoryProposal } = await import("../brain-proposals.ts");
  const fingerprint = proposalFingerprint({
    scopeKind: "project",
    scopeId: candidate.projectPath,
    kind: "observation",
    title: candidate.title,
    content: candidate.content,
  });
  const ids = recordMemoryProposals(
    {
      managerKind: "head-of-pm",
      sourceProjectPath: candidate.projectPath,
      conversationKey: `autonomy:${input.missionId}`,
      turnId: input.reviewId,
      messageId: input.reviewId,
      permission: { company: false, projectPaths: [candidate.projectPath] },
    },
    [{
      title: candidate.title,
      kind: "observation",
      claim: "observation",
      scopeKind: "project",
      scopeId: candidate.projectPath,
      projectPath: candidate.projectPath,
      content: candidate.content,
      sourceRef: candidate.sourceRef,
      fingerprint,
    }],
  );
  if (approval !== "auto-low-risk" || ids.length === 0) return;
  const proposal = readMemoryProposal(ids[0]!);
  await approveMemoryProposal(proposal.id, proposal.revision);
}
