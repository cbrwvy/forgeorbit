-- Provider refusal observations (FO-REAL-UI01 follow-up). A signed-in account can still be refused by
-- the provider. One row records one trusted refusal for one account/harness/model so the Head chat,
-- the account view and the router explanation tell the same story. This is an observation, not a
-- quota engine: it states no balance, no spend and no reset, and it is never turned into capacity.
-- `retry_hint` is the provider's own words, kept verbatim and never converted to a time.
-- A later successful provider answer for the same scope sets `superseded_at`. Nothing else clears a row.
CREATE TABLE provider_refusal_observations (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('usage-limit')),
  provider      TEXT NOT NULL,
  harness_id    TEXT NOT NULL,
  account_id    TEXT,
  model_id      TEXT,
  observed_at   INTEGER NOT NULL,
  surface       TEXT NOT NULL,
  evidence_id   TEXT NOT NULL,
  proof         TEXT NOT NULL,
  retry_hint    TEXT,
  diagnostics   TEXT NOT NULL,
  superseded_at INTEGER,
  superseded_by TEXT,
  UNIQUE (surface, evidence_id)
);
CREATE INDEX provider_refusal_observations_scope
  ON provider_refusal_observations(harness_id, model_id, observed_at DESC);
