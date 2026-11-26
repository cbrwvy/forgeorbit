/**
 * Which harness, model and account a hands-off step may use. The Router proposes; the project's policy decides.
 * A candidate is covered only when its harness AND its account are listed. An empty list covers nothing, and no
 * substitute is ever invented: a requested resource that is not covered is refused, not replaced.
 */
import { harnesses } from "../db.ts";
import { explainBinding } from "../multiaccount/binding.ts";
import { routerV2Service } from "../router-v2/router-v2-service.ts";
import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
import { hasResource, type HandsoffPolicy, type HandsoffState } from "../../shared/handsoff.ts";

export type HandsoffRole = "developer" | "reviewer";

/** The account id a policy lists for a harness that has no registered account (a plain, unscoped CLI login). */
export const UNSCOPED_ACCOUNT = "default";

export interface ChosenResource {
  harnessId: string;
  modelId: string;
  accountId: string | null;
  mode: string;
  kind: string;
}

const transient = (reason: string) => reason.startsWith("concurrency-limit-reached:");

export function accountKey(accountId: string | null | undefined): string {
  return accountId ?? UNSCOPED_ACCOUNT;
}

export function chooseResource(input: {
  taskId: string;
  projectPath: string;
  title: string;
  role: HandsoffRole;
  policy: HandsoffPolicy;
  requested: HandsoffState["requested"];
}): { ok: true; resource: ChosenResource } | { ok: false; code: "no-resource"; message: string } {
  if (input.policy.resources.length === 0) {
    return { ok: false, code: "no-resource", message: "The Work independently policy does not list a covered harness and account. Nothing was chosen for you." };
  }
  const evaluation = routerV2Service.evaluateTaskSync({
    taskId: input.taskId,
    projectId: input.projectPath,
    title: input.title,
    role: input.role,
    requestedHarnessId: input.role === "developer" ? input.requested.harnessId : null,
    requestedModelId: input.role === "developer" ? input.requested.modelId : null,
    requestedAccountId: input.role === "developer" ? input.requested.accountId : null,
  });
  const pool = [...evaluation.eligible, ...evaluation.ineligible.filter((candidate) => candidate.eliminationReasons.every(transient))];
  const covered = pool.flatMap((candidate) => {
    const kind = harnesses.get(candidate.harnessId)?.kind;
    if (!kind) return [];
    if (input.role === "developer") {
      // Version one drives Developers in the isolated working copy: Codex in its sandboxed Auto mode.
      if (kind !== "codex" || candidate.mode !== "auto") return [];
    } else {
      const contract = readOnlyReviewerContract(kind);
      if (!contract || candidate.mode !== contract.mode) return [];
    }
    if (!hasResource(input.policy.resources, input.role, candidate.harnessId, accountKey(candidate.accountId))) return [];
    const wanted = input.requested;
    if (input.role === "developer") {
      if (wanted.harnessId && wanted.harnessId !== candidate.harnessId) return [];
      if (wanted.modelId && wanted.modelId !== candidate.modelId) return [];
      if (wanted.accountId && wanted.accountId !== accountKey(candidate.accountId)) return [];
    }
    if (candidate.accountId) {
      const binding = explainBinding(candidate);
      if (!binding.ok || !binding.frozen) return [];
    }
    return [{ candidate, kind }];
  });
  if (covered.length === 0) {
    const asked = input.requested.harnessId || input.requested.modelId || input.requested.accountId
      ? " The resource you chose is not covered or not eligible, and no substitute was selected."
      : "";
    return { ok: false, code: "no-resource", message: `No covered harness, account and model is eligible for the ${input.role} right now.${asked}` };
  }
  // Prefer a candidate with no recorded provider refusal; an all-refused pool is still returned so the limit check explains it.
  const best = covered.find(({ candidate }) => !candidate.providerRefusal) ?? covered[0]!;
  const { candidate, kind } = best;
  return { ok: true, resource: { harnessId: candidate.harnessId, modelId: candidate.modelId, accountId: candidate.accountId, mode: candidate.mode, kind } };
}
