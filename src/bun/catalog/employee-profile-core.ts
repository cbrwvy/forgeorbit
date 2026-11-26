/**
 * Employee Professional Profile Core (FO-014B).
 *
 * Manages employee professional role assignments, prompt customization,
 * optimistic revision checks, and append-only revision histories in SQLite.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  AssignProfessionalRoleRequest,
  EmployeeProfessionalProfile,
  EmployeePromptRevision,
  EmployeePromptRevisionSummary,
  UpdateProfessionalPromptRequest,
} from "../../shared/employees/profile-types.ts";
import { MAX_PROMPT_BYTES } from "../../shared/employees/profile-types.ts";
import { RoleCatalogService, getRoleCatalogService } from "./role-catalog.ts";

export class EmployeeProfileError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "EmployeeProfileError";
  }
}

export interface EmployeeProfileCoreDeps {
  catalog?: RoleCatalogService;
  now?: () => number;
}

interface ProfileRow {
  employee_id: string;
  catalog_role_slug: string;
  professional_title: string;
  division: string;
  current_revision: number;
  created_at: number;
  updated_at: number;
}

interface RevisionRow {
  id: string;
  employee_id: string;
  revision: number;
  catalog_role_slug: string;
  professional_title: string;
  division: string;
  prompt_markdown: string;
  prompt_sha256: string;
  owner_provenance: "owner" | "system";
  change_note: string | null;
  created_at: number;
}

export class EmployeeProfileCore {
  private readonly catalog: RoleCatalogService;
  private readonly now: () => number;

  constructor(private readonly db: Database, deps: EmployeeProfileCoreDeps = {}) {
    this.catalog = deps.catalog ?? getRoleCatalogService();
    this.now = deps.now ?? (() => Date.now());
  }

  private ensureEmployeeExists(employeeId: string): void {
    if (!employeeId || typeof employeeId !== "string") {
      throw new EmployeeProfileError("Invalid employee ID.", 400);
    }
    const row = this.db.query("SELECT id FROM ai_employees WHERE id = ?").get(employeeId);
    if (!row) {
      throw new EmployeeProfileError("Employee not found.", 404);
    }
  }

  private hashPrompt(prompt: string): string {
    return createHash("sha256").update(prompt, "utf-8").digest("hex");
  }

  private write<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn).immediate();
    } catch (error) {
      if (error instanceof EmployeeProfileError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        throw new EmployeeProfileError("Database busy, please retry.", 409);
      }
      throw error;
    }
  }

  public getProfile(employeeId: string): EmployeeProfessionalProfile | null {
    this.ensureEmployeeExists(employeeId);

    const profileRow = this.db
      .query("SELECT * FROM ai_employee_professional_profiles WHERE employee_id = ?")
      .get(employeeId) as ProfileRow | null;

    if (!profileRow) return null;

    const revisionRow = this.db
      .query("SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = ?")
      .get(employeeId, profileRow.current_revision) as RevisionRow | null;

    if (!revisionRow) {
      throw new EmployeeProfileError(`Missing revision record for active revision ${profileRow.current_revision}`, 500);
    }

    let template = null;
    try {
      const fullTemplate = this.catalog.getRole(profileRow.catalog_role_slug);
      template = {
        slug: fullTemplate.slug,
        name: fullTemplate.name,
        description: fullTemplate.description,
        division: fullTemplate.division,
        color: fullTemplate.color,
        emoji: fullTemplate.emoji,
        vibe: fullTemplate.vibe,
        sourcePath: fullTemplate.sourcePath,
        sourceCommit: fullTemplate.sourceCommit,
        sha256: fullTemplate.sha256,
        sizeBytes: fullTemplate.sizeBytes,
      };
    } catch {
      // Template missing from catalog (unlikely, but handled safely)
    }

    const activePrompt: EmployeePromptRevision = {
      id: revisionRow.id,
      employeeId: revisionRow.employee_id,
      revision: revisionRow.revision,
      catalogRoleSlug: revisionRow.catalog_role_slug,
      professionalTitle: revisionRow.professional_title,
      division: revisionRow.division,
      promptMarkdown: revisionRow.prompt_markdown,
      promptSha256: revisionRow.prompt_sha256,
      ownerProvenance: revisionRow.owner_provenance,
      changeNote: revisionRow.change_note,
      createdAt: revisionRow.created_at,
    };

    return {
      employeeId: profileRow.employee_id,
      catalogRoleSlug: profileRow.catalog_role_slug,
      professionalTitle: profileRow.professional_title,
      division: profileRow.division,
      currentRevision: profileRow.current_revision,
      createdAt: profileRow.created_at,
      updatedAt: profileRow.updated_at,
      activePrompt,
      template,
    };
  }

  public assignRole(
    employeeId: string,
    req: AssignProfessionalRoleRequest,
    actor: "owner" | "system" = "owner",
  ): EmployeeProfessionalProfile {
    this.ensureEmployeeExists(employeeId);

    if (!req || typeof req !== "object" || Array.isArray(req)) {
      throw new EmployeeProfileError("Invalid request body.", 400);
    }

    if (typeof req.catalogRoleSlug !== "string" || !req.catalogRoleSlug.trim()) {
      throw new EmployeeProfileError("catalogRoleSlug is required and must be a non-empty string.", 400);
    }

    if (req.professionalTitle !== undefined && typeof req.professionalTitle !== "string") {
      throw new EmployeeProfileError("professionalTitle must be a string.", 400);
    }

    if (req.promptMarkdown !== undefined && typeof req.promptMarkdown !== "string") {
      throw new EmployeeProfileError("promptMarkdown must be a string.", 400);
    }

    if (req.changeNote !== undefined && typeof req.changeNote !== "string") {
      throw new EmployeeProfileError("changeNote must be a string.", 400);
    }

    if (req.expectedRevision !== undefined && (typeof req.expectedRevision !== "number" || !Number.isInteger(req.expectedRevision))) {
      throw new EmployeeProfileError("expectedRevision must be an integer.", 400);
    }

    let role;
    try {
      role = this.catalog.getRole(req.catalogRoleSlug.trim());
    } catch (err) {
      if (err instanceof Error) {
        throw new EmployeeProfileError(err.message, 400);
      }
      throw err;
    }

    let professionalTitle = role.name;
    if (req.professionalTitle !== undefined) {
      const trimmedTitle = req.professionalTitle.trim();
      if (!trimmedTitle) {
        throw new EmployeeProfileError("Professional title cannot be empty.", 400);
      }
      if (trimmedTitle.length > 120) {
        throw new EmployeeProfileError("Professional title exceeds 120 characters.", 400);
      }
      professionalTitle = trimmedTitle;
    }

    const promptMarkdown = (req.promptMarkdown !== undefined && req.promptMarkdown !== null
      ? req.promptMarkdown
      : role.originalMarkdown
    ).trim();

    if (!promptMarkdown) {
      throw new EmployeeProfileError("Prompt markdown cannot be empty.", 400);
    }

    const promptByteLen = Buffer.byteLength(promptMarkdown, "utf-8");
    if (promptByteLen > MAX_PROMPT_BYTES) {
      throw new EmployeeProfileError(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes.`, 413);
    }

    const promptSha256 = this.hashPrompt(promptMarkdown);
    const now = this.now();

    return this.write(() => {
      const existing = this.db
        .query("SELECT * FROM ai_employee_professional_profiles WHERE employee_id = ?")
        .get(employeeId) as ProfileRow | null;

      let newRevision = 1;

      if (existing) {
        // Enforce mandatory revision precondition for reassigning an existing profile (INT01-05)
        if (req.expectedRevision === undefined || typeof req.expectedRevision !== "number") {
          throw new EmployeeProfileError("expectedRevision is required when reassigning an existing professional profile.", 400);
        }

        if (req.expectedRevision !== existing.current_revision) {
          throw new EmployeeProfileError(
            `Stale revision conflict: current revision is ${existing.current_revision}, but expected ${req.expectedRevision}.`,
            409,
          );
        }

        // Check for identical assignment (same role, title, and prompt sha256)
        const currentRev = this.db
          .query("SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = ?")
          .get(employeeId, existing.current_revision) as RevisionRow | null;

        if (
          currentRev &&
          existing.catalog_role_slug === role.slug &&
          existing.professional_title === professionalTitle &&
          currentRev.prompt_sha256 === promptSha256
        ) {
          // Idempotent: return existing profile without creating duplicate revision
          return this.getProfile(employeeId)!;
        }

        newRevision = existing.current_revision + 1;
      } else {
        if (req.expectedRevision !== undefined && req.expectedRevision !== 0) {
          throw new EmployeeProfileError(
            `Stale revision conflict: profile does not exist yet, but expected revision was ${req.expectedRevision}.`,
            409,
          );
        }
      }

      const revId = randomUUID();
      const note = req.changeNote || (newRevision === 1 ? "Assigned from catalog" : "Changed catalog profession");

      this.db
        .query(
          `INSERT INTO ai_employee_profile_revisions (
            id, employee_id, revision, catalog_role_slug, professional_title, division,
            prompt_markdown, prompt_sha256, owner_provenance, change_note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revId,
          employeeId,
          newRevision,
          role.slug,
          professionalTitle,
          role.division,
          promptMarkdown,
          promptSha256,
          actor,
          note,
          now,
        );

      if (existing) {
        const updateRes = this.db
          .query(
            `UPDATE ai_employee_professional_profiles
             SET catalog_role_slug = ?, professional_title = ?, division = ?, current_revision = ?, updated_at = ?
             WHERE employee_id = ? AND current_revision = ?`,
          )
          .run(role.slug, professionalTitle, role.division, newRevision, now, employeeId, existing.current_revision);

        if (updateRes.changes === 0) {
          throw new EmployeeProfileError("Concurrent modification conflict.", 409);
        }
      } else {
        this.db
          .query(
            `INSERT INTO ai_employee_professional_profiles (
              employee_id, catalog_role_slug, professional_title, division, current_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(employeeId, role.slug, professionalTitle, role.division, newRevision, now, now);
      }

      return this.getProfile(employeeId)!;
    });
  }

  public updatePrompt(
    employeeId: string,
    req: UpdateProfessionalPromptRequest,
    actor: "owner" | "system" = "owner",
  ): EmployeeProfessionalProfile {
    this.ensureEmployeeExists(employeeId);

    if (!req || typeof req !== "object" || Array.isArray(req)) {
      throw new EmployeeProfileError("Invalid request body.", 400);
    }

    if (req.expectedRevision === undefined || typeof req.expectedRevision !== "number" || !Number.isInteger(req.expectedRevision)) {
      throw new EmployeeProfileError("expectedRevision is required and must be an integer.", 400);
    }

    if (req.promptMarkdown === undefined || typeof req.promptMarkdown !== "string") {
      throw new EmployeeProfileError("promptMarkdown is required and must be a string.", 400);
    }

    if (req.changeNote !== undefined && typeof req.changeNote !== "string") {
      throw new EmployeeProfileError("changeNote must be a string.", 400);
    }

    const promptMarkdown = req.promptMarkdown.trim();
    if (!promptMarkdown) {
      throw new EmployeeProfileError("Prompt markdown cannot be empty.", 400);
    }

    const promptByteLen = Buffer.byteLength(promptMarkdown, "utf-8");
    if (promptByteLen > MAX_PROMPT_BYTES) {
      throw new EmployeeProfileError(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes.`, 413);
    }

    const promptSha256 = this.hashPrompt(promptMarkdown);
    const now = this.now();

    return this.write(() => {
      const existing = this.db
        .query("SELECT * FROM ai_employee_professional_profiles WHERE employee_id = ?")
        .get(employeeId) as ProfileRow | null;

      if (!existing) {
        throw new EmployeeProfileError("Employee does not have a professional profile assigned.", 404);
      }

      if (req.expectedRevision !== existing.current_revision) {
        throw new EmployeeProfileError(
          `Stale revision conflict: current revision is ${existing.current_revision}, but expected ${req.expectedRevision}.`,
          409,
        );
      }

      // Check if new prompt is bit-identical to the active revision
      const currentRev = this.db
        .query("SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = ?")
        .get(employeeId, existing.current_revision) as RevisionRow | null;

      if (currentRev && currentRev.prompt_sha256 === promptSha256) {
        // Idempotent: return without creating duplicate revision
        return this.getProfile(employeeId)!;
      }

      const newRevision = existing.current_revision + 1;
      const revId = randomUUID();
      const note = req.changeNote || "Updated prompt instructions";

      this.db
        .query(
          `INSERT INTO ai_employee_profile_revisions (
            id, employee_id, revision, catalog_role_slug, professional_title, division,
            prompt_markdown, prompt_sha256, owner_provenance, change_note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revId,
          employeeId,
          newRevision,
          existing.catalog_role_slug,
          existing.professional_title,
          existing.division,
          promptMarkdown,
          promptSha256,
          actor,
          note,
          now,
        );

      const updateRes = this.db
        .query(
          `UPDATE ai_employee_professional_profiles
           SET current_revision = ?, updated_at = ?
           WHERE employee_id = ? AND current_revision = ?`,
        )
        .run(newRevision, now, employeeId, existing.current_revision);

      if (updateRes.changes === 0) {
        throw new EmployeeProfileError("Concurrent modification conflict.", 409);
      }

      return this.getProfile(employeeId)!;
    });
  }

  public resetToTemplate(
    employeeId: string,
    expectedRevision: number,
    actor: "owner" | "system" = "owner",
  ): EmployeeProfessionalProfile {
    this.ensureEmployeeExists(employeeId);

    if (expectedRevision === undefined || typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
      throw new EmployeeProfileError("expectedRevision is required and must be an integer.", 400);
    }

    const now = this.now();

    return this.write(() => {
      const existing = this.db
        .query("SELECT * FROM ai_employee_professional_profiles WHERE employee_id = ?")
        .get(employeeId) as ProfileRow | null;

      if (!existing) {
        throw new EmployeeProfileError("Employee does not have a professional profile assigned.", 404);
      }

      if (expectedRevision !== existing.current_revision) {
        throw new EmployeeProfileError(
          `Stale revision conflict: current revision is ${existing.current_revision}, but expected ${expectedRevision}.`,
          409,
        );
      }

      const role = this.catalog.getRole(existing.catalog_role_slug);
      const originalMarkdown = role.originalMarkdown.trim();
      const promptSha256 = this.hashPrompt(originalMarkdown);

      // If already identical to original template
      const currentRev = this.db
        .query("SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = ?")
        .get(employeeId, existing.current_revision) as RevisionRow | null;

      if (currentRev && currentRev.prompt_sha256 === promptSha256) {
        return this.getProfile(employeeId)!;
      }

      const newRevision = existing.current_revision + 1;
      const revId = randomUUID();
      const note = "Restored from original catalog template";

      this.db
        .query(
          `INSERT INTO ai_employee_profile_revisions (
            id, employee_id, revision, catalog_role_slug, professional_title, division,
            prompt_markdown, prompt_sha256, owner_provenance, change_note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revId,
          employeeId,
          newRevision,
          existing.catalog_role_slug,
          existing.professional_title,
          existing.division,
          originalMarkdown,
          promptSha256,
          actor,
          note,
          now,
        );

      const updateRes = this.db
        .query(
          `UPDATE ai_employee_professional_profiles
           SET current_revision = ?, updated_at = ?
           WHERE employee_id = ? AND current_revision = ?`,
        )
        .run(newRevision, now, employeeId, existing.current_revision);

      if (updateRes.changes === 0) {
        throw new EmployeeProfileError("Concurrent modification conflict.", 409);
      }

      return this.getProfile(employeeId)!;
    });
  }

  public listRevisions(employeeId: string): EmployeePromptRevisionSummary[] {
    this.ensureEmployeeExists(employeeId);

    const rows = this.db
      .query(
        `SELECT id, employee_id, revision, catalog_role_slug, professional_title, division,
                prompt_sha256, owner_provenance, change_note, created_at
         FROM ai_employee_profile_revisions
         WHERE employee_id = ?
         ORDER BY revision DESC`,
      )
      .all(employeeId) as RevisionRow[];

    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      revision: r.revision,
      catalogRoleSlug: r.catalog_role_slug,
      professionalTitle: r.professional_title,
      division: r.division,
      promptSha256: r.prompt_sha256,
      ownerProvenance: r.owner_provenance,
      changeNote: r.change_note,
      createdAt: r.created_at,
    }));
  }

  public getRevision(employeeId: string, revisionNumber: number): EmployeePromptRevision {
    this.ensureEmployeeExists(employeeId);

    const row = this.db
      .query("SELECT * FROM ai_employee_profile_revisions WHERE employee_id = ? AND revision = ?")
      .get(employeeId, revisionNumber) as RevisionRow | null;

    if (!row) {
      throw new EmployeeProfileError(`Revision ${revisionNumber} not found for employee.`, 404);
    }

    return {
      id: row.id,
      employeeId: row.employee_id,
      revision: row.revision,
      catalogRoleSlug: row.catalog_role_slug,
      professionalTitle: row.professional_title,
      division: row.division,
      promptMarkdown: row.prompt_markdown,
      promptSha256: row.prompt_sha256,
      ownerProvenance: row.owner_provenance,
      changeNote: row.change_note,
      createdAt: row.created_at,
    };
  }
}
