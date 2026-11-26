-- Launch profiles for the local environment manager (FO-004B).
-- One row per profile id, scoped to a registered project path. `data` is the
-- JSON StoredEnvironment (profile + last runtime). The runtime phase is a
-- recovery hint only: EnvironmentManager.restore() probes the process or
-- Compose project before treating it as running, and a saved "running"
-- phase with no ownership record is discarded.
--
-- Ownership tokens stay in this blob because a restarted process can only
-- be re-proven from them. HTTP responses strip those tokens. The API does
-- not accept new literal environment values; inherit bindings are the
-- stored reference to a variable that already exists in the environment.
CREATE TABLE environment_profiles (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX environment_profiles_project_path
  ON environment_profiles(project_path);
