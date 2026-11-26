-- References to FO-AUTO02 only; no duplicate task/run engine.
CREATE TABLE head_pm_auto (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX head_pm_auto_one_active_initiative ON head_pm_auto (initiative_id) WHERE status NOT IN ('completed', 'cancelled');
CREATE UNIQUE INDEX head_pm_auto_one_running ON head_pm_auto ((1)) WHERE status = 'running';
CREATE TABLE head_pm_auto_reservations (
  batch_id TEXT PRIMARY KEY,
  coordination_id TEXT NOT NULL REFERENCES head_pm_auto(id)
);
