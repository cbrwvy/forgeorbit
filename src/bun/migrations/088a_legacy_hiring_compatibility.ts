import type { Database } from 'bun:sqlite';
import type { Migration } from '../migrate.ts';

type Row = Record<string, string | number | null> & {
  id: string; project_path: string; catalog_role_slug: string;
  source_message_id: string | null; status: string; revision: number;
};

/** Synchronous, versioned preparation. The runner commits this WITH 089. */
export const legacyHiringCompatibility: Migration = {
  id: '088a_legacy_hiring_compatibility', sql: '', atomicWithNext: '089_hiring_proposal_dedup',
  apply(db: Database) {
    db.run(`CREATE TABLE hiring_legacy_provenance (
      proposal_id TEXT PRIMARY KEY, original_source_message_id TEXT,
      project_path TEXT NOT NULL, catalog_role_slug TEXT NOT NULL,
      original_status TEXT NOT NULL, canonical_pending_id TEXT, canonical_message_id TEXT,
      reason TEXT NOT NULL, normalized_at INTEGER NOT NULL,
      original_row_json TEXT NOT NULL, original_events_json TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX hiring_legacy_source ON hiring_legacy_provenance(project_path, original_source_message_id, catalog_role_slug)`);
    // One complete SQL statement per call; trigger bodies must not be split on ';'.
    for (const op of ['UPDATE', 'DELETE']) db.run(`CREATE TRIGGER hiring_legacy_no_${op.toLowerCase()}
      BEFORE ${op} ON hiring_legacy_provenance BEGIN SELECT RAISE(ABORT, 'Legacy provenance is immutable'); END`);
    db.run(`CREATE TRIGGER hiring_legacy_no_replace BEFORE INSERT ON hiring_legacy_provenance
      WHEN EXISTS (SELECT 1 FROM hiring_legacy_provenance WHERE proposal_id = NEW.proposal_id)
      BEGIN SELECT RAISE(ABORT, 'Legacy provenance is immutable'); END`);
    const rows = db.query<Row, []>('SELECT * FROM hiring_proposals ORDER BY created_at, id COLLATE BINARY').all();
    // Refuse lossy JSON conversion of unusual but schema-legal integer values.
    for (const row of rows) for (const value of Object.values(row)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('Legacy SQLite value requires Owner-reviewed resolution');
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Legacy hiring integer requires Owner-reviewed resolution');
    }
    if (rows.some(row => typeof row.id !== 'string')) throw new Error('Legacy null proposal UUID requires Owner-reviewed resolution');
    const pending = new Map<string, Row[]>();
    const messages = new Map<string, Row[]>();
    for (const row of rows) {
      const add = (map: Map<string, Row[]>, key: string) => { const group = map.get(key); if (group) group.push(row); else map.set(key, [row]); };
      if (row.status === 'pending') add(pending, JSON.stringify([row.project_path, row.catalog_role_slug]));
      if (row.source_message_id !== null) add(messages, JSON.stringify([row.project_path, row.source_message_id, row.catalog_role_slug]));
    }
    const at = Date.now();
    for (const row of rows) {
      const p = pending.get(JSON.stringify([row.project_path, row.catalog_role_slug]));
      const m = messages.get(JSON.stringify([row.project_path, row.source_message_id, row.catalog_role_slug]));
      const pc = row.status === 'pending' && p && p.length > 1 ? p[0]!.id : null;
      const mc = m && m.length > 1 ? m[0]!.id : null;
      if (!pc && !mc) continue;
      const stale = pc !== null && pc !== row.id;
      const detach = mc !== null && mc !== row.id;
      if (stale && row.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Legacy revision increment requires Owner-reviewed resolution');
      const reason = 'legacy_duplicate_normalization: first submitted (created_at, UUID) retained; alternatives preserved for Owner review';
      const events = db.query<Record<string, unknown>, [string]>('SELECT * FROM hiring_proposal_events WHERE proposal_id = ? ORDER BY id').all(row.id);
      for (const event of events) for (const value of Object.values(event)) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new Error('Legacy SQLite value requires Owner-reviewed resolution');
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Legacy audit integer requires Owner-reviewed resolution');
      }
      db.run(`INSERT INTO hiring_legacy_provenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.source_message_id, row.project_path, row.catalog_role_slug, row.status, pc, mc, reason, at, JSON.stringify(row), JSON.stringify(events)]);
      if (detach) db.run('UPDATE hiring_proposals SET source_message_id = NULL WHERE id = ?', [row.id]);
      if (stale) db.run(`UPDATE hiring_proposals SET status = 'stale', stale_reason = ?, decided_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
        [`${reason}. Pending proposal: ${pc}. This is not an Owner rejection.`, at, at, row.id]);
      if (stale || detach) db.run(`INSERT INTO hiring_proposal_events
        (proposal_id, project_path, action, actor, proposal_revision, created_employee_id, note, created_at)
        VALUES (?, ?, ?, 'system', ?, ?, ?, ?)`,
        [row.id, row.project_path, stale ? 'stale' : 'updated', row.revision + (stale ? 1 : 0), row.created_employee_id ?? null, reason, at]);
    }
  },
};
