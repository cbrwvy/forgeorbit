/**
 * The Owner's per-project "Work independently" policy. Saving is the one-time setup; it is the only place the policy
 * changes, and only through the Owner bearer route. A task, a model or a run cannot create or widen it.
 */
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { db, harnesses, projects } from "../db.ts";
import { ownerProjectOf } from "../project-ownership.ts";
import { isWorkspaceDevelopmentEnabled, setProjectWorkspaceDevelopment } from "../project-permissions.ts";
import { broadcastAppEvent } from "../quit-guard.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import { DEFAULT_HANDSOFF_POLICY, handsoffPolicyWidens, parseHandsoffPolicy, type HandsoffPolicy, type StoredHandsoffPolicy } from "../../shared/handsoff.ts";
import { HandsoffError } from "./errors.ts";
import { accountKey, UNSCOPED_ACCOUNT } from "./resources.ts";
import { authorizationView, revokeProjectAuthorization } from "./authorization.ts";
import { handsoffStore } from "./store.ts";
import type { HandsoffAuthorizationView } from "../../shared/handsoff-authorization.ts";

export interface HandsoffResourceOption {
  harnessId: string;
  harnessLabel: string;
  accountKey: string;
  accountLabel: string;
  role: "developer" | "reviewer";
}

export interface HandsoffPolicyView {
  projectPath: string;
  policy: HandsoffPolicy;
  revision: number;
  activatedAt: number | null;
  /** The existing per-project "Development in a working copy" switch. Hands-off work needs it on. */
  workingCopy: boolean;
  /** What the Router can offer for this project today. The Owner picks from these; nothing is pre-covered. */
  available: HandsoffResourceOption[];
  /** The project-level Owner authorization (one native confirmation), when this build asks for one. */
  authorization: HandsoffAuthorizationView;
}

function registered(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new HandsoffError("A project path is required.", 400, "project");
  const direct = projects.get(raw)?.path ?? ownerProjectOf(raw, { fresh: true });
  if (!direct || !projects.get(direct)) throw new HandsoffError("That project is not registered in ForgeOrbit.", 404, "project");
  return direct;
}

function availableFor(projectPath: string): HandsoffResourceOption[] {
  const seen = new Set<string>();
  const options: HandsoffResourceOption[] = [];
  for (const role of ["developer", "reviewer"] as const) {
    let candidates: ReturnType<typeof routerV2Service.gatherCandidatesSync> = [];
    try { candidates = routerV2Service.gatherCandidatesSync(role); } catch { candidates = []; }
    for (const candidate of candidates) {
      const kind = harnesses.get(candidate.harnessId)?.kind;
      if (!kind) continue;
      if (role === "developer" ? kind !== "codex" || candidate.mode !== "auto" : !readOnlyReviewerContract(kind) || candidate.mode !== readOnlyReviewerContract(kind)!.mode) continue;
      const key = `${role}:${candidate.harnessId}:${accountKey(candidate.accountId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        harnessId: candidate.harnessId,
        harnessLabel: candidate.harnessLabel,
        accountKey: accountKey(candidate.accountId),
        accountLabel: candidate.accountLabel ?? (candidate.accountId ? candidate.accountId : "Default account"),
        role,
      });
    }
  }
  return options;
}

export function readHandsoffPolicy(projectPathRaw: unknown): HandsoffPolicyView {
  const projectPath = registered(projectPathRaw);
  const stored: StoredHandsoffPolicy | null = handsoffStore.getPolicy(projectPath);
  return {
    projectPath,
    policy: stored?.policy ?? { ...DEFAULT_HANDSOFF_POLICY },
    revision: stored?.revision ?? 0,
    activatedAt: stored?.activatedAt ?? null,
    workingCopy: isWorkspaceDevelopmentEnabled(projectPath),
    available: availableFor(projectPath),
    authorization: authorizationView(projectPath),
  };
}

/**
 * Save the policy. Enabling it also turns on the existing working-copy switch for this project (the isolated
 * copy is what the policy covers) and refuses an empty harness or account list rather than covering everything.
 */
export async function saveHandsoffPolicy(projectPathRaw: unknown, body: unknown): Promise<HandsoffPolicyView> {
  const projectPath = registered(projectPathRaw);
  const before = handsoffStore.getPolicy(projectPath)?.policy ?? { ...DEFAULT_HANDSOFF_POLICY };
  const parsed = parseHandsoffPolicy(body, before);
  if (!parsed.ok) throw new HandsoffError(parsed.error, 400, "invalid");
  const next = parsed.policy;
  if (next.enabled && next.resources.length === 0) {
    throw new HandsoffError("Choose at least one covered resource (a role with its harness and account). An empty list covers nothing, and nothing is chosen for you.", 400, "empty-envelope");
  }
  const widened = handsoffPolicyWidens(before, next);
  const stored = handsoffStore.savePolicy(projectPath, next);
  // Turning the policy off narrows: it takes effect with no confirmation and ends the project's authorization.
  if (before.enabled && !next.enabled) await revokeProjectAuthorization(projectPath, "Work independently was turned off for this project.");
  if (next.enabled && !isWorkspaceDevelopmentEnabled(projectPath)) setProjectWorkspaceDevelopment(projectPath, true);
  try {
    new ActivityJournalCore(db).record({
      eventType: "handsoff.policy.updated",
      projectPath,
      actorType: "owner",
      actorId: "owner",
      targetType: "project",
      targetId: projectPath,
      idempotencyKey: `handsoff-policy:${projectPath}:${stored.revision}`,
      payload: {
        revision: stored.revision,
        enabled: next.enabled ? 1 : 0,
        autoApply: next.autoApply ? 1 : 0,
        autoDone: next.autoDone ? 1 : 0,
        widened: widened.join(",") || "none",
      } as Record<string, string | number>,
    });
  } catch { /* the policy row is the durable record */ }
  try { broadcastAppEvent({ type: "handsoff", projectPath, taskId: null, runId: null, status: next.enabled ? "policy-on" : "policy-off", ts: Date.now() }); } catch { /* next read catches up */ }
  return readHandsoffPolicy(projectPath);
}

export { UNSCOPED_ACCOUNT };
