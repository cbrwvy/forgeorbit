import type { Database } from "bun:sqlite";
import {
  DEFAULT_INHERITANCE_SETTINGS,
  type KnowledgeInheritanceSettings,
} from "../shared/knowledge/effective.ts";

export function getProjectInheritanceSettings(db: Database, projectPath: string): KnowledgeInheritanceSettings {
  const row = db.query<{ accept_company: number; accept_cluster: number }, [string]>(
    `SELECT accept_company, accept_cluster FROM knowledge_inheritance_settings
      WHERE scope_kind = 'project' AND scope_id = ?`,
  ).get(projectPath);
  if (!row) return { ...DEFAULT_INHERITANCE_SETTINGS };
  return { acceptCompany: row.accept_company === 1, acceptCluster: row.accept_cluster === 1 };
}

export function setProjectInheritanceSettings(
  db: Database,
  projectPath: string,
  patch: Partial<KnowledgeInheritanceSettings>,
  now: number,
): KnowledgeInheritanceSettings {
  const current = getProjectInheritanceSettings(db, projectPath);
  const next: KnowledgeInheritanceSettings = {
    acceptCompany: patch.acceptCompany ?? current.acceptCompany,
    acceptCluster: patch.acceptCluster ?? current.acceptCluster,
  };
  db.run(
    `INSERT INTO knowledge_inheritance_settings (scope_kind, scope_id, accept_company, accept_cluster, updated_at)
     VALUES ('project', ?, ?, ?, ?)
     ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
       accept_company = excluded.accept_company,
       accept_cluster = excluded.accept_cluster,
       updated_at = excluded.updated_at`,
    [projectPath, next.acceptCompany ? 1 : 0, next.acceptCluster ? 1 : 0, now],
  );
  return next;
}

export function documentInheritToProjects(db: Database, documentId: string): boolean {
  const row = db.query<{ inherit_to_projects: number }, [string]>(
    `SELECT inherit_to_projects FROM knowledge_documents WHERE id = ?`,
  ).get(documentId);
  return row?.inherit_to_projects === 1;
}

export function setDocumentInheritToProjects(db: Database, documentId: string, inherit: boolean): void {
  db.run(`UPDATE knowledge_documents SET inherit_to_projects = ? WHERE id = ?`, [inherit ? 1 : 0, documentId]);
}
