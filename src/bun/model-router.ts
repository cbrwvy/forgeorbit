/** Read-only bridge to the existing AccountCore, Portfolio ownership and Estimation Engine.
 * No CLI imports, credentials, provider calls, account switching or runtime writes. */
import type { Database } from "bun:sqlite";
import { AccountCore } from "./account-core.ts";
import { db, projects, projectEstimation } from "./db.ts";
import { projectWorkdirs } from "./project-ownership.ts";
import { resolveProject } from "./environment/http.ts";
import { analyzeTaskRequirements } from "../shared/model-router/requirements.ts";
import { EMPTY_MODEL_EVIDENCE, UNKNOWN_OWNER_CONSTRAINTS, quotaPoolKey } from "../shared/model-router/route.ts";
import type { OwnerRoutingConstraints, ResourceCandidate, ResourceLimit, RoutingSnapshot, TaskRequirements, VerifiedFact } from "../shared/model-router/types.ts";
import { parseEstimationSettings } from "../shared/estimation/settings.ts";
import { adaptProject } from "../shared/estimation/project-adapter.ts";
import { estimate } from "../shared/estimation/estimate.ts";

function fact<T>(value: T, source: string, now: number): VerifiedFact<T> {
  return { value, source, verification: "verified", observedAt: now, expiresAt: now + 30_000 };
}
/** Injectable database makes acquisition independently testable. The account registry stays canonical. */
export function buildRoutingSnapshot(database: Database = db, now = Date.now()): RoutingSnapshot {
  return database.transaction(() => {
    const core = new AccountCore(database, () => now);
    const accounts = core.listAccounts();
    const bindings = core.bindings();
    const quotas = accounts.flatMap(a => core.currentQuotas(a.id));
    const subscriptions = core.listSubscriptions();
    const subscriptionLinks = accounts.flatMap(a => core.subscriptionsFor(a.id).map(s => ({ accountId: a.id, subscriptionId: s.id })));
    const profiles = database.query<{ id: string; harness_id: string; model: string }, []>("SELECT id, harness_id, model FROM agent_profiles").all();
    const associations = core.associations();
    const harnessRows = database.query<{ id: string; enabled: number }, []>("SELECT id, enabled FROM harnesses ORDER BY id").all();
    const candidates: ResourceCandidate[] = [];
    for (const h of harnessRows) {
      const linked = bindings.filter(b => b.harnessId === h.id);
      for (const accountId of linked.length ? linked.map(b => b.accountId) : [null]) {
        const support = accountId ? core.modelCapabilities(accountId).filter(m => m.harnessId === h.id) : [];
        const linkedProfiles = profiles.filter(p => p.harness_id === h.id && (accountId === null
          || associations.some(a => a.accountId === accountId && a.harnessId === h.id && a.profileId === p.id)));
        const models = [...new Set([...support.map(m => m.modelId), ...linkedProfiles.map(p => p.model)])].sort();
        for (const modelId of models.length ? models : [null]) {
          candidates.push({
            id: JSON.stringify([h.id, accountId, modelId]), harnessId: h.id, accountId, modelId,
            profileIds: linkedProfiles.filter(p => p.model === modelId).map(p => p.id),
            enabled: h.enabled === 1, authorization: null, availability: null, billing: null,
            support: support.find(m => m.modelId === modelId) ?? null, evidence: { ...EMPTY_MODEL_EVIDENCE },
          });
        }
      }
    }
    // Includes runs outside registered projects. Historical profile bindings cannot identify run accounts.
    const running = database.query<{ agent: string; n: number }, []>("SELECT agent, COUNT(*) AS n FROM runs WHERE status = 'running' GROUP BY agent").all();
    const active = running.reduce((n,r) => n + r.n, 0);
    const limits: ResourceLimit[] = [{ id: "global", scope: { kind: "global" }, limit: null, occupied: fact(active, "sqlite:all-running-runs", now) }];
    for (const a of accounts) {
      const caps = quotas.filter(q => q.definition.accountId === a.id && q.definition.scope === "account"
        && q.definition.unit.kind === "concurrency" && q.definition.window === "instant" && !quotaPoolKey(q));
      const o = caps.length === 1 ? caps[0]!.current : null;
      limits.push({
        id: "account:" + a.id, scope: { kind: "account", id: a.id },
        limit: o?.verification === "verified" && o.limit !== null ? { ...fact(o.limit, o.source, o.observedAt), expiresAt: o.expiresAt } : null,
        // Absence of local runs does not prove absence of direct CLI/provider usage.
        occupied: active === 0 && o?.verification === "verified" && o.used !== null
          ? { ...fact(o.used, o.source, o.observedAt), expiresAt: o.expiresAt } : null,
      });
    }
    const pools = new Map(quotas.filter(q => q.definition.unit.kind === "concurrency" && q.definition.window === "instant").map(q => [quotaPoolKey(q), q]));
    for (const [key, q] of pools) {
      if (!key) continue;
      const o = q.current!;
      limits.push({ id: "pool:" + key, scope: { kind: "pool", id: key },
        limit: o.limit === null ? null : { ...fact(o.limit, o.source, o.observedAt), expiresAt: o.expiresAt },
        occupied: o.used === null ? null : { ...fact(o.used, o.source, o.observedAt), expiresAt: o.expiresAt },
      });
    }
    return { capturedAt: now, candidates, accounts, bindings, subscriptions, subscriptionLinks, quotas, limits, occupancyComplete: true };
  })();
}

export class RoutingInputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function projectRoutingInput(projectPath: string, taskId: string, overrides: Partial<TaskRequirements> = {}) {
  // Exact registry lookup precedes any filesystem lookup. Never inspect an arbitrary requested path.
  if (!projects.get(projectPath)) throw new RoutingInputError("Registered project not found.", 404);
  const resolved = resolveProject(projectPath);
  if (!resolved.ok) throw new RoutingInputError(resolved.error, resolved.status);
  const workdirs = projectWorkdirs(resolved.path, db.query<{ workdir: string }, []>("SELECT DISTINCT workdir FROM tasks").all());
  const rows = projectEstimation.facts(workdirs);
  const task = rows.find(t => t.id === taskId && !t.archived && t.pipelineParentId === null);
  if (!task) throw new RoutingInputError("Task not found in this project.", 404);
  const requirements = analyzeTaskRequirements({ ...overrides, taskId, projectId: resolved.path,
    priority: db.query<{ priority: TaskRequirements["priority"] }, [string]>("SELECT priority FROM task_priorities WHERE task_id = ?").get(taskId)?.priority ?? null, provenance: ["sqlite:task", "sqlite:task-priority", ...(Object.keys(overrides).length ? ["owner:preview-requirements"] : [])] });
  const owner: OwnerRoutingConstraints = { ...UNKNOWN_OWNER_CONSTRAINTS, requiredApprovals: [...UNKNOWN_OWNER_CONSTRAINTS.requiredApprovals] };
  let planningEstimate: ReturnType<typeof estimate> | null = null;
  const stored = projectEstimation.get(resolved.path);
  if (stored) {
    let value: unknown;
    try { value = JSON.parse(stored.settings); } catch { throw new RoutingInputError("Saved estimation settings are unreadable.", 422); }
    const parsed = parseEstimationSettings(value);
    if (!parsed.ok) throw new RoutingInputError("Saved estimation settings are invalid.", 422);
    const settings = parsed.settings;
    owner.spending = settings.budgetMode === "overage-off" ? "no-extra" : settings.budgetMode === "overage-on" ? "allow-overage" : null;
    owner.maxExpectedCost = settings.maxAdditionalSpend;
    owner.globalConcurrency = null; // Project planning parallelism is not a global limit.
    const selected = { ...settings, scope: { kind: "selected" as const, itemIds: [taskId] } };
    const adapted = adaptProject({ projectPath: resolved.path, projectLabel: "Routing preview", facts: rows.map(r => ({ ...r, observedRuns: [] })), settings: selected });
    planningEstimate = estimate(adapted.request);
  }
  return { requirements, owner, planningEstimate };
}
