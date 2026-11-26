-- Keep execution history authoritative. New observations are additive; old
-- runs and tasks are deliberately not backfilled from mutable board state.
CREATE TABLE usage_task_estimates (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  mission_id TEXT,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  created_at INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1))
);
CREATE INDEX usage_task_estimates_task ON usage_task_estimates(task_id, mission_id, id DESC);

CREATE TABLE usage_pricing (
  id INTEGER PRIMARY KEY,
  harness_id TEXT NOT NULL,
  account_id TEXT,
  model_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  terms TEXT NOT NULL CHECK (json_valid(terms))
);
CREATE INDEX usage_pricing_resource ON usage_pricing(harness_id, model_id, account_id, created_at DESC, id DESC);

CREATE TABLE usage_task_transitions (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX usage_task_transitions_task ON usage_task_transitions(task_id, destination, at);

ALTER TABLE runs ADD COLUMN usage_scope TEXT CHECK (usage_scope IS NULL OR json_valid(usage_scope));
ALTER TABLE runs ADD COLUMN usage_estimate_id INTEGER REFERENCES usage_task_estimates(id) ON DELETE SET NULL;

CREATE TRIGGER usage_task_column_changed AFTER UPDATE OF "column" ON tasks
WHEN NEW."column" <> OLD."column"
BEGIN
  INSERT INTO usage_task_transitions (task_id, destination, at)
  VALUES (NEW.id, NEW."column", CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER usage_scope_changed AFTER UPDATE OF title, prompt, agent, model, mode, effort,
  fast, max_mode, task_type, workdir, isolation, agent_profile_id, archived_at ON tasks
WHEN NEW.title IS NOT OLD.title OR NEW.prompt IS NOT OLD.prompt OR NEW.agent IS NOT OLD.agent
  OR NEW.model IS NOT OLD.model OR NEW.mode IS NOT OLD.mode OR NEW.effort IS NOT OLD.effort
  OR NEW.fast IS NOT OLD.fast OR NEW.max_mode IS NOT OLD.max_mode OR NEW.task_type IS NOT OLD.task_type
  OR NEW.workdir IS NOT OLD.workdir OR NEW.isolation IS NOT OLD.isolation
  OR NEW.agent_profile_id IS NOT OLD.agent_profile_id OR NEW.archived_at IS NOT OLD.archived_at
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE task_id = NEW.id AND superseded = 0;
END;

CREATE TRIGGER usage_dependency_added AFTER INSERT ON task_dependencies
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE task_id = NEW.task_id AND superseded = 0;
END;

CREATE TRIGGER usage_dependency_removed AFTER DELETE ON task_dependencies
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE task_id = OLD.task_id AND superseded = 0;
END;

CREATE TRIGGER usage_freeze_first_estimate AFTER INSERT ON runs
WHEN NOT EXISTS (SELECT 1 FROM runs WHERE task_id = NEW.task_id AND id <> NEW.id)
BEGIN
  UPDATE runs SET usage_estimate_id = (
    SELECT id FROM usage_task_estimates
    WHERE task_id = NEW.task_id AND superseded = 0 AND created_at <= NEW.started_at
      AND (mission_id IS NULL OR mission_id = json_extract(NEW.usage_scope, '$.missionId'))
    ORDER BY mission_id IS NOT NULL DESC, id DESC LIMIT 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER usage_mission_plan_changed AFTER UPDATE OF plan_digest ON orchestration_missions
WHEN NEW.plan_digest <> OLD.plan_digest
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE mission_id = NEW.id AND superseded = 0;
END;

CREATE INDEX usage_run_project ON runs(json_extract(usage_scope, '$.projectPath'), task_id, started_at)
  WHERE usage_scope IS NOT NULL;

CREATE TABLE usage_group_forecasts (
  id INTEGER PRIMARY KEY,
  selection_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_group_forecasts_selection ON usage_group_forecasts(selection_key, id DESC);
