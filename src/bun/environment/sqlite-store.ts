/**
 * SQLite adapter for {@link EnvironmentRepository}.
 *
 * Rows live in `environment_profiles` (migration 069). The manager still
 * owns the JSON shape. This module does not spawn, probe, or decide that a
 * saved phase is true.
 */

import { Database } from "bun:sqlite";

import type { StoredEnvironment } from "../../shared/environment/types.ts";
import { db } from "../db.ts";
import type { EnvironmentRepository } from "./store.ts";

const MAX_ROW_CHARS = 512_000;

export class SqliteEnvironmentStore implements EnvironmentRepository {
  constructor(private readonly database: Database = db) {}

  async loadAll(): Promise<StoredEnvironment[]> {
    const rows = this.database.query<{ data: string }, []>(
      `SELECT data FROM environment_profiles`,
    ).all();
    const records: StoredEnvironment[] = [];
    for (const row of rows) {
      const parsed = parseRow(row.data);
      if (parsed) records.push(parsed);
    }
    return records;
  }

  async save(record: StoredEnvironment): Promise<void> {
    const data = JSON.stringify(record);
    if (data.length > MAX_ROW_CHARS) {
      throw new Error("environment profile is too large to store");
    }
    this.database.run(
      `INSERT INTO environment_profiles (id, project_path, data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_path = excluded.project_path,
         data = excluded.data,
         updated_at = excluded.updated_at`,
      [record.profile.id, record.profile.projectPath, data, record.runtime.updatedAt],
    );
  }

  async remove(profileId: string): Promise<void> {
    this.database.run(`DELETE FROM environment_profiles WHERE id = ?`, [profileId]);
  }
}

function parseRow(data: string): StoredEnvironment | null {
  try {
    const parsed = JSON.parse(data) as StoredEnvironment;
    if (!parsed || typeof parsed !== "object" || !parsed.profile || !parsed.runtime) return null;
    if (typeof parsed.profile.id !== "string" || typeof parsed.profile.projectPath !== "string") return null;
    return structuredClone(parsed);
  } catch {
    return null;
  }
}
