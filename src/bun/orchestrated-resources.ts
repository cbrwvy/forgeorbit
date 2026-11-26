import { AccountCore } from "./account-core.ts";
import { headBatchBlock } from "./head-pm-auto-boundary.ts";
import { selectedCodexAccount } from "./codex-profiles.ts";
/** Resource snapshot inside the existing Owner grant; no independent authorization. */
import { createHash } from "node:crypto";
import { BOUNDED_CLAUDE, CLAUDE_EDIT_TOOLS, CLAUDE_READ_TOOLS, type ApprovedWorkflowExecution } from "../shared/bounded-claude.ts";
import { defaultModeFor, supportedModes, type Task, type Harness } from "../shared/types.ts";
import type { OrchestratedWorkflowApproveBody, OrchestratedWorkflowGrant } from "../shared/pm-orchestrated-workflow.ts";
import { harnesses, tasks, db } from "./db.ts";
import { agentDriverIsFake, resolveBin } from "./agents.ts";
import { configuredClaudeQaDirectory, configuredClaudeQaAuthHome, claudeQaHomeAccessAccepted } from "./claude-auth-compat.ts";
export function resourceKey(h: Harness): string {
  // Harness env may contain credentials: persist only a digest, never another copy.
  const profile = h.kind === "codex" ? selectedCodexAccount(h) : null;
  const identity: unknown[] = [h.id, h.kind, h.enabled, resolveBin(h), h.home, h.env, agentDriverIsFake(h.kind),
    h.kind === "claude-code" ? process.env.AGETOR_CLAUDE_DRIVER ?? "provider" : null];
  if (profile) identity.push("codex-account-profile", profile.id, profile.codexProfile);
  const qaDirectory = h.kind === "claude-code" ? configuredClaudeQaDirectory(h.env ?? {}) : undefined;
  if (qaDirectory !== undefined) identity.push(qaDirectory);
  const authHome = h.kind === "claude-code" ? configuredClaudeQaAuthHome(h.env ?? {}) : undefined;
  if (authHome !== undefined) identity.push("explicit-qa-auth-home", authHome, claudeQaHomeAccessAccepted(h.env ?? {}));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
export function unsupportedModelReason(h: Harness, model: string): string | null {
  return confirmedModelBlock(h, model);
}
function confirmedModelBlock(h: Harness, model: string): string | null {
  const core = new AccountCore(db), id = core.resolveIdentity(h.id).accountId;
  if (!id) return null;
  const now = Date.now();
  return core.modelCapabilities(id).some(c => c.harnessId === h.id && c.modelId === model && c.support === "unsupported" && c.verification === "verified" && !!c.source && c.observedAt <= now && c.expiresAt !== null && c.expiresAt > now)
    ? "Approved account/model is confirmed unsupported. No fallback." : null;
}
export function freezeWorkflowExecution(task: Task, body: OrchestratedWorkflowApproveBody): ApprovedWorkflowExecution {
  const impl = harnesses.getByIdOrKind(body.implementerHarnessId), qc = harnesses.getByIdOrKind(body.reviewerHarness);
  if (!impl?.enabled || !qc?.enabled) throw new Error("Approved execution resource is missing or disabled.");
  const implementerMode = body.implementerMode ?? task.mode ?? defaultModeFor(impl.kind);
  const reviewerMode = body.reviewerMode ?? implementerMode;
  for (const [h, mode, model] of [[impl, implementerMode, body.implementerModel], [qc, reviewerMode, body.reviewerModel]] as const) {
    const modelBlock = confirmedModelBlock(h, model);
    if (modelBlock) throw new Error(modelBlock);
    if (!supportedModes(h.kind, model).some(m => m.id === mode)) throw new Error(`Execution mode ${mode} is unavailable for ${h.id}. No fallback.`);
  }
  if (qc.kind === "codex" && reviewerMode !== "ask") throw new Error("Codex Reviewer requires explicit read-only mode. No fallback.");
  const bounded = implementerMode === "bounded-print" || reviewerMode === "bounded-print";
  if (bounded && (impl.kind !== "claude-code" || qc.kind !== "claude-code" || implementerMode !== "bounded-print" || reviewerMode !== "bounded-print")) throw new Error("Bounded batches require explicit Claude bounded-print for Developer and Reviewer.");
  return { implementerMode, reviewerMode, implementerHarnessKey: resourceKey(impl), reviewerHarnessKey: resourceKey(qc),
    implementerAccountProfile: impl.kind === "codex" ? profileLabel(impl) : null,
    reviewerAccountProfile: qc.kind === "codex" ? profileLabel(qc) : null,
    boundedPolicy: bounded ? { ...BOUNDED_CLAUDE, developerTools: [...CLAUDE_EDIT_TOOLS], reviewerTools: [...CLAUDE_READ_TOOLS] } : null };
}
export function workflowResourceBlock(grant: OrchestratedWorkflowGrant, review = false): string | null {
  if (grant.orchestratedBatchId) {
    const gate = headBatchBlock(grant.orchestratedBatchId);
    if (gate) return gate;
    const row = db.query<{status: string}, [string]>("SELECT status FROM pm_orchestrated_batches WHERE id = ?").get(grant.orchestratedBatchId);
    if (row?.status !== "running") return "Parent batch is paused, cancelled or unavailable.";
  }
  const e = grant.execution;
  if (!e) return null; // Legacy grants retain their existing behavior, never upgraded to bounded approval.
  const h = harnesses.getByIdOrKind(review ? grant.reviewerHarness : grant.implementerHarnessId);
  try {
    if (!h?.enabled || resourceKey(h) !== (review ? e.reviewerHarnessKey : e.implementerHarnessKey)) return "Approved execution resource changed or is unavailable. No fallback.";
  } catch { return "Approved Codex profile changed or is unavailable. No fallback."; }
  if (!h) return "Approved execution resource is missing.";
  const mode = review ? e.reviewerMode : e.implementerMode;
  const model = review ? grant.reviewerModel : grant.implementerModel;
  if (review && h.kind === "codex" && mode !== "ask") return "Codex Reviewer requires explicit read-only mode. No fallback.";
  const modelBlock = confirmedModelBlock(h, model);
  if (modelBlock) return modelBlock;
  if (!supportedModes(h.kind, model).some(m => m.id === mode)) return "Approved execution mode is unavailable. No fallback.";
  if (!review && (tasks.get(grant.taskId)?.mode ?? defaultModeFor(h.kind)) !== mode) return "Task execution mode changed since approval. No fallback.";
  if (e.boundedPolicy && JSON.stringify(e.boundedPolicy) !== JSON.stringify({ ...BOUNDED_CLAUDE, developerTools: CLAUDE_EDIT_TOOLS, reviewerTools: CLAUDE_READ_TOOLS })) return "Bounded execution policy changed. Owner approval required.";
  return null;
}

function profileLabel(h: Harness) {
  const a = selectedCodexAccount(h);
  return a ? { id: a.id, displayName: a.displayName } : null;
}
