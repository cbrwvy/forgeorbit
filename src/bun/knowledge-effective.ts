/**
 * FO-011E effective knowledge loader — deterministic resolver backed by SQLite + Knowledge Core.
 */

import path from "node:path";
import type { Database } from "bun:sqlite";
import { FORGEORBIT_COMPANY } from "../shared/clusters/types.ts";
import type { KnowledgeOwnerRef } from "../shared/knowledge/document.ts";
import {
  resolveEffectiveKnowledge,
  snapshotFromEffective,
  type EffectiveKnowledgePreview,
  type KnowledgeSnapshot,
} from "../shared/knowledge/effective.ts";
import type { KnowledgeCore } from "./knowledge-core.ts";
import { documentInheritToProjects, getProjectInheritanceSettings } from "./knowledge-inheritance-store.ts";

export interface EffectiveKnowledgeBundle {
  preview: EffectiveKnowledgePreview;
  snapshot: KnowledgeSnapshot;
}

function clusterForProject(db: Database, projectPath: string): string | null {
  const row = db.query<{ cluster_id: string }, [string]>(
    `SELECT cluster_id FROM cluster_project_memberships WHERE project_path = ?`,
  ).get(projectPath);
  return row?.cluster_id ?? null;
}

function ownerLabel(db: Database, owner: KnowledgeOwnerRef): string {
  if (owner.kind === "company") return "Company";
  if (owner.kind === "cluster") {
    return db.query<{ name: string }, [string]>(`SELECT name FROM clusters WHERE id = ?`).get(owner.id)?.name ?? "Cluster";
  }
  const row = db.query<{ name: string }, [string]>(`SELECT name FROM projects WHERE path = ?`).get(owner.id);
  return row?.name || path.basename(owner.id);
}

function ownersForProject(projectPath: string, clusterId: string | null): KnowledgeOwnerRef[] {
  const owners: KnowledgeOwnerRef[] = [{ kind: "company", id: FORGEORBIT_COMPANY.id }];
  if (clusterId) owners.push({ kind: "cluster", id: clusterId });
  owners.push({ kind: "project", id: projectPath });
  return owners;
}

export function effectiveKnowledgeForProject(
  db: Database,
  core: KnowledgeCore,
  projectPath: string,
  now = Date.now(),
): EffectiveKnowledgeBundle | null {
  const registered = db.query(`SELECT 1 FROM projects WHERE path = ?`).get(projectPath);
  if (!registered) return null;
  const clusterId = clusterForProject(db, projectPath);
  const settings = getProjectInheritanceSettings(db, projectPath);
  const candidates = [];
  for (const owner of ownersForProject(projectPath, clusterId)) {
    const listed = core.list(owner, { limit: 200 });
    for (const document of listed.documents) {
      try {
        const read = core.read(document.id);
        candidates.push({
          document,
          ownerLabel: ownerLabel(db, document.owner),
          content: read.content,
          sha256: read.sha256,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  const preview = resolveEffectiveKnowledge({
    projectPath,
    clusterId,
    settings,
    candidates,
    inheritFlag: (document) =>
      document.owner.kind === "project" || documentInheritToProjects(db, document.id),
  });
  return { preview, snapshot: snapshotFromEffective(preview, now) };
}

let defaultCore: KnowledgeCore | null = null;

export async function loadEffectiveKnowledgeForProject(projectPath: string): Promise<EffectiveKnowledgeBundle | null> {
  const [{ db, dataDir }, { KnowledgeCore: Core }, { createKnowledgeFiles }] = await Promise.all([
    import("./db.ts"),
    import("./knowledge-core.ts"),
    import("./knowledge-files.ts"),
  ]);
  if (!defaultCore) {
    defaultCore = new Core(db, createKnowledgeFiles(path.join(dataDir, "knowledge")));
  }
  return effectiveKnowledgeForProject(db, defaultCore, projectPath);
}

/** Tests may replace the cached core instance. */
export function __setKnowledgeCoreForEffectiveTest(core: KnowledgeCore | null): void {
  defaultCore = core;
}
