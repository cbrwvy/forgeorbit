/**
 * Cluster registry and project membership (FO-011A).
 *
 * Organizational writes only: cluster rows, one membership per registered
 * project, and an append-only history. No task, agent, git, worktree,
 * account, or filesystem mutation. Project identity is the existing
 * `projects` row.
 */

import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { aggregateCluster, type ClusterAggregate } from "../shared/clusters/aggregate.ts";
import { validateProjectPath } from "../shared/clusters/paths.ts";
import {
  CLUSTER_INFRASTRUCTURE,
  CLUSTER_LIMITS,
  CLUSTER_MANAGER,
  FORGEORBIT_COMPANY,
  knowledgeOwnerRef,
  type Cluster,
  type ClusterDetails,
  type ClusterProject,
  type MembershipEvent,
} from "../shared/clusters/types.ts";
import type { PortfolioSnapshotInput } from "../shared/portfolio/types.ts";

export class ClusterCoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ClusterCoreError";
  }
}

export interface ClusterCoreOptions {
  now?: () => number;
  /** Read-only. False when the registered path is not a directory. */
  pathExists?: (path: string) => boolean;
  realpath?: (path: string) => string | null;
}

interface ClusterRow {
  id: string;
  name: string;
  slug: string | null;
  description: string;
  color: string | null;
  icon: string | null;
  notes_summary: string | null;
  priority: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  project_count: number;
}

interface ProjectRow {
  path: string;
  name: string;
  added_at: number;
}

interface MembershipRow {
  project_path: string;
  cluster_id: string;
  assigned_at: number;
  updated_at: number;
}

const CREATE_KEYS = ["name", "slug", "description", "color", "icon", "notesSummary", "priority"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_RE = SLUG_RE;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function fail(message: string, status = 400): never {
  throw new ClusterCoreError(message, status);
}

export class ClusterCore {
  private readonly now: () => number;
  private readonly pathExists: (path: string) => boolean;
  private readonly realpath: (path: string) => string | null;

  constructor(private readonly db: Database, options: ClusterCoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.realpath = options.realpath ?? defaultRealpath;
  }

  list(options: { includeArchived?: boolean; slug?: string | null } = {}): Cluster[] {
    const slug = options.slug == null ? null : this.slugValue(options.slug);
    const rows = this.db.query<ClusterRow, [number, string | null, string | null]>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cluster_project_memberships m WHERE m.cluster_id = c.id) AS project_count
         FROM clusters c
        WHERE (? = 1 OR c.archived_at IS NULL)
          AND (? IS NULL OR c.slug = ?)
        ORDER BY c.priority IS NULL, c.priority ASC, c.name COLLATE NOCASE, c.id`,
    ).all(options.includeArchived ? 1 : 0, slug, slug);
    return rows.map(toCluster);
  }

  get(id: string): ClusterDetails {
    const cluster = this.requireCluster(id);
    const history = this.history(id);
    return {
      ...cluster,
      membershipHistory: history.events,
      membershipHistoryTruncated: history.truncated,
      infrastructure: CLUSTER_INFRASTRUCTURE,
      manager: CLUSTER_MANAGER,
    };
  }

  create(input: unknown): Cluster {
    const value = object(input, CREATE_KEYS);
    if (value.name === undefined) fail("Invalid name.");
    const now = this.now();
    const id = randomUUID();
    const record = {
      id,
      name: this.nameValue(value.name),
      slug: value.slug === undefined || value.slug === null ? null : this.slugValue(value.slug),
      description: value.description === undefined ? "" : this.descriptionValue(value.description),
      color: value.color === undefined || value.color === null ? null : this.colorValue(value.color),
      icon: value.icon === undefined || value.icon === null ? null : this.iconValue(value.icon),
      notesSummary: value.notesSummary === undefined || value.notesSummary === null ? null : this.notesValue(value.notesSummary),
      priority: value.priority === undefined || value.priority === null ? null : this.priorityValue(value.priority),
    };
    this.write(() => {
      this.db.run(
        `INSERT INTO clusters
           (id, name, slug, description, color, icon, notes_summary, priority, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [record.id, record.name, record.slug, record.description, record.color, record.icon, record.notesSummary, record.priority, now, now],
      );
    });
    return this.requireCluster(id);
  }

  update(id: string, input: unknown): Cluster {
    const current = this.requireCluster(id);
    const value = object(input, CREATE_KEYS);
    if (Object.keys(value).length === 0) fail("No fields to update.");
    const next = {
      name: value.name === undefined ? current.name : this.nameValue(value.name),
      slug: value.slug === undefined ? current.slug : value.slug === null ? null : this.slugValue(value.slug),
      description: value.description === undefined ? current.description : this.descriptionValue(value.description),
      color: value.color === undefined ? current.color : value.color === null ? null : this.colorValue(value.color),
      icon: value.icon === undefined ? current.icon : value.icon === null ? null : this.iconValue(value.icon),
      notesSummary: value.notesSummary === undefined ? current.notesSummary : value.notesSummary === null ? null : this.notesValue(value.notesSummary),
      priority: value.priority === undefined ? current.priority : value.priority === null ? null : this.priorityValue(value.priority),
    };
    const now = this.now();
    this.write(() => {
      this.db.run(
        `UPDATE clusters
            SET name = ?, slug = ?, description = ?, color = ?, icon = ?, notes_summary = ?, priority = ?, updated_at = ?
          WHERE id = ?`,
        [next.name, next.slug, next.description, next.color, next.icon, next.notesSummary, next.priority, now, id],
      );
    });
    return this.requireCluster(id);
  }

  /** Archive. Projects, memberships, and history stay. Repeated archive keeps the first timestamp. */
  archive(id: string): Cluster {
    const current = this.requireCluster(id);
    if (current.archivedAt != null) return current;
    const now = this.now();
    this.db.run(`UPDATE clusters SET archived_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    return this.requireCluster(id);
  }

  listProjects(clusterId: string): ClusterProject[] {
    this.requireCluster(clusterId);
    const rows = this.db.query<ProjectRow & { assigned_at: number }, [string]>(
      `SELECT p.path, p.name, p.added_at, m.assigned_at
         FROM cluster_project_memberships m
         JOIN projects p ON p.path = m.project_path
        WHERE m.cluster_id = ?
        ORDER BY p.name COLLATE NOCASE, p.path`,
    ).all(clusterId);
    return rows.map((row) => this.projectView(row, clusterId, row.assigned_at));
  }

  listUnassigned(): ClusterProject[] {
    const rows = this.db.query<ProjectRow, []>(
      `SELECT p.path, p.name, p.added_at
         FROM projects p
         LEFT JOIN cluster_project_memberships m ON m.project_path = p.path
        WHERE m.project_path IS NULL
        ORDER BY p.added_at DESC, p.path`,
    ).all();
    return rows.map((row) => this.projectView(row, null, null));
  }

  resolve(projectPath: unknown): ClusterProject & { cluster: Cluster | null } {
    const project = this.resolveProject(projectPath);
    const membership = this.membershipOf(project.path);
    const cluster = membership ? this.requireCluster(membership.cluster_id) : null;
    return { ...this.projectView(project, membership?.cluster_id ?? null, membership?.assigned_at ?? null), cluster };
  }

  assign(clusterId: string, projectPath: unknown): ClusterProject {
    const cluster = this.requireActiveCluster(clusterId);
    const project = this.resolveProject(projectPath);
    const existing = this.membershipOf(project.path);
    if (existing?.cluster_id === cluster.id) fail("Project is already in this cluster.", 409);
    if (existing) fail(`Project already belongs to cluster ${existing.cluster_id}. Move it explicitly.`, 409);
    const now = this.now();
    this.write(() => {
      this.db.run(
        `INSERT INTO cluster_project_memberships (project_path, cluster_id, assigned_at, updated_at) VALUES (?, ?, ?, ?)`,
        [project.path, cluster.id, now, now],
      );
      this.insertEvent(project.path, null, cluster.id, "assign", now);
    });
    return this.projectView(project, cluster.id, now);
  }

  move(clusterId: string, projectPath: unknown): ClusterProject {
    const cluster = this.requireActiveCluster(clusterId);
    const project = this.resolveProject(projectPath);
    const existing = this.membershipOf(project.path);
    if (!existing) fail("Project is not assigned to a cluster. Assign it explicitly.", 409);
    const current = existing;
    if (current.cluster_id === cluster.id) fail("Project is already in this cluster.", 409);
    const now = this.now();
    this.write(() => {
      const changed = this.db.run(
        `UPDATE cluster_project_memberships SET cluster_id = ?, updated_at = ? WHERE project_path = ? AND cluster_id = ?`,
        [cluster.id, now, project.path, current.cluster_id],
      ).changes;
      if (changed !== 1) fail("Project membership changed concurrently.", 409);
      this.insertEvent(project.path, current.cluster_id, cluster.id, "move", now);
    });
    return this.projectView(project, cluster.id, current.assigned_at);
  }

  unassign(clusterId: string, projectPath: unknown): { unassigned: true; projectPath: string } {
    const cluster = this.requireCluster(clusterId);
    const project = this.resolveProject(projectPath);
    const existing = this.membershipOf(project.path);
    if (!existing || existing.cluster_id !== cluster.id) fail("Project is not in this cluster.", 404);
    const now = this.now();
    this.write(() => {
      const changed = this.db.run(
        `DELETE FROM cluster_project_memberships WHERE project_path = ? AND cluster_id = ?`,
        [project.path, cluster.id],
      ).changes;
      if (changed !== 1) fail("Project is not in this cluster.", 404);
      this.insertEvent(project.path, cluster.id, null, "unassign", now);
    });
    return { unassigned: true, projectPath: project.path };
  }

  /** Read-only. `snapshot` is the existing portfolio assembly, or null when it could not be read. */
  summary(id: string, snapshot: PortfolioSnapshotInput | null): { cluster: Cluster; aggregate: ClusterAggregate } {
    const cluster = this.requireCluster(id);
    const paths = this.listProjects(id).map((project) => project.projectPath);
    return { cluster, aggregate: aggregateCluster(snapshot, paths) };
  }

  private history(clusterId: string): { events: MembershipEvent[]; truncated: boolean } {
    const rows = this.db.query<
      { id: number; project_path: string; from_cluster_id: string | null; to_cluster_id: string | null; action: MembershipEvent["action"]; created_at: number },
      [string, string, number]
    >(
      `SELECT id, project_path, from_cluster_id, to_cluster_id, action, created_at
         FROM cluster_membership_events
        WHERE to_cluster_id = ? OR from_cluster_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    ).all(clusterId, clusterId, CLUSTER_LIMITS.historyPage + 1);
    const truncated = rows.length > CLUSTER_LIMITS.historyPage;
    return {
      truncated,
      events: rows.slice(0, CLUSTER_LIMITS.historyPage).reverse().map((row) => ({
        id: row.id,
        projectPath: row.project_path,
        fromClusterId: row.from_cluster_id,
        toClusterId: row.to_cluster_id,
        action: row.action,
        at: row.created_at,
      })),
    };
  }

  private requireCluster(id: string): Cluster {
    if (!UUID_RE.test(id)) fail("Invalid cluster id.");
    const row = this.db.query<ClusterRow, [string]>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cluster_project_memberships m WHERE m.cluster_id = c.id) AS project_count
         FROM clusters c
        WHERE c.id = ?`,
    ).get(id);
    if (!row) fail("Cluster not found.", 404);
    return toCluster(row);
  }

  private requireActiveCluster(id: string): Cluster {
    const cluster = this.requireCluster(id);
    if (cluster.archivedAt != null) fail("Cluster is archived.", 409);
    return cluster;
  }

  private membershipOf(projectPath: string): MembershipRow | null {
    return this.db.query<MembershipRow, [string]>(
      `SELECT project_path, cluster_id, assigned_at, updated_at FROM cluster_project_memberships WHERE project_path = ?`,
    ).get(projectPath) ?? null;
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

  private projectView(row: ProjectRow, clusterId: string | null, assignedAt: number | null): ClusterProject {
    return {
      projectPath: row.path,
      name: row.name,
      addedAt: row.added_at,
      clusterId,
      assignedAt,
      pathMissing: !this.safeExists(row.path),
    };
  }

  private safeExists(path: string): boolean {
    try {
      return this.pathExists(path);
    } catch {
      return false;
    }
  }

  private insertEvent(projectPath: string, fromClusterId: string | null, toClusterId: string | null, action: MembershipEvent["action"], at: number): void {
    this.db.run(
      `INSERT INTO cluster_membership_events (project_path, from_cluster_id, to_cluster_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
      [projectPath, fromClusterId, toClusterId, action, at],
    );
  }

  private write(fn: () => void): void {
    try {
      this.db.transaction(fn)();
    } catch (error) {
      if (error instanceof ClusterCoreError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint failed: clusters\.slug/i.test(message)) fail("Slug is already in use.", 409);
      if (/UNIQUE constraint failed: cluster_project_memberships/i.test(message)) fail("Project membership conflict.", 409);
      throw error;
    }
  }

  private nameValue(value: unknown): string {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) fail("Invalid name.");
    const name = value.trim();
    if (name.length < 1 || name.length > CLUSTER_LIMITS.name) fail("Invalid name.");
    return name;
  }

  private slugValue(value: unknown): string {
    if (typeof value !== "string" || !SLUG_RE.test(value) || value.length > CLUSTER_LIMITS.slug) fail("Invalid slug.");
    return value;
  }

  private descriptionValue(value: unknown): string {
    if (typeof value !== "string" || value.length > CLUSTER_LIMITS.description) fail("Invalid description.");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("Invalid description.");
    return value.trim();
  }

  private notesValue(value: unknown): string {
    if (typeof value !== "string" || value.length > CLUSTER_LIMITS.notesSummary) fail("Invalid notesSummary.");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("Invalid notesSummary.");
    const notes = value.trim();
    if (notes.length === 0) fail("Invalid notesSummary.");
    return notes;
  }

  private colorValue(value: unknown): string {
    if (typeof value !== "string" || !COLOR_RE.test(value)) fail("Invalid color.");
    return value.toLowerCase();
  }

  private iconValue(value: unknown): string {
    if (typeof value !== "string" || !ICON_RE.test(value) || value.length > CLUSTER_LIMITS.icon) fail("Invalid icon.");
    return value;
  }

  private priorityValue(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > CLUSTER_LIMITS.priorityMax) fail("Invalid priority.");
    return value;
  }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail("Unsupported field.");
  return result;
}

function toCluster(row: ClusterRow): Cluster {
  return {
    id: row.id,
    companyId: FORGEORBIT_COMPANY.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    color: row.color,
    icon: row.icon,
    notesSummary: row.notes_summary,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    projectCount: row.project_count,
    knowledgeOwner: knowledgeOwnerRef("cluster", row.id),
  };
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
