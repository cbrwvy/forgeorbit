-- Keep frozen history readable even when later evidence invalidates its inputs.
DROP TRIGGER usage_freeze_first_estimate;
CREATE TRIGGER usage_freeze_first_estimate AFTER INSERT ON runs
WHEN NEW.qc_review_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id = NEW.task_id AND id <> NEW.id AND qc_review_id IS NULL)
BEGIN
  UPDATE runs SET usage_estimate_id = (
    SELECT id FROM usage_task_estimates
    WHERE task_id = NEW.task_id AND superseded = 0 AND created_at <= NEW.started_at
      AND (mission_id IS NULL OR mission_id = json_extract(NEW.usage_scope, '$.missionId'))
      AND (json_extract(snapshot, '$.plannedResource.harnessId') IS NULL
        OR json_extract(snapshot, '$.plannedResource.harnessId') = NEW.agent)
    ORDER BY mission_id IS NOT NULL DESC, id DESC LIMIT 1
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER usage_preferred_account_inserted AFTER INSERT ON project_account_preferences
WHEN NEW.role IN ('developer','reviewer')
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE superseded = 0 AND mission_id IS NULL
    AND json_extract(snapshot, '$.projectPath') = NEW.project_path;
END;
CREATE TRIGGER usage_preferred_account_changed AFTER UPDATE OF account_id ON project_account_preferences
WHEN NEW.role IN ('developer','reviewer') AND NEW.account_id IS NOT OLD.account_id
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE superseded = 0 AND mission_id IS NULL
    AND json_extract(snapshot, '$.projectPath') = NEW.project_path;
END;
CREATE TRIGGER usage_preferred_account_removed AFTER DELETE ON project_account_preferences
WHEN OLD.role IN ('developer','reviewer')
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE superseded = 0 AND mission_id IS NULL
    AND json_extract(snapshot, '$.projectPath') = OLD.project_path;
END;

CREATE TRIGGER usage_quota_observation_added AFTER INSERT ON quota_observations
BEGIN
  UPDATE usage_task_estimates SET superseded = 1 WHERE superseded = 0 AND EXISTS (
    SELECT 1 FROM quota_definitions q WHERE q.id = NEW.quota_id AND q.account_id IN (
      json_extract(snapshot, '$.plannedResource.accountId'),
      json_extract(snapshot, '$.developer.accountId'),
      json_extract(snapshot, '$.reviewer.accountId')
    )
  );
END;
