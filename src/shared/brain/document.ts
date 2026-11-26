/**
 * Brain memories (FO-BRAIN01).
 *
 * Knowledge Base stores reference documents and instructions.
 * Brain stores accepted facts, decisions, and historical observations.
 * A memory is data. It does not override Project Rules or safety policy,
 * and this module does not call a model or compose a prompt.
 *
 * Company and project are the scopes this milestone writes.
 * `cluster` and `agent` are reserved so later rows can be stored without
 * rewriting existing company and project records.
 */

import { FORGEORBIT_COMPANY } from "../clusters/types.ts";
import { validateProjectPath } from "../clusters/paths.ts";

export const BRAIN_FORMAT = "forgeorbit-brain 1";
export const BRAIN_SCHEMA_VERSION = 1;

export const BRAIN_KINDS = ["fact", "decision", "observation"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

/** Scopes the Owner API accepts today. */
export const BRAIN_SCOPE_KINDS = ["company", "project"] as const;
export type BrainScopeKind = (typeof BRAIN_SCOPE_KINDS)[number];

/**
 * Values the SQLite check allows. Cluster and agent are reserved.
 * Writers in this milestone only persist company and project.
 */
export const BRAIN_STORED_SCOPE_KINDS = ["company", "project", "cluster", "agent"] as const;
export type BrainStoredScopeKind = (typeof BRAIN_STORED_SCOPE_KINDS)[number];

export const BRAIN_STATUSES = ["active", "archived"] as const;
export type BrainStatusValue = (typeof BRAIN_STATUSES)[number];

export const BRAIN_LIMITS = {
  title: 200,
  contentBytes: 100_000,
  searchQuery: 200,
  listDefault: 20,
  listMax: 50,
  requestId: 80,
  snippet: 160,
  bodyBytes: 200_000,
} as const;

export const BRAIN_PROVENANCE_NOTE =
  "Explicit Owner submission. Stored as data and not as an instruction.";

/**
 * New manifest v4 snapshots add a Brain record and, when a store exists,
 * the index plus committed Markdown. Snapshots written before that record
 * stay valid and do not describe a Brain category.
 */
export const BRAIN_BACKUP_LIMITATION =
  "New profile snapshots include the Brain index and committed Markdown memories and revisions. Pending writes are counted and left out. A snapshot that has no Brain record does not create memories and does not erase Brain in any other profile. Project memories keep their original path and are not attached to a different project. Restoring the files does not recreate a missing project directory.";

export const BRAIN_INHERITANCE_RULE =
  "Company memories are included only when a project query sets inherit=company. They stay company-scoped and are not copied onto the project. A project memory is never returned for a different project.";

/** File header and index column. The schema only stores this value. */
export type BrainFileOrigin = "owner";

/**
 * What the API and prompts report. Owner-typed memories stay `owner`.
 * A memory created from an approved proposal says so, even though the
 * file header remains `owner` for existing records and integrity checks.
 */
export type BrainOrigin = "owner" | "owner-approved-proposal" | "automatic-extraction";

export type BrainProposalClaim = "owner-stated" | "observation" | "hypothesis";

export interface BrainOwnerProvenance {
  source: "owner";
  approval: "explicit";
  note: string;
}

/** Owner approved text a manager proposed. Not an independent Owner authoring. */
export interface BrainProposalProvenance {
  source: "owner-approved-proposal";
  approval: "explicit";
  note: string;
  proposedBy: "project-manager" | "head-of-pm";
  proposalId: string;
  claim: BrainProposalClaim;
  editedByOwner: boolean;
  approvedBy: "owner";
}

/** Automatically extracted candidate approved by Owner (or future policy engine). */
export interface BrainExtractionProvenance {
  source: "automatic-extraction";
  approval: "explicit" | "policy-granted";
  approvedBy: "owner" | "policy-engine";
  sourceEventKind: string;
  sourceRecordIds: string[];
  extractionMethod: "heuristic" | "model-assisted";
  confidence: number;
  note: string;
  supersedesMemoryId?: string | null;
}

export type BrainProvenance = BrainOwnerProvenance | BrainProposalProvenance | BrainExtractionProvenance;

export function brainRecordOrigin(provenance: BrainProvenance): BrainOrigin {
  if (provenance.source === "owner-approved-proposal") return "owner-approved-proposal";
  if (provenance.source === "automatic-extraction") return "automatic-extraction";
  return "owner";
}

export function proposalProvenance(input: {
  proposedBy: "project-manager" | "head-of-pm";
  proposalId: string;
  claim: BrainProposalClaim;
  editedByOwner: boolean;
}): BrainProposalProvenance {
  const claimNote = input.claim === "hypothesis"
    ? "The manager marked this as a hypothesis, not an accepted fact."
    : input.claim === "observation"
      ? "The manager recorded this as its own observation, not a statement by the Owner."
      : "The manager attributed this to something the Owner said in the conversation. That attribution was not independently verified.";
  const edit = input.editedByOwner
    ? " The Owner edited the title, kind, or content before approval."
    : " The Owner approved the proposed text without editing it.";
  return {
    source: "owner-approved-proposal",
    approval: "explicit",
    proposedBy: input.proposedBy,
    proposalId: input.proposalId,
    claim: input.claim,
    editedByOwner: input.editedByOwner,
    approvedBy: "owner",
    note: `Proposed by ${input.proposedBy === "head-of-pm" ? "Head of PM" : "the Project Manager"}. ${claimNote}${edit} Approved by the Owner and stored as data, not as an instruction.`,
  };
}

export interface BrainScope {
  kind: BrainScopeKind;
  id: string;
}

export interface BrainMemory {
  id: string;
  scope: BrainScope;
  title: string;
  kind: BrainKind;
  status: BrainStatusValue;
  origin: BrainOrigin;
  provenance: BrainProvenance;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  contentSha256: string;
  byteLength: number;
  content: string;
  /** Retrieval contract: data, never a system instruction. */
  role: "data";
  executable: false;
  overridesRules: false;
}

export interface BrainMemorySummary {
  id: string;
  scope: BrainScope;
  title: string;
  kind: BrainKind;
  status: BrainStatusValue;
  origin: BrainOrigin;
  provenance: BrainProvenance;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  contentSha256: string;
  byteLength: number;
  snippet: string;
  role: "data";
  executable: false;
  overridesRules: false;
}

export interface BrainFileHeader {
  id: string;
  scopeKind: BrainScopeKind;
  scopeId: string;
  kind: BrainKind;
  status: BrainStatusValue;
  origin: BrainFileOrigin;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  contentSha256: string;
  title: string;
}

export interface BrainCreateInput {
  scopeKind: BrainScopeKind;
  projectPath?: string;
  title: string;
  kind: BrainKind;
  content: string;
  requestId?: string;
}

export interface BrainUpdateInput {
  expectedRevision: number;
  title?: string;
  kind?: BrainKind;
  content?: string;
}

export interface BrainListQuery {
  scopeKind: BrainScopeKind;
  projectPath?: string;
  /** Project queries only. Absent means project memories alone. */
  inheritCompany: boolean;
  text: string;
  status: BrainStatusValue;
  limit: number;
}

export interface BrainIntegrityIssue {
  memoryId: string | null;
  code:
    | "missing_file"
    | "content_mismatch"
    | "metadata_mismatch"
    | "path_rejected"
    | "pending_missing_file"
    | "unindexed_file"
    | "unexpected_file"
    | "orphaned_project";
  detail: string;
}

export interface BrainIndexStatus {
  schemaVersion: number;
  counts: { active: number; archived: number; pending: number; issues: number };
  issues: BrainIntegrityIssue[];
  orphanedProjects: { scopeId: string; count: number }[];
  backup: { includedInProfileSnapshot: boolean; limitation: string };
  retrieval: {
    defaultStatus: "active";
    companyInheritance: "opt-in";
    role: "data";
    rule: string;
  };
}

const CREATE_KEYS = ["scopeKind", "projectPath", "title", "kind", "content", "requestId"] as const;
const UPDATE_KEYS = ["expectedRevision", "title", "kind", "content"] as const;
const ARCHIVE_KEYS = ["expectedRevision"] as const;
const HEADER_KEYS = [
  "id",
  "scopeKind",
  "scopeId",
  "kind",
  "status",
  "origin",
  "revision",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "contentSha256",
  "title",
] as const;

const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  // Current provider keys carry hyphens and underscores (sk-proj-…, sk-ant-api03-…).
  /\bsk-(?:proj|ant|svcacct|admin|live|test)[-_][A-Za-z0-9_-]{16,}/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bgh[opsur]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  // A JWT (three base64url parts, the first two starting with an encoded `{"`).
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  // A connection string with a password in its userinfo (scheme://user:secret@host).
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@\/]+:[^\s@\/]{3,}@[^\s\/]+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export function isBrainMemoryId(value: string): boolean {
  return MEMORY_ID.test(value);
}

export function brainCompanyScope(): BrainScope {
  return { kind: "company", id: FORGEORBIT_COMPANY.id };
}

export function containsCredentialMaterial(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function encodeMemoryFile(header: BrainFileHeader, body: string): string {
  return [
    `<!-- ${BRAIN_FORMAT} -->`,
    `id: ${header.id}`,
    `scopeKind: ${header.scopeKind}`,
    `scopeId: ${header.scopeId}`,
    `kind: ${header.kind}`,
    `status: ${header.status}`,
    `origin: ${header.origin}`,
    `revision: ${header.revision}`,
    `createdAt: ${header.createdAt}`,
    `updatedAt: ${header.updatedAt}`,
    `archivedAt: ${header.archivedAt ?? ""}`,
    `contentSha256: ${header.contentSha256}`,
    `title: ${header.title}`,
    "---",
    body,
  ].join("\n");
}

export function decodeMemoryFile(text: string): { ok: true; header: BrainFileHeader; body: string } | { ok: false; error: string } {
  const prefix = `<!-- ${BRAIN_FORMAT} -->\n`;
  if (!text.startsWith(prefix)) return { ok: false, error: "Unrecognized memory file." };
  const marker = "\n---\n";
  const splitAt = text.indexOf(marker);
  if (splitAt < 0) return { ok: false, error: "Memory file has no body." };
  const headerText = text.slice(prefix.length, splitAt);
  const body = text.slice(splitAt + marker.length);
  const lines = headerText.split("\n");
  if (lines.length !== HEADER_KEYS.length) return { ok: false, error: "Memory file header is incomplete." };
  const values = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const key = HEADER_KEYS[i];
    if (!key) return { ok: false, error: "Memory file header is incomplete." };
    const label = `${key}:`;
    if (!line.startsWith(label)) return { ok: false, error: "Memory file header is out of order." };
    values.set(key, line.slice(label.length).trim());
  }
  const id = values.get("id") ?? "";
  const scopeKind = values.get("scopeKind") ?? "";
  const scopeId = values.get("scopeId") ?? "";
  const kind = values.get("kind") ?? "";
  const status = values.get("status") ?? "";
  const origin = values.get("origin") ?? "";
  const contentSha256 = values.get("contentSha256") ?? "";
  const title = values.get("title") ?? "";
  const revision = Number(values.get("revision"));
  const createdAt = Number(values.get("createdAt"));
  const updatedAt = Number(values.get("updatedAt"));
  const archivedRaw = values.get("archivedAt") ?? "";
  if (!isBrainMemoryId(id)) return { ok: false, error: "Invalid memory id." };
  if (!isScopeKind(scopeKind) || scopeId.length === 0 || scopeId.includes("\n")) return { ok: false, error: "Invalid memory scope." };
  if (!isKind(kind) || !isStatus(status) || origin !== "owner") return { ok: false, error: "Invalid memory metadata." };
  if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: "Invalid revision." };
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) return { ok: false, error: "Invalid timestamp." };
  if (!SHA256.test(contentSha256)) return { ok: false, error: "Invalid content hash." };
  if (title.length === 0 || title.length > BRAIN_LIMITS.title) return { ok: false, error: "Invalid title." };
  let archivedAt: number | null = null;
  if (archivedRaw.length > 0) {
    archivedAt = Number(archivedRaw);
    if (!Number.isSafeInteger(archivedAt)) return { ok: false, error: "Invalid archive timestamp." };
  }
  return {
    ok: true,
    header: {
      id,
      scopeKind,
      scopeId,
      kind,
      status,
      origin: "owner",
      revision,
      createdAt,
      updatedAt,
      archivedAt,
      contentSha256,
      title,
    },
    body,
  };
}

export function parseBrainCreate(body: unknown): { ok: true; value: BrainCreateInput } | { ok: false; error: string; status: number; code: string } {
  const record = plainObject(body, CREATE_KEYS);
  if (!record.ok) return record;
  const scopeKind = record.value.scopeKind;
  if (scopeKind === "cluster" || scopeKind === "agent") {
    return { ok: false, status: 400, code: "scope_unavailable", error: "Cluster and agent memories are not available yet." };
  }
  if (!isScopeKind(scopeKind)) return { ok: false, status: 400, code: "invalid_scope", error: "Scope must be company or project." };
  const title = requiredText(record.value.title, BRAIN_LIMITS.title);
  if (!title.ok) return { ok: false, status: 400, code: "invalid_request", error: "Title must be 1–200 characters." };
  const kind = record.value.kind;
  if (!isKind(kind)) return { ok: false, status: 400, code: "invalid_request", error: "Kind must be fact, decision, or observation." };
  const content = requiredContent(record.value.content);
  if (!content.ok) return content;
  if (containsCredentialMaterial(`${title.value}\n${content.value}`)) {
    return { ok: false, status: 400, code: "credential_refused", error: "Brain refused text that looks like a secret or credential." };
  }
  let projectPath: string | undefined;
  if (scopeKind === "company") {
    if ("projectPath" in record.value) {
      return { ok: false, status: 400, code: "invalid_scope", error: "Company memories do not take a project." };
    }
  } else {
    const parsed = validateProjectPath(record.value.projectPath);
    if (!parsed.ok) return { ok: false, status: 400, code: "invalid_project", error: parsed.error };
    projectPath = parsed.path;
  }
  let requestId: string | undefined;
  if ("requestId" in record.value) {
    if (typeof record.value.requestId !== "string" || !REQUEST_ID.test(record.value.requestId)) {
      return { ok: false, status: 400, code: "invalid_request", error: "requestId must be 8–80 letters, numbers, or . _ : -." };
    }
    requestId = record.value.requestId;
  }
  return { ok: true, value: { scopeKind, projectPath, title: title.value, kind, content: content.value, requestId } };
}

export function parseBrainUpdate(body: unknown): { ok: true; value: BrainUpdateInput } | { ok: false; error: string; status: number; code: string } {
  const record = plainObject(body, UPDATE_KEYS);
  if (!record.ok) return record;
  const expected = revisionOf(record.value.expectedRevision);
  if (!expected.ok) return expected;
  const next: BrainUpdateInput = { expectedRevision: expected.value };
  if ("title" in record.value) {
    const title = requiredText(record.value.title, BRAIN_LIMITS.title);
    if (!title.ok) return { ok: false, status: 400, code: "invalid_request", error: "Title must be 1–200 characters." };
    next.title = title.value;
  }
  if ("kind" in record.value) {
    if (!isKind(record.value.kind)) return { ok: false, status: 400, code: "invalid_request", error: "Kind must be fact, decision, or observation." };
    next.kind = record.value.kind;
  }
  if ("content" in record.value) {
    const content = requiredContent(record.value.content);
    if (!content.ok) return content;
    next.content = content.value;
  }
  if (next.title === undefined && next.kind === undefined && next.content === undefined) {
    return { ok: false, status: 400, code: "invalid_request", error: "Update must change the title, kind, or content." };
  }
  if (containsCredentialMaterial(`${next.title ?? ""}\n${next.content ?? ""}`)) {
    return { ok: false, status: 400, code: "credential_refused", error: "Brain refused text that looks like a secret or credential." };
  }
  return { ok: true, value: next };
}

export function parseBrainArchive(body: unknown): { ok: true; value: { expectedRevision: number } } | { ok: false; error: string; status: number; code: string } {
  const record = plainObject(body, ARCHIVE_KEYS);
  if (!record.ok) return record;
  const expected = revisionOf(record.value.expectedRevision);
  if (!expected.ok) return expected;
  return { ok: true, value: { expectedRevision: expected.value } };
}

export function parseBrainListQuery(params: URLSearchParams): { ok: true; value: BrainListQuery } | { ok: false; error: string; status: number; code: string } {
  const allowed = new Set(["scopeKind", "projectPath", "q", "limit", "status", "inherit"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) return { ok: false, status: 400, code: "invalid_request", error: "Unsupported query." };
  }
  const scopeKind = params.get("scopeKind");
  if (scopeKind === "cluster" || scopeKind === "agent") {
    return { ok: false, status: 400, code: "scope_unavailable", error: "Cluster and agent memories are not available yet." };
  }
  if (!isScopeKind(scopeKind)) return { ok: false, status: 400, code: "invalid_scope", error: "Scope must be company or project." };
  const statusRaw = params.get("status") ?? "active";
  if (!isStatus(statusRaw)) return { ok: false, status: 400, code: "invalid_request", error: "Status must be active or archived." };
  const inherit = params.get("inherit");
  if (inherit != null && inherit !== "company") return { ok: false, status: 400, code: "invalid_request", error: "inherit must be company." };
  if (inherit === "company" && scopeKind !== "project") {
    return { ok: false, status: 400, code: "invalid_scope", error: "Company inheritance applies only to a project query." };
  }
  let projectPath: string | undefined;
  if (scopeKind === "project") {
    const parsed = validateProjectPath(params.get("projectPath"));
    if (!parsed.ok) return { ok: false, status: 400, code: "invalid_project", error: parsed.error };
    projectPath = parsed.path;
  } else if (params.has("projectPath")) {
    return { ok: false, status: 400, code: "invalid_scope", error: "Company queries do not take a project." };
  }
  const text = (params.get("q") ?? "").trim();
  if (text.length > BRAIN_LIMITS.searchQuery) return { ok: false, status: 400, code: "invalid_request", error: "Search text is too long." };
  const limitRaw = params.get("limit");
  let limit: number = BRAIN_LIMITS.listDefault;
  if (limitRaw != null) {
    if (!/^[1-9][0-9]{0,3}$/.test(limitRaw)) return { ok: false, status: 400, code: "invalid_request", error: "Invalid limit." };
    limit = Math.min(BRAIN_LIMITS.listMax, Number(limitRaw));
  }
  return {
    ok: true,
    value: { scopeKind, projectPath, inheritCompany: inherit === "company", text, status: statusRaw, limit },
  };
}

export function snippetOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= BRAIN_LIMITS.snippet) return flat;
  return `${flat.slice(0, BRAIN_LIMITS.snippet - 1)}…`;
}

function isScopeKind(value: unknown): value is BrainScopeKind {
  return value === "company" || value === "project";
}

export function isKind(value: unknown): value is BrainKind {
  return value === "fact" || value === "decision" || value === "observation";
}

function isStatus(value: unknown): value is BrainStatusValue {
  return value === "active" || value === "archived";
}

function requiredText(value: unknown, max: number): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (text.length === 0 || text.length > max || CONTROL.test(text) || text.includes("\n") || text.includes("\r")) return { ok: false };
  return { ok: true, value: text };
}

function requiredContent(value: unknown): { ok: true; value: string } | { ok: false; error: string; status: number; code: string } {
  if (typeof value !== "string") return { ok: false, status: 400, code: "invalid_request", error: "Content is required." };
  if (value.trim().length === 0) return { ok: false, status: 400, code: "invalid_request", error: "Content is required." };
  if (CONTROL.test(value)) return { ok: false, status: 400, code: "invalid_request", error: "Content contains unsupported control characters." };
  if (new TextEncoder().encode(value).byteLength > BRAIN_LIMITS.contentBytes) {
    return { ok: false, status: 400, code: "invalid_request", error: "Content is too large." };
  }
  return { ok: true, value };
}

function revisionOf(value: unknown): { ok: true; value: number } | { ok: false; error: string; status: number; code: string } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, status: 400, code: "invalid_request", error: "expectedRevision must be a positive integer." };
  }
  return { ok: true, value };
}

function plainObject<K extends string>(
  body: unknown,
  keys: readonly K[],
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: number; code: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, code: "invalid_request", error: "JSON object required." };
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set<string>(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, status: 400, code: "invalid_request", error: `Unsupported field ${key}.` };
  }
  return { ok: true, value: record };
}
