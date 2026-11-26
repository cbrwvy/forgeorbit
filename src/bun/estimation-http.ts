/**
 * Project estimation routes (FO-006B).
 *
 * Read and write manual planning inputs for one registered project. The
 * handler never starts a harness, a shell, or a kanban run, and it does not
 * log the settings document.
 */

import { ESTIMATION_LIMITS } from "../shared/estimation/types.ts";
import {
  adaptProject,
  backlogFingerprint,
  type ProjectTaskFact,
  type StructuredDependency,
} from "../shared/estimation/project-adapter.ts";
import {
  parseEstimationSettings,
  type EstimationRecord,
  type EstimationSettings,
  type ObservedDuration,
} from "../shared/estimation/settings.ts";
import { validateRequest } from "../shared/estimation/validate.ts";
import { projectEstimation, taskScheduling } from "./db.ts";
import { resolveProject } from "./environment/http.ts";
import { projectWorkdirs } from "./project-ownership.ts";

const BODY_MAX = 256 * 1024;
const OBSERVATION_CAP = ESTIMATION_LIMITS.maxHistory;

export async function getProjectEstimation(req: Request): Promise<{ status: number; body: unknown }> {
  const project = resolveProject(queryPath(req));
  if (!project.ok) return { status: project.status, body: { error: project.error } };
  return { status: 200, body: recordFor(project.path) };
}

/** Only the structured links, for the page to notice a dependency edit. */
export async function getProjectEstimationDependencies(req: Request): Promise<{ status: number; body: unknown }> {
  const project = resolveProject(queryPath(req));
  if (!project.ok) return { status: project.status, body: { error: project.error } };
  return { status: 200, body: { structuredDependencies: structuredDependencies(project.path) } };
}

export async function putProjectEstimation(req: Request): Promise<{ status: number; body: unknown }> {
  const body = await readBody(req);
  if (!body.ok) return { status: body.status, body: { error: body.error } };
  const project = resolveProject(typeof body.value.path === "string" ? body.value.path : "");
  if (!project.ok) return { status: project.status, body: { error: project.error } };
  const parsed = parseEstimationSettings(body.value.settings);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const facts = loadFacts(project.path);
  const edges = structuredDependencies(project.path);
  const adapted = adaptProject({
    projectPath: project.path,
    projectLabel: project.path,
    facts,
    settings: parsed.settings,
    structuredDependencies: edges,
  });
  const issues = validateRequest(adapted.request);
  if (issues.length > 0) {
    return { status: 400, body: { error: "Estimation inputs were rejected.", issues: issues.map((issue) => issue.message) } };
  }
  const fingerprint = backlogFingerprint(facts, edges);
  projectEstimation.set(project.path, JSON.stringify(parsed.settings), fingerprint);
  return { status: 200, body: recordFor(project.path, parsed.settings) };
}

function recordFor(projectPath: string, known?: EstimationSettings): EstimationRecord {
  const stored = projectEstimation.get(projectPath);
  let settings: EstimationSettings | null = known ?? null;
  let settingsError: string | undefined;
  if (!known && stored) {
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(stored.settings);
    } catch {
      settingsError = "Saved estimation inputs could not be read.";
    }
    if (decoded) {
      const parsed = parseEstimationSettings(decoded);
      if (parsed.ok) settings = parsed.settings;
      else settingsError = parsed.error;
    }
  }
  const loaded = loadObservations(projectPath);
  // Same task set as every other project view (FO-008D ownership).
  const facts = projectEstimation.facts(projectWorkdirs(projectPath));
  const edges = structuredDependencies(projectPath);
  const record: EstimationRecord = {
    settings,
    savedAt: stored?.updatedAt ?? null,
    backlogFingerprint: stored?.backlogFingerprint ?? null,
    currentFingerprint: backlogFingerprint(facts, edges),
    observations: loaded.observations,
    observationsTruncated: loaded.truncated,
    structuredDependencies: edges,
  };
  if (settingsError) record.settingsError = settingsError;
  return record;
}

/**
 * Links whose dependent task is in this project. The scheduling layer refuses
 * cross-project links when they are written; the adapter drops any whose
 * other end is not one of this project's tasks anyway.
 */
function structuredDependencies(projectPath: string): StructuredDependency[] {
  return taskScheduling.edgesForProject(projectWorkdirs(projectPath)).map((edge) => ({ taskId: edge.taskId, dependsOn: edge.dependsOn }));
}

function loadFacts(projectPath: string): ProjectTaskFact[] {
  const observed = new Map<string, ProjectTaskFact["observedRuns"]>();
  for (const run of loadObservations(projectPath).observations) {
    const list = observed.get(run.taskId) ?? [];
    list.push({
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agentMs: run.agentMs,
      status: run.status,
    });
    observed.set(run.taskId, list);
  }
  return projectEstimation.facts(projectWorkdirs(projectPath)).map((row) => ({
    id: row.id,
    title: row.title,
    column: row.column,
    taskType: row.taskType,
    harnessId: row.harnessId.trim() ? row.harnessId : null,
    modelId: row.modelId && row.modelId.trim() ? row.modelId : null,
    updatedAt: row.updatedAt,
    archived: row.archived,
    pipelineParentId: row.pipelineParentId,
    observedRuns: observed.get(row.id) ?? [],
  }));
}

function loadObservations(projectPath: string): { observations: ObservedDuration[]; truncated: boolean } {
  const rows = projectEstimation.observations(projectWorkdirs(projectPath), OBSERVATION_CAP + 1);
  const truncated = rows.length > OBSERVATION_CAP;
  const observations = (truncated ? rows.slice(0, OBSERVATION_CAP) : rows).map((row) => ({
    taskId: row.taskId,
    runId: row.runId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    agentMs: row.endedAt - row.startedAt,
    status: row.status,
  }));
  return { observations, truncated };
}

function queryPath(req: Request): string {
  return new URL(req.url).searchParams.get("path") ?? "";
}

async function readBody(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_MAX) return { ok: false, status: 413, error: "request body is too large" };
  const text = await req.text();
  if (text.length > BODY_MAX) return { ok: false, status: 413, error: "request body is too large" };
  if (!text) return { ok: false, status: 400, error: "body must be an object" };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400, error: "body must be an object" };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "invalid json" };
  }
}
