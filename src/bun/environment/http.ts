/**
 * HTTP handlers for the local environment manager.
 *
 * Mounted on the existing localhost API behind the same bearer token.
 * Every handler checks that the directory is a registered project and that
 * the profile stays inside it. Responses never include ownership tokens.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  literalEnvRejection,
  logMentionsService,
  restoreRedactedEnv,
  toPublicProfile,
  type ComposeSuggestion,
  type EnvironmentIndex,
  type EnvironmentProfileView,
} from "../../shared/environment/present.ts";
import { isLexicalInside, isSafeRelativeFile, PROFILE_ID_PATTERN, SERVICE_NAME_PATTERN, validateLaunchProfile } from "../../shared/environment/profile.ts";
import { COMPOSE_CANDIDATES, composeServiceNames } from "../../shared/project-discovery.ts";
import type { EnvErrorCode, LaunchProfile } from "../../shared/environment/types.ts";
import type { EnvironmentOperationResult } from "../../shared/environment/types.ts";
import { projects } from "../db.ts";
import { getEnvironmentManager } from "./runtime.ts";
import type { EnvironmentManager } from "./manager.ts";

const BODY_MAX = 64 * 1024;
const COMPOSE_READ_MAX = 256 * 1024;
const LOG_LINE_MAX = 4_000;
const LOG_LINES_MAX = 200;

const HTTP_STATUS: Record<EnvErrorCode, number> = {
  "invalid-profile": 400,
  "not-found": 404,
  "missing-workdir": 422,
  "missing-compose-file": 422,
  "docker-unavailable": 503,
  busy: 409,
  "start-failed": 422,
  "startup-timeout": 422,
  "shutdown-timeout": 422,
  "health-failed": 422,
  cancelled: 409,
  "foreign-process": 409,
  "foreign-compose-project": 409,
  "external-environment": 409,
  "unverified-ownership": 409,
  "process-exited": 422,
  "project-name-conflict": 409,
};

export interface EnvHttpResult {
  status: number;
  body: unknown;
}

export async function getEnvironmentIndex(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const project = resolveProject(queryPath(req));
  if (!project.ok) return fail(project.status, project.error);
  return { status: 200, body: indexFor(ready, project.path) };
}

export async function createEnvironmentProfile(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const body = await readBody(req);
  if (!body.ok) return fail(body.status, body.error);
  const project = resolveProject(typeof body.value.path === "string" ? body.value.path : "");
  if (!project.ok) return fail(project.status, project.error);
  const prepared = prepareProfile(body.value.profile, project.path, null);
  if (!prepared.ok) return fail(prepared.status, prepared.error);
  return fromOperation(ready, await ready.register(prepared.profile));
}

export async function getEnvironmentProfile(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const located = locate(ready, req, queryPath(req));
  if (!located.ok) return fail(located.status, located.error);
  return { status: 200, body: viewFor(ready, located.profile) };
}

export async function updateEnvironmentProfile(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const body = await readBody(req);
  if (!body.ok) return fail(body.status, body.error);
  const projectPath = typeof body.value.path === "string" ? body.value.path : queryPath(req);
  const located = locate(ready, req, projectPath);
  if (!located.ok) return fail(located.status, located.error);
  const prepared = prepareProfile(body.value.profile, located.projectPath, located.profile);
  if (!prepared.ok) return fail(prepared.status, prepared.error);
  if (prepared.profile.id !== located.profile.id) {
    return fail(400, "profile id cannot change");
  }
  return fromOperation(ready, await ready.update(located.profile.id, prepared.profile));
}

export async function deleteEnvironmentProfile(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const located = locate(ready, req, queryPath(req));
  if (!located.ok) return fail(located.status, located.error);
  return fromOperation(ready, await ready.unregister(located.profile.id));
}

export async function postEnvironmentAction(
  req: Request,
  action: "start" | "stop" | "restart" | "refresh",
): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const located = locate(ready, req, queryPath(req));
  if (!located.ok) return fail(located.status, located.error);
  const result = await ready[action](located.profile.id);
  return fromOperation(ready, result);
}

export async function getEnvironmentLogs(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const located = locate(ready, req, queryPath(req));
  if (!located.ok) return fail(located.status, located.error);
  const service = new URL(req.url).searchParams.get("service");
  if (service !== null && service !== "" && !SERVICE_NAME_PATTERN.test(service)) {
    return fail(400, "service name is invalid");
  }
  const logs = await ready.logs(located.profile.id);
  const lines = (logs?.lines ?? [])
    .filter((line) => (service ? logMentionsService(line.text, service) : true))
    .slice(-LOG_LINES_MAX)
    .map((line) => ({
      stream: line.stream,
      at: line.at,
      text: line.text.length > LOG_LINE_MAX ? line.text.slice(-LOG_LINE_MAX) : line.text,
    }));
  return { status: 200, body: { lines } };
}

export async function getEnvironmentUrls(req: Request): Promise<EnvHttpResult> {
  const ready = readyManager();
  if (isHttpResult(ready)) return ready;
  const located = locate(ready, req, queryPath(req));
  if (!located.ok) return fail(located.status, located.error);
  return { status: 200, body: { urls: ready.urls(located.profile.id) ?? [] } };
}

function readyManager(): EnvironmentManager | EnvHttpResult {
  const manager = getEnvironmentManager();
  if (!manager) return fail(503, "environment manager is not ready");
  return manager;
}

function isHttpResult(value: EnvironmentManager | EnvHttpResult): value is EnvHttpResult {
  return "body" in value;
}

function fail(status: number, error: string): EnvHttpResult {
  return { status, body: { error } };
}

function queryPath(req: Request): string {
  return new URL(req.url).searchParams.get("path") ?? "";
}

function profileIdOf(req: Request): string | null {
  const params = (req as Request & { params?: { profileId?: string } }).params;
  const id = params?.profileId ?? "";
  return PROFILE_ID_PATTERN.test(id) ? id : null;
}

async function readBody(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_MAX) {
    return { ok: false, status: 413, error: "request body is too large" };
  }
  const text = await req.text();
  if (text.length > BODY_MAX) return { ok: false, status: 413, error: "request body is too large" };
  if (text.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, status: 400, error: "body must be an object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "invalid json" };
  }
}

/** A registered project matching `raw` (directly or by realpath). Shared
 *  with the project manager routes. */
export function resolveProject(raw: string): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (typeof raw !== "string" || raw.length === 0 || !path.isAbsolute(raw) || raw.includes("\0")) {
    return { ok: false, status: 400, error: "path must be an absolute path" };
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    return { ok: false, status: 404, error: "project directory does not exist" };
  }
  const direct = projects.get(raw) ?? projects.get(real);
  if (direct) return { ok: true, path: direct.path };
  for (const project of projects.list()) {
    try {
      if (realpathSync(project.path) === real) return { ok: true, path: project.path };
    } catch {
      /* a registered path that disappeared is not this directory */
    }
  }
  return { ok: false, status: 404, error: "project is not registered" };
}

function locate(
  manager: EnvironmentManager,
  req: Request,
  rawPath: string,
): { ok: true; projectPath: string; profile: LaunchProfile } | { ok: false; status: number; error: string } {
  const id = profileIdOf(req);
  if (!id) return { ok: false, status: 400, error: "profile id is invalid" };
  const project = resolveProject(rawPath);
  if (!project.ok) return project;
  const profile = manager.profile(id);
  if (!profile || profile.projectPath !== project.path) {
    return { ok: false, status: 404, error: "launch profile not found" };
  }
  return { ok: true, projectPath: project.path, profile };
}

function prepareProfile(
  input: unknown,
  projectPath: string,
  previous: LaunchProfile | null,
): { ok: true; profile: LaunchProfile } | { ok: false; status: number; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "profile must be an object" };
  }
  const literal = literalEnvRejection((input as { env?: unknown }).env);
  if (literal) return { ok: false, status: 400, error: literal };
  let merged: unknown = input;
  if (previous) {
    const restored = restoreRedactedEnv(input, previous);
    if (!restored.ok) return { ok: false, status: 400, error: restored.error };
    merged = restored.value;
  }
  if (!merged || typeof merged !== "object") {
    return { ok: false, status: 400, error: "profile must be an object" };
  }
  const record: Record<string, unknown> = { ...(merged as Record<string, unknown>), projectPath };
  if (typeof record.id !== "string" || record.id.length === 0) {
    record.id = `p${randomBytes(8).toString("hex")}`;
  }
  const guarded = guardPaths(projectPath, record);
  if (guarded) return { ok: false, status: 400, error: guarded };
  const validated = validateLaunchProfile(record);
  if (!validated.ok) {
    return {
      ok: false,
      status: 400,
      error: validated.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, profile: validated.profile };
}

function guardPaths(projectPath: string, input: Record<string, unknown>): string | null {
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (!isLexicalInside(projectPath, cwd)) return "cwd must stay inside the project";
  try {
    const root = realpathSync(projectPath);
    const cwdReal = realpathSync(cwd);
    if (!isLexicalInside(root, cwdReal)) return "cwd escapes the project directory";
  } catch {
    return "working directory does not exist";
  }
  const launch = input.launch;
  if (!launch || typeof launch !== "object") return null;
  if ((launch as { kind?: unknown }).kind !== "docker-compose") return null;
  const file = (launch as { composeFile?: unknown }).composeFile;
  if (typeof file !== "string" || !isSafeRelativeFile(file)) {
    return "compose file must stay inside the working directory";
  }
  const abs = path.resolve(cwd, file);
  if (!isLexicalInside(projectPath, abs)) return "compose file escapes the project directory";
  try {
    const root = realpathSync(projectPath);
    const fileReal = realpathSync(abs);
    if (!isLexicalInside(root, fileReal)) return "compose file escapes the project directory";
    if (!existsSync(fileReal)) return "compose file does not exist";
  } catch {
    return "compose file does not exist";
  }
  return null;
}

function indexFor(manager: EnvironmentManager, projectPath: string): EnvironmentIndex {
  const profiles: EnvironmentProfileView[] = [];
  for (const status of manager.list()) {
    const profile = manager.profile(status.profileId);
    if (!profile || profile.projectPath !== projectPath) continue;
    profiles.push(viewFor(manager, profile));
  }
  profiles.sort((a, b) => a.profile.name.localeCompare(b.profile.name) || (a.profile.id < b.profile.id ? -1 : 1));
  return { profiles, suggestions: { composeFiles: suggestCompose(projectPath) } };
}

function viewFor(manager: EnvironmentManager, profile: LaunchProfile): EnvironmentProfileView {
  const status = manager.status(profile.id);
  return {
    profile: toPublicProfile(profile),
    status: status ?? {
      profileId: profile.id,
      name: profile.name,
      kind: profile.launch.kind,
      recordedPhase: "unknown",
      observed: { ownership: "none", processAlive: null, detail: null, at: null },
      ownership: "none",
      pid: null,
      composeProject: profile.launch.kind === "docker-compose" ? profile.launch.projectName : null,
      lastError: null,
      errorCode: null,
      updatedAt: 0,
      health: [],
    },
    urls: manager.urls(profile.id) ?? [],
  };
}

function fromOperation(manager: EnvironmentManager, result: EnvironmentOperationResult): EnvHttpResult {
  if (result.ok) {
    const profile = manager.profile(result.status.profileId);
    return {
      status: 200,
      body: {
        ok: true,
        status: result.status,
        urls: manager.urls(result.status.profileId) ?? [],
        profile: profile ? toPublicProfile(profile) : null,
      },
    };
  }
  return {
    status: HTTP_STATUS[result.code] ?? 422,
    body: { ok: false, code: result.code, error: result.error, status: result.status },
  };
}

function suggestCompose(projectPath: string): ComposeSuggestion[] {
  let root: string;
  try {
    root = realpathSync(projectPath);
  } catch {
    return [];
  }
  const suggestions: ComposeSuggestion[] = [];
  for (const file of COMPOSE_CANDIDATES) {
    const abs = path.join(root, file);
    if (!isLexicalInside(root, abs) || !existsSync(abs)) continue;
    let real: string;
    try {
      const info = statSync(abs);
      if (!info.isFile() || info.size > COMPOSE_READ_MAX) continue;
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!isLexicalInside(root, real)) continue;
    let text = "";
    try {
      text = readFileSync(real, "utf8");
    } catch {
      continue;
    }
    suggestions.push({ file, services: composeServiceNames(text) });
  }
  return suggestions;
}
