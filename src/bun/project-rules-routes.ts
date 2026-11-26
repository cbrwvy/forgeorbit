import { randomUUID } from "node:crypto";
import { projectRules, projects } from "./db.ts";
import {
  PROJECT_RULES_LIMITS,
  sanitizeProjectRuleBody,
  sanitizeProjectRuleName,
  snapshotProjectRules,
} from "../shared/project-rules.ts";
import type { ProjectRule } from "../shared/types.ts";

export type ProjectRulesResult =
  | { ok: true; rules: ProjectRule[]; version: string }
  | { ok: false; error: string; status: 400 | 404 };

function guardProject(path: unknown): { path: string } | { error: string; status: 404 } {
  if (typeof path !== "string" || !path.trim()) return { error: "path required", status: 404 };
  const p = path.trim();
  if (!projects.get(p)) return { error: "project not found", status: 404 };
  return { path: p };
}

export function listProjectRules(rawPath: unknown): ProjectRulesResult {
  const g = guardProject(rawPath);
  if ("error" in g) return { ok: false, error: g.error, status: g.status };
  const rules = projectRules.list(g.path);
  const snap = snapshotProjectRules(g.path, rules);
  return { ok: true, rules, version: snap.version };
}

export function createProjectRule(body: {
  path?: unknown;
  name?: unknown;
  body?: unknown;
  enabled?: unknown;
  sortOrder?: unknown;
}): ProjectRulesResult & ({ ok: true; rule: ProjectRule } | {}) {
  const g = guardProject(body.path);
  if ("error" in g) return { ok: false, error: g.error, status: g.status };
  const name = sanitizeProjectRuleName(body.name);
  const text = sanitizeProjectRuleBody(body.body);
  if (!name) return { ok: false, error: "name required (max 120 characters)", status: 400 };
  if (!text) return { ok: false, error: "body required (max 12,000 characters)", status: 400 };
  if (projectRules.count(g.path) >= PROJECT_RULES_LIMITS.maxRules) {
    return { ok: false, error: `maximum ${PROJECT_RULES_LIMITS.maxRules} rules per project`, status: 400 };
  }
  const sortOrder = typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder) ? Math.trunc(body.sortOrder) : projectRules.count(g.path);
  const enabled = body.enabled !== false;
  const rule = projectRules.insert({
    id: randomUUID(),
    projectPath: g.path,
    name,
    body: text,
    enabled,
    sortOrder,
  });
  const rules = projectRules.list(g.path);
  return { ok: true, rules, version: snapshotProjectRules(g.path, rules).version, rule };
}

export function updateProjectRule(
  ruleId: string,
  body: { path?: unknown; name?: unknown; body?: unknown; enabled?: unknown; sortOrder?: unknown },
): ProjectRulesResult & ({ ok: true; rule: ProjectRule } | {}) {
  const g = guardProject(body.path);
  if ("error" in g) return { ok: false, error: g.error, status: g.status };
  const patch: Partial<Pick<ProjectRule, "name" | "body" | "enabled" | "sortOrder">> = {};
  if (body.name !== undefined) {
    const name = sanitizeProjectRuleName(body.name);
    if (!name) return { ok: false, error: "invalid name", status: 400 };
    patch.name = name;
  }
  if (body.body !== undefined) {
    const text = sanitizeProjectRuleBody(body.body);
    if (!text) return { ok: false, error: "invalid body", status: 400 };
    patch.body = text;
  }
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) {
      return { ok: false, error: "sortOrder must be a number", status: 400 };
    }
    patch.sortOrder = Math.trunc(body.sortOrder);
  }
  const rule = projectRules.update(ruleId, g.path, patch);
  if (!rule) return { ok: false, error: "rule not found", status: 404 };
  const rules = projectRules.list(g.path);
  return { ok: true, rules, version: snapshotProjectRules(g.path, rules).version, rule };
}

export function deleteProjectRule(ruleId: string, rawPath: unknown): ProjectRulesResult {
  const g = guardProject(rawPath);
  if ("error" in g) return { ok: false, error: g.error, status: g.status };
  if (!projectRules.delete(ruleId, g.path)) return { ok: false, error: "rule not found", status: 404 };
  const rules = projectRules.list(g.path);
  return { ok: true, rules, version: snapshotProjectRules(g.path, rules).version };
}

export function projectRulesSnapshotForPath(projectPath: string) {
  return snapshotProjectRules(projectPath, projectRules.list(projectPath));
}
