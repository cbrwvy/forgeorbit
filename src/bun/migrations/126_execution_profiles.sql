-- FO-MULTIACCOUNT02. Profile preferences and non-secret execution metadata.
-- Authentication secrets are not stored. A row does not grant execution permission.
CREATE TABLE IF NOT EXISTS account_execution_meta (
  account_id TEXT PRIMARY KEY REFERENCES resource_accounts(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS project_account_preferences (
  project_path TEXT NOT NULL,
  role TEXT NOT NULL,
  account_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_path, role)
);
