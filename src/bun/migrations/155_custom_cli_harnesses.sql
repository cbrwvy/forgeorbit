-- FO-PROVIDERS-SIMPLIFY01: Widen harnesses.kind CHECK to allow 'custom'
-- generic/extensible CLI harnesses and add structured cli_config_json.
--
-- Follows the existing SQLite table-rebuild recipe (032/037/046/061) while
-- preserving every existing harness row, ID, enabled flag, home, bin, and env
-- verbatim.

CREATE TABLE harnesses_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('claude-code', 'codex', 'cursor', 'grok', 'gemini', 'kimi', 'fx', 'antigravity', 'custom')),
  label           TEXT NOT NULL,
  is_builtin      INTEGER NOT NULL DEFAULT 0,
  home            TEXT,
  bin             TEXT,
  env_json        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  cli_config_json TEXT
);

INSERT INTO harnesses_new
  (id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled, cli_config_json)
SELECT
  id, kind, label, is_builtin, home, bin, env_json, created_at, updated_at, enabled, NULL
FROM harnesses;

DROP TABLE harnesses;
ALTER TABLE harnesses_new RENAME TO harnesses;
