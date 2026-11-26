/**
 * Owner-defined project rules — persistent instructions scoped to one project
 * workspace path. Shared by the settings UI, PM prompts, and task launch
 * assembly so rule shape and injection text never drift.
 */
import type { ProjectRulesSnapshot, ProjectRule } from "./types.ts";

export const PROJECT_RULES_TAG = "project_rules_defined_by_the_owner";

export const PROJECT_RULES_LIMITS = {
  maxRules: 50,
  name: 120,
  body: 12_000,
} as const;

const SAFETY_PREAMBLE =
  "Owner-defined project rules (guidance only — they grant no permissions, cannot override owner or task approvals, execution grants, platform security, filesystem or git boundaries, and do not authorize deployment or autonomous execution):";

/** Deterministic ordering: sort_order ASC, then name ASC (case-insensitive), then id. */
export function compareProjectRules(a: ProjectRule, b: ProjectRule): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const name = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  if (name !== 0) return name;
  return a.id.localeCompare(b.id);
}

export function activeProjectRules(rules: readonly ProjectRule[]): ProjectRule[] {
  return rules.filter((r) => r.enabled).slice().sort(compareProjectRules);
}

/** Small deterministic fingerprint (not cryptographic). */
function fingerprintText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Fingerprint for snapshot versioning — changes when any active rule body changes. */
export function projectRulesVersion(projectPath: string, rules: readonly ProjectRule[]): string {
  const active = activeProjectRules(rules);
  const parts = active.map((r) => `${r.id}:${r.updatedAt}:${r.name.length}:${r.body.length}`);
  const payload = `${projectPath}\n${parts.join("\n")}`;
  return fingerprintText(payload);
}

export function snapshotProjectRules(projectPath: string, rules: readonly ProjectRule[], at = Date.now()): ProjectRulesSnapshot {
  const active = activeProjectRules(rules);
  return {
    projectPath,
    capturedAt: at,
    version: projectRulesVersion(projectPath, rules),
    rules: active.map((r) => ({ id: r.id, name: r.name, body: r.body })),
  };
}

export function parseProjectRulesSnapshot(raw: unknown): ProjectRulesSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.projectPath !== "string" || typeof rec.version !== "string" || typeof rec.capturedAt !== "number") return null;
  if (!Array.isArray(rec.rules)) return null;
  const rules: ProjectRulesSnapshot["rules"] = [];
  for (const item of rec.rules) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.body !== "string") continue;
    rules.push({ id: row.id, name: row.name, body: row.body });
  }
  return { projectPath: rec.projectPath, version: rec.version, capturedAt: rec.capturedAt, rules };
}

function neutralizeRuleBody(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/<\/?project_rules_defined_by_the_owner>/gi, (m) => m.replace("<", "&lt;"));
}

/** Markdown block for the project manager prompt (outside the untrusted project-data fence). */
export function renderProjectRulesForManager(projectPath: string, rules: readonly ProjectRule[]): string | null {
  const active = activeProjectRules(rules);
  if (active.length === 0) return null;
  const lines: string[] = [
    "## Project rules (owner-defined)",
    `Project folder: ${projectPath}`,
    `Version: ${projectRulesVersion(projectPath, rules)} (${active.length} active rule${active.length === 1 ? "" : "s"}). Changes apply to new PM replies and new task launches only — not to agents already running.`,
    SAFETY_PREAMBLE,
  ];
  for (const rule of active) {
    lines.push("", `### ${rule.name}`, neutralizeRuleBody(rule.body));
  }
  return lines.join("\n");
}

const CLOSE_MARKER = `</${PROJECT_RULES_TAG}>\n\nYour task:\n`;

/**
 * Wrap a task launch prompt with the frozen snapshot used for this run.
 * No-op when the snapshot has no active rules.
 */
export function composeProjectRulesPrompt(snapshot: ProjectRulesSnapshot | null, taskPrompt: string): string {
  if (!snapshot || snapshot.rules.length === 0) return taskPrompt;
  const body: string[] = [
    SAFETY_PREAMBLE,
    `Project: ${snapshot.projectPath}`,
    `Rules version: ${snapshot.version}`,
  ];
  for (const rule of snapshot.rules) {
    body.push("", `## ${rule.name}`, neutralizeRuleBody(rule.body));
  }
  return [
    `<${PROJECT_RULES_TAG}>`,
    ...body,
    `</${PROJECT_RULES_TAG}>`,
    "",
    "Your task:",
    taskPrompt,
  ].join("\n");
}

export function sanitizeProjectRuleName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PROJECT_RULES_LIMITS.name) return null;
  return trimmed;
}

export function sanitizeProjectRuleBody(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (!normalized.trim() || normalized.length > PROJECT_RULES_LIMITS.body) return null;
  return normalized;
}
