-- FO-QC-EVIDENCE01: bounded source captured when a Developer run succeeds.
-- Historical rows stay NULL. A later read of the workspace is not a retrospective snapshot.

ALTER TABLE runs ADD COLUMN source_evidence_json TEXT;
