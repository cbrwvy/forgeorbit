-- FO-HEAD03: Owner-reviewed cross-project initiative proposals from Head chat.

CREATE TABLE head_pm_initiative_proposals (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX head_pm_initiative_proposals_updated ON head_pm_initiative_proposals(updated_at DESC);
