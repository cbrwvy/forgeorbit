-- What happened when a supervised run was stopped or reached its time limit, and what the core could prove
-- about the process. One row per run. `armed` rows (limit set, nothing requested yet) carry the deadline so a
-- restart can enforce it; a row is only a stop record once `requested_at` is set. Nothing here claims a
-- process exited unless `outcome` says the core observed it: 'exited' (the recorded process id and its
-- process group were gone), 'no-process' (no live session or pane process was found), 'unconfirmed' (still
-- alive after every signal) or 'unverified' (the harness does not report process exit).
CREATE TABLE run_terminations (
  run_id          TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  limit_seconds   INTEGER,
  deadline_at     INTEGER,
  reason          TEXT CHECK (reason IN ('manual', 'time-limit')),
  requested_at    INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT CHECK (outcome IN ('exited', 'no-process', 'unconfirmed', 'unverified', 'not-launched', 'recovered-gone', 'recovered-alive', 'recovered-unknown')),
  process_id      INTEGER,
  process_started TEXT,
  methods         TEXT NOT NULL DEFAULT '[]',
  checked_at      INTEGER,
  exited_at       INTEGER,
  note            TEXT
);
