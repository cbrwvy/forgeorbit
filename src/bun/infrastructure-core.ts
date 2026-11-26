/**
 * Infrastructure inventory (FO-011D).
 *
 * Writes registry rows and links only. It does not read the project
 * directory, open a remote shell, control containers, or contact a network.
 * Environment Manager profiles stay in their own table.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  INFRASTRUCTURE_COST_NOTE,
  INFRASTRUCTURE_EMPTY_NOTE,
  INFRASTRUCTURE_LIMITS,
  INFRASTRUCTURE_STATUS_NOTE,
  INFRASTRUCTURE_VERIFICATION,
  parseClusterLink,
  parseEnvironmentDeclaration,
  parseInfrastructureCreate,
  parseInfrastructureListQuery,
  parseInfrastructureUpdate,
  parseProjectLink,
  parseResourceId,
  type ClusterInfrastructureProject,
  type ClusterInfrastructureView,
  type InfrastructureCreate,
  type InfrastructureEnvironment,
  type InfrastructureListQuery,
  type InfrastructureParse,
  type InfrastructureResource,
  type InfrastructureStatus,
  type InfrastructureType,
  type InfrastructureUpdate,
  type ProjectEnvironmentDeclaration,
} from "../shared/infrastructure/model.ts";

export class InfrastructureError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "InfrastructureError";
  }
}

export interface InfrastructureCoreOptions {
  now?: () => number;
}

interface ResourceRow {
  id: string;
  name: string;
  resource_type: InfrastructureType;
  provider: string | null;
  description: string;
  hostname: string | null;
  ip_address: string | null;
  environment: InfrastructureEnvironment | null;
  environment_custom: string | null;
  region: string | null;
  cost_amount: string | null;
  currency: string | null;
  status: InfrastructureStatus;
  notes: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface EnvironmentRow {
  project_path: string;
  project_name: string;
  environment: InfrastructureEnvironment;
  custom_label: string;
  created_at: number;
}

const CLUSTER_NOTE =
  "Resources linked here are shared records. One server can belong to several clusters, and this cluster can use several servers. Nothing on this page was checked live.";

function take<T>(result: InfrastructureParse<T>): T {
  if (!result.ok) throw new InfrastructureError(result.error, result.status);
  return result.value;
}

export class InfrastructureCore {
  private readonly now: () => number;

  constructor(private readonly db: Database, options: InfrastructureCoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  list(input: InfrastructureListQuery | URLSearchParams): { resources: InfrastructureResource[]; truncated: boolean } {
    const query = input instanceof URLSearchParams ? take(parseInfrastructureListQuery(input)) : input;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.archived === "active") where.push("archived_at IS NULL");
    if (query.archived === "archived") where.push("archived_at IS NOT NULL");
    if (query.resourceType) {
      where.push("resource_type = ?");
      args.push(query.resourceType);
    }
    if (query.environment) {
      where.push("environment IS ?");
      args.push(query.environment);
    }
    if (query.provider) {
      where.push("provider = ? COLLATE NOCASE");
      args.push(query.provider);
    }
    if (query.clusterId) {
      where.push(`EXISTS (
        SELECT 1 FROM infrastructure_cluster_links link
        WHERE link.resource_id = infrastructure_resources.id AND link.cluster_id = ?
      )`);
      args.push(query.clusterId);
    }
    if (query.projectPath) {
      where.push(`EXISTS (
        SELECT 1 FROM infrastructure_project_links link
        WHERE link.resource_id = infrastructure_resources.id AND link.project_path = ?
      )`);
      args.push(query.projectPath);
    }
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push(`(
        name LIKE ? ESCAPE '\\' OR
        ifnull(provider, '') LIKE ? ESCAPE '\\' OR
        ifnull(hostname, '') LIKE ? ESCAPE '\\' OR
        ifnull(ip_address, '') LIKE ? ESCAPE '\\' OR
        ifnull(region, '') LIKE ? ESCAPE '\\' OR
        description LIKE ? ESCAPE '\\' OR
        notes LIKE ? ESCAPE '\\'
      )`);
      for (let i = 0; i < 7; i++) args.push(pattern);
    }
    const sql = `SELECT * FROM infrastructure_resources${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY name COLLATE NOCASE, id
      LIMIT ?`;
    args.push(INFRASTRUCTURE_LIMITS.list + 1);
    const rows = this.db.query<ResourceRow, (string | number)[]>(sql).all(...args);
    const truncated = rows.length > INFRASTRUCTURE_LIMITS.list;
    return { resources: this.hydrate(rows.slice(0, INFRASTRUCTURE_LIMITS.list)), truncated };
  }

  get(id: string): InfrastructureResource {
    return this.hydrate([this.requireRow(take(parseResourceId(id)))])[0]!;
  }

  create(input: unknown): InfrastructureResource {
    const value = take(parseInfrastructureCreate(input));
    const now = this.now();
    const id = randomUUID();
    const write = this.db.transaction(() => {
      this.insertResource(id, value, now);
      for (const clusterId of value.clusterIds) this.addClusterLink(id, clusterId, now);
      for (const projectPath of value.projectPaths) this.addProjectLink(id, projectPath, now);
    });
    write();
    return this.get(id);
  }

  update(id: string, input: unknown): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    const patch = take(parseInfrastructureUpdate(input));
    const current = this.requireRow(resourceId);
    if (current.archived_at != null) throw new InfrastructureError("Resource is archived.", 409);
    const environment = patch.environment !== undefined ? patch.environment : current.environment;
    const custom = patch.environmentCustom !== undefined ? patch.environmentCustom : current.environment_custom;
    if (environment === "custom" && !custom) throw new InfrastructureError("A custom environment needs a label.", 400);
    if (environment !== "custom" && custom) throw new InfrastructureError("Only a custom environment has a label.", 400);
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.resourceType !== undefined) set("resource_type", patch.resourceType);
    if (patch.provider !== undefined) set("provider", patch.provider);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.hostname !== undefined) set("hostname", patch.hostname);
    if (patch.ipAddress !== undefined) set("ip_address", patch.ipAddress);
    if (patch.environment !== undefined || patch.environmentCustom !== undefined) {
      set("environment", environment);
      set("environment_custom", environment === "custom" ? custom : null);
    }
    if (patch.region !== undefined) set("region", patch.region);
    if (patch.costAmount !== undefined) set("cost_amount", patch.costAmount);
    if (patch.currency !== undefined) set("currency", patch.currency);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.notes !== undefined) set("notes", patch.notes);
    set("updated_at", this.now());
    args.push(resourceId);
    this.db.run(`UPDATE infrastructure_resources SET ${sets.join(", ")} WHERE id = ?`, args);
    return this.get(resourceId);
  }

  archive(id: string): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    const current = this.requireRow(resourceId);
    if (current.archived_at == null) {
      const now = this.now();
      this.db.run(
        `UPDATE infrastructure_resources SET archived_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, resourceId],
      );
    }
    return this.get(resourceId);
  }

  restore(id: string): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    this.requireRow(resourceId);
    const now = this.now();
    this.db.run(
      `UPDATE infrastructure_resources SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL`,
      [now, resourceId],
    );
    return this.get(resourceId);
  }

  linkCluster(id: string, input: unknown): InfrastructureResource {
    const resourceId = this.requireActive(id);
    const link = take(parseClusterLink(input));
    this.addClusterLink(resourceId, link.clusterId, this.now());
    return this.get(resourceId);
  }

  unlinkCluster(id: string, clusterId: string): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    this.requireRow(resourceId);
    const cluster = take(parseClusterLink({ clusterId })).clusterId;
    const removed = this.db.run(
      `DELETE FROM infrastructure_cluster_links WHERE resource_id = ? AND cluster_id = ?`,
      [resourceId, cluster],
    );
    if (removed.changes === 0) throw new InfrastructureError("Cluster is not linked.", 404);
    return this.get(resourceId);
  }

  linkProject(id: string, input: unknown): InfrastructureResource {
    const resourceId = this.requireActive(id);
    const link = take(parseProjectLink(input));
    this.addProjectLink(resourceId, link.projectPath, this.now());
    return this.get(resourceId);
  }

  unlinkProject(id: string, projectPath: string): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    this.requireRow(resourceId);
    const link = take(parseProjectLink({ projectPath }));
    const removed = this.db.run(
      `DELETE FROM infrastructure_project_links WHERE resource_id = ? AND project_path = ?`,
      [resourceId, link.projectPath],
    );
    if (removed.changes === 0) throw new InfrastructureError("Project is not linked.", 404);
    return this.get(resourceId);
  }

  listProjectEnvironments(projectPath: string): ProjectEnvironmentDeclaration[] {
    const path = take(parseProjectLink({ projectPath })).projectPath;
    this.requireProject(path);
    return this.db.query<EnvironmentRow, [string]>(
      `SELECT e.project_path, p.name AS project_name, e.environment, e.custom_label, e.created_at
         FROM infrastructure_project_environments e
         JOIN projects p ON p.path = e.project_path
        WHERE e.project_path = ?
        ORDER BY e.environment, e.custom_label`,
    ).all(path).map(toDeclaration);
  }

  declareEnvironment(input: unknown): { declaration: ProjectEnvironmentDeclaration; created: boolean } {
    const value = take(parseEnvironmentDeclaration(input));
    this.requireProject(value.projectPath);
    const now = this.now();
    const inserted = this.db.run(
      `INSERT INTO infrastructure_project_environments (project_path, environment, custom_label, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_path, environment, custom_label) DO NOTHING`,
      [value.projectPath, value.environment, value.customLabel, now],
    );
    const row = this.db.query<EnvironmentRow, [string, string, string]>(
      `SELECT e.project_path, p.name AS project_name, e.environment, e.custom_label, e.created_at
         FROM infrastructure_project_environments e
         JOIN projects p ON p.path = e.project_path
        WHERE e.project_path = ? AND e.environment = ? AND e.custom_label = ?`,
    ).get(value.projectPath, value.environment, value.customLabel);
    if (!row) throw new InfrastructureError("Environment was not recorded.", 500);
    return { declaration: toDeclaration(row), created: inserted.changes > 0 };
  }

  removeEnvironment(projectPath: string, environment: string, customLabel = ""): void {
    const value = take(parseEnvironmentDeclaration({
      projectPath,
      environment,
      customLabel: customLabel || null,
    }));
    const removed = this.db.run(
      `DELETE FROM infrastructure_project_environments
        WHERE project_path = ? AND environment = ? AND custom_label = ?`,
      [value.projectPath, value.environment, value.customLabel],
    );
    if (removed.changes === 0) throw new InfrastructureError("Environment is not declared.", 404);
  }

  linkEnvironment(id: string, input: unknown): InfrastructureResource {
    const resourceId = this.requireActive(id);
    const value = take(parseEnvironmentDeclaration(input));
    const declared = this.db.query<{ project_path: string }, [string, string, string]>(
      `SELECT project_path FROM infrastructure_project_environments
        WHERE project_path = ? AND environment = ? AND custom_label = ?`,
    ).get(value.projectPath, value.environment, value.customLabel);
    if (!declared) throw new InfrastructureError("Declare the project environment before linking a resource.", 409);
    try {
      this.db.run(
        `INSERT INTO infrastructure_environment_links (resource_id, project_path, environment, custom_label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [resourceId, value.projectPath, value.environment, value.customLabel, this.now()],
      );
    } catch (error) {
      if (isConstraint(error)) throw new InfrastructureError("Environment is already linked.", 409);
      throw error;
    }
    return this.get(resourceId);
  }

  unlinkEnvironment(id: string, projectPath: string, environment: string, customLabel = ""): InfrastructureResource {
    const resourceId = take(parseResourceId(id));
    this.requireRow(resourceId);
    const value = take(parseEnvironmentDeclaration({
      projectPath,
      environment,
      customLabel: customLabel || null,
    }));
    const removed = this.db.run(
      `DELETE FROM infrastructure_environment_links
        WHERE resource_id = ? AND project_path = ? AND environment = ? AND custom_label = ?`,
      [resourceId, value.projectPath, value.environment, value.customLabel],
    );
    if (removed.changes === 0) throw new InfrastructureError("Environment is not linked.", 404);
    return this.get(resourceId);
  }

  clusterView(clusterId: string): ClusterInfrastructureView {
    const id = take(parseResourceId(clusterId));
    const cluster = this.db.query<{ id: string }, [string]>(`SELECT id FROM clusters WHERE id = ?`).get(id);
    if (!cluster) throw new InfrastructureError("Cluster not found.", 404);
    const listed = this.list({ clusterId: id, archived: "all" });
    const resources = listed.resources;
    const capNote = listed.truncated ? " The list is capped." : "";
    const members = this.db.query<{ project_path: string; name: string }, [string]>(
      `SELECT m.project_path, p.name
         FROM cluster_project_memberships m
         JOIN projects p ON p.path = m.project_path
        WHERE m.cluster_id = ?
        ORDER BY p.name COLLATE NOCASE, m.project_path`,
    ).all(id);
    const byPath = new Map<string, ClusterInfrastructureProject>();
    for (const member of members) {
      byPath.set(member.project_path, {
        projectPath: member.project_path,
        name: member.name,
        membership: "cluster",
        environments: [],
        resourceIds: [],
      });
    }
    for (const resource of resources) {
      for (const project of resource.projects) {
        const existing = byPath.get(project.path);
        if (existing) {
          existing.resourceIds.push(resource.id);
        } else {
          byPath.set(project.path, {
            projectPath: project.path,
            name: project.name,
            membership: "resource-only",
            environments: [],
            resourceIds: [resource.id],
          });
        }
      }
    }
    const paths = [...byPath.keys()];
    if (paths.length > 0) {
      const marks = paths.map(() => "?").join(", ");
      const environments = this.db.query<{ project_path: string; environment: InfrastructureEnvironment; custom_label: string }, string[]>(
        `SELECT project_path, environment, custom_label
           FROM infrastructure_project_environments
          WHERE project_path IN (${marks})
          ORDER BY environment, custom_label`,
      ).all(...paths);
      for (const row of environments) {
        byPath.get(row.project_path)?.environments.push({
          environment: row.environment,
          customLabel: row.custom_label,
        });
      }
    }
    const providers = new Map<string, string[]>();
    let providerUnspecified = 0;
    const costs: ClusterInfrastructureView["costs"] = [];
    let notVerified = 0;
    let unknown = 0;
    const active = resources.filter((resource) => resource.archivedAt == null);
    for (const resource of active) {
      if (resource.status === "unknown") unknown += 1;
      else notVerified += 1;
      if (resource.provider) {
        const key = resource.provider;
        providers.set(key, [...(providers.get(key) ?? []), resource.id]);
      } else {
        providerUnspecified += 1;
      }
      if (resource.costAmount || resource.currency) {
        costs.push({
          resourceId: resource.id,
          name: resource.name,
          amount: resource.costAmount,
          currency: resource.currency,
        });
      }
    }
    return {
      clusterId: id,
      note: CLUSTER_NOTE + capNote,
      resources,
      projects: [...byPath.values()],
      domains: active.filter((resource) => resource.resourceType === "domain").map((resource) => ({
        id: resource.id,
        name: resource.name,
        hostname: resource.hostname,
      })),
      providers: [...providers.entries()].map(([name, resourceIds]) => ({ name, resourceIds })),
      providerUnspecified,
      costs,
      unverified: { notVerified, unknown },
      statusNote: INFRASTRUCTURE_STATUS_NOTE,
      costNote: INFRASTRUCTURE_COST_NOTE,
      emptyNote: INFRASTRUCTURE_EMPTY_NOTE,
    };
  }

  private insertResource(id: string, value: InfrastructureCreate, now: number): void {
    this.db.run(
      `INSERT INTO infrastructure_resources (
         id, name, resource_type, provider, description, hostname, ip_address,
         environment, environment_custom, region, cost_amount, currency, status,
         notes, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        value.name,
        value.resourceType,
        value.provider,
        value.description,
        value.hostname,
        value.ipAddress,
        value.environment,
        value.environmentCustom,
        value.region,
        value.costAmount,
        value.currency,
        value.status,
        value.notes,
        now,
        now,
      ],
    );
  }

  private addClusterLink(resourceId: string, clusterId: string, now: number): void {
    const cluster = this.db.query<{ id: string }, [string]>(`SELECT id FROM clusters WHERE id = ?`).get(clusterId);
    if (!cluster) throw new InfrastructureError("Cluster not found.", 404);
    const existing = this.db.query<{ resource_id: string }, [string, string]>(
      `SELECT resource_id FROM infrastructure_cluster_links WHERE resource_id = ? AND cluster_id = ?`,
    ).get(resourceId, clusterId);
    if (existing) throw new InfrastructureError("Cluster is already linked.", 409);
    this.db.run(
      `INSERT INTO infrastructure_cluster_links (resource_id, cluster_id, created_at) VALUES (?, ?, ?)`,
      [resourceId, clusterId, now],
    );
  }

  private addProjectLink(resourceId: string, projectPath: string, now: number): void {
    this.requireProject(projectPath);
    const existing = this.db.query<{ resource_id: string }, [string, string]>(
      `SELECT resource_id FROM infrastructure_project_links WHERE resource_id = ? AND project_path = ?`,
    ).get(resourceId, projectPath);
    if (existing) throw new InfrastructureError("Project is already linked.", 409);
    this.db.run(
      `INSERT INTO infrastructure_project_links (resource_id, project_path, created_at) VALUES (?, ?, ?)`,
      [resourceId, projectPath, now],
    );
  }

  private requireProject(projectPath: string): void {
    const project = this.db.query<{ path: string }, [string]>(`SELECT path FROM projects WHERE path = ?`).get(projectPath);
    if (!project) throw new InfrastructureError("Project is not registered.", 404);
  }

  private requireActive(id: string): string {
    const resourceId = take(parseResourceId(id));
    const row = this.requireRow(resourceId);
    if (row.archived_at != null) throw new InfrastructureError("Resource is archived.", 409);
    return resourceId;
  }

  private requireRow(id: string): ResourceRow {
    const row = this.db.query<ResourceRow, [string]>(`SELECT * FROM infrastructure_resources WHERE id = ?`).get(id);
    if (!row) throw new InfrastructureError("Resource not found.", 404);
    return row;
  }

  private hydrate(rows: ResourceRow[]): InfrastructureResource[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => "?").join(", ");
    const clusters = this.db.query<{ resource_id: string; id: string; name: string }, string[]>(
      `SELECT link.resource_id, cluster.id, cluster.name
         FROM infrastructure_cluster_links link
         JOIN clusters cluster ON cluster.id = link.cluster_id
        WHERE link.resource_id IN (${marks})
        ORDER BY cluster.name COLLATE NOCASE, cluster.id`,
    ).all(...ids);
    const projects = this.db.query<{ resource_id: string; path: string; name: string }, string[]>(
      `SELECT link.resource_id, project.path, project.name
         FROM infrastructure_project_links link
         JOIN projects project ON project.path = link.project_path
        WHERE link.resource_id IN (${marks})
        ORDER BY project.name COLLATE NOCASE, project.path`,
    ).all(...ids);
    const environments = this.db.query<{
      resource_id: string;
      project_path: string;
      project_name: string;
      environment: InfrastructureEnvironment;
      custom_label: string;
    }, string[]>(
      `SELECT link.resource_id, link.project_path, project.name AS project_name, link.environment, link.custom_label
         FROM infrastructure_environment_links link
         JOIN projects project ON project.path = link.project_path
        WHERE link.resource_id IN (${marks})
        ORDER BY link.environment, link.custom_label`,
    ).all(...ids);
    const clusterMap = group(clusters, (row) => ({ id: row.id, name: row.name }));
    const projectMap = group(projects, (row) => ({ path: row.path, name: row.name }));
    const environmentMap = group(environments, (row) => ({
      projectPath: row.project_path,
      projectName: row.project_name,
      environment: row.environment,
      customLabel: row.custom_label,
    }));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      resourceType: row.resource_type,
      provider: row.provider,
      description: row.description,
      hostname: row.hostname,
      ipAddress: row.ip_address,
      environment: row.environment,
      environmentCustom: row.environment_custom,
      region: row.region,
      costAmount: row.cost_amount,
      currency: row.currency,
      status: row.status,
      verification: INFRASTRUCTURE_VERIFICATION,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      clusters: clusterMap.get(row.id) ?? [],
      projects: projectMap.get(row.id) ?? [],
      environmentLinks: environmentMap.get(row.id) ?? [],
    }));
  }
}

function toDeclaration(row: EnvironmentRow): ProjectEnvironmentDeclaration {
  return {
    projectPath: row.project_path,
    projectName: row.project_name,
    environment: row.environment,
    customLabel: row.custom_label,
    createdAt: row.created_at,
  };
}

function group<Row extends { resource_id: string }, T>(rows: Row[], map: (row: Row) => T): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.resource_id) ?? [];
    list.push(map(row));
    grouped.set(row.resource_id, list);
  }
  return grouped;
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error && error.name === "SQLiteError" && /UNIQUE|constraint/i.test(error.message);
}
