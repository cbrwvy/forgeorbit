/**
 * Hiring Proposal Core (FO-014C).
 *
 * Implements persistent Project Manager team recommendations and Owner review/approval
 * of AI employees from the 283-role Agency Agents catalog.
 *
 * Atomic employee creation: On Owner approval, atomically writes to ai_employees,
 * ai_employee_events, ai_employee_professional_profiles, ai_employee_profile_revisions,
 * hiring_proposals, and hiring_proposal_events within a single database transaction.
 *
 * Never holds transactions across async boundaries or during AI manager turns.
 * Grants no execution permissions, starts no runs, creates no tasks or CLI sessions.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { getRoleCatalogService, RoleCatalogService } from "./role-catalog.ts";
import { EmployeeCore } from "../employee-core.ts";
import { ActivityJournalCore } from "../activity-journal-core.ts";
import { isWithin } from "../project-ownership.ts";
import type { HiringDraft } from "../../shared/hiring/proposals.ts";
import {
  HIRING_PROPOSAL_LIMITS,
  type ApproveHiringProposalRequest,
  type HiringProposal,
  type HiringProposalAction,
  type HiringProposalActor,
  type HiringProposalEvent,
  type HiringProposalStatus,
  type HiringProposalSummary,
  type RejectHiringProposalRequest,
  type UpdateHiringProposalRequest,
} from "../../shared/hiring/types.ts";
import type { Employee } from "../../shared/employees/types.ts";

export class HiringProposalError extends Error {
  constructor(message: string, readonly status = 400, readonly proposal?: HiringProposal) {
    super(message);
    this.name = "HiringProposalError";
  }
}

export interface HiringProposalCoreOptions {
  catalog?: RoleCatalogService;
  now?: () => number;
}

interface ProposalRow {
  id: string;
  project_path: string;
  proposed_name: string;
  kind: "worker";
  professional_title: string;
  catalog_role_slug: string;
  template_sha256: string;
  prompt_markdown: string;
  justification: string;
  competencies: string;
  related_tasks: string;
  proposed_by_kind: "owner" | "project-manager";
  proposed_by_employee_id: string | null;
  source_message_id: string | null;
  status: HiringProposalStatus;
  revision: number;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_from_revision: number | null;
  decision_note: string | null;
  stale_reason: string | null;
  created_employee_id: string | null;
}

interface EventRow {
  id: number;
  proposal_id: string;
  project_path: string;
  action: HiringProposalAction;
  actor: HiringProposalActor;
  proposal_revision: number;
  created_employee_id: string | null;
  note: string | null;
  created_at: number;
}

interface ProjectRow {
  path: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HiringProposalCore {
  private readonly db: Database;
  private readonly catalog: RoleCatalogService;
  private readonly now: () => number;

  constructor(db: Database, options: HiringProposalCoreOptions = {}) {
    this.db = db;
    this.catalog = options.catalog ?? getRoleCatalogService();
    this.now = options.now ?? (() => Date.now());
  }

  private validateUuid(id: unknown, label = "id"): string {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new HiringProposalError(`Invalid ${label} UUID: "${id}".`, 400);
    }
    return id.toLowerCase();
  }

  private requireRow(id: string): ProposalRow {
    const row = this.db
      .query<ProposalRow, [string]>("SELECT * FROM hiring_proposals WHERE id = ?")
      .get(id);
    if (!row) {
      throw new HiringProposalError(`Hiring proposal "${id}" not found.`, 404);
    }
    return row;
  }

  private requireProject(projectPath: string): ProjectRow {
    const project = this.db
      .query<ProjectRow, [string]>("SELECT path, name FROM projects WHERE path = ?")
      .get(projectPath);
    if (!project) {
      throw new HiringProposalError(`Project "${projectPath}" is not registered.`, 404);
    }
    const archivedCluster = this.db
      .query<{ name: string }, [string]>(
        `SELECT c.name FROM cluster_project_memberships m
           JOIN clusters c ON c.id = m.cluster_id
          WHERE m.project_path = ? AND c.archived_at IS NOT NULL`,
      )
      .get(projectPath);
    if (archivedCluster) {
      throw new HiringProposalError(`Project "${projectPath}" is archived (in cluster "${archivedCluster.name}").`, 409);
    }
    return project;
  }

  private checkActiveDuplicateEmployee(projectPath: string, roleSlug: string): { id: string; name: string } | null {
    const row = this.db
      .query<{ id: string; name: string }, [string, string]>(
        `SELECT e.id, e.name
           FROM ai_employees e
           JOIN ai_employee_professional_profiles p ON p.employee_id = e.id
          WHERE e.project_path = ?
            AND p.catalog_role_slug = ?
            AND e.archived_at IS NULL
            AND e.status = 'active'`,
      )
      .get(projectPath, roleSlug);
    return row ?? null;
  }

  private write<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (error) {
      if (error instanceof HiringProposalError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        throw new HiringProposalError("This proposal changed concurrently. Refresh and try again.", 409);
      }
      throw error;
    }
  }

  private validateRelatedTasks(
    projectPath: string,
    tasksInput: readonly string[],
  ): { validTasks: string[]; error?: string } {
    const validTasks: string[] = [];
    for (const ref of tasksInput) {
      if (typeof ref !== "string" || !ref.trim()) continue;
      const cleanRef = ref.trim().replace(/^#/, "");
      if (!cleanRef) continue;

      const matchingTasks = this.db
        .query<{ id: string; workdir: string; archived_at: number | null }, [string, string]>(
          `SELECT id, workdir, archived_at FROM tasks WHERE id = ? OR id LIKE ?`,
        )
        .all(cleanRef, `${cleanRef}%`);

      if (matchingTasks.length === 0) {
        return { validTasks: [], error: `Task reference "${ref}" cannot be resolved in tasks.` };
      }
      if (matchingTasks.length > 1) {
        return { validTasks: [], error: `Task reference "${ref}" is ambiguous (matches ${matchingTasks.length} tasks).` };
      }

      const task = matchingTasks[0]!;
      if (task.archived_at !== null && task.archived_at !== undefined) {
        return { validTasks: [], error: `Task "${ref}" is archived.` };
      }

      // Check canonical boundaries and prefix collision: /work/app vs /work/app-other
      if (!task.workdir || !isWithin(projectPath, task.workdir)) {
        return { validTasks: [], error: `references task from a foreign project ("${ref}").` };
      }

      if (!validTasks.includes(task.id)) {
        validTasks.push(task.id);
      }
    }
    return { validTasks };
  }

  private hydrate(row: ProposalRow): HiringProposal {
    const project = this.db
      .query<{ name: string }, [string]>("SELECT name FROM projects WHERE path = ?")
      .get(row.project_path);

    let authorName: string | null = null;
    if (row.proposed_by_employee_id) {
      const author = this.db
        .query<{ name: string }, [string]>("SELECT name FROM ai_employees WHERE id = ?")
        .get(row.proposed_by_employee_id);
      authorName = author?.name ?? null;
    }

    let competencies: string[] = [];
    try {
      competencies = JSON.parse(row.competencies);
    } catch {
      competencies = [];
    }

    let relatedTasks: string[] = [];
    try {
      relatedTasks = JSON.parse(row.related_tasks);
    } catch {
      relatedTasks = [];
    }

    let template = null;
    try {
      const full = this.catalog.getRole(row.catalog_role_slug);
      template = {
        slug: full.slug,
        name: full.name,
        description: full.description,
        division: full.division,
        color: full.color,
        emoji: full.emoji,
        vibe: full.vibe ?? "",
        sourcePath: full.sourcePath,
        sourceCommit: full.sourceCommit,
        sha256: full.sha256,
        sizeBytes: full.sizeBytes,
        originalMarkdown: full.originalMarkdown,
      };
    } catch {
      // Template missing from catalog
    }

    let duplicateWarning: string | null = null;
    if (row.status === "pending") {
      const dup = this.checkActiveDuplicateEmployee(row.project_path, row.catalog_role_slug);
      if (dup) {
        duplicateWarning = `An active employee (${dup.name}) with role "${row.catalog_role_slug}" already exists in this project.`;
      }
    }

    const legacy = this.db.query("SELECT name FROM sqlite_master WHERE name = 'hiring_legacy_provenance'").get()
      ? this.db.query<{ original_source_message_id: string | null; reason: string; original_row_json: string; original_events_json: string; canonical_pending_id: string | null; canonical_message_id: string | null; normalized_at: number }, [string]>(
        'SELECT * FROM hiring_legacy_provenance WHERE proposal_id = ?').get(row.id) : null;
    return {
      ...(legacy ? { legacyNormalization: {
        reason: legacy.reason, normalizedAt: legacy.normalized_at,
        canonicalPendingId: legacy.canonical_pending_id, canonicalMessageId: legacy.canonical_message_id,
        originalProposal: JSON.parse(legacy.original_row_json), originalEvents: JSON.parse(legacy.original_events_json),
      } } : {}),
      id: row.id,
      projectPath: row.project_path,
      projectName: project?.name ?? null,
      proposedName: row.proposed_name,
      kind: "worker",
      professionalTitle: row.professional_title,
      catalogRoleSlug: row.catalog_role_slug,
      templateSha256: row.template_sha256,
      promptMarkdown: row.prompt_markdown,
      justification: row.justification,
      competencies,
      relatedTasks,
      proposedBy: {
        kind: row.proposed_by_kind,
        employeeId: row.proposed_by_employee_id,
        employeeName: authorName,
      },
      sourceMessageId: legacy ? legacy.original_source_message_id : row.source_message_id,
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at,
      decidedFromRevision: row.decided_from_revision,
      decisionNote: row.decision_note,
      staleReason: row.stale_reason,
      createdEmployeeId: row.created_employee_id,
      template,
      duplicateWarning,
    };
  }

  public get(id: unknown): HiringProposal | null {
    try {
      const validId = this.validateUuid(id);
      const row = this.db
        .query<ProposalRow, [string]>("SELECT * FROM hiring_proposals WHERE id = ?")
        .get(validId);
      return row ? this.hydrate(row) : null;
    } catch {
      return null;
    }
  }

  public requireProposal(id: unknown): HiringProposal {
    const validId = this.validateUuid(id);
    return this.hydrate(this.requireRow(validId));
  }

  public list(filter: {
    projectPath?: string;
    status?: HiringProposalStatus;
    catalogRoleSlug?: string;
  } = {}): { proposals: HiringProposal[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.projectPath) {
      conditions.push("project_path = ?");
      params.push(filter.projectPath);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.catalogRoleSlug) {
      conditions.push("catalog_role_slug = ?");
      params.push(filter.catalogRoleSlug);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM hiring_proposals ${where} ORDER BY created_at DESC LIMIT ${HIRING_PROPOSAL_LIMITS.list}`;
    const rows = this.db.query<ProposalRow, (string | number)[]>(sql).all(...params);

    return { proposals: rows.map((r) => this.hydrate(r)) };
  }

  public summary(): HiringProposalSummary {
    const rows = this.db
      .query<{ project_path: string; pending: number; latest_at: number | null }, []>(
        `SELECT project_path, COUNT(*) AS pending, MAX(created_at) AS latest_at
           FROM hiring_proposals
          WHERE status = 'pending'
          GROUP BY project_path
          ORDER BY latest_at DESC`,
      )
      .all();

    const projects = rows.map((r) => {
      const p = this.db
        .query<{ name: string }, [string]>("SELECT name FROM projects WHERE path = ?")
        .get(r.project_path);
      return {
        projectPath: r.project_path,
        projectName: p?.name ?? r.project_path,
        pending: Number(r.pending),
        latestAt: r.latest_at,
      };
    });

    const pendingTotal = projects.reduce((sum, item) => sum + item.pending, 0);
    return { pendingTotal, projects };
  }

  public history(id: unknown): { proposal: HiringProposal; events: HiringProposalEvent[] } {
    const validId = this.validateUuid(id);
    const proposal = this.requireProposal(validId);

    const rows = this.db
      .query<EventRow, [string]>(
        `SELECT * FROM hiring_proposal_events WHERE proposal_id = ? ORDER BY id ASC LIMIT ${HIRING_PROPOSAL_LIMITS.history}`,
      )
      .all(validId);

    const events: HiringProposalEvent[] = rows.map((r) => ({
      id: r.id,
      proposalId: r.proposal_id,
      projectPath: r.project_path,
      action: r.action,
      actor: r.actor,
      proposalRevision: r.proposal_revision,
      createdEmployeeId: r.created_employee_id,
      note: r.note,
      createdAt: r.created_at,
    }));

    return { proposal, events };
  }

  public createFromManager(
    projectPath: string,
    drafts: readonly HiringDraft[],
    ctx: { messageId?: string; authorEmployeeId?: string } = {},
  ): { created: HiringProposal[]; dropped: string[] } {
    const created: HiringProposal[] = [];
    const dropped: string[] = [];

    // Verify project exists and is active
    let project: ProjectRow;
    try {
      project = this.requireProject(projectPath);
    } catch (err) {
      return { created, dropped: [(err as Error).message] };
    }

    const managerId = ctx.authorEmployeeId ??
      this.db
        .query<{ id: string }, [string]>(
          `SELECT id FROM ai_employees WHERE kind = 'project-manager' AND project_path = ? AND archived_at IS NULL`,
        )
        .get(project.path)?.id ??
      null;

    const pendingCount = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM hiring_proposals WHERE project_path = ? AND status = 'pending'`,
      )
      .get(project.path)?.n ?? 0;

    let availablePendingSlots = HIRING_PROPOSAL_LIMITS.pendingPerProject - pendingCount;
    for (const draft of drafts.slice(0, HIRING_PROPOSAL_LIMITS.perReply)) {
      // Check catalog slug validity
      let role;
      try {
        role = this.catalog.getRole(draft.roleSlug);
      } catch {
        dropped.push(`Role slug "${draft.roleSlug}" was not found in the role catalog.`);
        continue;
      }

      // Idempotent replay for same PM message and role
      if (ctx.messageId) {
        const existingFromMsg = this.db
          .query<ProposalRow, [string, string, string]>(
            `SELECT * FROM hiring_proposals WHERE project_path = ? AND source_message_id = ? AND catalog_role_slug = ?`,
          )
          .get(project.path, ctx.messageId, role.slug);
        if (existingFromMsg) {
          created.push(this.hydrate(existingFromMsg));
          continue;
        }
      }

      if (availablePendingSlots <= 0) {
        dropped.push("This project has reached the pending hiring proposals limit. Decide existing ones first.");
        continue;
      }

      // Check existing active employee duplication in project
      const duplicate = this.checkActiveDuplicateEmployee(project.path, role.slug);
      if (duplicate) {
        dropped.push(`An active employee (${duplicate.name}) with role "${role.slug}" already exists in this project.`);
        continue;
      }

      // Check existing pending proposal for same role in project
      const existingPending = this.db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM hiring_proposals WHERE project_path = ? AND catalog_role_slug = ? AND status = 'pending'`,
        )
        .get(project.path, role.slug);
      if (existingPending) {
        dropped.push(`A pending proposal for role "${role.slug}" already exists in this project.`);
        continue;
      }

      // Prompt size check (UTF-8 bytes)
      const promptText = (draft.adaptedPrompt?.trim() || role.originalMarkdown).trim();
      const promptByteLen = Buffer.byteLength(promptText, "utf-8");
      if (promptByteLen > HIRING_PROPOSAL_LIMITS.promptBytes) {
        dropped.push(
          `Role "${draft.roleSlug}": prompt exceeds maximum allowed size of ${HIRING_PROPOSAL_LIMITS.promptBytes} bytes (got ${promptByteLen} bytes).`,
        );
        continue;
      }

      // Validate related tasks
      let validatedTasks: string[] = [];
      if (draft.relatedTasks && draft.relatedTasks.length > 0) {
        const taskValidation = this.validateRelatedTasks(project.path, draft.relatedTasks);
        if (taskValidation.error) {
          dropped.push(`Role "${draft.roleSlug}": ${taskValidation.error}`);
          continue;
        }
        validatedTasks = taskValidation.validTasks;
      }

      try {
        const proposal = this.insertProposalRow({
          projectPath: project.path,
          proposedName: draft.name?.trim() || role.name,
          professionalTitle: draft.title?.trim() || role.name,
          catalogRoleSlug: role.slug,
          templateSha256: role.sha256,
          promptMarkdown: promptText,
          justification: draft.justification.trim(),
          competencies: draft.competencies || [],
          relatedTasks: validatedTasks,
          proposedByKind: "project-manager",
          proposedByEmployeeId: managerId,
          sourceMessageId: ctx.messageId ?? null,
        });
        created.push(proposal);
        availablePendingSlots--;
      } catch (err) {
        dropped.push(`Role "${draft.roleSlug}": ${(err as Error).message}`);
      }
    }

    return { created, dropped };
  }

  public create(
    projectPath: string,
    input: {
      roleSlug: string;
      proposedName?: string;
      professionalTitle?: string;
      promptMarkdown?: string;
      justification: string;
      competencies?: string[];
      relatedTasks?: string[];
    },
  ): HiringProposal {
    const project = this.requireProject(projectPath);

    if (!input || typeof input !== "object") {
      throw new HiringProposalError("Invalid input object.", 400);
    }
    if (typeof input.roleSlug !== "string" || !input.roleSlug.trim()) {
      throw new HiringProposalError("roleSlug is required.", 400);
    }
    if (input.proposedName !== undefined && typeof input.proposedName !== "string") {
      throw new HiringProposalError("proposedName must be a string.", 400);
    }
    if (input.professionalTitle !== undefined && typeof input.professionalTitle !== "string") {
      throw new HiringProposalError("professionalTitle must be a string.", 400);
    }
    if (input.promptMarkdown !== undefined && typeof input.promptMarkdown !== "string") {
      throw new HiringProposalError("promptMarkdown must be a string.", 400);
    }
    if (input.competencies !== undefined && !Array.isArray(input.competencies)) {
      throw new HiringProposalError("competencies must be an array.", 400);
    }
    if (input.relatedTasks !== undefined && !Array.isArray(input.relatedTasks)) {
      throw new HiringProposalError("relatedTasks must be an array.", 400);
    }

    const role = this.catalog.getRole(input.roleSlug);

    const duplicate = this.checkActiveDuplicateEmployee(project.path, role.slug);
    if (duplicate) {
      throw new HiringProposalError(
        `An active employee (${duplicate.name}) with role "${role.slug}" already exists in this project.`,
        409,
      );
    }

    const existingPending = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM hiring_proposals WHERE project_path = ? AND catalog_role_slug = ? AND status = 'pending'`,
      )
      .get(project.path, role.slug);
    if (existingPending) {
      throw new HiringProposalError(
        `A pending hiring proposal for role "${role.slug}" already exists in this project.`,
        409,
      );
    }

    const pendingCount = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM hiring_proposals WHERE project_path = ? AND status = 'pending'`,
      )
      .get(project.path)?.n ?? 0;

    if (pendingCount >= HIRING_PROPOSAL_LIMITS.pendingPerProject) {
      throw new HiringProposalError("Pending hiring proposals limit reached for this project.", 409);
    }

    const justification = input.justification?.trim();
    if (!justification) {
      throw new HiringProposalError("Justification cannot be empty.", 400);
    }
    if (justification.length > HIRING_PROPOSAL_LIMITS.justification) {
      throw new HiringProposalError(`Justification exceeds maximum ${HIRING_PROPOSAL_LIMITS.justification} characters.`, 400);
    }

    const promptMarkdown = (input.promptMarkdown?.trim() || role.originalMarkdown).trim();
    if (!promptMarkdown) {
      throw new HiringProposalError("Prompt markdown cannot be empty.", 400);
    }
    const promptByteLen = Buffer.byteLength(promptMarkdown, "utf-8");
    if (promptByteLen > HIRING_PROPOSAL_LIMITS.promptBytes) {
      throw new HiringProposalError(
        `Prompt exceeds maximum allowed size of ${HIRING_PROPOSAL_LIMITS.promptBytes} bytes (got ${promptByteLen} bytes).`,
        413,
      );
    }

    let validatedTasks: string[] = [];
    if (input.relatedTasks && input.relatedTasks.length > 0) {
      const taskValidation = this.validateRelatedTasks(project.path, input.relatedTasks);
      if (taskValidation.error) {
        throw new HiringProposalError(taskValidation.error, 400);
      }
      validatedTasks = taskValidation.validTasks;
    }

    return this.insertProposalRow({
      projectPath: project.path,
      proposedName: input.proposedName?.trim() || role.name,
      professionalTitle: input.professionalTitle?.trim() || role.name,
      catalogRoleSlug: role.slug,
      templateSha256: role.sha256,
      promptMarkdown,
      justification,
      competencies: input.competencies || [],
      relatedTasks: validatedTasks,
      proposedByKind: "owner",
      proposedByEmployeeId: null,
      sourceMessageId: null,
    });
  }

  private insertProposalRow(params: {
    projectPath: string;
    proposedName: string;
    professionalTitle: string;
    catalogRoleSlug: string;
    templateSha256: string;
    promptMarkdown: string;
    justification: string;
    competencies: string[];
    relatedTasks: string[];
    proposedByKind: "owner" | "project-manager";
    proposedByEmployeeId: string | null;
    sourceMessageId: string | null;
  }): HiringProposal {
    const now = this.now();
    const id = randomUUID();

    this.write(() => {
      this.db
        .query(
          `INSERT INTO hiring_proposals (
            id, project_path, proposed_name, kind, professional_title, catalog_role_slug,
            template_sha256, prompt_markdown, justification, competencies, related_tasks,
            proposed_by_kind, proposed_by_employee_id, source_message_id, status, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
        )
        .run(
          id,
          params.projectPath,
          params.proposedName.slice(0, HIRING_PROPOSAL_LIMITS.name),
          params.professionalTitle.slice(0, HIRING_PROPOSAL_LIMITS.title),
          params.catalogRoleSlug,
          params.templateSha256,
          params.promptMarkdown,
          params.justification.slice(0, HIRING_PROPOSAL_LIMITS.justification),
          JSON.stringify(params.competencies.slice(0, HIRING_PROPOSAL_LIMITS.competencies)),
          JSON.stringify(params.relatedTasks.slice(0, HIRING_PROPOSAL_LIMITS.relatedTasks)),
          params.proposedByKind,
          params.proposedByEmployeeId,
          params.sourceMessageId,
          now,
          now,
        );

      this.db
        .query(
          `INSERT INTO hiring_proposal_events (
            proposal_id, project_path, action, actor, proposal_revision,
            created_employee_id, note, created_at
          ) VALUES (?, ?, 'created', ?, 1, NULL, ?, ?)`,
        )
        .run(
          id,
          params.projectPath,
          params.proposedByKind,
          params.proposedByKind === "owner" ? "Created by owner" : "Proposed by Project Manager",
          now,
        );
    });

    return this.requireProposal(id);
  }

  public approve(
    idInput: unknown,
    options: ApproveHiringProposalRequest,
  ): { proposal: HiringProposal; employee: Employee; alreadyApplied: boolean } {
    const id = this.validateUuid(idInput);
    if (!options || typeof options !== "object" || typeof options.expectedRevision !== "number") {
      throw new HiringProposalError("Invalid approve request: expectedRevision is required.", 400);
    }
    if (options.proposedName !== undefined && typeof options.proposedName !== "string") {
      throw new HiringProposalError("proposedName must be a string.", 400);
    }
    if (options.professionalTitle !== undefined && typeof options.professionalTitle !== "string") {
      throw new HiringProposalError("professionalTitle must be a string.", 400);
    }
    if (options.promptMarkdown !== undefined && typeof options.promptMarkdown !== "string") {
      throw new HiringProposalError("promptMarkdown must be a string.", 400);
    }
    if (options.changeNote !== undefined && typeof options.changeNote !== "string") {
      throw new HiringProposalError("changeNote must be a string.", 400);
    }

    const row = this.requireRow(id);

    // Idempotent retry / replay check
    if (row.status === "approved") {
      if (row.decided_from_revision === options.expectedRevision && row.created_employee_id) {
        // Contract for re-approval with different payload: reject with 409
        const payloadMatches =
          (options.proposedName === undefined || options.proposedName.trim() === row.proposed_name) &&
          (options.professionalTitle === undefined || options.professionalTitle.trim() === row.professional_title) &&
          (options.promptMarkdown === undefined || options.promptMarkdown.trim() === row.prompt_markdown);
        if (!payloadMatches) {
          throw new HiringProposalError("This proposal was already approved with different parameters.", 409);
        }
        const emp = this.getEmployee(row.created_employee_id);
        if (emp) {
          return { proposal: this.hydrate(row), employee: emp, alreadyApplied: true };
        }
      }
      throw new HiringProposalError("This proposal was already approved.", 409);
    }

    if (row.status !== "pending") {
      throw new HiringProposalError(`This proposal is ${row.status}.`, 409);
    }

    if (row.revision !== options.expectedRevision) {
      throw new HiringProposalError(
        `Stale revision conflict: expected revision ${options.expectedRevision}, but current revision is ${row.revision}.`,
        409,
      );
    }

    // Verify project exists and is active
    this.requireProject(row.project_path);

    // Verify template existence and SHA
    const role = this.catalog.getRole(row.catalog_role_slug);
    if (role.sha256 !== row.template_sha256) {
      throw new HiringProposalError(
        `Catalog SHA mismatch: proposal base template was ${row.template_sha256}, but catalog currently has ${role.sha256}.`,
        409,
      );
    }

    // Check duplicate employee in project before starting write transaction
    const dup = this.checkActiveDuplicateEmployee(row.project_path, row.catalog_role_slug);
    if (dup) {
      throw new HiringProposalError(
        `Duplicate hiring refused: an active employee (${dup.name}) with role "${row.catalog_role_slug}" is already hired in this project.`,
        409,
      );
    }

    const proposedName = (options.proposedName ?? row.proposed_name).trim().slice(0, HIRING_PROPOSAL_LIMITS.name);
    if (!proposedName) {
      throw new HiringProposalError("Proposed employee name cannot be empty.", 400);
    }

    const professionalTitle = (options.professionalTitle ?? row.professional_title).trim().slice(0, HIRING_PROPOSAL_LIMITS.title);
    if (!professionalTitle) {
      throw new HiringProposalError("Professional title cannot be empty.", 400);
    }

    const promptMarkdown = (options.promptMarkdown ?? row.prompt_markdown).trim();
    if (!promptMarkdown) {
      throw new HiringProposalError("Prompt markdown cannot be empty.", 400);
    }
    const promptByteLen = Buffer.byteLength(promptMarkdown, "utf-8");
    if (promptByteLen > HIRING_PROPOSAL_LIMITS.promptBytes) {
      throw new HiringProposalError(
        `Prompt exceeds maximum allowed size of ${HIRING_PROPOSAL_LIMITS.promptBytes} bytes (got ${promptByteLen} bytes).`,
        413,
      );
    }

    const now = this.now();
    const newEmployeeId = randomUUID();
    const nextRevision = row.revision + 1;
    const changeNote = options.changeNote || "Approved by owner";
    const promptSha256 = createHash("sha256").update(promptMarkdown).digest("hex");
    const revId = randomUUID();

    this.write(() => {
      // Re-fetch inside write transaction boundary to guard against concurrent interleaving
      const currentRow = this.requireRow(id);
      if (currentRow.status !== "pending") {
        throw new HiringProposalError(`This proposal is ${currentRow.status}.`, 409);
      }
      if (currentRow.revision !== options.expectedRevision) {
        throw new HiringProposalError("Concurrent modification conflict. Refresh and try again.", 409);
      }

      // Re-check active duplicate employee inside write transaction boundary to prevent duplicate hires across SQLite connections
      const dupInside = this.checkActiveDuplicateEmployee(row.project_path, row.catalog_role_slug);
      if (dupInside) {
        throw new HiringProposalError(
          `Duplicate hiring refused: an active employee (${dupInside.name}) with role "${row.catalog_role_slug}" is already hired in this project.`,
          409,
        );
      }

      // 1. CAS update on proposal to ensure no concurrent approval races
      const updateResult = this.db
        .query(
          `UPDATE hiring_proposals
              SET status = 'approved',
                  revision = ?,
                  proposed_name = ?,
                  professional_title = ?,
                  prompt_markdown = ?,
                  created_employee_id = ?,
                  decided_at = ?,
                  decided_from_revision = ?,
                  decision_note = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(
          nextRevision,
          proposedName,
          professionalTitle,
          promptMarkdown,
          newEmployeeId,
          now,
          options.expectedRevision,
          changeNote,
          now,
          id,
          options.expectedRevision,
        );

      if (updateResult.changes !== 1) {
        throw new HiringProposalError("Concurrent modification conflict. Refresh and try again.", 409);
      }

      // 2. Insert into ai_employees using exact standard schema
      this.db
        .query(
          `INSERT INTO ai_employees (
            id, kind, name, name_source, job_title, role_category, specializations,
            project_path, department, description, notes, status, created_at, updated_at
          ) VALUES (?, 'worker', ?, 'owner', ?, ?, '[]', ?, NULL, ?, NULL, 'active', ?, ?)`,
        )
        .run(
          newEmployeeId,
          proposedName,
          professionalTitle,
          role.division,
          row.project_path,
          `Hired from role catalog: ${role.name}`,
          now,
          now,
        );

      // 3. Insert ai_employee_events
      this.db
        .query(
          `INSERT INTO ai_employee_events (
            employee_id, action, changes, created_at
          ) VALUES (?, 'create', ?, ?)`,
        )
        .run(
          newEmployeeId,
          JSON.stringify({
            name: { from: null, to: proposedName },
            kind: { from: null, to: "worker" },
            jobTitle: { from: null, to: professionalTitle },
            projectPath: { from: null, to: row.project_path },
            hiringProposalId: { from: null, to: id },
          }),
          now,
        );

      // 4. Insert professional profile revision 1
      this.db
        .query(
          `INSERT INTO ai_employee_profile_revisions (
            id, employee_id, revision, catalog_role_slug, professional_title, division,
            prompt_markdown, prompt_sha256, owner_provenance, change_note, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'owner', ?, ?)`,
        )
        .run(
          revId,
          newEmployeeId,
          role.slug,
          professionalTitle,
          role.division,
          promptMarkdown,
          promptSha256,
          changeNote,
          now,
        );

      // 5. Insert active professional profile
      this.db
        .query(
          `INSERT INTO ai_employee_professional_profiles (
            employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(newEmployeeId, role.slug, professionalTitle, role.division, now, now);

      // 6. Insert hiring proposal event
      this.db
        .query(
          `INSERT INTO hiring_proposal_events (
            proposal_id, project_path, action, actor, proposal_revision,
            created_employee_id, note, created_at
          ) VALUES (?, ?, 'approved', 'owner', ?, ?, ?, ?)`,
        )
        .run(id, row.project_path, nextRevision, newEmployeeId, changeNote, now);

      // 7. Record in Company Activity Journal
      new ActivityJournalCore(this.db).record({
        eventType: "employee.hired",
        projectPath: row.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "employee",
        targetId: newEmployeeId,
        employeeId: newEmployeeId,
        idempotencyKey: `hiring_proposal:${id}:approved`,
        payload: {
          proposalId: id,
          employeeId: newEmployeeId,
          employeeName: proposedName,
          jobTitle: professionalTitle,
          roleCategory: role.division,
          catalogRoleSlug: role.slug,
          projectPath: row.project_path,
        },
        createdAt: now,
      });
    });

    const employee = this.getEmployee(newEmployeeId)!;
    return { proposal: this.requireProposal(id), employee, alreadyApplied: false };
  }

  public reject(
    idInput: unknown,
    options: RejectHiringProposalRequest,
  ): { proposal: HiringProposal; alreadyApplied: boolean } {
    const id = this.validateUuid(idInput);
    if (!options || typeof options !== "object" || typeof options.expectedRevision !== "number") {
      throw new HiringProposalError("Invalid reject request: expectedRevision is required.", 400);
    }
    if (options.note !== undefined && typeof options.note !== "string") {
      throw new HiringProposalError("note must be a string.", 400);
    }

    const row = this.requireRow(id);

    if (row.status === "rejected") {
      if (row.decided_from_revision === options.expectedRevision) {
        return { proposal: this.hydrate(row), alreadyApplied: true };
      }
      throw new HiringProposalError("This proposal was already rejected.", 409);
    }

    if (row.status !== "pending") {
      throw new HiringProposalError(`This proposal is ${row.status}.`, 409);
    }

    if (row.revision !== options.expectedRevision) {
      throw new HiringProposalError(
        `Stale revision conflict: expected revision ${options.expectedRevision}, but current revision is ${row.revision}.`,
        409,
      );
    }

    const now = this.now();
    const nextRevision = row.revision + 1;
    const note = options.note || "Rejected by owner";

    this.write(() => {
      const updateResult = this.db
        .query(
          `UPDATE hiring_proposals
              SET status = 'rejected',
                  revision = ?,
                  decided_at = ?,
                  decided_from_revision = ?,
                  decision_note = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(nextRevision, now, options.expectedRevision, note, now, id, options.expectedRevision);

      if (updateResult.changes !== 1) {
        throw new HiringProposalError("Concurrent modification conflict. Refresh and try again.", 409);
      }

      this.db
        .query(
          `INSERT INTO hiring_proposal_events (
            proposal_id, project_path, action, actor, proposal_revision,
            created_employee_id, note, created_at
          ) VALUES (?, ?, 'rejected', 'owner', ?, NULL, ?, ?)`,
        )
        .run(id, row.project_path, nextRevision, note, now);
    });

    return { proposal: this.requireProposal(id), alreadyApplied: false };
  }

  public update(idInput: unknown, options: UpdateHiringProposalRequest): { proposal: HiringProposal } {
    const id = this.validateUuid(idInput);
    if (!options || typeof options !== "object" || typeof options.expectedRevision !== "number") {
      throw new HiringProposalError("Invalid update request: expectedRevision is required.", 400);
    }
    if (options.proposedName !== undefined && typeof options.proposedName !== "string") {
      throw new HiringProposalError("proposedName must be a string.", 400);
    }
    if (options.professionalTitle !== undefined && typeof options.professionalTitle !== "string") {
      throw new HiringProposalError("professionalTitle must be a string.", 400);
    }
    if (options.promptMarkdown !== undefined && typeof options.promptMarkdown !== "string") {
      throw new HiringProposalError("promptMarkdown must be a string.", 400);
    }
    if (options.justification !== undefined && typeof options.justification !== "string") {
      throw new HiringProposalError("justification must be a string.", 400);
    }
    if (options.competencies !== undefined && !Array.isArray(options.competencies)) {
      throw new HiringProposalError("competencies must be an array.", 400);
    }
    if (options.relatedTasks !== undefined && !Array.isArray(options.relatedTasks)) {
      throw new HiringProposalError("relatedTasks must be an array.", 400);
    }
    if (options.changeNote !== undefined && typeof options.changeNote !== "string") {
      throw new HiringProposalError("changeNote must be a string.", 400);
    }

    const row = this.requireRow(id);

    if (row.status !== "pending") {
      throw new HiringProposalError(`Cannot edit a proposal that is ${row.status}.`, 409);
    }

    if (row.revision !== options.expectedRevision) {
      throw new HiringProposalError(
        `Stale revision conflict: expected revision ${options.expectedRevision}, but current revision is ${row.revision}.`,
        409,
      );
    }

    const proposedName = options.proposedName !== undefined
      ? options.proposedName.trim().slice(0, HIRING_PROPOSAL_LIMITS.name)
      : row.proposed_name;
    if (!proposedName) {
      throw new HiringProposalError("Proposed employee name cannot be empty.", 400);
    }

    const professionalTitle = options.professionalTitle !== undefined
      ? options.professionalTitle.trim().slice(0, HIRING_PROPOSAL_LIMITS.title)
      : row.professional_title;
    if (!professionalTitle) {
      throw new HiringProposalError("Professional title cannot be empty.", 400);
    }

    const promptMarkdown = options.promptMarkdown !== undefined
      ? options.promptMarkdown.trim()
      : row.prompt_markdown;
    if (!promptMarkdown) {
      throw new HiringProposalError("Prompt markdown cannot be empty.", 400);
    }
    const promptByteLen = Buffer.byteLength(promptMarkdown, "utf-8");
    if (promptByteLen > HIRING_PROPOSAL_LIMITS.promptBytes) {
      throw new HiringProposalError(
        `Prompt exceeds maximum allowed size of ${HIRING_PROPOSAL_LIMITS.promptBytes} bytes (got ${promptByteLen} bytes).`,
        413,
      );
    }

    const justification = options.justification !== undefined
      ? options.justification.trim().slice(0, HIRING_PROPOSAL_LIMITS.justification)
      : row.justification;

    const competencies = options.competencies !== undefined
      ? JSON.stringify(options.competencies.slice(0, HIRING_PROPOSAL_LIMITS.competencies))
      : row.competencies;

    let relatedTasks = row.related_tasks;
    if (options.relatedTasks !== undefined) {
      const taskValidation = this.validateRelatedTasks(row.project_path, options.relatedTasks);
      if (taskValidation.error) {
        throw new HiringProposalError(taskValidation.error, 400);
      }
      relatedTasks = JSON.stringify(taskValidation.validTasks.slice(0, HIRING_PROPOSAL_LIMITS.relatedTasks));
    }

    const now = this.now();
    const nextRevision = row.revision + 1;
    const note = options.changeNote || "Edited by owner before approval";

    this.write(() => {
      const updateResult = this.db
        .query(
          `UPDATE hiring_proposals
              SET revision = ?,
                  proposed_name = ?,
                  professional_title = ?,
                  prompt_markdown = ?,
                  justification = ?,
                  competencies = ?,
                  related_tasks = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(
          nextRevision,
          proposedName,
          professionalTitle,
          promptMarkdown,
          justification,
          competencies,
          relatedTasks,
          now,
          id,
          options.expectedRevision,
        );

      if (updateResult.changes !== 1) {
        throw new HiringProposalError("Concurrent modification conflict. Refresh and try again.", 409);
      }

      this.db
        .query(
          `INSERT INTO hiring_proposal_events (
            proposal_id, project_path, action, actor, proposal_revision,
            created_employee_id, note, created_at
          ) VALUES (?, ?, 'updated', 'owner', ?, NULL, ?, ?)`,
        )
        .run(id, row.project_path, nextRevision, note, now);
    });

    return { proposal: this.requireProposal(id) };
  }

  public withdraw(idInput: unknown, expectedRevision: number, note?: string): { proposal: HiringProposal } {
    const id = this.validateUuid(idInput);
    if (typeof expectedRevision !== "number") {
      throw new HiringProposalError("expectedRevision is required.", 400);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new HiringProposalError("note must be a string.", 400);
    }

    const row = this.requireRow(id);

    if (row.status !== "pending") {
      throw new HiringProposalError(`Cannot withdraw a proposal that is ${row.status}.`, 409);
    }

    if (row.revision !== expectedRevision) {
      throw new HiringProposalError(
        `Stale revision conflict: expected revision ${expectedRevision}, but current revision is ${row.revision}.`,
        409,
      );
    }

    const now = this.now();
    const nextRevision = row.revision + 1;
    const withdrawNote = note || "Withdrawn";

    this.write(() => {
      const updateResult = this.db
        .query(
          `UPDATE hiring_proposals
              SET status = 'withdrawn',
                  revision = ?,
                  decided_at = ?,
                  decided_from_revision = ?,
                  decision_note = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'pending' AND revision = ?`,
        )
        .run(nextRevision, now, expectedRevision, withdrawNote, now, id, expectedRevision);

      if (updateResult.changes !== 1) {
        throw new HiringProposalError("Concurrent modification conflict. Refresh and try again.", 409);
      }

      this.db
        .query(
          `INSERT INTO hiring_proposal_events (
            proposal_id, project_path, action, actor, proposal_revision,
            created_employee_id, note, created_at
          ) VALUES (?, ?, 'withdrawn', 'owner', ?, NULL, ?, ?)`,
        )
        .run(id, row.project_path, nextRevision, withdrawNote, now);
    });

    return { proposal: this.requireProposal(id) };
  }

  private getEmployee(id: string): Employee | null {
    try {
      return new EmployeeCore(this.db).get(id);
    } catch {
      return null;
    }
  }
}
