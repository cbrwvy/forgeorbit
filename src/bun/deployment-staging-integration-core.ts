/**
 * FO-DEPLOY02 — persisted Owner-controlled staging integration mappings.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  defaultCapabilities,
  parseStagingIntegrationCreate,
  type StagingIntegrationCapabilities,
  type StagingIntegrationRecord,
} from "../shared/deployment-request/integration.ts";

export class StagingIntegrationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid") {
    super(message);
    this.name = "StagingIntegrationError";
  }
}

interface Row {
  id: string;
  cluster_id: string;
  project_path: string;
  environment: "staging";
  integration_type: string;
  integration_label: string;
  project_slug: string;
  entrypoint_ref: string;
  images_catalog_ref: string | null;
  capabilities_json: string;
  real_execution_configured: number;
  real_execution_enabled: number;
  created_at: number;
  updated_at: number;
}

function take<T>(result: { ok: true; value: T } | { ok: false; error: string; status: number }): T {
  if (!result.ok) throw new StagingIntegrationError(result.error, result.status);
  return result.value;
}

function parseCapabilities(raw: string): StagingIntegrationCapabilities {
  try {
    return JSON.parse(raw) as StagingIntegrationCapabilities;
  } catch {
    return { preflight: "unsupported", dryRun: "unsupported", execute: "disabled" };
  }
}

export class StagingIntegrationCore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(projectPath?: string): StagingIntegrationRecord[] {
    const rows = projectPath
      ? this.db.query<Row, [string]>(
          `SELECT * FROM deployment_staging_integrations WHERE project_path = ? ORDER BY updated_at DESC`,
        ).all(projectPath)
      : this.db.query<Row, []>(`SELECT * FROM deployment_staging_integrations ORDER BY updated_at DESC`).all();
    return rows.map((row) => this.toRecord(row));
  }

  get(id: string): StagingIntegrationRecord {
    const row = this.db.query<Row, [string]>(`SELECT * FROM deployment_staging_integrations WHERE id = ?`).get(id);
    if (!row) throw new StagingIntegrationError("Staging integration not found.", 404, "not-found");
    return this.toRecord(row);
  }

  findForTarget(clusterId: string, projectPath: string, environment: string): StagingIntegrationRecord | null {
    if (environment !== "staging") return null;
    const row = this.db.query<Row, [string, string]>(
      `SELECT * FROM deployment_staging_integrations WHERE cluster_id = ? AND project_path = ? AND environment = 'staging'`,
    ).get(clusterId.toLowerCase(), projectPath);
    return row ? this.toRecord(row) : null;
  }

  create(input: unknown): StagingIntegrationRecord {
    const value = take(parseStagingIntegrationCreate(input));
    this.assertClusterMembership(value.clusterId, value.projectPath);
    const id = randomUUID();
    const now = this.now();
    const caps = defaultCapabilities(value.integrationType);
    this.db.run(
      `INSERT INTO deployment_staging_integrations (
         id, cluster_id, project_path, environment, integration_type, integration_label,
         project_slug, entrypoint_ref, images_catalog_ref, capabilities_json,
         real_execution_configured, real_execution_enabled, created_at, updated_at
       ) VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.clusterId,
        value.projectPath,
        value.integrationType,
        value.integrationLabel,
        value.projectSlug,
        value.entrypointRef,
        value.imagesCatalogRef ?? null,
        JSON.stringify(caps),
        value.realExecutionConfigured ? 1 : 0,
        value.realExecutionEnabled ? 1 : 0,
        now,
        now,
      ],
    );
    return this.get(id);
  }

  delete(id: string): { ok: true } {
    const row = this.db.query<{ id: string }, [string]>(`SELECT id FROM deployment_staging_integrations WHERE id = ?`).get(id);
    if (!row) throw new StagingIntegrationError("Staging integration not found.", 404, "not-found");
    this.db.run(`DELETE FROM deployment_staging_integrations WHERE id = ?`, [id]);
    return { ok: true };
  }

  private assertClusterMembership(clusterId: string, projectPath: string): void {
    const row = this.db.query<{ cluster_id: string | null }, [string]>(
      `SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?`,
    ).get(projectPath);
    if (!row?.cluster_id || row.cluster_id.toLowerCase() !== clusterId.toLowerCase()) {
      throw new StagingIntegrationError("Project is not assigned to the selected cluster.", 409, "membership");
    }
  }

  private toRecord(row: Row): StagingIntegrationRecord {
    return {
      id: row.id,
      clusterId: row.cluster_id,
      projectPath: row.project_path,
      environment: row.environment,
      integrationType: row.integration_type as StagingIntegrationRecord["integrationType"],
      integrationLabel: row.integration_label,
      projectSlug: row.project_slug,
      entrypointRef: row.entrypoint_ref,
      imagesCatalogRef: row.images_catalog_ref,
      capabilities: parseCapabilities(row.capabilities_json),
      realExecutionConfigured: row.real_execution_configured === 1,
      realExecutionEnabled: row.real_execution_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
