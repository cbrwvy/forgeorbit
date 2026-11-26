import { analyzeTaskRequirements } from "../shared/model-router/requirements.ts";
import { currentReadScope } from "./codex-read-scope.ts";
import { interviewSupportFor } from "../shared/project-interview.ts";
/**
 * Executor recommendations (FO-ORCH01).
 *
 * Reads the same state the preflight reads, asks the existing Model Router to
 * judge each candidate, and groups the answer for the Owner. It writes
 * nothing, starts nothing, probes no CLI process and changes no preference.
 * The router's fail-closed automatic pick is passed through untouched.
 */
import {
  AGENT_OPTIONS,
  DEFAULT_MODEL,
  supportedEfforts,
  supportedModes,
  type AgentKind,
  type Harness,
  type Task,
} from "../shared/types.ts";
import { RESOURCE_ROLES, type ResourceRole } from "../shared/model-router/account-eligibility.ts";
import { accountResourceEvidence } from "./account-resource-evidence.ts";
import { routeTask, UNKNOWN_OWNER_CONSTRAINTS } from "../shared/model-router/route.ts";
import type { CandidateAssessment, ResourceCandidate, RoutingSnapshot } from "../shared/model-router/types.ts";
import { describePermissions, type WorkspaceLayout } from "../shared/execution/permissions.ts";
import { parsePreflightRequest } from "../shared/execution/preflight.ts";
import {
  buildExecutorRecommendations,
  type ExecutorHarnessSource,
  type ExecutorPreferences,
  type ExecutorRecommendations,
  type RecommendationResponse,
} from "../shared/execution/executor-routing.ts";
import { db, harnesses, tasks } from "./db.ts";
import { harnessBinaryPresent } from "./agent-status.ts";
import { loadExecutorPreferences } from "./executor-preferences.ts";
import { detectWorkspaceLayout } from "./execution-layout.ts";
import { permissionSubject } from "./task-workspace.ts";
import { buildRoutingSnapshot, projectRoutingInput } from "./model-router.ts";
import { prepareEmployeeExecution, PreflightError, withExecutorPreferences, type PreflightDeps } from "./employee-execution.ts";
import { employeeConfig } from "./execution-selection.ts";

export interface RecommendationDeps {
  preflight?: PreflightDeps;
  now?: () => number;
  /** Test seam: replaces the local binary lookup. */
  cli?: (harness: Harness) => { available: boolean | null; loggedIn: boolean | null };
  /** Test seam: replaces git inspection of the task's workspace. */
  layout?: (task: Task) => Promise<{ layout: WorkspaceLayout; predicted: boolean }>;
}

const unique = <T,>(items: T[]) => [...new Set(items)];
const labelOf = (kind: AgentKind, id: string) => AGENT_OPTIONS[kind]?.models.find((m) => m.id === id)?.label ?? id;

/** The mode a confirmed review would launch with. Mirrors employeeConfig without importing the runner. */

/** Models worth listing for one harness: what the router knows, plus a few the Owner or task named. Bounded. */
function modelsFor(harness: Harness, task: Pick<Task, "agent" | "model">, prefs: ExecutorPreferences, rows: readonly ResourceCandidate[]): string[] {
  const curated = AGENT_OPTIONS[harness.kind]?.models.map((m) => m.id) ?? [];
  const ids = [...curated.filter(id => !AGENT_OPTIONS[harness.kind]?.models.find(m => m.id === id)?.catalogOnly), ...rows.flatMap((c) => (c.modelId ? [c.modelId] : []))];
  ids.push(DEFAULT_MODEL[harness.kind]);
  if (task.agent === harness.id && task.model) ids.push(task.model);
  if (prefs.preferredModel && (prefs.preferredHarnessId === harness.id || (!prefs.preferredHarnessId && curated.includes(prefs.preferredModel)))) ids.push(prefs.preferredModel);
  return unique(ids).filter(Boolean).slice(0, 12);
}

export async function recommendExecutors(raw: unknown, deps: RecommendationDeps = {}): Promise<RecommendationResponse> {
  const prefs = (deps.preflight?.preferences ?? loadExecutorPreferences)();
  let request;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PreflightError("Invalid request.");
  const { role: roleInput = "developer", mode: modeInput, ...preflightRaw } = raw as Record<string, unknown>;
  if (!RESOURCE_ROLES.includes(roleInput as ResourceRole)) throw new PreflightError("Invalid resource role.");
  if (modeInput !== undefined && (typeof modeInput !== "string" || modeInput.length > 100)) throw new PreflightError("Invalid execution mode.");
  const role = roleInput as ResourceRole;

  try {
    request = parsePreflightRequest(preflightRaw);
  } catch (message) {
    throw new PreflightError(typeof message === "string" ? message : "Invalid request.");
  }
  const policyOmitted = !(raw as Record<string, unknown>)["policy"];
  const policy = policyOmitted ? prefs.policy ?? request.policy : request.policy;
  const now = (deps.now ?? deps.preflight?.now ?? Date.now)();
  const task = tasks.get(request.taskId);
  if (!task) throw new PreflightError("Task not found.", 404);

  // One snapshot for the preflight and for the per-model judgement, so both see the same facts.
  let snapshot: RoutingSnapshot | null = null;
  const preflightDeps: PreflightDeps = { ...deps.preflight, now: () => now, preferences: () => prefs };
  const sharedSnapshot = () => (snapshot ??= (deps.preflight?.snapshot ? deps.preflight.snapshot() : buildRoutingSnapshot(db, now)));
  const preflight = prepareEmployeeExecution({ ...preflightRaw, policy }, { ...preflightDeps, snapshot: sharedSnapshot });

  const registered = harnesses.list();
  let assessments: CandidateAssessment[] = [];
  let routingAvailable = false;
  if (preflight.canonicalProject) {
    try {
      const built = projectRoutingInput(preflight.canonicalProject.path, task.id, request.complexity ? { complexity: request.complexity } : {});
      const saved = preflightDeps.owner ? preflightDeps.owner(built.owner) : built.owner;
      const preview = routeTask(built.requirements, sharedSnapshot(), policy, withExecutorPreferences(saved, prefs));
      assessments = [
        ...(preview.recommendedCandidate ? [preview.recommendedCandidate] : []),
        ...preview.alternativeCandidates, ...preview.conditionalCandidates, ...preview.excludedCandidates,
      ];
      routingAvailable = true;
    } catch {
      routingAvailable = false;
    }
  }
  const snap = snapshot as RoutingSnapshot | null;
  const detect = deps.layout ?? detectWorkspaceLayout;
  const subject = permissionSubject(task);
  const layout = await detect(subject.workdir === task.workdir ? task : { ...task, isolation: "none", workdir: subject.workdir, worktreePath: null });
  const cli = deps.cli ?? ((h: Harness) => ({ available: harnessBinaryPresent(h), loggedIn: null }));

  const sources: ExecutorHarnessSource[] = registered.map((harness) => {
    const rows = snap ? snap.candidates.filter((c) => c.harnessId === harness.id) : [];
    const mine = assessments.filter((a) => a.candidate.harnessId === harness.id);
    const kind = harness.kind as AgentKind;
    return {
      harness: { id: harness.id, kind, label: harness.label, enabled: harness.enabled },
      cli: cli(harness),
      resourceFor: (model, mode) => accountResourceEvidence(harness, task, model, mode, role, rows, now),
      models: unique([...modelsFor(harness, task, prefs, rows), ...(request.harnessId === harness.id && request.model ? [request.model] : [])]).map((id) => ({ id, label: labelOf(kind, id) })),
      assessments: mine,
      candidates: rows,
      modesFor: (model) => supportedModes(kind, model).map((m) => ({ id: m.id, label: m.label })),
      effortsFor: (model) => {
        const known = supportedEfforts(kind, model).map((e) => e.id);
        return known.length > 0 ? known : null;
      },
      launchMode: (model) => typeof modeInput === "string" ? modeInput : (role === "project-manager" || role === "head") && interviewSupportFor(kind).supported ? (interviewSupportFor(kind) as {mode:string}).mode : role === "reviewer" && kind === "codex" ? "ask" : employeeConfig(task, harness, { ...request, model }, prefs).mode,
      permissionFor: (_model, mode) => describePermissions({ kind, mode, layout: layout.layout, predicted: layout.predicted, readScope: currentReadScope() }),
    };
  });

  const selection = request.harnessId
    ? (() => {
        const chosen = registered.find((h) => h.id === request.harnessId);
        if (!chosen) return null;
        const model = request.model ?? (chosen.id === task.agent && task.model ? task.model : DEFAULT_MODEL[chosen.kind as AgentKind]);
        return { harnessId: chosen.id, model };
      })()
    : null;

  const recommendations = buildExecutorRecommendations({
    now,
    role,
    preferences: { ...prefs, policy },
    task: { harnessId: task.agent, model: task.model ?? null },
    requestedEffort: request.effort,
    sources,
    routerPick: { harnessId: preflight.routerRecommendation.harnessId, modelId: preflight.routerRecommendation.modelId },
    selection,
  });
  return { recommendations, preflight, routingAvailable };
}

/** Existing PM/Head picker context: no task is created or borrowed to compare resources. */
export function recommendManagerResources(raw: unknown): ExecutorRecommendations {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PreflightError("Invalid manager comparison.");
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(k => !["role", "harnessId", "model"].includes(k)) || !["project-manager", "head"].includes(String(body.role))) throw new PreflightError("Invalid manager comparison fields.");
  if (typeof body.harnessId !== "string" || typeof body.model !== "string" || !body.model || body.model.length > 200 || body.harnessId.length > 200) throw new PreflightError("Invalid manager resource.");
  const now = Date.now(), prefs = loadExecutorPreferences(), snapshot = buildRoutingSnapshot(db, now);
  const role = body.role as ResourceRole;
  const configured = { agent: body.harnessId, model: body.model, agentProfileId: null };
  const preview = routeTask(analyzeTaskRequirements({taskId:"manager-resource-comparison",projectId:"manager-resource-comparison"}),snapshot,prefs.policy ?? "balanced",withExecutorPreferences(UNKNOWN_OWNER_CONSTRAINTS,prefs));
  const assessments = [...(preview.recommendedCandidate ? [preview.recommendedCandidate] : []),...preview.alternativeCandidates,...preview.conditionalCandidates,...preview.excludedCandidates];
  const sources: ExecutorHarnessSource[] = harnesses.list().map(h => {
    const support = interviewSupportFor(h.kind), rows = snapshot.candidates.filter(c => c.harnessId === h.id);
    const mode = support.supported ? support.mode : "unsupported-manager-mode";
    return {
      harness: h, cli: {available: harnessBinaryPresent(h), loggedIn: null},
      models: unique([...modelsFor(h, configured, prefs, rows), ...(h.id === configured.agent ? [configured.model] : [])]).map(id => ({id,label:labelOf(h.kind,id)})),
      // Unknown quota/cost cannot authorize automatic selection here.
      assessments: assessments.filter(a=>a.candidate.harnessId===h.id), candidates: rows,
      resourceFor: (model, selectedMode) => accountResourceEvidence(h,configured,model,selectedMode,role,rows,now),
      modesFor: model => support.supported ? supportedModes(h.kind,model).filter(m=>m.id===support.mode) : [],
      effortsFor: model => supportedEfforts(h.kind,model).map(e=>e.id),
      launchMode: () => mode,
      permissionFor: (_model, selectedMode) => describePermissions({kind:h.kind,mode:selectedMode,layout:"non-git",predicted:true,readScope:currentReadScope()}),
    };
  });
  return buildExecutorRecommendations({now,preferences:prefs,role,task:{harnessId:configured.agent,model:configured.model},requestedEffort:null,sources,routerPick:{harnessId:null,modelId:null},selection:{harnessId:configured.agent,model:configured.model}});
}
