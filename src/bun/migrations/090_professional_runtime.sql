-- FO-014D. NULL is pre-090 attribution Unknown; never infer historical guidance.
ALTER TABLE employee_executions ADD COLUMN professional_json TEXT;
ALTER TABLE employee_executions ADD COLUMN professional_payload_status TEXT NOT NULL DEFAULT 'bound'
  CHECK (professional_payload_status IN ('bound', 'prepared', 'included', 'failed'));
ALTER TABLE employee_executions ADD COLUMN professional_payload_at INTEGER;
ALTER TABLE employee_executions ADD COLUMN professional_payload_sha256 TEXT;
