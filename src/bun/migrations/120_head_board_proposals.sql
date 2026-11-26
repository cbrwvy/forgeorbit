-- New Head approvals are independent of legacy project manager conversations.
-- Keep action records after chat retention or project removal.
CREATE TABLE head_board_proposals (
  message_id TEXT PRIMARY KEY,
  context_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applying','applied','rejected','failed')),
  task_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
