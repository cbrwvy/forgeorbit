/**
 * Register a project directory. The wizard sends `rejectDuplicate` so a
 * second row is never created for a path that already resolves to a
 * registered project (symlinks included). `createDirectory` mkdirs one
 * new empty leaf and nothing else. Existing files are never written.
 */

import { existsSync, mkdirSync, realpathSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { projects } from "./db.ts";
import { PROJECT_NAME_MAX, validateFolderName } from "../shared/project-discovery.ts";
import type { Project } from "../shared/types.ts";

export type RegisterResult =
  | { ok: true; project: Project }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

export function findRegisteredDuplicate(candidate: string): Project | null {
  const norm = normalize(candidate);
  let real: string | null = null;
  try {
    real = realpathSync(candidate);
  } catch {
    real = null;
  }
  for (const project of projects.list()) {
    if (normalize(project.path) === norm) return project;
    if (!real) continue;
    try {
      if (realpathSync(project.path) === real) return project;
    } catch {
      /* The stored path is gone. The string compare above already ran. */
    }
  }
  return null;
}

function directoryEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).every((name) => name === ".DS_Store");
  } catch {
    return false;
  }
}

function displayName(requested: string, dir: string): string {
  const trimmed = requested.trim();
  const base = path.basename(dir) || dir;
  return (trimmed || base).slice(0, PROJECT_NAME_MAX);
}

/**
 * `rejectDuplicate` defaults to false so CLI `projects add` and the
 * existing POST body stay an idempotent upsert. The wizard sets it.
 */
export function registerProject(body: {
  path?: unknown;
  name?: unknown;
  rejectDuplicate?: unknown;
  createDirectory?: unknown;
}): RegisterResult {
  const raw = typeof body.path === "string" ? body.path.trim() : "";
  if (!raw) return { ok: false, status: 400, error: "path required" };
  if (!path.isAbsolute(raw)) return { ok: false, status: 400, error: "path must be absolute" };
  const nameInput = typeof body.name === "string" ? body.name : "";
  if (nameInput.trim().length > PROJECT_NAME_MAX) {
    return { ok: false, status: 400, error: "Project name is too long." };
  }
  const rejectDuplicate = body.rejectDuplicate === true;
  const createDirectory = body.createDirectory === true;

  let created = false;
  let dest = raw;
  try {
    if (!existsSync(raw)) {
      if (!createDirectory) return { ok: false, status: 404, error: `path does not exist: ${raw}` };
      const parent = path.dirname(raw);
      const leaf = path.basename(raw);
      const nameError = validateFolderName(leaf);
      if (nameError) return { ok: false, status: 400, error: nameError };
      if (!existsSync(parent) || !statSync(parent).isDirectory()) {
        return { ok: false, status: 404, error: "Parent folder does not exist." };
      }
      mkdirSync(raw);
      created = true;
    }
    const st = statSync(raw);
    if (!st.isDirectory()) {
      if (created) rmSync(raw, { recursive: false });
      return { ok: false, status: 400, error: "path is not a directory" };
    }
    if (createDirectory && !created && !directoryEmpty(raw)) {
      return {
        ok: false,
        status: 409,
        error: "That folder already exists and is not empty. Import it instead of creating it.",
      };
    }
    dest = rejectDuplicate ? realpathSync(raw) : raw;
    if (rejectDuplicate) {
      const duplicate = findRegisteredDuplicate(dest);
      if (duplicate) {
        if (created) rmSync(raw, { recursive: false });
        return {
          ok: false,
          status: 409,
          error: `Already registered as "${duplicate.name}".`,
        };
      }
    }
    const project = projects.upsert(dest, displayName(nameInput, dest));
    return { ok: true, project };
  } catch {
    if (created) {
      try {
        rmSync(raw, { recursive: false });
      } catch {
        /* The folder we just created couldn't be removed. Leave it empty. */
      }
    }
    return { ok: false, status: 500, error: "Couldn't register that folder." };
  }
}
