-- Who asked for a project test. `worker` requests come from a structured suggestion the core read
-- when a Developer run settled. One suggestion per originating run: the unique index makes repeated
-- delivery of the same suggestion (a replayed settle, a boot re-read) create nothing.
ALTER TABLE project_permission_requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'worker'));
ALTER TABLE project_permission_requests ADD COLUMN origin_run_id TEXT;
CREATE UNIQUE INDEX project_permission_requests_origin_run ON project_permission_requests(task_id, origin_run_id) WHERE origin_run_id IS NOT NULL;
