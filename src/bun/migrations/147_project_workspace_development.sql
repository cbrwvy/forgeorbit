-- Project-scoped Developer working-copy permissions (opt-in per project).
-- Existing and newly registered projects stay on their current policy (0)
-- until the Owner explicitly enables working-copy development for that project.
ALTER TABLE projects ADD COLUMN workspace_development INTEGER NOT NULL DEFAULT 0 CHECK (workspace_development IN (0, 1));
