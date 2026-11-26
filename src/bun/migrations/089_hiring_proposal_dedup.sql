-- FO-INT01-FIX: Hiring Deduplication & Long-term PM Replay Idempotency.
--
-- Migration 089 enforces database-level uniqueness constraints for:
-- 1. Pending proposals per project and catalog role (prevents concurrent duplicate proposals).
-- 2. Project Manager message replay idempotency (prevents duplicate proposals from reprocessed turns).

-- At most one pending proposal per (project_path, catalog_role_slug).
CREATE UNIQUE INDEX IF NOT EXISTS idx_hiring_proposals_pending_role
  ON hiring_proposals(project_path, catalog_role_slug)
  WHERE status = 'pending';

-- Idempotent PM replay: at most one proposal per (project_path, source_message_id, catalog_role_slug).
CREATE UNIQUE INDEX IF NOT EXISTS idx_hiring_proposals_pm_replay
  ON hiring_proposals(project_path, source_message_id, catalog_role_slug)
  WHERE source_message_id IS NOT NULL;
