/**
 * Hiring proposals pure parsing and helpers (FO-014C).
 *
 * Untrusted model output parsing: reads `<hiring_proposals>` tags, validates JSON,
 * drops malformed entries with errors, enforces limits, and prevents duplicates.
 * Resolving slugs against the actual catalog and checking project scope happens server-side.
 */

import { capText, lastTagBody, redactSecrets } from "../project-interview.ts";
import { HIRING_PROPOSAL_LIMITS, type HiringProposalStatus } from "./types.ts";

export interface HiringDraft {
  name?: string;
  roleSlug: string;
  title?: string;
  justification: string;
  competencies?: string[];
  relatedTasks?: string[];
  adaptedPrompt?: string;
}

export interface HiringDraftResult {
  drafts: HiringDraft[];
  errors: string[];
}

export const HIRING_REPLY_FORMAT = [
  "When the owner asks to build a team, recommend specialists, or hire roles for this project, analyze the project requirements, stack, existing tasks, and existing employees, then suggest a minimal sufficient team as JSON:",
  "<hiring_proposals>",
  '{"proposals": [{"name": "Jane", "role_slug": "engineering-frontend-developer", "title": "Senior Frontend Developer", "justification": "Required to implement React UI components and state management", "competencies": ["React", "TypeScript", "Tailwind CSS"], "related_tasks": ["#1a2b3c4d"], "adapted_prompt": "# Frontend Developer instructions..."}]}',
  "</hiring_proposals>",
  "Use only valid catalog role slugs. Never invent slugs. Never propose employees who are already active in the project. If project data is insufficient, state the limitations clearly.",
  "Proposed specialists are only recommendations. No employee is created until the owner approves each proposal.",
].join("\n");

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF_CLEAN_RE = /^[0-9a-f]{8}$/;

function cleanTaskRef(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const stripped = val.trim().toLowerCase().replace(/^#/, "");
  return REF_CLEAN_RE.test(stripped) ? stripped : null;
}

export function parseHiringDrafts(text: string): HiringDraftResult {
  const raw = text.replace(/\r\n?/g, "\n");
  const hasHiring = raw.includes("<hiring_proposals>") || raw.includes("<hiring_proposals ");
  const hasTeam = raw.includes("<team_hiring_proposals>") || raw.includes("<team_hiring_proposals ");

  if (!hasHiring && !hasTeam) {
    return { drafts: [], errors: [] };
  }

  const tagName = hasHiring ? "hiring_proposals" : "team_hiring_proposals";
  const body = lastTagBody(raw, tagName);

  if (body == null) {
    return { drafts: [], errors: ["The team hiring suggestion was cut off, so none was recorded."] };
  }

  if (body.length > 100_000) {
    return { drafts: [], errors: ["The team hiring suggestion was too large, so none was recorded."] };
  }

  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(body);
  const json = (fenced ? fenced[1]! : body)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { drafts: [], errors: ["The team hiring suggestion was not valid JSON, so none was recorded."] };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals)
      ? (parsed as { proposals: unknown[] }).proposals
      : null;

  if (!list) {
    return { drafts: [], errors: ["The team hiring suggestion had no proposals list, so none was recorded."] };
  }

  const drafts: HiringDraft[] = [];
  const errors: string[] = [];
  const seenSlugs = new Set<string>();

  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Suggestion ${index + 1} was not an object.`);
      continue;
    }

    const rec = entry as Record<string, unknown>;
    const rawSlug = rec.role_slug ?? rec.catalog_role_slug ?? rec.roleSlug ?? rec.slug;

    if (typeof rawSlug !== "string") {
      errors.push(`Suggestion ${index + 1} did not specify a role slug.`);
      continue;
    }

    const roleSlug = rawSlug.trim().toLowerCase();
    if (!SLUG_RE.test(roleSlug)) {
      errors.push(`Suggestion ${index + 1} specified an invalid role slug format: "${rawSlug}".`);
      continue;
    }

    const rawJustification = rec.justification ?? rec.rationale ?? rec.reason;
    if (typeof rawJustification !== "string" || !rawJustification.trim()) {
      errors.push(`Suggestion ${index + 1} had no justification.`);
      continue;
    }

    const justification = capText(
      redactSecrets(rawJustification).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(),
      HIRING_PROPOSAL_LIMITS.justification,
    );

    if (rec.name !== undefined && typeof rec.name !== "string") {
      errors.push(`Suggestion ${index + 1} (${roleSlug}): name must be a string.`);
      continue;
    }
    const name = typeof rec.name === "string" && rec.name.trim()
      ? capText(rec.name.trim(), HIRING_PROPOSAL_LIMITS.name)
      : undefined;

    if (rec.title !== undefined && typeof rec.title !== "string") {
      errors.push(`Suggestion ${index + 1} (${roleSlug}): title must be a string.`);
      continue;
    }
    const title = typeof rec.title === "string" && rec.title.trim()
      ? capText(rec.title.trim(), HIRING_PROPOSAL_LIMITS.title)
      : undefined;

    if (rec.competencies !== undefined && !Array.isArray(rec.competencies)) {
      errors.push(`Suggestion ${index + 1} (${roleSlug}): competencies must be an array.`);
      continue;
    }
    const competencies: string[] = [];
    if (Array.isArray(rec.competencies)) {
      for (const item of rec.competencies) {
        if (typeof item !== "string" || !item.trim()) {
          errors.push(`Suggestion ${index + 1} (${roleSlug}): each competency must be a non-empty string.`);
          continue;
        }
        competencies.push(capText(item.trim(), HIRING_PROPOSAL_LIMITS.competencyChars));
        if (competencies.length >= HIRING_PROPOSAL_LIMITS.competencies) break;
      }
    }

    const rawTasks = rec.related_tasks ?? rec.relatedTasks;
    if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
      errors.push(`Suggestion ${index + 1} (${roleSlug}): related_tasks must be an array.`);
      continue;
    }
    const relatedTasks: string[] = [];
    if (Array.isArray(rawTasks)) {
      for (const item of rawTasks) {
        const ref = cleanTaskRef(item);
        if (ref && !relatedTasks.includes(ref)) {
          relatedTasks.push(ref);
          if (relatedTasks.length >= HIRING_PROPOSAL_LIMITS.relatedTasks) break;
        }
      }
    }

    let adaptedPrompt: string | undefined;
    const promptRaw = rec.adapted_prompt ?? rec.adaptedPrompt ?? rec.prompt_markdown;
    if (promptRaw !== undefined && promptRaw !== null) {
      if (typeof promptRaw !== "string") {
        errors.push(`Suggestion ${index + 1} (${roleSlug}): adapted prompt must be a string.`);
        continue;
      }
      const trimmed = promptRaw.trim();
      if (trimmed) {
        const byteLen = new TextEncoder().encode(trimmed).length;
        if (byteLen > HIRING_PROPOSAL_LIMITS.promptBytes) {
          errors.push(
            `Suggestion ${index + 1} (${roleSlug}): prompt exceeds maximum allowed size of ${HIRING_PROPOSAL_LIMITS.promptBytes} bytes (got ${byteLen} bytes).`,
          );
          continue;
        }
        adaptedPrompt = trimmed;
      }
    }

    if (seenSlugs.has(roleSlug)) {
      errors.push(`Suggestion ${index + 1} repeated role slug "${roleSlug}".`);
      continue;
    }

    if (drafts.length >= HIRING_PROPOSAL_LIMITS.perReply) {
      errors.push(`Only the first ${HIRING_PROPOSAL_LIMITS.perReply} suggestions were kept.`);
      break;
    }

    seenSlugs.add(roleSlug);
    drafts.push({
      name,
      roleSlug,
      title,
      justification,
      competencies,
      relatedTasks,
      adaptedPrompt,
    });
  }

  return { drafts, errors };
}

export function hiringProposalStatusLabel(status: HiringProposalStatus): string {
  switch (status) {
    case "pending":
      return "Pending Review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
    case "stale":
      return "Stale";
  }
}

export function hiringProposalStatusTone(
  status: HiringProposalStatus,
): "success" | "warning" | "danger" | "muted" | "info" {
  switch (status) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
      return "danger";
    case "withdrawn":
      return "muted";
    case "stale":
      return "muted";
  }
}
