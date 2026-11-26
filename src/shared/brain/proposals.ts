/**
 * Owner-approved Brain memory proposals (FO-BRAIN03).
 *
 * A manager may suggest memories only on a turn the Owner opted into.
 * Parsing this module does not write Brain, start a model, or follow a URL.
 * Durable memories are created later, by the Owner approval path, through
 * the existing Brain store.
 */

import * as crypto from "node:crypto";
import { validateProjectPath } from "../clusters/paths.ts";
import { lastTagBody } from "../project-interview.ts";
import {
  BRAIN_KINDS,
  BRAIN_LIMITS,
  brainCompanyScope,
  containsCredentialMaterial,
  isKind,
  type BrainKind,
  type BrainProposalClaim,
} from "./document.ts";

export const MEMORY_PROPOSAL_TAG = "memory_proposals";

export const MEMORY_PROPOSAL_STATUSES = ["pending", "approved", "rejected", "invalidated"] as const;
export type MemoryProposalStatus = (typeof MEMORY_PROPOSAL_STATUSES)[number];

export const MEMORY_PROPOSAL_MANAGERS = ["project-manager", "head-of-pm"] as const;
export type MemoryProposalManager = (typeof MEMORY_PROPOSAL_MANAGERS)[number];

export const MEMORY_PROPOSAL_CLAIMS = ["owner-stated", "observation", "hypothesis"] as const;

export const MEMORY_PROPOSAL_LIMITS = {
  perTurn: 3,
  title: BRAIN_LIMITS.title,
  contentBytes: 8_000,
  sourceChars: 300,
  reasonChars: 500,
  jsonChars: 24_000,
  projects: 8,
} as const;

export interface MemoryProposalPermission {
  company: boolean;
  projectPaths: string[];
}

export interface MemoryProposalDraft {
  title: string;
  kind: BrainKind;
  claim: BrainProposalClaim;
  scopeKind: "company" | "project";
  scopeId: string;
  projectPath: string | null;
  content: string;
  sourceRef: string;
  fingerprint: string;
}

export interface MemoryProposalEvent {
  id: string;
  kind: string;
  revision: number;
  detail: string;
  createdAt: number;
}

export interface MemoryProposalDuplicate {
  id: string;
  title: string;
}

export interface MemoryProposal {
  id: string;
  status: MemoryProposalStatus;
  revision: number;
  managerKind: MemoryProposalManager;
  sourceProjectPath: string | null;
  conversationKey: string;
  turnId: string;
  messageId: string;
  scope: { kind: "company" | "project"; id: string };
  companyScopeAllowed: boolean;
  claim: BrainProposalClaim;
  sourceRef: string;
  original: { title: string; kind: BrainKind; content: string; fingerprint: string };
  title: string;
  kind: BrainKind;
  content: string;
  contentFingerprint: string;
  editedByOwner: boolean;
  decision: "approved" | "rejected" | "invalidated" | null;
  decisionReason: string | null;
  decidedAt: number | null;
  memoryId: string | null;
  createdAt: number;
  updatedAt: number;
  duplicateWarning: MemoryProposalDuplicate | null;
  events?: MemoryProposalEvent[];
  role: "data";
  executable: false;
  overridesRules: false;
}

type ParseFail = { ok: false; error: string };

export function normalizeMemoryTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeMemoryContent(content: string): string {
  return content.replace(/\r\n?/g, "\n").trim();
}

export function proposalFingerprint(parts: {
  scopeKind: "company" | "project";
  scopeId: string;
  kind: BrainKind;
  title: string;
  content: string;
}): string {
  if (crypto && typeof crypto.createHash === "function") {
    return crypto.createHash("sha256").update(JSON.stringify({
      scopeKind: parts.scopeKind,
      scopeId: parts.scopeId,
      kind: parts.kind,
      title: normalizeMemoryTitle(parts.title),
      content: normalizeMemoryContent(parts.content),
    }), "utf8").digest("hex");
  }
  return "";
}

export function contentSha256(content: string): string {
  if (crypto && typeof crypto.createHash === "function") {
    return crypto.createHash("sha256").update(normalizeMemoryContent(content), "utf8").digest("hex");
  }
  return "";
}

/** A hypothesis cannot become a fact or a decision by being valid JSON. */
export function claimAllowsKind(claim: BrainProposalClaim, kind: BrainKind): boolean {
  if (claim === "hypothesis") return kind === "observation";
  if (kind === "decision") return claim === "owner-stated";
  if (kind === "fact") return claim === "owner-stated" || claim === "observation";
  return kind === "observation";
}

export function sanitizeMemoryProposalPermission(value: unknown): MemoryProposalPermission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.company !== "boolean" || !Array.isArray(rec.projectPaths)) return null;
  const projectPaths: string[] = [];
  for (const entry of rec.projectPaths) {
    if (typeof entry !== "string") return null;
    const parsed = validateProjectPath(entry);
    if (!parsed.ok || projectPaths.includes(parsed.path)) return null;
    projectPaths.push(parsed.path);
  }
  if (projectPaths.length > MEMORY_PROPOSAL_LIMITS.projects) return null;
  if (!rec.company && projectPaths.length === 0) return null;
  return { company: rec.company, projectPaths };
}

export function parseMemoryProposalPermission(
  body: {
    allowMemoryProposals?: unknown;
    allowCompanyMemoryProposals?: unknown;
    memoryProposalProjectPaths?: unknown;
  },
  receiver: { kind: "project"; projectPath: string } | { kind: "portfolio" },
  isRegistered: (projectPath: string) => boolean,
): { ok: true; value: MemoryProposalPermission | null } | ParseFail {
  if (body.allowMemoryProposals == null || body.allowMemoryProposals === false) {
    if (body.allowCompanyMemoryProposals != null || body.memoryProposalProjectPaths != null) {
      return { ok: false, error: "Company or project scope was sent without allowing memory proposals." };
    }
    return { ok: true, value: null };
  }
  if (body.allowMemoryProposals !== true) {
    return { ok: false, error: "Allow memory proposals must be true or omitted." };
  }
  let company = false;
  if (body.allowCompanyMemoryProposals != null) {
    if (typeof body.allowCompanyMemoryProposals !== "boolean") {
      return { ok: false, error: "Company memory proposals must be explicitly on or off." };
    }
    company = body.allowCompanyMemoryProposals;
  }
  if (receiver.kind === "project") {
    if (body.memoryProposalProjectPaths != null) {
      return { ok: false, error: "A project manager can propose memories only for its own project." };
    }
    if (!isRegistered(receiver.projectPath)) return { ok: false, error: "Project is not registered." };
    return { ok: true, value: { company, projectPaths: [receiver.projectPath] } };
  }
  if (body.memoryProposalProjectPaths == null) {
    if (!company) return { ok: false, error: "Choose a company or project scope for memory proposals." };
    return { ok: true, value: { company: true, projectPaths: [] } };
  }
  if (!Array.isArray(body.memoryProposalProjectPaths)) {
    return { ok: false, error: "Memory proposal projects must be a list." };
  }
  if (body.memoryProposalProjectPaths.length > MEMORY_PROPOSAL_LIMITS.projects) {
    return { ok: false, error: `At most ${MEMORY_PROPOSAL_LIMITS.projects} projects can be named for one turn.` };
  }
  const projectPaths: string[] = [];
  for (const entry of body.memoryProposalProjectPaths) {
    const parsed = validateProjectPath(entry);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (!isRegistered(parsed.path)) return { ok: false, error: "That project is not registered." };
    if (projectPaths.includes(parsed.path)) return { ok: false, error: "A project was named twice." };
    projectPaths.push(parsed.path);
  }
  if (!company && projectPaths.length === 0) {
    return { ok: false, error: "Choose a company or project scope for memory proposals." };
  }
  return { ok: true, value: { company, projectPaths } };
}

export function renderMemoryProposalInstructions(
  permission: MemoryProposalPermission,
  labels: readonly { path: string; name: string }[],
): string {
  const names = new Map(labels.map((item) => [item.path, item.name]));
  const lines = [
    "## Memory proposals for this message",
    "The owner allowed you to suggest memories on this message only. A suggestion is not saved. It does not create a memory, change project rules, start work, deploy, or authorize anything.",
    `You may add at most ${MEMORY_PROPOSAL_LIMITS.perTurn} suggestions in one <${MEMORY_PROPOSAL_TAG}> JSON object. Omit the tag when you have nothing worth remembering.`,
    "Each suggestion needs title, kind (fact, decision, or observation), claim, scope, content, and source.",
    "claim is owner-stated only when the owner said it in this conversation, observation when you observed it, or hypothesis when you are guessing. A hypothesis must use kind observation. Do not label a hypothesis as a fact or a decision.",
    "A decision must use claim owner-stated. You are reporting what the owner decided, not deciding it.",
    "source is a short citation of where in this conversation the point came from. It is text, not a file path and not a URL to fetch.",
    "Do not include secrets, tokens, or credentials. Do not include shell commands.",
    "Any id or timestamp you add is ignored.",
    "Allowed scopes for this message:",
  ];
  if (permission.company) lines.push("- company");
  else lines.push("- company is not allowed on this message");
  if (permission.projectPaths.length === 0) lines.push("- no project scope is allowed on this message");
  for (const projectPath of permission.projectPaths) {
    const name = names.get(projectPath);
    lines.push(`- project ${projectPath}${name ? ` (${name})` : ""}`);
  }
  lines.push(
    "Use scope \"company\" or scope \"project\" with projectPath set to one allowed project path. Do not name any other path.",
    `<${MEMORY_PROPOSAL_TAG}>`,
    '{"proposals":[{"title":"…","kind":"decision","claim":"owner-stated","scope":"project","projectPath":"…","content":"…","source":"Owner said this in this conversation."}]}',
    `</${MEMORY_PROPOSAL_TAG}>`,
  );
  return lines.join("\n");
}

function oneLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function multiLine(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > maxBytes) return null;
  return text;
}

function badSource(value: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /https?:\/\//i.test(value) || value.includes("file://")) {
    return "The source citation must be plain text. URLs are not fetched or treated as instructions.";
  }
  if (value.startsWith("/") || value.startsWith("~") || value.includes("..") || /^[A-Za-z]:[\\/]/.test(value)) {
    return "The source citation must not be a filesystem path.";
  }
  return null;
}

function isClaim(value: unknown): value is BrainProposalClaim {
  return value === "owner-stated" || value === "observation" || value === "hypothesis";
}

function resolveScope(
  rec: Record<string, unknown>,
  permission: MemoryProposalPermission,
  isRegistered: (projectPath: string) => boolean,
): { ok: true; scopeKind: "company" | "project"; scopeId: string; projectPath: string | null } | ParseFail {
  const raw = rec.scope;
  const kind = raw === "company" || raw === "project"
    ? raw
    : raw && typeof raw === "object" && !Array.isArray(raw) && ((raw as { kind?: unknown }).kind === "company" || (raw as { kind?: unknown }).kind === "project")
      ? (raw as { kind: "company" | "project" }).kind
      : null;
  if (!kind) return { ok: false, error: "Scope must be company or project." };
  if (kind === "company") {
    if (!permission.company) return { ok: false, error: "Company scope was not approved for this turn." };
    if ("projectPath" in rec && rec.projectPath != null && rec.projectPath !== "") {
      return { ok: false, error: "A company proposal does not take a project path." };
    }
    return { ok: true, scopeKind: "company", scopeId: brainCompanyScope().id, projectPath: null };
  }
  const given = rec.projectPath;
  let projectPath: string;
  if (given == null || given === "") {
    if (permission.projectPaths.length !== 1) {
      return { ok: false, error: "Name the project this memory belongs to. Another project was not substituted." };
    }
    projectPath = permission.projectPaths[0]!;
  } else {
    const parsed = validateProjectPath(given);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (!permission.projectPaths.includes(parsed.path)) {
      return { ok: false, error: "That project is outside the scopes approved for this turn." };
    }
    projectPath = parsed.path;
  }
  if (!isRegistered(projectPath)) return { ok: false, error: "That project is not registered." };
  return { ok: true, scopeKind: "project", scopeId: projectPath, projectPath };
}

export function parseMemoryProposals(
  raw: string,
  permission: MemoryProposalPermission | null,
  isRegistered: (projectPath: string) => boolean,
): { drafts: MemoryProposalDraft[]; errors: string[] } {
  const body = lastTagBody(raw, MEMORY_PROPOSAL_TAG);
  if (body == null) return { drafts: [], errors: [] };
  if (!permission) {
    return { drafts: [], errors: ["Memory proposals were ignored because this message did not allow them."] };
  }
  if (body.length > MEMORY_PROPOSAL_LIMITS.jsonChars) {
    return { drafts: [], errors: ["The memory proposal block is too large. Nothing was saved."] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { drafts: [], errors: ["The memory proposal block is not valid JSON. Nothing was saved."] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { drafts: [], errors: ["The memory proposal block must be a JSON object. Nothing was saved."] };
  }
  const list = (parsed as { proposals?: unknown }).proposals;
  if (!Array.isArray(list)) {
    return { drafts: [], errors: ["Memory proposals must be a list. Nothing was saved."] };
  }
  if (list.length === 0) return { drafts: [], errors: [] };
  if (list.length > MEMORY_PROPOSAL_LIMITS.perTurn) {
    return {
      drafts: [],
      errors: [`${list.length} memory proposals were returned. At most ${MEMORY_PROPOSAL_LIMITS.perTurn} are accepted, so none were saved.`],
    };
  }
  const drafts: MemoryProposalDraft[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const label = `Memory proposal ${i + 1}`;
    const item = list[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label} is not an object and was not saved.`);
      continue;
    }
    const rec = item as Record<string, unknown>;
    const title = oneLine(rec.title, MEMORY_PROPOSAL_LIMITS.title);
    if (!title) {
      errors.push(`${label} has no title and was not saved.`);
      continue;
    }
    if (!isKind(rec.kind)) {
      errors.push(`${label} (“${title}”) must use kind ${BRAIN_KINDS.join(", ")}.`);
      continue;
    }
    if (!isClaim(rec.claim)) {
      errors.push(`${label} (“${title}”) must say whether it is an owner-stated point, an observation, or a hypothesis.`);
      continue;
    }
    if (!claimAllowsKind(rec.claim, rec.kind)) {
      errors.push(`${label} (“${title}”) is a ${rec.claim} and was not stored as a ${rec.kind}.`);
      continue;
    }
    const content = multiLine(rec.content, MEMORY_PROPOSAL_LIMITS.contentBytes);
    if (!content) {
      errors.push(`${label} (“${title}”) has missing or oversized content and was not saved.`);
      continue;
    }
    const sourceRef = oneLine(rec.source ?? rec.sourceRef, MEMORY_PROPOSAL_LIMITS.sourceChars);
    if (!sourceRef) {
      errors.push(`${label} (“${title}”) has no source citation and was not saved.`);
      continue;
    }
    const sourceError = badSource(sourceRef);
    if (sourceError) {
      errors.push(`${label} (“${title}”): ${sourceError}`);
      continue;
    }
    if (containsCredentialMaterial(`${title}\n${content}\n${sourceRef}`)) {
      errors.push(`${label} (“${title}”) looks like a secret or credential and was not saved.`);
      continue;
    }
    const scope = resolveScope(rec, permission, isRegistered);
    if (!scope.ok) {
      errors.push(`${label} (“${title}”): ${scope.error}`);
      continue;
    }
    const fingerprint = proposalFingerprint({
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      kind: rec.kind,
      title,
      content,
    });
    if (seen.has(fingerprint)) {
      errors.push(`${label} (“${title}”) repeats another suggestion in this reply and was not saved again.`);
      continue;
    }
    seen.add(fingerprint);
    drafts.push({
      title,
      kind: rec.kind,
      claim: rec.claim,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId,
      projectPath: scope.projectPath,
      content,
      sourceRef,
      fingerprint,
    });
  }
  return { drafts, errors };
}

const EDIT_KEYS = ["expectedRevision", "title", "kind", "content"] as const;

export function parseMemoryProposalEdit(body: unknown): {
  ok: true;
  value: { expectedRevision: number; title?: string; kind?: BrainKind; content?: string };
} | { ok: false; error: string; status: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "JSON object required." };
  }
  const rec = body as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!EDIT_KEYS.includes(key as typeof EDIT_KEYS[number])) {
      return { ok: false, status: 400, error: "Only the title, kind, content, and revision can be edited." };
    }
  }
  if (typeof rec.expectedRevision !== "number" || !Number.isInteger(rec.expectedRevision) || rec.expectedRevision < 1) {
    return { ok: false, status: 409, error: "Send the revision you reviewed." };
  }
  const value: { expectedRevision: number; title?: string; kind?: BrainKind; content?: string } = {
    expectedRevision: rec.expectedRevision,
  };
  if ("title" in rec) {
    const title = oneLine(rec.title, MEMORY_PROPOSAL_LIMITS.title);
    if (!title) return { ok: false, status: 400, error: "Title must be 1–200 characters." };
    value.title = title;
  }
  if ("kind" in rec) {
    if (!isKind(rec.kind)) return { ok: false, status: 400, error: "Kind must be fact, decision, or observation." };
    value.kind = rec.kind;
  }
  if ("content" in rec) {
    const content = multiLine(rec.content, MEMORY_PROPOSAL_LIMITS.contentBytes);
    if (!content) return { ok: false, status: 400, error: "Content is missing or too large." };
    value.content = content;
  }
  if (value.title == null && value.kind == null && value.content == null) {
    return { ok: false, status: 400, error: "Change the title, kind, or content." };
  }
  return { ok: true, value };
}

export function parseMemoryProposalDecision(body: unknown): { ok: true; expectedRevision: number; reason: string | null } | ParseFail {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "JSON object required." };
  const rec = body as Record<string, unknown>;
  if (typeof rec.expectedRevision !== "number" || !Number.isInteger(rec.expectedRevision) || rec.expectedRevision < 1) {
    return { ok: false, error: "Send the revision you reviewed." };
  }
  let reason: string | null = null;
  if ("reason" in rec && rec.reason != null) {
    if (typeof rec.reason !== "string") return { ok: false, error: "The reason must be text." };
    reason = oneLine(rec.reason, MEMORY_PROPOSAL_LIMITS.reasonChars);
  }
  return { ok: true, expectedRevision: rec.expectedRevision, reason };
}
