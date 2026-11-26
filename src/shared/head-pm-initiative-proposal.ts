/**
 * FO-HEAD03 — structured initiative proposals from Head of PM portfolio chat.
 */

import { capText } from "./project-interview.ts";
import { multiLine, oneLine, parseJsonObject, MANAGER_LIMITS } from "./project-manager.ts";
import { HEAD_PM_INITIATIVE_LIMITS } from "./head-pm-initiative.ts";

export type InitiativeProposalStatus = "proposed" | "approved" | "rejected" | "dismissed";

export interface InitiativeProposalContribution {
  projectPath: string;
  projectName: string;
  objective: string;
  request: string;
  reason: string;
  contextSummary: string;
  expectedOutput: string;
}

export interface HeadPmInitiativeProposal {
  id: string;
  messageId: string;
  status: InitiativeProposalStatus;
  title: string;
  goal: string;
  description: string;
  contributions: InitiativeProposalContribution[];
  initiativeId: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
}

export interface InitiativeProposalDraft {
  title: string;
  goal: string;
  description: string;
  contributions: InitiativeProposalContribution[];
}

export type ProjectRefs = ReadonlyMap<string, { path: string; name: string }>;

function resolveRef(refs: ProjectRefs, value: unknown): { path: string; name: string } | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toUpperCase().replace(/^#/, "");
  return refs.get(key) ?? null;
}

export function parseInitiativeProposal(
  value: Record<string, unknown>,
  refs: ProjectRefs,
): { ok: true; draft: InitiativeProposalDraft } | { ok: false; error: string } {
  const L = HEAD_PM_INITIATIVE_LIMITS;
  const requestCap = MANAGER_LIMITS.messageChars;
  const title = oneLine(value.title, L.titleChars);
  if (!title) return { ok: false, error: "it has no title" };
  const goal = oneLine(value.goal, L.goalChars);
  const description = multiLine(value.description, L.descriptionChars);
  const list = value.projects;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "it names no projects" };
  if (list.length > L.maxProjects) return { ok: false, error: `it names more than ${L.maxProjects} projects` };
  const contributions: InitiativeProposalContribution[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "a project entry is not an object" };
    const rec = raw as Record<string, unknown>;
    const target = resolveRef(refs, rec.project);
    if (!target) return { ok: false, error: `it names a project that is not in the portfolio (${oneLine(rec.project, 40) || "none"})` };
    if (contributions.some((item) => item.projectPath === target.path)) {
      return { ok: false, error: `${target.name} is listed twice` };
    }
    if (typeof rec.request !== "string") return { ok: false, error: `the request to ${target.name} is missing` };
    const request = multiLine(rec.request, Number.MAX_SAFE_INTEGER);
    if (!request) return { ok: false, error: `the request to ${target.name} is empty` };
    if (request.length > requestCap) return { ok: false, error: `the request to ${target.name} is longer than ${requestCap} characters` };
    const objective = oneLine(rec.objective, 300);
    if (!objective) return { ok: false, error: `the contribution to ${target.name} has no objective` };
    contributions.push({
      projectPath: target.path,
      projectName: target.name,
      objective,
      request: capText(request, requestCap),
      reason: multiLine(rec.reason, 800),
      contextSummary: multiLine(rec.context_summary, 1500),
      expectedOutput: multiLine(rec.expected_output, 600),
    });
  }
  return { ok: true, draft: { title, goal, description, contributions } };
}

export function parseInitiativeProposalTag(
  body: string,
  refs: ProjectRefs,
): { ok: true; draft: InitiativeProposalDraft } | { ok: false; error: string } {
  const json = parseJsonObject(body);
  if (!json.ok) return json;
  return parseInitiativeProposal(json.value, refs);
}

export function sanitizeHeadPmInitiativeProposal(value: unknown): HeadPmInitiativeProposal | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.messageId !== "string") return null;
  const statuses: InitiativeProposalStatus[] = ["proposed", "approved", "rejected", "dismissed"];
  const status = statuses.includes(rec.status as InitiativeProposalStatus) ? rec.status as InitiativeProposalStatus : "proposed";
  const contributionsRaw = Array.isArray(rec.contributions) ? rec.contributions : [];
  const contributions: InitiativeProposalContribution[] = [];
  for (const item of contributionsRaw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.projectPath !== "string") continue;
    contributions.push({
      projectPath: c.projectPath,
      projectName: typeof c.projectName === "string" ? c.projectName : c.projectPath,
      objective: typeof c.objective === "string" ? c.objective : "",
      request: typeof c.request === "string" ? c.request : "",
      reason: typeof c.reason === "string" ? c.reason : "",
      contextSummary: typeof c.contextSummary === "string" ? c.contextSummary : "",
      expectedOutput: typeof c.expectedOutput === "string" ? c.expectedOutput : "",
    });
  }
  return {
    id: rec.id,
    messageId: rec.messageId,
    status,
    title: typeof rec.title === "string" ? rec.title : "",
    goal: typeof rec.goal === "string" ? rec.goal : "",
    description: typeof rec.description === "string" ? rec.description : "",
    contributions,
    initiativeId: typeof rec.initiativeId === "string" ? rec.initiativeId : null,
    createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
    updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : 0,
    approvedAt: typeof rec.approvedAt === "number" ? rec.approvedAt : null,
  };
}
