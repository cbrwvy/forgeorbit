/**
 * One-turn Brain context for Head of PM and the Project Manager.
 *
 * The owner previews an exact set, confirms it, and one manager message
 * consumes that grant. The bodies are read again at consume time. A changed,
 * archived, missing, or out-of-scope memory fails the turn. Nothing is
 * swapped in, and no model is started by this module.
 */

import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { BrainError } from "./brain-error.ts";
import { brainDirectory, openBrainStore, type BrainStore } from "./brain-store.ts";
import {
  BRAIN_CONTEXT_LIMITS,
  BRAIN_CONTEXT_NOTE,
  brainContextDigest,
  compareBrainContextItems,
  memoryAllowed,
  previewKeyOf,
  type BrainContextAccess,
  type BrainContextGrant,
  type BrainContextIssue,
  type BrainContextIssueCode,
  type BrainContextItem,
  type BrainContextPreview,
  type BrainContextTarget,
  type BrainEligibleMemory,
  type BrainEligibleResult,
  type BrainPromptMemory,
  type BrainSelectionInput,
  type BrainTransmission,
} from "../shared/brain/context.ts";
import { BRAIN_LIMITS, snippetOf, type BrainMemory } from "../shared/brain/document.ts";

export type ContextResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; issues?: BrainContextIssue[] };

/** Memories re-read for one manager turn. Bodies stay in the Brain store. */
export interface BrainConsumedContext {
  memories: BrainPromptMemory[];
  totalChars: number;
  ref: string;
  digest: string;
  access: BrainContextAccess;
}

export interface BrainContextDeps {
  now?: () => number;
  projectName: (projectPath: string) => string | null;
  listProjects: () => { path: string; name: string }[];
}

interface StoredItem {
  id: string;
  revision: number;
  sha256: string;
  title: string;
  kind: BrainContextItem["kind"];
  scopeKind: "company" | "project";
  scopeId: string;
  origin: import("../shared/brain/document.ts").BrainOrigin;
  charLength: number;
}

interface GrantRow {
  id: string;
  manager_kind: "project" | "portfolio";
  project_path: string | null;
  scope_mode: BrainContextAccess["mode"];
  inherit_company: number;
  project_scopes_json: string;
  status: BrainTransmission["status"];
  preview_key: string;
  digest: string;
  items_json: string;
  total_chars: number;
  approved_by: string;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
  message_id: string | null;
  turn_id: string | null;
  used: number;
  detail: string | null;
}

interface Evaluation {
  items: BrainContextItem[];
  documents: BrainPromptMemory[];
  issues: BrainContextIssue[];
  totalChars: number;
}

interface ResolvedTarget {
  target: BrainContextTarget;
  receiver: { kind: "project" | "portfolio"; label: string };
  managerPath: string | null;
}

function fail(status: number, error: string, issues?: BrainContextIssue[]): ContextResult<never> {
  return { ok: false, status, error, ...(issues ? { issues } : {}) };
}

export class BrainContextService {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly store: BrainStore,
    private readonly deps: BrainContextDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Boot: a grant that waited through a restart is never honored. */
  recover(): number {
    return this.db.run(
      `UPDATE brain_context_grants SET status = 'expired', settled_at = ?, used = 0,
        detail = 'app restarted before the message was sent'
        WHERE status = 'approved'`,
      [this.now()],
    ).changes;
  }

  eligible(target: BrainContextTarget, access: BrainContextAccess, text: string): ContextResult<BrainEligibleResult> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const scope = this.bindAccess(resolved.value, access);
    if (!scope.ok) return scope;
    const listed = this.listMemories(scope.value, text);
    if (!listed.ok) return listed;
    return {
      ok: true,
      value: {
        receiver: resolved.value.receiver,
        access: scope.value,
        memories: listed.value.memories,
        availableProjects: resolved.value.target.kind === "portfolio" ? this.availableProjects() : [],
        truncated: listed.value.truncated,
        note: BRAIN_CONTEXT_NOTE,
      },
    };
  }

  preview(target: BrainContextTarget, access: BrainContextAccess, selections: BrainSelectionInput[]): ContextResult<BrainContextPreview> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const scope = this.bindAccess(resolved.value, access);
    if (!scope.ok) return scope;
    return { ok: true, value: this.previewOf(resolved.value, scope.value, this.evaluate(scope.value, selections)) };
  }

  approve(
    target: BrainContextTarget,
    access: BrainContextAccess,
    selections: BrainSelectionInput[],
    previewKey: string,
  ): ContextResult<BrainContextGrant> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const scope = this.bindAccess(resolved.value, access);
    if (!scope.ok) return scope;
    const evaluation = this.evaluate(scope.value, selections);
    const preview = this.previewOf(resolved.value, scope.value, evaluation);
    if (evaluation.issues.length > 0) {
      return fail(409, "Some memories changed or can't be sent. Preview them again. Nothing was substituted.", evaluation.issues);
    }
    if (preview.previewKey !== previewKey || preview.digest !== brainContextDigest({
      managerKind: resolved.value.target.kind,
      projectPath: resolved.value.managerPath,
      access: scope.value,
      items: evaluation.items,
    })) {
      return fail(409, "The memories changed since the preview. Preview them again.", [
        { code: "preview-changed", memoryId: null, message: "The previewed list no longer matches the memories." },
      ]);
    }
    const id = randomBytes(32).toString("hex");
    const now = this.now();
    const stored: StoredItem[] = evaluation.items.map((item) => ({
      id: item.id,
      revision: item.revision,
      sha256: item.sha256,
      title: item.title,
      kind: item.kind,
      scopeKind: item.scope.kind,
      scopeId: item.scope.id,
      origin: item.origin,
      charLength: item.charLength,
    }));
    this.db.transaction(() => {
      this.db.run(
        `UPDATE brain_context_grants SET status = 'revoked', settled_at = ?, detail = 'replaced by a newer confirmation'
          WHERE status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
        [now, resolved.value.target.kind, resolved.value.managerPath ?? ""],
      );
      this.db.run(
        `INSERT INTO brain_context_grants (
          id, manager_kind, project_path, scope_mode, inherit_company, project_scopes_json, status,
          preview_key, digest, items_json, total_chars, approved_by, created_at, expires_at, used
        ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, 'owner', ?, ?, 0)`,
        [
          id,
          resolved.value.target.kind,
          resolved.value.managerPath,
          scope.value.mode,
          scope.value.inheritCompany ? 1 : 0,
          JSON.stringify(scope.value.projectPaths),
          preview.previewKey,
          preview.digest,
          JSON.stringify(stored),
          evaluation.totalChars,
          now,
          now + BRAIN_CONTEXT_LIMITS.grantTtlMs,
        ],
      );
    }).immediate();
    return {
      ok: true,
      value: {
        grantId: id,
        expiresAt: now + BRAIN_CONTEXT_LIMITS.grantTtlMs,
        approvedBy: "owner",
        createdAt: now,
        digest: preview.digest,
        preview,
      },
    };
  }

  revoke(target: BrainContextTarget, grantId: string): ContextResult<{ revoked: boolean }> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const changed = this.db.run(
      `UPDATE brain_context_grants SET status = 'revoked', settled_at = ?, detail = 'cancelled by the owner'
        WHERE id = ? AND status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [this.now(), grantId, resolved.value.target.kind, resolved.value.managerPath ?? ""],
    ).changes;
    return { ok: true, value: { revoked: changed === 1 } };
  }

  /**
   * Spend a grant for one manager message, then re-read every memory.
   * The grant is spent first so two sends cannot both win. Any difference
   * ends the grant as rejected and returns no memories. This does not start
   * a model. `used` stays 0 until the caller marks the prompt as launched.
   */
  consume(
    target: BrainContextTarget,
    grantId: string,
    messageId: string | null,
    turnId: string | null,
  ): ContextResult<BrainConsumedContext> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const now = this.now();
    const spent = this.db.run(
      `UPDATE brain_context_grants SET status = 'consumed', settled_at = ?, message_id = ?, turn_id = ?, used = 0
        WHERE id = ? AND status = 'approved' AND expires_at > ? AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [now, messageId, turnId, grantId, now, resolved.value.target.kind, resolved.value.managerPath ?? ""],
    ).changes;
    if (spent !== 1) {
      const row = this.grantRow(grantId);
      if (row && row.status === "approved" && row.expires_at <= now) {
        this.db.run(
          `UPDATE brain_context_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent'
            WHERE id = ? AND status = 'approved'`,
          [now, grantId],
        );
      }
      return fail(409, "The permission to send these memories is not valid any more (already used, expired, cancelled, or for another manager). Choose and confirm the memories again.");
    }
    const row = this.grantRow(grantId)!;
    const access = this.storedAccess(row);
    if (!access) {
      this.reject(grantId, "invalid stored scope");
      return fail(409, "The saved memory permission is not usable. Confirm the memories again.");
    }
    const registered = this.bindAccess(resolved.value, access);
    if (!registered.ok) {
      this.reject(grantId, registered.error);
      return fail(409, `${registered.error} Nothing was sent.`, registered.issues);
    }
    const stored = parseStored(row.items_json);
    if (stored.length === 0) {
      this.reject(grantId, "empty selection");
      return fail(409, "The saved memory list is empty. Confirm the memories again.");
    }
    const evaluation = this.evaluate(registered.value, stored.map((item) => ({
      id: item.id,
      revision: item.revision,
      sha256: item.sha256,
    })));
    const preview = this.previewOf(resolved.value, registered.value, evaluation);
    const drift = evaluation.issues.length > 0 || preview.previewKey !== row.preview_key || preview.digest !== row.digest;
    if (drift) {
      const issues = evaluation.issues.length > 0
        ? evaluation.issues
        : [{ code: "preview-changed" as const, memoryId: null, message: "The memories changed after they were confirmed." }];
      this.reject(grantId, issues.map((issue) => issue.code).join(","));
      return fail(409, "A confirmed memory changed or can't be sent any more. Nothing was sent. Review the memories and confirm again.", issues);
    }
    return {
      ok: true,
      value: {
        memories: evaluation.documents,
        totalChars: evaluation.totalChars,
        ref: grantId.slice(0, 8),
        digest: row.digest,
        access: registered.value,
      },
    };
  }

  /** The prompt that included these memories was handed to the manager turn. */
  markUsed(grantId: string): void {
    this.db.run(
      `UPDATE brain_context_grants SET used = 1 WHERE id = ? AND status = 'consumed' AND used = 0`,
      [grantId],
    );
  }

  transmissions(target: BrainContextTarget): ContextResult<{ transmissions: BrainTransmission[] }> {
    const resolved = this.resolveTarget(target);
    if (!resolved.ok) return resolved;
    const rows = this.db.query<GrantRow, [string, string, number]>(
      `SELECT * FROM brain_context_grants WHERE manager_kind = ? AND IFNULL(project_path, '') = ?
        ORDER BY created_at DESC, id ASC LIMIT ?`,
    ).all(resolved.value.target.kind, resolved.value.managerPath ?? "", BRAIN_CONTEXT_LIMITS.auditPage);
    const now = this.now();
    return {
      ok: true,
      value: {
        transmissions: rows.flatMap((row) => {
          const access = this.storedAccess(row);
          if (!access) return [];
          return [{
            ref: row.id.slice(0, 8),
            status: row.status === "approved" && row.expires_at <= now ? "expired" : row.status,
            createdAt: row.created_at,
            settledAt: row.settled_at,
            messageId: row.message_id,
            turnId: row.turn_id,
            used: row.used === 1,
            digest: row.digest,
            totalChars: row.total_chars,
            access,
            approvedBy: "owner" as const,
            detail: row.detail,
            items: parseStored(row.items_json).map((item) => ({
              id: item.id,
              title: item.title,
              scope: { kind: item.scopeKind, id: item.scopeId },
              kind: item.kind,
              revision: item.revision,
              sha256: item.sha256,
              charLength: item.charLength,
            })),
          }];
        }),
      },
    };
  }

  private reject(grantId: string, detail: string): void {
    this.db.run(
      `UPDATE brain_context_grants SET status = 'rejected', used = 0, detail = ? WHERE id = ?`,
      [detail.slice(0, 400), grantId],
    );
  }

  private resolveTarget(target: BrainContextTarget): ContextResult<ResolvedTarget> {
    if (target.kind === "portfolio") {
      return { ok: true, value: { target, receiver: { kind: "portfolio", label: "Head of PM" }, managerPath: null } };
    }
    const name = this.deps.projectName(target.projectPath);
    if (!name) return fail(404, "Project is not registered.");
    return {
      ok: true,
      value: {
        target,
        receiver: { kind: "project", label: `Project manager · ${name}` },
        managerPath: target.projectPath,
      },
    };
  }

  /** Re-check that every named project is still registered. Do not drop one and continue. */
  private bindAccess(resolved: ResolvedTarget, access: BrainContextAccess): ContextResult<BrainContextAccess> {
    if (resolved.target.kind === "project") {
      if (access.mode === "projects") return fail(400, "A project manager cannot take another project's memories.");
      if (access.mode !== "company" && (access.projectPaths.length !== 1 || access.projectPaths[0] !== resolved.managerPath)) {
        return fail(403, "This permission is not for this project's manager.");
      }
      if (access.mode === "company" && access.projectPaths.length > 0) {
        return fail(403, "Company-only context does not include a project memory.");
      }
    }
    for (const path of access.projectPaths) {
      if (!this.deps.projectName(path)) {
        return fail(404, `Project is not registered: ${path}`, [
          { code: "orphaned", memoryId: null, message: `${path} is not a registered project. Its memories were not attached to another project.` },
        ]);
      }
    }
    return { ok: true, value: access };
  }

  private availableProjects(): { path: string; name: string }[] {
    return this.deps.listProjects()
      .filter((project) => project.path && project.name)
      .sort((a, b) => a.name.localeCompare(b.name, "en") || a.path.localeCompare(b.path, "en"));
  }

  private listMemories(access: BrainContextAccess, text: string): ContextResult<{ memories: BrainEligibleMemory[]; truncated: boolean }> {
    const found = new Map<string, BrainEligibleMemory>();
    let truncated = false;
    const take = (scopeKind: "company" | "project", projectPath?: string, inheritCompany = false) => {
      let page;
      try {
        page = this.store.list({
          scopeKind,
          projectPath,
          inheritCompany,
          text,
          status: "active",
          limit: BRAIN_LIMITS.listMax,
        });
      } catch (error) {
        if (error instanceof BrainError) throw error;
        throw error;
      }
      truncated ||= page.truncated;
      for (const memory of page.memories) {
        if (memory.status !== "active" || memory.role !== "data" || memory.executable || memory.overridesRules) continue;
        if (!memoryAllowed(access, memory.scope)) continue;
        if (memory.scope.kind === "project" && !this.deps.projectName(memory.scope.id)) continue;
        found.set(memory.id, {
          id: memory.id,
          title: memory.title,
          scope: memory.scope,
          scopeLabel: this.scopeLabel(memory.scope),
          kind: memory.kind,
          origin: memory.origin,
          revision: memory.revision,
          sha256: memory.contentSha256,
          excerpt: memory.snippet,
          byteLength: memory.byteLength,
          active: true,
          valid: true,
        });
      }
    };
    try {
      if (access.mode === "company" || access.inheritCompany) take("company");
      for (const path of access.projectPaths) take("project", path, false);
    } catch (error) {
      if (error instanceof BrainError) return fail(error.status, error.message);
      throw error;
    }
    const memories = [...found.values()].sort(compareBrainContextItems);
    const capped = memories.length > BRAIN_LIMITS.listMax;
    return { ok: true, value: { memories: memories.slice(0, BRAIN_LIMITS.listMax), truncated: truncated || capped } };
  }

  private scopeLabel(scope: { kind: string; id: string }): string {
    if (scope.kind === "company") return "Company";
    return this.deps.projectName(scope.id) ?? scope.id;
  }

  private evaluate(access: BrainContextAccess, selections: BrainSelectionInput[]): Evaluation {
    const issues: BrainContextIssue[] = [];
    const items: BrainContextItem[] = [];
    const documents: BrainPromptMemory[] = [];
    const issue = (code: BrainContextIssueCode, memoryId: string | null, message: string) => issues.push({ code, memoryId, message });
    for (const selection of selections) {
      let memory: BrainMemory;
      try {
        memory = this.store.read(selection.id);
      } catch (error) {
        if (error instanceof BrainError && error.status === 404) issue("not-found", selection.id, "This memory no longer exists.");
        else if (error instanceof BrainError && (error.code === "content_mismatch" || error.code === "missing_file" || error.code === "metadata_mismatch" || error.code === "integrity")) {
          issue("integrity", selection.id, "This memory's file does not match its index. It was left in place and was not replaced.");
        } else issue("unreadable", selection.id, "This memory could not be read.");
        continue;
      }
      if (memory.status !== "active") {
        issue("archived", memory.id, `"${memory.title}" is archived and is not sent.`);
        continue;
      }
      if (memory.role !== "data" || memory.executable || memory.overridesRules) {
        issue("integrity", memory.id, `"${memory.title}" is not stored as data.`);
        continue;
      }
      if (memory.scope.kind === "project" && !this.deps.projectName(memory.scope.id)) {
        issue("orphaned", memory.id, `"${memory.title}" belongs to a project that is not registered. It was not attached to another project.`);
        continue;
      }
      if (!memoryAllowed(access, memory.scope)) {
        const company = memory.scope.kind === "company";
        issue(
          "out-of-scope",
          memory.id,
          company
            ? `"${memory.title}" is a company memory. Company memories are included only when this turn approves company inheritance.`
            : `"${memory.title}" is outside the projects authorized for this turn.`,
        );
        continue;
      }
      const actual = createHash("sha256").update(memory.content, "utf8").digest("hex");
      if (actual !== memory.contentSha256) {
        issue("integrity", memory.id, `"${memory.title}" does not match its recorded checksum.`);
        continue;
      }
      if (selection.revision !== undefined && selection.revision !== memory.revision) {
        issue("stale-revision", memory.id, `"${memory.title}" is revision ${memory.revision}, not the revision you reviewed (${selection.revision}). The newer text was not substituted.`);
        continue;
      }
      if (selection.sha256 !== undefined && selection.sha256 !== actual) {
        issue("stale-hash", memory.id, `"${memory.title}" changed since you reviewed it. The new text was not substituted.`);
        continue;
      }
      const charLength = memory.content.length;
      if (charLength > BRAIN_CONTEXT_LIMITS.totalChars) {
        issue("too-large", memory.id, `"${memory.title}" is ${charLength.toLocaleString("en-US")} characters. One message can carry ${BRAIN_CONTEXT_LIMITS.totalChars.toLocaleString("en-US")}. It was not cut.`);
        continue;
      }
      const item: BrainContextItem = {
        id: memory.id,
        title: memory.title,
        scope: memory.scope,
        scopeLabel: this.scopeLabel(memory.scope),
        kind: memory.kind,
        origin: memory.origin,
        provenance: memory.provenance.note,
        revision: memory.revision,
        sha256: actual,
        active: true,
        valid: true,
        excerpt: snippetOf(memory.content),
        content: memory.content,
        charLength,
        role: "data",
        executable: false,
        overridesRules: false,
      };
      items.push(item);
      documents.push(item);
    }
    const order = items.map((item, index) => ({ item, doc: documents[index]! }));
    order.sort((a, b) => compareBrainContextItems(a.item, b.item));
    const sortedItems = order.map((entry) => entry.item);
    const sortedDocs = order.map((entry) => entry.doc);
    const totalChars = sortedItems.reduce((sum, item) => sum + item.charLength, 0);
    if (totalChars > BRAIN_CONTEXT_LIMITS.totalChars) {
      issue(
        "over-budget",
        null,
        `The chosen memories are ${totalChars.toLocaleString("en-US")} characters. One message can carry ${BRAIN_CONTEXT_LIMITS.totalChars.toLocaleString("en-US")}. Choose fewer memories; nothing is cut or summarized.`,
      );
    }
    return { items: sortedItems, documents: sortedDocs, issues, totalChars };
  }

  private previewOf(resolved: ResolvedTarget, access: BrainContextAccess, evaluation: Evaluation): BrainContextPreview {
    const digest = brainContextDigest({
      managerKind: resolved.target.kind,
      projectPath: resolved.managerPath,
      access,
      items: evaluation.items,
    });
    return {
      receiver: resolved.receiver,
      access,
      items: evaluation.items,
      count: evaluation.items.length,
      totalChars: evaluation.totalChars,
      limits: { memories: BRAIN_CONTEXT_LIMITS.memories, totalChars: BRAIN_CONTEXT_LIMITS.totalChars },
      digest,
      previewKey: previewKeyOf(digest),
      issues: evaluation.issues,
      canApprove: evaluation.issues.length === 0 && evaluation.items.length > 0 && evaluation.items.length <= BRAIN_CONTEXT_LIMITS.memories,
      note: BRAIN_CONTEXT_NOTE,
    };
  }

  private storedAccess(row: GrantRow): BrainContextAccess | null {
    let paths: unknown;
    try {
      paths = JSON.parse(row.project_scopes_json);
    } catch {
      return null;
    }
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string")) return null;
    return {
      mode: row.scope_mode,
      projectPaths: paths as string[],
      inheritCompany: row.inherit_company === 1,
    };
  }

  private grantRow(id: string): GrantRow | null {
    return this.db.query<GrantRow, [string]>(`SELECT * FROM brain_context_grants WHERE id = ?`).get(id) ?? null;
  }
}

function parseStored(json: string): StoredItem[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is StoredItem =>
      !!item && typeof item === "object"
      && typeof (item as StoredItem).id === "string"
      && typeof (item as StoredItem).revision === "number"
      && typeof (item as StoredItem).sha256 === "string"
      && ((item as StoredItem).scopeKind === "company" || (item as StoredItem).scopeKind === "project")
      && typeof (item as StoredItem).scopeId === "string");
  } catch {
    return [];
  }
}

let defaultService: BrainContextService | null = null;

export async function loadBrainContext(): Promise<BrainContextService> {
  if (defaultService) return defaultService;
  const { db, dataDir, projects } = await import("./db.ts");
  const store = openBrainStore(brainDirectory(dataDir), {
    isRegistered(projectPath) {
      return projects.get(projectPath) != null;
    },
  });
  defaultService = new BrainContextService(db, store, {
    projectName: (projectPath) => projects.get(projectPath)?.name ?? null,
    listProjects: () => projects.list().map((project) => ({ path: project.path, name: project.name })),
  });
  return defaultService;
}

export async function recoverBrainContext(): Promise<number> {
  return (await loadBrainContext()).recover();
}

export function __setBrainContextForTest(service: BrainContextService | null): void {
  defaultService = service;
}
