/**
 * Project-path input for cluster membership.
 *
 * The registry path is the identity. This check only rejects shapes that
 * cannot be a registered absolute path. It does not look at the filesystem,
 * does not resolve `..`, and does not invent a project.
 */

import { CLUSTER_LIMITS } from "./types.ts";

const CONTROL = /[\u0000-\u001f\u007f]/;

export function validateProjectPath(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Invalid projectPath." };
  const path = raw.trim();
  if (path.length === 0 || path.length > CLUSTER_LIMITS.path) return { ok: false, error: "Invalid projectPath." };
  if (CONTROL.test(path) || path.includes("\\")) return { ok: false, error: "Invalid projectPath." };
  if (!path.startsWith("/")) return { ok: false, error: "projectPath must be absolute." };
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "" || segment === "." || segment === "..") return { ok: false, error: "Invalid projectPath." };
  }
  return { ok: true, path };
}
