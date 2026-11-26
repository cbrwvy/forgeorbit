-- FO-HEAD02: Owner-visible cross-project initiatives (Head of PM coordination).

CREATE TABLE head_pm_initiatives (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX head_pm_initiatives_updated ON head_pm_initiatives(updated_at DESC);
