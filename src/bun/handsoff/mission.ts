/**
 * The mission side of "Work independently". An objective mission already carries the Owner's approval of its exact
 * plan; what used to wait for a click per task were the launch confirmations, the local application of a reviewed
 * result and its acceptance. When the task's project has an enabled policy that covers the step, the scheduler asks
 * this module instead of waiting. Same policy, same records, same refusals as a directly submitted task.
 */
import { tasks } from "../db.ts";
import { autonomyPolicyStore } from "../autonomy/policy-store.ts";
import { checkProjectLaunchAdmission } from "../project-lifecycle.ts";
import { requestPolicyCoveredTest } from "../project-permissions.ts";
import { acceptAuthorizedTaskDone } from "../task-quality-control.ts";
import { getTaskWorkspace, publishTaskWorkspace, TaskWorkspaceError } from "../task-workspace.ts";
import { handsoffStore } from "./store.ts";
import { accountKey } from "./resources.ts";

function livePolicy(projectPath: string) {
  const stored = handsoffStore.getPolicy(projectPath);
  return stored?.policy.enabled ? { policy: stored.policy, revision: stored.revision } : null;
}

/**
 * Does the project's policy already cover launching this resource? The caller still applies the Owner-device gate,
 * Emergency Stop, the project lifecycle and the Router envelope; this only answers "is a click still needed".
 */
export function handsoffCoversMissionStage(projectPath: string, resource: { harnessId: string; accountId?: string | null }, usageNotice: boolean): boolean {
  const live = livePolicy(projectPath);
  if (!live) return false;
  const key = accountKey(resource.accountId);
  if (!live.policy.resources.some((r) => r.harnessId === resource.harnessId && r.accountKey === key)) return false;
  if (usageNotice && !live.policy.acknowledgeUsageNotice) return false;
  return true;
}

export type MissionCompletion =
  | { kind: "done" }
  | { kind: "held"; reason: string };

/**
 * After an independent Reviewer passed a mission task: run the covered offline test, apply the reviewed working copy
 * through the scoped publication, and accept the result. Each step is the existing service; a refusal leaves the
 * Owner's normal controls untouched and reports why. Idempotent: a published workspace is not written twice, and a
 * task already Done stays Done.
 */
export async function handsoffCompleteMissionTask(taskId: string): Promise<MissionCompletion> {
  const task = tasks.get(taskId);
  if (!task) return { kind: "held", reason: "The task no longer exists." };
  if (task.column === "done") return { kind: "done" };
  const live = livePolicy(task.workdir);
  if (!live) return { kind: "held", reason: "Work independently is off for this project." };
  if (autonomyPolicyStore.readEmergency().active) return { kind: "held", reason: "Emergency Stop is active." };
  const admission = checkProjectLaunchAdmission(task.workdir);
  if (!admission.allowed) return { kind: "held", reason: admission.reason ?? "The project is stopped." };
  const ws = getTaskWorkspace(taskId);
  const paths = (ws?.changes ?? []).filter((change) => change.scope === "output" && change.kind !== "unchanged").map((change) => change.path);
  if (paths.length > 0 && ws?.status !== "published") {
    if (!live.policy.autoApply) return { kind: "held", reason: "Applying the result is left to you by this project's policy." };
    if (live.policy.runOfflineTests) {
      try {
        const request = await requestPolicyCoveredTest({ taskId, policyRevision: live.revision });
        if (request.status === "failed") return { kind: "held", reason: "The offline test failed, so nothing was applied." };
      } catch { /* no single test file, or the test could not run: reported by the task, never counted as a pass */ }
    }
    try {
      await publishTaskWorkspace(taskId, { approve: true, paths });
    } catch (error) {
      return { kind: "held", reason: `Nothing was overwritten. ${error instanceof TaskWorkspaceError ? error.message : String(error)}` };
    }
  }
  if (!live.policy.autoDone) return { kind: "held", reason: "Accepting the result is left to you by this project's policy." };
  const done = acceptAuthorizedTaskDone(taskId);
  return done.ok && done.task.column === "done" ? { kind: "done" } : { kind: "held", reason: done.ok ? "The task did not reach Done." : done.reason };
}
