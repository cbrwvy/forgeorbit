/** Read-only PM routing: same deterministic recommender, never assigns or runs. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AssignmentProposal } from "../shared/assignments/proposals.ts";
import { pickProposedExecutor, type AssignmentExecutorReview } from "../shared/execution/executor-routing.ts";
import { taskFingerprint } from "../shared/project-execution.ts";
import { routingEvidenceKey } from "./routing-evidence-key.ts";
import { buildRoutingSnapshot } from "./model-router.ts";
import { tasks, harnesses, db } from "./db.ts";
import { recommendExecutors, type RecommendationDeps } from "./executor-recommendations.ts";
import { workspacePermissionIdentity } from "./execution-layout.ts";
import { permissionSubject } from "./task-workspace.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";

const secret = randomBytes(32);
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");

function liveState(proposal: AssignmentProposal) {
  const task = tasks.get(proposal.taskId);
  const evidence = routingEvidenceKey(buildRoutingSnapshot(db));
  return { evidence, proposalId: proposal.id, revision: proposal.revision, worker: proposal.worker,
    currentAssignment: proposal.currentAssignment, task: task ? taskFingerprint(task) : null,
    workspace: task ? workspacePermissionIdentity(permissionSubject(task), harnesses.getByIdOrKind(task.agent) ?? undefined) : null,
    preferences: loadExecutorPreferences(), harnesses: harnesses.list() };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function assignmentExecutorReview(proposal: AssignmentProposal, deps: RecommendationDeps = {}): Promise<AssignmentExecutorReview & { stateKey: string }> {
  const before = liveState(proposal);
  const response = await recommendExecutors({ taskId: proposal.taskId }, deps);
  const state = liveState(proposal);
  if (digest(before) !== digest(state)) throw new Error("Routing inputs changed. Review again.");
  const groups = response.recommendations.groups;
  const { proposed, alternatives } = pickProposedExecutor(response.recommendations);
  const hash = digest({ state, groups, routingAvailable: response.routingAvailable });
  const expiresAt = (deps.now ?? Date.now)() + 5 * 60_000;
  const body = Buffer.from(JSON.stringify({ proposalId: proposal.id, hash, expiresAt })).toString("base64url");
  return { proposed, alternatives, automaticSelection: response.recommendations.automaticSelection,
    routingAvailable: response.routingAvailable, reviewToken: `${body}.${sign(body)}`, expiresAt,
    readOnly: true, executionAvailable: false, stateKey: digest(state) };
}

/** Called after recomputing current evidence; any change requires a new Owner review. */
export function verifyAssignmentExecutorReview(proposal: AssignmentProposal, token: unknown, fresh: AssignmentExecutorReview & { stateKey: string }, now = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 1024) return false;
  try {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra || mac.length !== sign(body).length || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) return false;
    const seen = JSON.parse(Buffer.from(body, "base64url").toString());
    const current = JSON.parse(Buffer.from(fresh.reviewToken.split(".")[0]!, "base64url").toString());
    return seen.proposalId === proposal.id && seen.expiresAt > now && seen.hash === current.hash
      && fresh.stateKey === digest(liveState(proposal));
  } catch { return false; }
}
