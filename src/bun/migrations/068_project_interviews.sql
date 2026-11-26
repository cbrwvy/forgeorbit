-- AI project interview drafts (FO-003). One row per planned project folder:
-- the interview transcript, notes, and IDEA/PRD drafts the wizard is building,
-- so going back, closing the wizard, a CLI error, or an app restart doesn't
-- lose them. The row is deleted once the documents are saved or the user
-- discards the interview.
--
-- Its own table rather than `preferences`: a draft can be hundreds of KB and
-- would otherwise ride along on every `GET /preferences` and `agetor config ls`
-- (same reasoning as 067_retention_swept_tasks). Keyed by path, not by project
-- id, because the interview runs before the project is registered.
CREATE TABLE project_interviews (
  project_path TEXT PRIMARY KEY,
  data         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
