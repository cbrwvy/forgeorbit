-- Supervised quality control rounds (FO-QC01).

CREATE TABLE task_quality_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  round INTEGER NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  summary TEXT,
  findings_json TEXT,
  feedback TEXT,
  reviewer_employee_id TEXT,
  reviewer_role_slug TEXT,
  reviewer_harness TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  reviewer_profile_id TEXT,
  implementation_run_id TEXT,
  review_run_id TEXT,
  saved_task_json TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE (task_id, round)
);

CREATE INDEX idx_task_quality_reviews_task ON task_quality_reviews (task_id, round DESC);
CREATE INDEX idx_task_quality_reviews_active ON task_quality_reviews (task_id, status);

ALTER TABLE tasks ADD COLUMN qc_state TEXT;
ALTER TABLE runs ADD COLUMN qc_review_id TEXT;
