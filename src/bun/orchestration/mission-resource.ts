import { AccountCore } from "../account-core.ts";
import { autonomyNow } from "../autonomy/policy-engine.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { db, harnesses, runs } from "../db.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { policyCoversTarget, type AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";
import type { ProjectRouterPolicyConfig } from "../../shared/router-v2/types.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import { computeMissionPlanDigest } from "../../shared/orchestration/plan-digest.ts";
import type { MissionRecord, MissionStageResource, MissionTaskPlan } from "../../shared/orchestration/types.ts";
import type { MissionAccountLimit } from "../../shared/orchestration/types.ts";
import { activeProviderRefusal } from "../provider-refusals.ts";
import { AccountCoreQuotaAdapter } from "../router-v2/router-v2-quota-adapters.ts";

export function missionAccountLimit(
  resource: { harnessId: string; accountId?: string | null; modelId: string },
  role: MissionAccountLimit["role"],
  now: number,
  retryRefusalId?: string,
): MissionAccountLimit | undefined {
  const { accountId, harnessId, modelId } = resource;
  if (!accountId) return;
  const refusal = activeProviderRefusal({ accountId, harnessId, modelId }, now);
  if (refusal && refusal.id !== retryRefusalId) {
    return { role, accountId, accountLabel: refusal.accountLabel ?? harnesses.get(harnessId)?.label ?? accountId, resetAt: null, refusal };
  }
  const windows = new AccountCoreQuotaAdapter(db, () => now).getQuotaSync(accountId, harnessId, modelId)?.exhaustedWindows;
  if (!windows?.length) return;
  const accountLabel = new AccountCore(db).getAccount(accountId).displayName;
  const resetAt = windows.every(window => window.resetAt !== null) ? Math.max(...windows.map(window => window.resetAt!)) : null;
  return { role, accountId, accountLabel, resetAt, windows };
}

export function settledMissionImplementation(task: MissionTaskPlan) {
  const run = task.runId ? runs.get(task.runId) : null;
  return run?.taskId === task.taskId && run.status === "succeeded" && !run.qcReviewId ? run : null;
}

export function activeMissionPolicy(mission: MissionRecord) {
  const binding = autonomyPolicyStore.getBinding(mission.id);
  if (!binding || binding.mode === "supervised" || binding.outcome !== "active" || autonomyPolicyStore.readEmergency().active) return null;
  const activation = autonomyPolicyStore.getActivation(binding.activationId);
  const policy = autonomyPolicyStore.policyRevision(binding.policyId, binding.revision);
  const now = autonomyNow();
  if (!policy || !activation || activation.status !== "active" || activation.digest !== binding.digest ||
    policy.digest !== binding.digest || now >= Math.min(activation.expiresAt, policy.body.expiresAt, activation.activatedAt + policy.body.maxDurationMs)) return null;
  return { binding, policy, activation };
}

export function missionResourceBlock(mission: MissionRecord, task: MissionTaskPlan, role: "developer" | "reviewer", resource: MissionStageResource) {
  const current = activeMissionPolicy(mission);
  const harness = harnesses.get(resource.harnessId);
  if (!current || current.binding.emergencyTaskIds.includes(task.taskId)) return "The original mission policy is no longer active.";
  if (!harness?.enabled) return "The selected harness is disabled or missing.";
  const body = current.policy.body;
  const action = role === "reviewer" ? "run_qc" : "launch_task";
  if (!policyCoversTarget(body, task) || !body.permittedActions.includes(action) || !body.specialistRoles.includes(role) ||
    !body.providers.includes(harness.kind) || !body.models.includes(resource.modelId) || !body.accounts.includes(resource.accountId)) {
    return "This exact resource is outside the current Owner policy.";
  }
  if (body.spending.requireEnforceableCap) return "The policy requires an enforceable spending cap.";
  const admission = checkProjectLaunchAdmission(task.projectPath);
  if (!admission.allowed) return admission.reason ?? "Project admission is blocked.";
  if (role === "reviewer" ? readOnlyReviewerContract(harness.kind)?.mode !== resource.mode
    : resource.mode !== "auto" || !["codex", "claude-code"].includes(harness.kind)) {
    return "The selected mode has no supported project-bound execution contract for this stage.";
  }
  const exact = explainBinding({ ...resource, provider: harness.kind });
  if (!exact.ok || !exact.frozen) return exact.ok ? "An exact registered account is required." : exact.reason;
  if (body.requireVerifiedQuota && !new AccountCore(db).hasVerifiedHeadroom(resource.accountId, resource.harnessId, resource.modelId)) {
    return "The policy requires fresh verified headroom for this resource.";
  }
  return null;
}

export function autonomyEnvelopeOverride(body: AutonomyPolicyBody): Partial<ProjectRouterPolicyConfig> {
  const ids = new Set(body.providers.map(provider => provider.toLowerCase()));
  for (const row of harnesses.list()) {
    if (ids.has(row.kind.toLowerCase()) || ids.has(row.id.toLowerCase())) ids.add(row.id);
  }
  return {
    envelopeLocked: true,
    envelopeAllowUnscopedAccount: body.allowUnscopedAccount === true && body.accounts.length === 0,
    autonomyMode: body.mode === "full-autonomy" ? "full-autonomy" : body.mode === "autonomous" ? "autonomous" : "supervised",
    constraints: {
      allowedHarnessIds: [...ids],
      allowedAccountIds: [...body.accounts],
      allowedModels: [...body.models],
    },
  };
}

/** Fail closed when an autonomous launch is outside the approved envelope. A recommendation is not a grant. */
export function autonomousResourceHold(mission: MissionRecord, task: MissionTaskPlan, role: "developer" | "reviewer", retryRefusalId?: string): string | null {
  const current = activeMissionPolicy(mission);
  if (!current || current.policy.body.mode === "supervised") return null;
  const body = current.policy.body;
  if (body.providers.length === 0 || body.models.length === 0) {
    return "The approved policy has an empty provider or model envelope. The launch is held for Owner review. No resource was invented.";
  }
  const frozen = role === "reviewer" ? task.reviewerBinding : task.developerBinding;
  const harnessId = frozen?.harnessId ?? task.harnessId;
  const modelId = frozen?.modelId ?? task.modelId;
  const accountId = frozen?.accountId ?? task.accountId ?? null;
  const mode = frozen?.mode ?? task.mode;
  const harness = harnesses.get(harnessId);
  const kind = (harness?.kind ?? harnessId).toLowerCase();
  const providers = body.providers.map(provider => provider.toLowerCase());
  if (!providers.includes(kind) && !providers.includes(harnessId.toLowerCase())) {
    return `Provider ${harnessId} is outside the approved envelope. No substitute was selected.`;
  }
  if (!body.models.includes(modelId)) {
    return `Model ${modelId} is outside the approved envelope. No substitute was selected.`;
  }
  if (accountId) {
    if (!body.accounts.includes(accountId)) return `Account ${accountId} is outside the approved envelope. No substitute was selected.`;
  } else if (body.allowUnscopedAccount !== true || body.accounts.length > 0) {
    return "The launch has no approved account. An empty account list was not treated as unrestricted. It is held for Owner review.";
  }
  if (!frozen) return null;
  try {
    const evaluation = routerV2Service.evaluateTaskSync({
      taskId: task.taskId,
      projectId: task.projectPath,
      role,
      requestedHarnessId: harnessId,
      requestedModelId: modelId,
      requestedAccountId: accountId,
      requestedMode: mode,
    }, { policyOverride: autonomyEnvelopeOverride(body), retryRefusalId });
    const selected = evaluation.selected;
    if (!selected || selected.harnessId !== harnessId || selected.modelId !== modelId || selected.mode !== mode || selected.accountId !== accountId) {
      const pinned = evaluation.all.find(row => row.harnessId === harnessId && row.modelId === modelId && row.accountId === accountId && row.mode === mode);
      return `${pinned?.eliminationReasons[0] ?? "The frozen resource is not eligible."} No substitute was selected.`;
    }
  } catch (error) {
    return `Resource evaluation failed: ${error instanceof Error ? error.message : "unknown error"}. No substitute was selected.`;
  }
  return null;
}

export function verifyMissionStage(mission: MissionRecord, task: MissionTaskPlan, role: "developer" | "reviewer", resource: MissionStageResource, retryRefusalId?: string) {
  const row = db.query<{ status: string; plan_digest: string; authorization_json: string; plan_json: string }, [string]>(
    "SELECT status, plan_digest, authorization_json, plan_json FROM orchestration_missions WHERE id = ?",
  ).get(mission.id);
  if (!row || row.status !== "running" || row.plan_digest !== mission.planDigest ||
    JSON.parse(row.authorization_json ?? "null")?.digest !== mission.planDigest ||
    computeMissionPlanDigest(JSON.parse(row.plan_json)) !== mission.planDigest) {
    return "The exact mission revision is no longer authorized to launch.";
  }
  const problem = missionResourceBlock(mission, task, role, resource);
  if (problem) return problem;
  const current = activeMissionPolicy(mission);
  const evaluation = routerV2Service.evaluateTaskSync(
    {
      taskId: task.taskId,
      projectId: task.projectPath,
      role,
      requestedHarnessId: resource.harnessId,
      requestedModelId: resource.modelId,
      requestedAccountId: resource.accountId,
      requestedMode: resource.mode,
    },
    { policyOverride: current ? autonomyEnvelopeOverride(current.policy.body) : undefined, retryRefusalId },
  );
  const candidate = [...evaluation.eligible, ...evaluation.ineligible].find(c =>
    c.harnessId === resource.harnessId && c.modelId === resource.modelId && c.accountId === resource.accountId && c.mode === resource.mode);
  if (!candidate) return "The exact resource is no longer in the Router catalog.";
  return candidate.eliminationReasons.find(reason => !reason.startsWith("concurrency-limit-reached:")) ?? null;
}
