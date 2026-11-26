-- Brain 2.0 (FO-BRAIN04): Automatic knowledge extraction candidates & specialist run provenance.

CREATE TABLE brain_extraction_candidates (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved', 'rejected', 'archived')),
  source_event_kind TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_record_ids_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('company', 'project')),
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'observation')),
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  extraction_method TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  supersedes_memory_id TEXT,
  related_memory_ids_json TEXT NOT NULL,
  memory_id TEXT,
  decision_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE(source_event_kind, source_event_id)
);

CREATE INDEX brain_extraction_candidates_scope
  ON brain_extraction_candidates(scope_kind, scope_id, status, created_at DESC);

ALTER TABLE runs ADD COLUMN brain_context_snapshot TEXT;
