-- Distinguish a read-only routing recommendation from an Owner approval.
-- Existing applied plans keep their approval mark. Recommendations never start a run.

ALTER TABLE router_v2_decisions ADD COLUMN authority TEXT NOT NULL DEFAULT 'recommendation';

UPDATE router_v2_decisions
SET authority = 'approval'
WHERE plan_digest IS NOT NULL AND decision_type IN ('automatic', 'manual-override');

UPDATE router_v2_decisions
SET authority = 'fallback-proposal'
WHERE decision_type = 'fallback';
