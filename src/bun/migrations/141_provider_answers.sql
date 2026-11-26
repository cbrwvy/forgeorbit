-- Latest successful provider answer per (harness, account, model). It is the only recovery signal for
-- a provider refusal observation (see 140). One row per scope; the newest answer wins, so a late or
-- duplicate settlement can never move it backwards. `account_key` is '' for the unidentified scope.
-- It states no balance, no reset and no capacity: only that the provider answered once, at that time.
CREATE TABLE provider_last_answer (
  harness_id  TEXT NOT NULL,
  account_key TEXT NOT NULL DEFAULT '',
  model_id    TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  surface     TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  PRIMARY KEY (harness_id, account_key, model_id)
);
