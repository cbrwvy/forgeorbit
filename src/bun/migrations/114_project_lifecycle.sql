-- FO-PROJECT-LIFECYCLE01: Persisted project-scoped AI execution lifecycle state.
-- Stored without a SQL CHECK constraint so unknown or corrupted persisted values
-- can be detected and failed closed explicitly at runtime rather than silently coerced.
ALTER TABLE projects ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'running';
ALTER TABLE projects ADD COLUMN lifecycle_updated_at INTEGER;
ALTER TABLE projects ADD COLUMN lifecycle_reason TEXT;
