-- Allocation plans the Router itself issued (FO-DIRECTION16). A plan is a recommendation the Owner reviews and may
-- apply. The plan travels through the client, so applying one needs proof that the exact contents were issued here:
-- the digest of the issued plan is remembered, and an apply is refused for any digest that is not in this table.
-- A row authorizes nothing by itself; eligibility, task state and mission ownership are re-checked at apply.
CREATE TABLE IF NOT EXISTS router_v2_issued_plans (
  digest TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_router_v2_issued_plans_at ON router_v2_issued_plans (issued_at);
