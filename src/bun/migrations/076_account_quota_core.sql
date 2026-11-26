-- Additive metadata only. Account deletion is archival; observations and run history survive.
CREATE TABLE IF NOT EXISTS resource_accounts (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS account_harness_bindings (
  account_id TEXT NOT NULL REFERENCES resource_accounts(id) ON DELETE RESTRICT,
  harness_id TEXT NOT NULL REFERENCES harnesses(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, harness_id)
);
CREATE TABLE IF NOT EXISTS account_profile_associations (
  profile_id TEXT PRIMARY KEY REFERENCES agent_profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, harness_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id, harness_id) REFERENCES account_harness_bindings(account_id, harness_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS resource_subscriptions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS account_subscriptions (
  account_id TEXT NOT NULL REFERENCES resource_accounts(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES resource_subscriptions(id) ON DELETE RESTRICT,
  PRIMARY KEY(account_id, subscription_id)
);
CREATE TABLE IF NOT EXISTS quota_definitions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES resource_accounts(id) ON DELETE RESTRICT,
  subscription_id TEXT REFERENCES resource_subscriptions(id) ON DELETE RESTRICT,
  data TEXT NOT NULL CHECK(json_valid(data)),
  FOREIGN KEY(account_id, subscription_id) REFERENCES account_subscriptions(account_id, subscription_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS quota_observations (
  id TEXT PRIMARY KEY, quota_id TEXT NOT NULL REFERENCES quota_definitions(id) ON DELETE RESTRICT,
  observed_at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX IF NOT EXISTS quota_observations_history ON quota_observations(quota_id, observed_at DESC, id);
CREATE INDEX IF NOT EXISTS quota_definitions_account ON quota_definitions(account_id);
CREATE TABLE IF NOT EXISTS account_model_capabilities (
  account_id TEXT NOT NULL, harness_id TEXT NOT NULL, model_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(account_id, harness_id, model_id),
  FOREIGN KEY(account_id, harness_id) REFERENCES account_harness_bindings(account_id, harness_id) ON DELETE CASCADE
);
-- Version journal for the existing usage cache, not another poller. Never associates an account.
-- Only known fields are copied; reasons, credentials and arbitrary provider payloads are excluded.
CREATE TABLE IF NOT EXISTS harness_usage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  UNIQUE(harness_id, observed_at, snapshot_json)
);
CREATE INDEX IF NOT EXISTS harness_usage_history_lookup ON harness_usage_history(harness_id, observed_at DESC, id DESC);
INSERT OR IGNORE INTO harness_usage_history(harness_id, observed_at, snapshot_json)
SELECT harness_id, COALESCE(json_extract(snapshot_json, '$.fetchedAtMs'), updated_at),
  json_object('harnessId', harness_id, 'kind', json_extract(snapshot_json, '$.kind'),
    'status', json_extract(snapshot_json, '$.status'), 'source', json_extract(snapshot_json, '$.source'),
    'fetchedAtMs', json_extract(snapshot_json, '$.fetchedAtMs'),
    'meters', json(COALESCE((SELECT json_group_array(json_object(
      'id', json_extract(value, '$.id'), 'usedPercent', json_extract(value, '$.usedPercent'),
      'resetsAtMs', json_extract(value, '$.resetsAtMs')))
      FROM json_each(snapshot_json, '$.meters') WHERE type = 'object'), '[]')))
FROM harness_usage WHERE json_valid(snapshot_json);
