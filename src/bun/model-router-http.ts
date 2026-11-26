import { recommendManagerResources } from "./executor-recommendations.ts";
import { PreflightError } from "./employee-execution.ts";
import { ROUTING_POLICIES, type OwnerRoutingConstraints, type RoutingPolicy, type TaskRequirements } from "../shared/model-router/types.ts";
import { previewPortfolioRouting, routeTask } from "../shared/model-router/route.ts";
import { buildRoutingSnapshot, projectRoutingInput, RoutingInputError } from "./model-router.ts";
import { buildModelRouterResourceContext } from "./model-router-context.ts";

const MAX_BODY = 64 * 1024;
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new RoutingInputError("Unsupported preview fields.");
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 2000 || /[\x00-\x1f]/.test(v)) throw new RoutingInputError("Invalid preview identifier.");
  return v;
}
function list(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 64) throw new RoutingInputError("Invalid requirement list.");
  return v.map(text);
}
function number(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new RoutingInputError("Invalid preview quantity.");
  return v;
}
function requirements(v: unknown): Partial<TaskRequirements> {
  if (v === undefined) return {};
  const r = object(v, ["type", "complexity", "capabilities", "tools", "requiredPermissions", "allowedPermissions", "contextTokens", "quotaDemands"]);
  if (r.type !== undefined && (typeof r.type !== "string" || !["backend", "frontend", "testing", "architecture", "documentation", "devops", "general"].includes(r.type))) throw new RoutingInputError("Invalid task type.");
  if (r.complexity !== undefined && (typeof r.complexity !== "string" || !["low", "medium", "high", "very-high", "unknown"].includes(r.complexity))) throw new RoutingInputError("Invalid task complexity.");
  for (const k of ["capabilities", "tools", "requiredPermissions", "allowedPermissions"]) if (r[k] !== undefined && !(k === "allowedPermissions" && r[k] === null)) r[k] = list(r[k]);
  if (r.contextTokens !== undefined && r.contextTokens !== null) r.contextTokens = number(r.contextTokens);
  if (r.quotaDemands !== undefined) {
    if (!Array.isArray(r.quotaDemands) || r.quotaDemands.length > 64) throw new RoutingInputError("Invalid quota demands.");
    const seen = new Set<string>();
    r.quotaDemands = r.quotaDemands.map(d => {
      const x = object(d, ["quotaId", "amount"]), quotaId = text(x.quotaId);
      if (seen.has(quotaId)) throw new RoutingInputError("Duplicate quota demand.");
      seen.add(quotaId); return { quotaId, amount: number(x.amount) };
    });
  }
  return r as Partial<TaskRequirements>;
}
/** Explicit preview-only Owner restrictions; saved project budget always wins if tighter.
 * No permissions, consent or execution approval is granted by this document. */
function ownerConstraints(v: unknown, saved: OwnerRoutingConstraints): OwnerRoutingConstraints {
  if (v === undefined) return saved;
  const r = object(v, ["allowedHarnesses", "allowedAccounts", "globalConcurrency", "projectPriority", "requiredApprovals", "spending", "maxExpectedCost"]);
  const out = { ...saved };
  for (const key of ["allowedHarnesses", "allowedAccounts", "requiredApprovals"] as const) {
    if (r[key] !== undefined) out[key] = key === "requiredApprovals" ? [...saved.requiredApprovals, ...list(r[key])] : list(r[key]);
  }
  if (r.globalConcurrency !== undefined) out.globalConcurrency = number(r.globalConcurrency);
  if (r.projectPriority !== undefined) {
    if (typeof r.projectPriority !== "string" || !["critical", "high", "normal", "low"].includes(r.projectPriority)) throw new RoutingInputError("Invalid project priority.");
    out.projectPriority = r.projectPriority as OwnerRoutingConstraints["projectPriority"];
  }
  if (r.spending !== undefined) {
    const spending = r.spending;
    if (typeof spending !== "string" || !["no-extra", "allow-overage", "allow-paid"].includes(spending)) throw new RoutingInputError("Invalid spending policy.");
    const rank = { "no-extra": 0, "allow-overage": 1, "allow-paid": 2 } as const;
    const requested = spending as keyof typeof rank;
    out.spending = saved.spending && rank[saved.spending] < rank[requested] ? saved.spending : requested;
  }
  if (r.maxExpectedCost !== undefined) {
    const m = object(r.maxExpectedCost, ["currency", "minor"]);
    if (typeof m.currency !== "string" || !/^[A-Z]{3}$/.test(m.currency)) throw new RoutingInputError("Invalid currency.");
    const money = { currency: m.currency, minor: number(m.minor) };
    if (saved.maxExpectedCost && saved.maxExpectedCost.currency !== money.currency) throw new RoutingInputError("Preview budget currency must match saved budget.");
    out.maxExpectedCost = saved.maxExpectedCost ? { currency: money.currency, minor: Math.min(money.minor, saved.maxExpectedCost.minor) } : money;
  }
  return out;
}
function input(v: unknown) {
  const r = object(v, ["path", "taskId", "policy", "requirements", "ownerConstraints"]);
  const policy = r.policy ?? "balanced";
  if (!ROUTING_POLICIES.includes(policy as RoutingPolicy)) throw new RoutingInputError("Invalid routing policy.");
  const built = projectRoutingInput(text(r.path), text(r.taskId), requirements(r.requirements));
  return { ...built, owner: ownerConstraints(r.ownerConstraints, built.owner), policy: policy as RoutingPolicy };
}
async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new RoutingInputError("Expected preview body.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new RoutingInputError("Preview body is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RoutingInputError("Invalid preview JSON."); }
}
export async function modelRouterHttp(req: Request, authorized: boolean): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!authorized) return json({ error: "unauthorized" }, 401);
  const path = new URL(req.url).pathname;
  if (path === "/model-router/resource-context") {
    if (req.method !== "GET") return json({ error: "Use GET for read-only resource context." }, 405);
    if (new URL(req.url).search) return json({ error: "Query parameters are not supported." }, 400);
    return json(buildModelRouterResourceContext());
  }
  if (path === "/model-router/manager-recommendations") {
    if (req.method !== "POST") return json({ error: "Use POST for read-only recommendations." }, 405);
    try { return json(recommendManagerResources(await readBody(req))); }
    catch (e) { return json({ error: e instanceof PreflightError || e instanceof RoutingInputError ? e.message : "Resource comparison failed." }, e instanceof PreflightError || e instanceof RoutingInputError ? e.status : 500); }
  }
  if (path !== "/model-router/preview" && path !== "/model-router/portfolio-preview") return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "Use POST for a read-only calculation." }, 405);
  try {
    const raw = await readBody(req);
    if (path === "/model-router/preview") {
      const r = input(raw);
      const snapshot = buildRoutingSnapshot();
      if (r.owner.globalConcurrency !== null) snapshot.limits[0]!.limit = { value: r.owner.globalConcurrency, verification: "verified", source: "owner:preview-global-limit", observedAt: snapshot.capturedAt, expiresAt: snapshot.capturedAt + 30_000 };
      return json({ preview: routeTask(r.requirements, snapshot, r.policy, r.owner), planningEstimate: r.planningEstimate });
    }
    const body = object(raw, ["requests"]);
    if (!Array.isArray(body.requests) || body.requests.length < 1 || body.requests.length > 50) throw new RoutingInputError("Expected 1 to 50 task requests.");
    const requests = body.requests.map(input);
    if (new Set(requests.map(r => r.requirements.taskId)).size !== requests.length) throw new RoutingInputError("Duplicate task requests.");
    const snapshot = buildRoutingSnapshot();
    // One shared global cap, constrained by the strictest explicit Owner limit.
    const caps = requests.flatMap(r => r.owner.globalConcurrency === null ? [] : [r.owner.globalConcurrency]);
    if (caps.length) snapshot.limits[0]!.limit = { value: Math.min(...caps), verification: "verified", source: "owner:preview-global-limit", observedAt: snapshot.capturedAt, expiresAt: snapshot.capturedAt + 30_000 };
    return json({ ...previewPortfolioRouting(requests, snapshot), planningEstimates: requests.map(r => ({ taskId: r.requirements.taskId, estimate: r.planningEstimate })) });
  } catch (e) {
    return e instanceof RoutingInputError ? json({ error: e.message }, e.status) : json({ error: "Routing evidence could not be read." }, 500);
  }
}
