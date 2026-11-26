-- FO-DIRECTION18: an evaluation names the exact revisions it compared and how many fixtures it used.
-- Activation re-checks these against the immutable version rows, so a verdict cannot be reused for other text.
-- Rows written before this migration keep NULLs and are never accepted as evidence for a new activation.
ALTER TABLE improvement_evaluations ADD COLUMN baseline_version INTEGER;
ALTER TABLE improvement_evaluations ADD COLUMN baseline_sha TEXT;
ALTER TABLE improvement_evaluations ADD COLUMN candidate_version INTEGER;
ALTER TABLE improvement_evaluations ADD COLUMN candidate_sha TEXT;
ALTER TABLE improvement_evaluations ADD COLUMN sample_size INTEGER;
ALTER TABLE improvement_evaluations ADD COLUMN execution TEXT;
