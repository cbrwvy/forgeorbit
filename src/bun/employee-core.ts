/**
 * AI employee identity and organization core (FO-010A).
 *
 * Organizational writes only: employee rows and an append-only history.
 * Nothing here starts, stops, or configures an agent, touches an account or
 * model, creates a task, or changes a project, cluster, or manager. Moving,
 * unassigning, archiving, or pausing a worker who still has task assignments
 * is refused; those assignments are not transferred or deleted. Reading
 * never draws a name or creates a row. A project is identified by its
 * registered path in the existing project registry.
 */

import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { ClusterCore } from "./cluster-core.ts";
import { generateEmployeeName } from "../shared/employees/names.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";
import { ACTIVE_TASK_ASSIGNMENT_GUARD } from "../shared/assignments/types.ts";
import { FORGEORBIT_COMPANY, type Cluster } from "../shared/clusters/types.ts";
import {
  EMPLOYEE_AUTHORITY,
  EMPLOYEE_KINDS,
  EMPLOYEE_LIMITS,
  EMPLOYEE_RUNTIME_BINDING,
  EMPLOYEE_STATUSES,
  OWNER_NODE,
  POSITION_DEFAULTS,
  ROLE_CATEGORIES,
  type Employee,
  type EmployeeDetails,
  type EmployeeEvent,
  type EmployeeEventAction,
  type EmployeeField,
  type EmployeeKind,
  type EmployeeNameSource,
  type EmployeeStatus,
  type OrganizationTree,
  type ProjectTeam,
  type RoleCategory,
} from "../shared/employees/types.ts";

export class EmployeeCoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "EmployeeCoreError";
  }
}

export interface EmployeeCoreOptions {
  now?: () => number;
  /** Returns a number in [0, 1). Injectable so name draws are testable. */
  random?: () => number;
  pathExists?: (path: string) => boolean;
  realpath?: (path: string) => string | null;
}

interface EmployeeRow {
  id: string;
  kind: EmployeeKind;
  name: string;
  name_source: EmployeeNameSource;
  display_name: string | null;
  job_title: string;
  role_category: RoleCategory;
  specializations: string;
  project_path: string | null;
  department: string | null;
  description: string;
  notes: string | null;
  status: EmployeeStatus;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface ProjectRow {
  path: string;
  name: string;
  added_at: number;
}

interface EventRow {
  id: number;
  employee_id: string;
  action: EmployeeEventAction;
  changes: string;
  created_at: number;
}

type Changes = Partial<Record<EmployeeField, { from: unknown; to: unknown }>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const WORKER_CREATE_KEYS = ["name", "displayName", "jobTitle", "roleCategory", "specializations", "projectPath", "department", "description", "notes"] as const;
const UPDATE_KEYS = ["name", "displayName", "jobTitle", "roleCategory", "specializations", "department", "description", "notes", "status"] as const;
const POSITION_KEYS = ["name", "displayName", "description", "notes"] as const;

function fail(message: string, status = 400): never {
  throw new EmployeeCoreError(message, status);
}

export class EmployeeCore {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pathExists: (path: string) => boolean;
  private readonly realpath: (path: string) => string | null;

  constructor(private readonly db: Database, options: EmployeeCoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.realpath = options.realpath ?? defaultRealpath;
  }

  // ----- reads (never write, never draw a name) -----

  list(options: { projectPath?: unknown; kind?: unknown; status?: unknown; includeArchived?: boolean } = {}): Employee[] {
    const projectPath = options.projectPath == null ? null : this.resolveProject(options.projectPath).path;
    const kind = options.kind == null ? null : this.kindValue(options.kind);
    const status = options.status == null ? null : this.statusFilterValue(options.status);
    const rows = this.db.query<EmployeeRow, [string | null, string | null, string | null, string | null, number]>(
      `SELECT * FROM ai_employees
        WHERE (? IS NULL OR project_path = ?)
          AND (? IS NULL OR kind = ?)
          AND (? = 1 OR archived_at IS NULL)
        ORDER BY CASE kind WHEN 'head' THEN 0 WHEN 'project-manager' THEN 1 ELSE 2 END,
                 name COLLATE NOCASE, id`,
    ).all(projectPath, projectPath, kind, kind, options.includeArchived || status === "archived" ? 1 : 0);
    const filtered = status ? rows.filter((row) => row.status === status) : rows;
    return this.hydrate(filtered);
  }

  get(id: string): EmployeeDetails {
    const employee = this.requireEmployee(id);
    const history = this.historyOf(id);
    return { ...employee, history: history.events, historyTruncated: history.truncated };
  }

  history(id: string): { events: EmployeeEvent[]; truncated: boolean } {
    this.requireEmployee(id);
    return this.historyOf(id);
  }

  head(): Employee | null {
    const row = this.db.query<EmployeeRow, []>(`SELECT * FROM ai_employees WHERE kind = 'head' AND archived_at IS NULL`).get();
    return row ? this.hydrate([row])[0]! : null;
  }

  projectManager(projectPath: unknown): { projectPath: string; projectName: string; projectManager: Employee | null } {
    const project = this.resolveProject(projectPath);
    const row = this.activeManagerRow(project.path);
    return { projectPath: project.path, projectName: project.name, projectManager: row ? this.hydrate([row])[0]! : null };
  }

  projectTeam(projectPath: unknown): ProjectTeam {
    const project = this.resolveProject(projectPath);
    return this.buildTeam(project, this.activeRows());
  }

  organization(): OrganizationTree {
    const clusters = new ClusterCore(this.db, { now: this.now, pathExists: this.pathExists, realpath: this.realpath });
    const rows = this.activeRows();
    const hydrated = new Map(this.hydrate(rows).map((employee) => [employee.id, employee]));
    const employees = (matching: EmployeeRow[]) => matching.map((row) => hydrated.get(row.id)!);
    const projectRows = this.db.query<ProjectRow, []>(`SELECT path, name, added_at FROM projects`).all();
    const registered = new Set(projectRows.map((row) => row.path));
    const team = (path: string, name: string, pathMissing: boolean): ProjectTeam => {
      const mine = rows.filter((row) => row.project_path === path);
      const manager = mine.find((row) => row.kind === "project-manager");
      return {
        projectPath: path,
        projectName: name,
        pathMissing,
        projectManager: manager ? hydrated.get(manager.id)! : null,
        employees: employees(mine.filter((row) => row.kind === "worker")),
      };
    };
    const tree: OrganizationTree["clusters"] = clusters.list({ includeArchived: true }).map((cluster: Cluster) => ({
      cluster,
      projects: clusters.listProjects(cluster.id).map((project) => team(project.projectPath, project.name, project.pathMissing)),
    }));
    return {
      company: { id: FORGEORBIT_COMPANY.id, name: FORGEORBIT_COMPANY.name },
      owner: OWNER_NODE,
      head: this.head(),
      clusters: tree,
      unclusteredProjects: clusters.listUnassigned().map((project) => team(project.projectPath, project.name, project.pathMissing)),
      unassignedEmployees: employees(rows.filter((row) => row.kind === "worker" && row.project_path === null)),
      detachedEmployees: employees(rows.filter((row) => row.project_path !== null && !registered.has(row.project_path))),
    };
  }

  // ----- writes -----

  /** Create or update the one global Head. The owner names it; no name is drawn. */
  setHead(input: unknown): { employee: Employee; created: boolean } {
    const value = object(input, POSITION_KEYS);
    const existing = this.db.query<EmployeeRow, []>(`SELECT * FROM ai_employees WHERE kind = 'head' AND archived_at IS NULL`).get();
    if (existing) {
      if (Object.keys(value).length === 0) fail("No fields to update.");
      return { employee: this.update(existing.id, value), created: false };
    }
    if (value.name === undefined) fail("The owner names the Head of Project Management.");
    const defaults = POSITION_DEFAULTS.head;
    const id = this.insert({
      kind: "head",
      name: this.nameValue(value.name),
      nameSource: "owner",
      displayName: this.optionalText(value.displayName, "displayName", EMPLOYEE_LIMITS.displayName),
      jobTitle: defaults.jobTitle,
      roleCategory: defaults.roleCategory,
      specializations: [],
      projectPath: null,
      department: null,
      description: value.description === undefined ? "" : this.descriptionValue(value.description),
      notes: this.optionalNotes(value.notes),
      action: "create",
    });
    return { employee: this.requireEmployee(id), created: true };
  }

  /**
   * Idempotent. Returns the active manager identity of a registered project,
   * creating it only when there is none. A name is drawn once, here.
   */
  ensureProjectManager(projectPath: unknown, input: unknown = {}): { employee: Employee; created: boolean } {
    const project = this.resolveProject(projectPath);
    const value = object(input ?? {}, POSITION_KEYS);
    const existing = this.activeManagerRow(project.path);
    if (existing) return { employee: this.hydrate([existing])[0]!, created: false };
    return { employee: this.requireEmployee(this.insertManager(project.path, value, "create")), created: true };
  }

  /**
   * Give an identity to every registered project that already has a manager
   * configuration and no active manager identity. Existing chats, proposals,
   * decisions, and executions are not touched or re-attributed.
   */
  initializeExistingProjectManagers(): { created: Employee[]; alreadyInitialized: number } {
    const rows = this.db.query<{ project_path: string }, []>(
      `SELECT m.project_path
         FROM project_managers m
         JOIN projects p ON p.path = m.project_path
        ORDER BY p.added_at, p.path`,
    ).all();
    const created: string[] = [];
    let already = 0;
    this.write(() => {
      for (const row of rows) {
        if (this.activeManagerRow(row.project_path)) {
          already += 1;
          continue;
        }
        created.push(this.insertManager(row.project_path, {}, "initialize"));
      }
    });
    return { created: created.map((id) => this.requireEmployee(id)), alreadyInitialized: already };
  }

  createWorker(input: unknown): Employee {
    const value = object(input, WORKER_CREATE_KEYS);
    if (value.jobTitle === undefined) fail("Invalid jobTitle.");
    const project = value.projectPath == null ? null : this.resolveProject(value.projectPath);
    const generated = value.name === undefined;
    const id = this.insert({
      kind: "worker",
      name: generated ? this.drawName() : this.nameValue(value.name),
      nameSource: generated ? "generated" : "owner",
      displayName: this.optionalText(value.displayName, "displayName", EMPLOYEE_LIMITS.displayName),
      jobTitle: this.jobTitleValue(value.jobTitle),
      roleCategory: value.roleCategory === undefined ? "other" : this.roleCategoryValue(value.roleCategory),
      specializations: value.specializations === undefined ? [] : this.specializationsValue(value.specializations),
      projectPath: project?.path ?? null,
      department: this.optionalText(value.department, "department", EMPLOYEE_LIMITS.department),
      description: value.description === undefined ? "" : this.descriptionValue(value.description),
      notes: this.optionalNotes(value.notes),
      action: "create",
    });
    return this.requireEmployee(id);
  }

  /** Rename, retitle, change specializations or text fields, or pause. Identity and history stay. */
  update(id: string, input: unknown): Employee {
    const current = this.requireRow(id);
    const value = object(input, UPDATE_KEYS);
    if (Object.keys(value).length === 0) fail("No fields to update.");
    if (current.archived_at != null) fail("Employee is archived.", 409);
    if (value.roleCategory !== undefined && current.kind !== "worker") {
      fail("The role category of the Head and of a Project Manager is fixed by the position.", 409);
    }
    const next: Record<string, unknown> = {};
    if (value.name !== undefined) next.name = this.nameValue(value.name);
    if (value.displayName !== undefined) next.displayName = this.optionalText(value.displayName, "displayName", EMPLOYEE_LIMITS.displayName);
    if (value.jobTitle !== undefined) next.jobTitle = this.jobTitleValue(value.jobTitle);
    if (value.roleCategory !== undefined) next.roleCategory = this.roleCategoryValue(value.roleCategory);
    if (value.specializations !== undefined) next.specializations = this.specializationsValue(value.specializations);
    if (value.department !== undefined) next.department = this.optionalText(value.department, "department", EMPLOYEE_LIMITS.department);
    if (value.description !== undefined) next.description = this.descriptionValue(value.description);
    if (value.notes !== undefined) next.notes = this.optionalNotes(value.notes);
    if (value.status !== undefined) next.status = this.activeStatusValue(value.status);

    const before = this.fieldsOf(current);
    const changes: Changes = {};
    for (const [field, to] of Object.entries(next) as [EmployeeField, unknown][]) {
      if (!sameValue(before[field], to)) changes[field] = { from: before[field], to };
    }
    if (Object.keys(changes).length === 0) return this.requireEmployee(id);
    const now = this.now();
    const renamed = changes.name !== undefined;
    this.write(() => {
      if (changes.status?.to === "inactive") {
        this.lockEmployeeRow(id);
        this.refuseActiveTaskAssignments(id);
      }
      this.db.run(
        `UPDATE ai_employees
            SET name = ?, name_source = ?, display_name = ?, job_title = ?, role_category = ?,
                specializations = ?, department = ?, description = ?, notes = ?, status = ?, updated_at = ?
          WHERE id = ?`,
        [
          (next.name as string | undefined) ?? current.name,
          renamed ? "owner" : current.name_source,
          next.displayName !== undefined ? (next.displayName as string | null) : current.display_name,
          (next.jobTitle as string | undefined) ?? current.job_title,
          (next.roleCategory as string | undefined) ?? current.role_category,
          JSON.stringify((next.specializations as string[] | undefined) ?? parseList(current.specializations)),
          next.department !== undefined ? (next.department as string | null) : current.department,
          (next.description as string | undefined) ?? current.description,
          next.notes !== undefined ? (next.notes as string | null) : current.notes,
          (next.status as string | undefined) ?? current.status,
          now,
          id,
        ],
      );
      this.insertEvent(id, Object.keys(changes).length === 1 && renamed ? "rename" : "update", changes, now);
    });
    return this.requireEmployee(id);
  }

  /** Draw a new random name. Not for the Head: the owner names it. */
  regenerateName(id: string): Employee {
    const current = this.requireRow(id);
    if (current.kind === "head") fail("The owner names the Head of Project Management.", 409);
    if (current.archived_at != null) fail("Employee is archived.", 409);
    const name = this.drawName(current.name);
    const now = this.now();
    this.write(() => {
      this.db.run(`UPDATE ai_employees SET name = ?, name_source = 'generated', updated_at = ? WHERE id = ?`, [name, now, id]);
      this.insertEvent(id, "regenerate-name", { name: { from: current.name, to: name } }, now);
    });
    return this.requireEmployee(id);
  }

  /** Workers only. A manager belongs to its project and the Head to none. */
  assign(id: string, projectPath: unknown): Employee {
    const current = this.requireRow(id);
    if (current.kind !== "worker") fail("Only a worker can be assigned to a project. A manager belongs to its project.", 409);
    if (current.archived_at != null) fail("Employee is archived.", 409);
    const project = this.resolveProject(projectPath);
    if (current.project_path === project.path) fail("Employee is already assigned to this project.", 409);
    const now = this.now();
    this.write(() => {
      this.lockEmployeeRow(id);
      const fresh = this.requireRow(id);
      if (fresh.kind !== "worker") fail("Only a worker can be assigned to a project. A manager belongs to its project.", 409);
      if (fresh.archived_at != null) fail("Employee is archived.", 409);
      if (fresh.project_path === project.path) fail("Employee is already assigned to this project.", 409);
      this.refuseActiveTaskAssignments(id);
      this.db.run(`UPDATE ai_employees SET project_path = ?, updated_at = ? WHERE id = ?`, [project.path, now, id]);
      this.insertEvent(id, fresh.project_path === null ? "assign" : "reassign", { projectPath: { from: fresh.project_path, to: project.path } }, now);
    });
    return this.requireEmployee(id);
  }

  unassign(id: string): Employee {
    const current = this.requireRow(id);
    if (current.kind !== "worker") fail("Only a worker can be unassigned. A manager belongs to its project.", 409);
    if (current.archived_at != null) fail("Employee is archived.", 409);
    if (current.project_path === null) fail("Employee is not assigned to a project.", 409);
    const now = this.now();
    this.write(() => {
      this.lockEmployeeRow(id);
      const fresh = this.requireRow(id);
      if (fresh.kind !== "worker") fail("Only a worker can be unassigned. A manager belongs to its project.", 409);
      if (fresh.archived_at != null) fail("Employee is archived.", 409);
      if (fresh.project_path === null) fail("Employee is not assigned to a project.", 409);
      this.refuseActiveTaskAssignments(id);
      this.db.run(`UPDATE ai_employees SET project_path = NULL, updated_at = ? WHERE id = ?`, [now, id]);
      this.insertEvent(id, "unassign", { projectPath: { from: fresh.project_path, to: null } }, now);
    });
    return this.requireEmployee(id);
  }

  /** Keeps the row, tasks, runs, and history. Repeating it keeps the first timestamp. */
  archive(id: string): Employee {
    const current = this.requireRow(id);
    if (current.archived_at != null) return this.requireEmployee(id);
    const now = this.now();
    this.write(() => {
      this.lockEmployeeRow(id);
      const fresh = this.requireRow(id);
      if (fresh.archived_at != null) return;
      this.refuseActiveTaskAssignments(id);
      this.db.run(`UPDATE ai_employees SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
      this.insertEvent(id, "archive", { status: { from: fresh.status, to: "archived" } }, now);
      new ActivityJournalCore(this.db).record({
        eventType: "employee.archived",
        projectPath: fresh.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "employee",
        targetId: id,
        employeeId: id,
        idempotencyKey: `employee:${id}:archived:${now}`,
        payload: {
          employeeId: id,
          employeeName: fresh.name,
          jobTitle: fresh.job_title,
          projectPath: fresh.project_path,
        },
        createdAt: now,
      });
    });
    return this.requireEmployee(id);
  }

  unarchive(id: string): Employee {
    const current = this.requireRow(id);
    if (current.archived_at == null) fail("Employee is not archived.", 409);
    const now = this.now();
    this.write(() => {
      this.db.run(`UPDATE ai_employees SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`, [now, id]);
      this.insertEvent(id, "unarchive", { status: { from: "archived", to: "active" } }, now);
      new ActivityJournalCore(this.db).record({
        eventType: "employee.unarchived",
        projectPath: current.project_path,
        actorType: "owner",
        actorId: "owner",
        targetType: "employee",
        targetId: id,
        employeeId: id,
        idempotencyKey: `employee:${id}:unarchived:${now}`,
        payload: {
          employeeId: id,
          employeeName: current.name,
          projectPath: current.project_path,
        },
        createdAt: now,
      });
    });
    return this.requireEmployee(id);
  }

  // ----- internals -----

  private insertManager(projectPath: string, value: Record<string, unknown>, action: "create" | "initialize"): string {
    const defaults = POSITION_DEFAULTS["project-manager"];
    const generated = value.name === undefined;
    return this.insert({
      kind: "project-manager",
      name: generated ? this.drawName() : this.nameValue(value.name),
      nameSource: generated ? "generated" : "owner",
      displayName: this.optionalText(value.displayName, "displayName", EMPLOYEE_LIMITS.displayName),
      jobTitle: defaults.jobTitle,
      roleCategory: defaults.roleCategory,
      specializations: [],
      projectPath,
      department: null,
      description: value.description === undefined ? "" : this.descriptionValue(value.description),
      notes: this.optionalNotes(value.notes),
      action,
    });
  }

  private insert(record: {
    kind: EmployeeKind;
    name: string;
    nameSource: EmployeeNameSource;
    displayName: string | null;
    jobTitle: string;
    roleCategory: RoleCategory;
    specializations: string[];
    projectPath: string | null;
    department: string | null;
    description: string;
    notes: string | null;
    action: "create" | "initialize";
  }): string {
    const id = randomUUID();
    const now = this.now();
    this.write(() => {
      this.db.run(
        `INSERT INTO ai_employees
           (id, kind, name, name_source, display_name, job_title, role_category, specializations,
            project_path, department, description, notes, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
        [
          id, record.kind, record.name, record.nameSource, record.displayName, record.jobTitle, record.roleCategory,
          JSON.stringify(record.specializations), record.projectPath, record.department, record.description, record.notes, now, now,
        ],
      );
      this.insertEvent(id, record.action, {
        name: { from: null, to: record.name },
        jobTitle: { from: null, to: record.jobTitle },
        projectPath: { from: null, to: record.projectPath },
      }, now);
    });
    return id;
  }

  /** Draw once. Prefers a name no active employee holds and, on a redraw, a different one. */
  private drawName(avoid?: string): string {
    const taken = this.db.query<{ name: string }, []>(`SELECT name FROM ai_employees WHERE archived_at IS NULL`).all().map((row) => row.name);
    let name = generateEmployeeName(taken, this.random);
    for (let attempt = 0; avoid !== undefined && name.toLowerCase() === avoid.toLowerCase() && attempt < EMPLOYEE_LIMITS.nameDrawAttempts; attempt++) {
      name = generateEmployeeName(taken, this.random);
    }
    return name;
  }

  private activeRows(): EmployeeRow[] {
    return this.db.query<EmployeeRow, []>(
      `SELECT * FROM ai_employees WHERE archived_at IS NULL
        ORDER BY CASE kind WHEN 'head' THEN 0 WHEN 'project-manager' THEN 1 ELSE 2 END, name COLLATE NOCASE, id`,
    ).all();
  }

  private activeManagerRow(projectPath: string): EmployeeRow | null {
    return this.db.query<EmployeeRow, [string]>(
      `SELECT * FROM ai_employees WHERE kind = 'project-manager' AND project_path = ? AND archived_at IS NULL`,
    ).get(projectPath) ?? null;
  }

  private buildTeam(project: ProjectRow, rows: EmployeeRow[]): ProjectTeam {
    const mine = rows.filter((row) => row.project_path === project.path);
    const manager = mine.find((row) => row.kind === "project-manager");
    return {
      projectPath: project.path,
      projectName: project.name,
      pathMissing: !this.safeExists(project.path),
      projectManager: manager ? this.hydrate([manager])[0]! : null,
      employees: this.hydrate(mine.filter((row) => row.kind === "worker")),
    };
  }

  private requireRow(id: string): EmployeeRow {
    if (typeof id !== "string" || !UUID_RE.test(id)) fail("Invalid employee id.");
    const row = this.db.query<EmployeeRow, [string]>(`SELECT * FROM ai_employees WHERE id = ?`).get(id);
    if (!row) fail("Employee not found.", 404);
    return row;
  }

  private requireEmployee(id: string): Employee {
    return this.hydrate([this.requireRow(id)])[0]!;
  }

  private hydrate(rows: EmployeeRow[]): Employee[] {
    if (rows.length === 0) return [];
    const projects = new Map(this.db.query<ProjectRow, []>(`SELECT path, name, added_at FROM projects`).all().map((row) => [row.path, row.name]));
    const headId = this.db.query<{ id: string }, []>(`SELECT id FROM ai_employees WHERE kind = 'head' AND archived_at IS NULL`).get()?.id ?? null;
    const managers = new Map(
      this.db.query<{ id: string; project_path: string }, []>(
        `SELECT id, project_path FROM ai_employees WHERE kind = 'project-manager' AND archived_at IS NULL`,
      ).all().map((row) => [row.project_path, row.id]),
    );
    return rows.map((row) => {
      let reportsTo: Employee["reportsTo"] = null;
      if (row.archived_at == null) {
        if (row.kind === "head") reportsTo = { kind: "owner" };
        else if (row.kind === "project-manager") reportsTo = headId ? { kind: "employee", id: headId } : null;
        else {
          const manager = row.project_path ? managers.get(row.project_path) : undefined;
          reportsTo = manager ? { kind: "employee", id: manager } : null;
        }
      }
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        nameSource: row.name_source,
        displayName: row.display_name,
        jobTitle: row.job_title,
        roleCategory: row.role_category,
        specializations: parseList(row.specializations),
        projectPath: row.project_path,
        projectName: row.project_path ? projects.get(row.project_path) ?? null : null,
        projectRegistered: row.project_path ? projects.has(row.project_path) : false,
        department: row.department,
        description: row.description,
        notes: row.notes,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
        reportsTo,
        runtimeBinding: EMPLOYEE_RUNTIME_BINDING,
        authority: EMPLOYEE_AUTHORITY,
      };
    });
  }

  private fieldsOf(row: EmployeeRow): Record<EmployeeField, unknown> {
    return {
      name: row.name,
      displayName: row.display_name,
      jobTitle: row.job_title,
      roleCategory: row.role_category,
      specializations: parseList(row.specializations),
      projectPath: row.project_path,
      department: row.department,
      description: row.description,
      notes: row.notes,
      status: row.status,
    };
  }

  private historyOf(id: string): { events: EmployeeEvent[]; truncated: boolean } {
    const rows = this.db.query<EventRow, [string, number]>(
      `SELECT id, employee_id, action, changes, created_at FROM ai_employee_events WHERE employee_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(id, EMPLOYEE_LIMITS.historyPage + 1);
    return {
      truncated: rows.length > EMPLOYEE_LIMITS.historyPage,
      events: rows.slice(0, EMPLOYEE_LIMITS.historyPage).reverse().map((row) => ({
        id: row.id,
        employeeId: row.employee_id,
        action: row.action,
        changes: parseChanges(row.changes),
        at: row.created_at,
      })),
    };
  }

  private insertEvent(employeeId: string, action: EmployeeEventAction, changes: Changes, at: number): void {
    this.db.run(`INSERT INTO ai_employee_events (employee_id, action, changes, created_at) VALUES (?, ?, ?, ?)`, [employeeId, action, JSON.stringify(changes), at]);
  }

  private resolveProject(raw: unknown): ProjectRow {
    const validated = validateProjectPath(raw);
    if (!validated.ok) fail(validated.error);
    const projectPath = validated.path;
    const rows = this.db.query<ProjectRow, []>(`SELECT path, name, added_at FROM projects`).all();
    const exact = rows.find((row) => row.path === projectPath);
    if (exact) return exact;
    const real = this.realpath(projectPath);
    if (!real) fail("Project is not registered.", 404);
    const matches = rows.filter((row) => row.path === real || this.realpath(row.path) === real);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) fail("Project path matches more than one registered project.", 409);
    fail("Project is not registered.", 404);
  }

  private safeExists(path: string): boolean {
    try {
      return this.pathExists(path);
    } catch {
      return false;
    }
  }

  /** Holds the employee row so a task assignment cannot land mid-move. */
  private lockEmployeeRow(id: string): void {
    this.db.run(`UPDATE ai_employees SET updated_at = updated_at WHERE id = ?`, [id]);
  }

  private refuseActiveTaskAssignments(employeeId: string): void {
    const row = this.db.query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM employee_task_assignments WHERE employee_id = ? AND status = 'active'`,
    ).get(employeeId);
    if ((row?.n ?? 0) > 0) fail(ACTIVE_TASK_ASSIGNMENT_GUARD, 409);
  }

  private write(fn: () => void): void {
    try {
      this.db.transaction(fn)();
    } catch (error) {
      if (error instanceof EmployeeCoreError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint failed: ai_employees\.kind/i.test(message)) fail("There is already an active Head of Project Management.", 409);
      if (/UNIQUE constraint failed: ai_employees\.project_path/i.test(message)) fail("This project already has an active Project Manager.", 409);
      throw error;
    }
  }

  private nameValue(value: unknown): string {
    if (typeof value !== "string" || CONTROL.test(value)) fail("Invalid name.");
    const name = value.trim();
    if (name.length < 1 || name.length > EMPLOYEE_LIMITS.name) fail("Invalid name.");
    return name;
  }

  private jobTitleValue(value: unknown): string {
    if (typeof value !== "string" || CONTROL.test(value)) fail("Invalid jobTitle.");
    const title = value.trim();
    if (title.length < 1 || title.length > EMPLOYEE_LIMITS.jobTitle) fail("Invalid jobTitle.");
    return title;
  }

  private roleCategoryValue(value: unknown): RoleCategory {
    if (typeof value !== "string" || !(ROLE_CATEGORIES as readonly string[]).includes(value)) fail("Invalid roleCategory.");
    return value as RoleCategory;
  }

  private kindValue(value: unknown): EmployeeKind {
    if (typeof value !== "string" || !(EMPLOYEE_KINDS as readonly string[]).includes(value)) fail("Invalid kind.");
    return value as EmployeeKind;
  }

  private statusFilterValue(value: unknown): EmployeeStatus {
    if (typeof value !== "string" || !(EMPLOYEE_STATUSES as readonly string[]).includes(value)) fail("Invalid status.");
    return value as EmployeeStatus;
  }

  private activeStatusValue(value: unknown): "active" | "inactive" {
    if (value !== "active" && value !== "inactive") fail("Invalid status. Archive an employee with the archive action.");
    return value;
  }

  private specializationsValue(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > EMPLOYEE_LIMITS.specializations) fail("Invalid specializations.");
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || CONTROL.test(item)) fail("Invalid specializations.");
      const text = item.trim();
      if (text.length < 1 || text.length > EMPLOYEE_LIMITS.specialization) fail("Invalid specializations.");
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
    return result;
  }

  private descriptionValue(value: unknown): string {
    if (typeof value !== "string" || value.length > EMPLOYEE_LIMITS.description || TEXT_CONTROL.test(value)) fail("Invalid description.");
    return value.trim();
  }

  private optionalNotes(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > EMPLOYEE_LIMITS.notes || TEXT_CONTROL.test(value)) fail("Invalid notes.");
    return value.trim() === "" ? null : value.trim();
  }

  private optionalText(value: unknown, field: string, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || CONTROL.test(value)) fail(`Invalid ${field}.`);
    const text = value.trim();
    if (text.length > max) fail(`Invalid ${field}.`);
    return text === "" ? null : text;
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail("Unsupported field.");
  return result;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseList(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseChanges(raw: string): Changes {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Changes) : {};
  } catch {
    return {};
  }
}

function defaultPathExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
