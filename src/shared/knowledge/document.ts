/**
 * Knowledge documents (FO-011C).
 *
 * A note has one owner: the company, one cluster, or one registered project.
 * The owner id is that registry's identity. It is never a folder name and
 * never a path to the Markdown file. Moving a project changes which cluster
 * notes are in scope later. It does not change the note's owner.
 */

import { FORGEORBIT_COMPANY, type KnowledgeOwnerKind, type KnowledgeOwnerRef } from "../clusters/types.ts";

export type { KnowledgeOwnerRef };
import { validateProjectPath } from "../clusters/paths.ts";

export const KNOWLEDGE_CATEGORIES = [
  "architecture",
  "agreements",
  "infrastructure",
  "deployment",
  "operations",
  "product",
  "decisions",
  "general",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_LIMITS = {
  title: 200,
  description: 2_000,
  category: 40,
  tag: 32,
  tags: 12,
  contentBytes: 512 * 1024,
  bodyBytes: 600 * 1024,
  searchQuery: 200,
  searchLimit: 50,
  searchDefault: 20,
  listLimit: 200,
  listDefault: 100,
  scan: 300,
  revisionsKept: 30,
  snippet: 160,
  ownerId: 4_096,
} as const;

export const KNOWLEDGE_CREDENTIAL_WARNING =
  "Do not put passwords, access tokens, cookies, or SSH private keys in a note. Knowledge is not a secrets manager.";

export const KNOWLEDGE_INFRASTRUCTURE_NOTE =
  "A note can describe a server, domain, or deployment. It is not a confirmed live state. Knowledge does not open SSH connections or check servers.";

export const KNOWLEDGE_CONTEXT_NOTE =
  "A project manager may later receive company notes, notes for the project's current cluster, and this project's notes. Other clusters, other projects, secrets, and files outside that boundary stay out. This page does not send notes to a model.";

const CREATE_KEYS = ["ownerKind", "ownerId", "title", "description", "category", "tags", "content", "sensitive"] as const;
const UPDATE_KEYS = ["expectedRevision", "title", "description", "category", "tags", "content", "sensitive"] as const;
const ARCHIVE_KEYS = ["expectedRevision"] as const;
const DELETE_KEYS = ["expectedRevision", "confirm"] as const;

const CONTROL = /[\u0000-\u001f\u007f]/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const TAG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLUSTER_ID = DOCUMENT_ID;

export interface KnowledgeDocument {
  id: string;
  owner: KnowledgeOwnerRef;
  title: string;
  description: string;
  category: string;
  tags: string[];
  sensitive: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  byteLength: number;
  /** When true on company/cluster notes, the note may inherit into projects that opted in. */
  inheritToProjects: boolean;
}

export interface KnowledgeRevisionInfo {
  revision: number;
  createdAt: number;
  byteLength: number;
  sha256: string;
}

export interface KnowledgeSearchHit {
  document: KnowledgeDocument;
  snippet: string | null;
}

export interface KnowledgeScope {
  company: KnowledgeOwnerRef;
  cluster: KnowledgeOwnerRef | null;
  project: KnowledgeOwnerRef;
  documents: KnowledgeDocument[];
  note: string;
}

export interface KnowledgeCreateInput {
  owner: KnowledgeOwnerRef;
  title: string;
  description: string;
  category: string;
  tags: string[];
  content: string;
  sensitive: boolean;
  inheritToProjects?: boolean;
}

export interface KnowledgeUpdateInput {
  expectedRevision: number;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  content?: string;
  sensitive?: boolean;
  inheritToProjects?: boolean;
}

export interface KnowledgeTemplate {
  id: string;
  label: string;
  title: string;
  category: KnowledgeCategory;
  body: string;
}

export const KNOWLEDGE_TEMPLATES: readonly KnowledgeTemplate[] = [
  { id: "blank", label: "Blank note", title: "", category: "general", body: "" },
  {
    id: "architecture",
    label: "Architecture decision",
    title: "Architecture decision",
    category: "architecture",
    body: "## Context\n\n## Decision\n\n## Consequences\n",
  },
  {
    id: "agreement",
    label: "Technical agreement",
    title: "Technical agreement",
    category: "agreements",
    body: "## Agreement\n\n## Scope\n\n## Review\n",
  },
  {
    id: "infrastructure",
    label: "Infrastructure note",
    title: "Infrastructure note",
    category: "infrastructure",
    body: "## Server\n\n- Name:\n- Provider:\n- Purpose:\n- Environment: staging or production (unconfirmed)\n\n## Projects that use it\n\n## Domains\n\n## Deployment notes\n\nThis note is not a confirmed live server status.\n",
  },
  {
    id: "deployment",
    label: "Deployment note",
    title: "Deployment note",
    category: "deployment",
    body: "## What is deployed\n\n## How to deploy\n\n## Rollback\n\nThis note is not a confirmed live deployment.\n",
  },
  {
    id: "operations",
    label: "Operations note",
    title: "Operations note",
    category: "operations",
    body: "## Procedure\n\n## Checks\n\n## When to stop\n",
  },
  {
    id: "product",
    label: "Product note",
    title: "Product note",
    category: "product",
    body: "## Audience\n\n## Behavior\n\n## Open questions\n",
  },
  {
    id: "decision",
    label: "Decision",
    title: "Decision",
    category: "decisions",
    body: "## Decision\n\n## Why\n\n## Date\n",
  },
];

export type KnowledgeParseFailure = { ok: false; error: string; status: 400 | 413 };
export type KnowledgeParse<T> = { ok: true; value: T } | KnowledgeParseFailure;

export function isKnowledgeDocumentId(value: string): boolean {
  return DOCUMENT_ID.test(value);
}

export function knowledgeExportFilename(title: string): string {
  const cleaned = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  const base = cleaned.length > 0 ? cleaned : "note";
  return `${base}.md`;
}

export function parseKnowledgeCreate(input: unknown): KnowledgeParse<KnowledgeCreateInput> {
  const record = recordWithKeys(input, CREATE_KEYS);
  if (!record.ok) return record;
  const owner = parseOwner(record.value.ownerKind, record.value.ownerId);
  if (!owner.ok) return owner;
  const title = parseTitle(record.value.title);
  if (!title.ok) return title;
  const description = parseDescription(record.value.description, true);
  if (!description.ok) return description;
  const category = parseCategory(record.value.category, true);
  if (!category.ok) return category;
  const tags = parseTags(record.value.tags, true);
  if (!tags.ok) return tags;
  const content = parseContent(record.value.content, true);
  if (!content.ok) return content;
  const sensitive = parseSensitive(record.value.sensitive, true);
  if (!sensitive.ok) return sensitive;
  return {
    ok: true,
    value: {
      owner: owner.value,
      title: title.value,
      description: description.value,
      category: category.value,
      tags: tags.value,
      content: content.value,
      sensitive: sensitive.value,
    },
  };
}

export function parseKnowledgeUpdate(input: unknown): KnowledgeParse<KnowledgeUpdateInput> {
  const record = recordWithKeys(input, UPDATE_KEYS);
  if (!record.ok) return record;
  const expected = parseRevision(record.value.expectedRevision);
  if (!expected.ok) return expected;
  const value: KnowledgeUpdateInput = { expectedRevision: expected.value };
  if ("title" in record.value) {
    const title = parseTitle(record.value.title);
    if (!title.ok) return title;
    value.title = title.value;
  }
  if ("description" in record.value) {
    const description = parseDescription(record.value.description, false);
    if (!description.ok) return description;
    value.description = description.value;
  }
  if ("category" in record.value) {
    const category = parseCategory(record.value.category, false);
    if (!category.ok) return category;
    value.category = category.value;
  }
  if ("tags" in record.value) {
    const tags = parseTags(record.value.tags, false);
    if (!tags.ok) return tags;
    value.tags = tags.value;
  }
  if ("content" in record.value) {
    const content = parseContent(record.value.content, false);
    if (!content.ok) return content;
    value.content = content.value;
  }
  if ("sensitive" in record.value) {
    const sensitive = parseSensitive(record.value.sensitive, false);
    if (!sensitive.ok) return sensitive;
    value.sensitive = sensitive.value;
  }
  if (Object.keys(value).length === 1) return fail("Nothing to change.");
  return { ok: true, value };
}

export function parseKnowledgeRevisionBody(input: unknown): KnowledgeParse<{ expectedRevision: number }> {
  const record = recordWithKeys(input, ARCHIVE_KEYS);
  if (!record.ok) return record;
  const expected = parseRevision(record.value.expectedRevision);
  if (!expected.ok) return expected;
  return { ok: true, value: { expectedRevision: expected.value } };
}

export function parseKnowledgeDelete(input: unknown): KnowledgeParse<{ expectedRevision: number }> {
  const record = recordWithKeys(input, DELETE_KEYS);
  if (!record.ok) return record;
  if (record.value.confirm !== "delete") return fail('Permanent delete requires confirm: "delete".');
  const expected = parseRevision(record.value.expectedRevision);
  if (!expected.ok) return expected;
  return { ok: true, value: { expectedRevision: expected.value } };
}

export function parseKnowledgeOwnerQuery(kind: string | null, id: string | null): KnowledgeParse<KnowledgeOwnerRef> {
  return parseOwner(kind, id);
}

export function parseSearchQuery(raw: string | null): KnowledgeParse<string> {
  if (raw == null) return fail("Search text is required.");
  const text = raw.trim();
  if (text.length === 0 || text.length > KNOWLEDGE_LIMITS.searchQuery) return fail("Search text is required.");
  if (CONTROL.test(text)) return fail("Search text is invalid.");
  return { ok: true, value: text };
}

export function parseResultLimit(raw: string | null, fallback: number, max: number): KnowledgeParse<number> {
  if (raw == null || raw === "") return { ok: true, value: fallback };
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return fail("Invalid limit.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return fail("Invalid limit.");
  return { ok: true, value };
}

function parseOwner(kind: unknown, id: unknown): KnowledgeParse<KnowledgeOwnerRef> {
  if (kind !== "company" && kind !== "cluster" && kind !== "project") return fail("Invalid owner.");
  if (typeof id !== "string") return fail("Invalid owner.");
  const ownerKind = kind as KnowledgeOwnerKind;
  if (ownerKind === "company") {
    if (id !== FORGEORBIT_COMPANY.id) return fail("Invalid owner.");
    return { ok: true, value: { kind: ownerKind, id } };
  }
  if (ownerKind === "cluster") {
    const clusterId = id.toLowerCase();
    if (!CLUSTER_ID.test(clusterId)) return fail("Invalid owner.");
    return { ok: true, value: { kind: ownerKind, id: clusterId } };
  }
  const project = validateProjectPath(id);
  if (!project.ok) return fail("Invalid owner.");
  return { ok: true, value: { kind: ownerKind, id: project.path } };
}

function parseTitle(value: unknown): KnowledgeParse<string> {
  if (typeof value !== "string") return fail("Title is required.");
  const title = value.trim();
  if (title.length === 0 || title.length > KNOWLEDGE_LIMITS.title || CONTROL.test(title)) return fail("Title is required.");
  return { ok: true, value: title };
}

function parseDescription(value: unknown, optional: boolean): KnowledgeParse<string> {
  if (value == null && optional) return { ok: true, value: "" };
  if (typeof value !== "string") return fail("Invalid description.");
  if (value.length > KNOWLEDGE_LIMITS.description || CONTROL.test(value.replace(/[\n\r\t]/g, ""))) return fail("Invalid description.");
  return { ok: true, value };
}

function parseCategory(value: unknown, optional: boolean): KnowledgeParse<string> {
  if ((value == null || value === "") && optional) return { ok: true, value: "general" };
  if (typeof value !== "string") return fail("Invalid category.");
  const category = value.trim().toLowerCase();
  if (!SLUG.test(category) || category.length > KNOWLEDGE_LIMITS.category) return fail("Invalid category.");
  return { ok: true, value: category };
}

function parseTags(value: unknown, optional: boolean): KnowledgeParse<string[]> {
  if (value == null && optional) return { ok: true, value: [] };
  if (!Array.isArray(value)) return fail("Invalid tags.");
  if (value.length > KNOWLEDGE_LIMITS.tags) return fail("Too many tags.");
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return fail("Invalid tags.");
    const tag = entry.trim().toLowerCase();
    if (!TAG.test(tag)) return fail("Invalid tags.");
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { ok: true, value: tags };
}

function parseContent(value: unknown, optional: boolean): KnowledgeParse<string> {
  if (value == null && optional) return { ok: true, value: "" };
  if (typeof value !== "string") return fail("Invalid Markdown.");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > KNOWLEDGE_LIMITS.contentBytes) return { ok: false, error: "Markdown is too large.", status: 413 };
  return { ok: true, value };
}

function parseSensitive(value: unknown, optional: boolean): KnowledgeParse<boolean> {
  if (value == null && optional) return { ok: true, value: false };
  if (typeof value !== "boolean") return fail("Invalid sensitive flag.");
  return { ok: true, value };
}

function parseRevision(value: unknown): KnowledgeParse<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    return fail("expectedRevision is required.");
  }
  return { ok: true, value };
}

function recordWithKeys(input: unknown, allowed: readonly string[]): KnowledgeParse<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Expected an object.");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (key.toLowerCase().includes("path") || key === "file" || key === "filename" || key === "storage" || key === "storageKey") {
      return fail("A document path cannot be set by the client.");
    }
    return fail("Unexpected field.");
  }
  return { ok: true, value: record };
}

function fail(error: string, status: 400 | 413 = 400): KnowledgeParseFailure {
  return { ok: false, error, status };
}
