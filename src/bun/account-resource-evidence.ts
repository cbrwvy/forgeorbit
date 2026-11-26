import { interviewSupportFor } from "../shared/project-interview.ts";
/** Read-only adapter over AccountCore, exact profile status, model and permission evidence. */
import { AGENT_OPTIONS, type Harness, type Task } from "../shared/types.ts";
import { currentFact } from "../shared/model-router/route.ts";
import type { ResourceCandidate } from "../shared/model-router/types.ts";
import type { AccountResourceEvidence, ResourceRole } from "../shared/model-router/account-eligibility.ts";
import { AccountCore } from "./account-core.ts";
import { db } from "./db.ts";
import { activeProviderRefusal } from "./provider-refusals.ts";
import { resourceKey } from "./orchestrated-resources.ts";
import { cachedCodexAuthentication, isCodexProfile, selectedCodexAccount } from "./codex-profiles.ts";

export function accountResourceEvidence(h: Harness, task: Pick<Task, "agent" | "agentProfileId">, model: string, mode: string, role: ResourceRole, rows: readonly ResourceCandidate[], now: number): AccountResourceEvidence {
  const core = new AccountCore(db, () => now);
  let fingerprint: string | null = null, configuration: AccountResourceEvidence["configuration"] = "valid";
  let account: AccountResourceEvidence["account"] = null;
  try {
    const id = isCodexProfile(h) ? selectedCodexAccount(h)?.id : core.resolveIdentity(h.id, task.agent === h.id ? task.agentProfileId : null).accountId;
    const a = id ? core.getAccount(id) : null;
    if (a && a.archivedAt === null) account = { id: a.id, label: a.displayName, provider: a.provider };
    fingerprint = resourceKey(h);
  } catch { configuration = "invalid"; }
  // Never consume a neighbour's authentication, support or capability record.
  const exact = rows.filter(r => r.accountId === account?.id && r.modelId === model);
  const auth = exact.find(r => currentFact(r.authorization, now))?.authorization;
  const authentication = isCodexProfile(h) ? cachedCodexAuthentication(h, now)
    : auth && currentFact(auth, now) ? auth.value ? "authenticated" : "required" : "unknown";
  const support = exact.find(r => r.support && r.support.verification === "verified" && !!r.support.source && r.support.observedAt <= now && r.support.expiresAt !== null && r.support.expiresAt > now)?.support;
  const known = AGENT_OPTIONS[h.kind]?.models.some(m => m.id === model && !m.catalogOnly) ?? false;
  // Local vocabulary proves adapter compatibility only, never account entitlement.
  const modelState = support?.support === "unsupported" ? "unsupported" : support?.support === "supported" ? "supported" : known || exact.length > 0 ? "unknown" : "unsupported";
  const managerSupport = interviewSupportFor(h.kind);
  const writeModes: Record<string, string[]> = { codex:["auto","full-access"], "claude-code":["auto","bypass"], cursor:["auto"], gemini:["auto"], fx:["auto","yolo"], antigravity:["auto","ask"] };
  const access: AccountResourceEvidence["access"] = h.kind === "claude-code" && mode === "bounded-print" ? role === "reviewer" ? "read-only" : "workspace-write"
    : managerSupport.supported && managerSupport.mode === mode || h.kind === "gemini" && mode === "ask" ? "read-only"
    : writeModes[h.kind]?.includes(mode) ? "workspace-write" : "unknown";
  const observed = exact.flatMap(r => currentFact(r.evidence.capabilities, now) ? r.evidence.capabilities.value : []);
  const providerRefusal = activeProviderRefusal({ harnessId: h.id, accountId: account?.id ?? null, modelId: model });
  return { account, fingerprint, configuration, authentication, model: modelState, providerRefusal,
    access, capabilities: [...new Set([...observed, ...(access === "read-only" ? ["read-only"] : access === "workspace-write" ? ["file-modification"] : [])])] };
}
