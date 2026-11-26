# FO-015A.1 — Company Activity Journal Backend

Date: 2026-10-26 (UTC). Worktree: `forgeorbit-journal-fix`.
Branch: `task/fo-015a1-fix01`. Base: `45cc9b363e81c9dd157e317b248cbc3f8f0ae2a2`.

## A. Existing Event Architecture Audit

Prior to FO-015A.1, ForgeOrbit maintained several fragmented, domain-specific event streams and status tables without a unified chronological audit journal for the Owner:

1. **Ephemeral Application Events (`app_events` / SSE)**:
   - Emitted via `broadcastAppEvent()` in `src/bun/quit-guard.ts` to active SSE clients connected to `GET /app/events`.
   - Ephemeral in-memory fan-out with no database persistence. Disconnected clients lost missed events.
   - Event types included `run_started`, `run_done`, `run_failed`, `task_updated`, `claude_token_consumed`, etc.

2. **Run Execution Events (`run_events`)**:
   - Table `run_events` (migration 018, 039) stored terminal chunk-level execution events (`output`, `error`, `finish`) tied strictly to low-level agent runs.
   - Used for console log reconstruction, not business intent or organizational decision tracking.

3. **Domain-Specific Audit Logs**:
   - `organization_assignment_proposals` (migration 084): tracked proposal lifecycle (`pending`, `approved`, `rejected`, `stale`) with an append-only JSON event array in the `events` column.
   - `employee_hiring_proposals` (migration 088, 089): tracked candidate hiring approvals with an embedded event trail.
   - `employee_executions` (migration 085, 090): tracked single-turn execution attempt state machine (`awaiting-approval`, `starting`, `started`, `start-failed`, `indeterminate`, `rejected`, `cancelled`, `expired`, `superseded`).
   - `employee_execution_turns` (migration 091): tracked multi-turn follow-up submissions (`reviewed`, `approved`, `claimed`, `prepared`, `included`, `failed`, `indeterminate`).

**Gap Analysis**:
The Owner had no single canonical timeline answering:
- Which Project Manager proposed or assigned a task?
- Which AI Employee was designated for the work?
- What approvals were granted by the Owner?
- When did the employee execution actually start?
- How did execution terminate?
- Were follow-up turns approved and submitted?
- Where did failures or indeterminate deliveries occur?

FO-015A.1 introduces the **Company Activity Journal** (`activity_events`) as the single source of truth for confirmed business events across all subsystems.

---

## B. Implemented Event Catalog

The Activity Journal records strictly confirmed business facts with atomic transactional boundaries across 18 canonical event types (`ACTIVITY_EVENT_TYPES`):

| Event Type | Actor Type | Actor ID | Target Type | Recorded At | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `employee.hired` | `owner` | `"owner"` | `employee` | `HiringProposalCore.approve()` | Candidate hiring proposal approved; AI employee & profile created. |
| `employee.archived` | `owner` | `"owner"` | `employee` | `EmployeeCore.archive()` | AI employee archived from active organization duty. |
| `employee.unarchived` | `owner` | `"owner"` | `employee` | `EmployeeCore.unarchive()` | AI employee restored to active organization duty. |
| `employee.assigned` | `owner` | `"owner"` | `task` | `AssignmentCore.assign()` / `reassign()` | AI employee assigned or reassigned to a task in the registered project. |
| `employee.unassigned` | `owner` | `"owner"` | `task` | `AssignmentCore.unassign()` | Active task assignment removed by Owner. |
| `task.proposal.created` | `project-manager` | `"project-manager"` | `proposal` | `runJob()` in `project-manager.ts` | Project Manager generated task proposal in project backlog. |
| `task.assignment.proposed` | `project-manager` / `owner` | PM employee ID / `"project-manager"` / `"owner"` | `proposal` | `AssignmentProposalCore.insertProposal()` | PM or Owner created a task assignment proposal for review. |
| `task.assignment.approved` | `owner` | `"owner"` | `proposal` | `AssignmentProposalCore.approve()` | Owner confirmed assignment proposal (`changes === 1`). |
| `task.assignment.rejected` | `owner` | `"owner"` | `proposal` | `AssignmentProposalCore.close("rejected")` | Owner rejected assignment proposal (`changes === 1`). |
| `execution.reviewed` | `owner` | `"owner"` | `execution` | `EmployeeRunCore.createOrReuse()` | Supervised execution attempt reviewed and placed in `awaiting-approval` state. |
| `execution.approved` | `owner` | `"owner"` | `execution` | `EmployeeRunCore.claim()` | Owner confirmed execution attempt (`changes === 1`); claimed for launch. |
| `execution.started` | `system` | `"runtime"` | `execution` | `EmployeeRunCore.markStarted()` | Supervised process spawned and run registered (`changes === 1`). |
| `run.completed` | `employee` | `row.employee_id` | `task` | `EmployeeRunCore.finish()` (`result === "succeeded"`) | Execution finished with verified `succeeded` outcome (`changes === 1`). |
| `run.failed` | `employee` | `row.employee_id` | `task` | `EmployeeRunCore.finish()` (`result !== "succeeded"`) | Execution finished with non-succeeded outcome (`failed`, `cancelled`, `orphaned`) (`changes === 1`). |
| `turn.proposed` | `owner` | `"owner"` | `turn` | `ProfessionalTurnCore.review()` | Follow-up conversation turn prepared and recorded in `reviewed` state. |
| `turn.approved` | `owner` | `"owner"` | `turn` | `ProfessionalTurnCore.claim()` | Owner confirmed follow-up turn (`changes === 1`). |
| `turn.submitted` | `system` | `"runtime"` | `turn` | `ProfessionalTurnCore.transition("included")` | Approved follow-up turn accepted by adapter session (`changes === 1`). |
| `delivery.indeterminate` | `system` | `"runtime"` | `execution` / `turn` | `EmployeeRunCore.settleStart("indeterminate")` / `ProfessionalTurnCore.transition("indeterminate")` / `settleInitialProfessionalTurn(included=false)` | Execution start or turn delivery could not be verified (`changes === 1`). |

---

## C. `activity_events` Data Model & Schema

Migration `092_company_activity_journal` creates the `activity_events` table:

```sql
CREATE TABLE IF NOT EXISTS activity_events (
  sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  project_path TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'project-manager', 'employee', 'system')),
  actor_id TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('company', 'project', 'employee', 'task', 'proposal', 'execution', 'turn')),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  task_id TEXT,
  run_id TEXT,
  execution_id TEXT,
  turn_id TEXT,
  employee_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  source_event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_events_project ON activity_events(project_path, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_actor ON activity_events(actor_type, actor_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_employee ON activity_events(employee_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_task ON activity_events(task_id, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_type ON activity_events(event_type, sequence_id);
CREATE INDEX IF NOT EXISTS activity_events_created ON activity_events(created_at, sequence_id);
```

### Soft Reference Architecture
ForgeOrbit conventions purposefully use soft references (no `FOREIGN KEY ... ON DELETE CASCADE`) for `task_id`, `run_id`, `employee_id`, `execution_id`, `turn_id`, and `project_path`. This prevents cascading deletions from destroying immutable audit history and prevents task deletions from failing due to historical rows.

### Append-Only Triggers (Conflict, Update, and Delete Protection)
Enforced at the SQLite engine level via three triggers in `src/bun/migrations/092_company_activity_journal.ts`:
- `activity_events_no_replace`: `BEFORE INSERT ON activity_events WHEN EXISTS (SELECT 1 FROM activity_events WHERE sequence_id = NEW.sequence_id OR id = NEW.id OR idempotency_key = NEW.idempotency_key)` raises `ABORT` with `'activity_events is append-only: replacement is prohibited'`. This blocks `INSERT OR REPLACE`, `INSERT OR IGNORE`, `INSERT ... ON CONFLICT DO UPDATE`, and duplicate `INSERT` statements even when `PRAGMA recursive_triggers = OFF`.
- `activity_events_no_update`: `BEFORE UPDATE ON activity_events` raises `ABORT` with `'activity_events is append-only: updates are prohibited'`.
- `activity_events_no_delete`: `BEFORE DELETE ON activity_events` raises `ABORT` with `'activity_events is append-only: deletes are prohibited'`.

---

## D. Actor and Target Attribution Rules

Strict attribution invariants are enforced at ingestion:

1. **Actor Types (`ActivityActorType`)**:
   - `owner`: Direct actions by the human Owner (approving proposals, hiring, archiving/unarchiving, assigning/unassigning, reviewing/confirming runs, proposing/approving turns).
   - `project-manager`: Actions initiated by the project manager agent (generating task proposals, proposing assignments).
   - `employee`: Run completion/failure outcomes attributed to the assigned AI Employee (`row.employee_id`).
   - `system`: Runtime transitions (`execution.started`, `turn.submitted`) and unconfirmed delivery settlements (`delivery.indeterminate`).

2. **Target Types (`ActivityTargetType`)**:
   - `company`: Virtual organization level.
   - `project`: Project-scoped entity.
   - `employee`: Employee entity lifecycle (`employee.hired`, `employee.archived`, `employee.unarchived`).
   - `task`: Task entity lifecycle (`employee.assigned`, `employee.unassigned`, `run.completed`, `run.failed`).
   - `proposal`: Proposal entity lifecycle (`task.proposal.created`, `task.assignment.proposed`, `task.assignment.approved`, `task.assignment.rejected`).
   - `execution`: Single-turn execution attempt lifecycle (`execution.reviewed`, `execution.approved`, `execution.started`, execution-level `delivery.indeterminate`).
   - `turn`: Multi-turn conversational turn lifecycle (`turn.proposed`, `turn.approved`, `turn.submitted`, turn-level `delivery.indeterminate`).

3. **Multi-Turn Project Attribution**:
   - In `ProfessionalTurnCore` and `settleInitialProfessionalTurn()`, `projectPath` is resolved directly from the verified immutable `employee_executions` row (`WHERE id = turnRow.attempt_id AND run_id = turnRow.run_id AND task_id = turnRow.task_id`), ensuring all multi-turn events (`turn.proposed`, `turn.approved`, `turn.submitted`, `delivery.indeterminate`) are accurately returned by `GET /activity?projectPath=...`.

---

## E. Transaction Boundaries & Guarantees

1. **Colocated Transaction Writes**:
   - Every subsystem method that records an activity event (`HiringProposalCore.approve`, `EmployeeCore.archive/unarchive`, `AssignmentCore.assign/reassign/unassign`, `AssignmentProposalCore.insertProposal/approve/close`, `EmployeeRunCore.createOrReuse/claim/markStarted/settleStart/finish`, `ProfessionalTurnCore.review/claim/transition/recover`, and `settleInitialProfessionalTurn`) executes inside an atomic SQLite write transaction (`db.transaction(...).immediate()`).
   - Guarded transitions (`markStarted`, `settleStart`, `finish`, `transition`, `settleInitialProfessionalTurn`) inspect `this.db.run(...).changes === 1` and verify the post-update row state before calling `ActivityJournalCore.record()`. Failed, stale, or no-op updates (`changes === 0`) never emit activity events.
2. **Crash & Restart Resilience**:
   - Once a transaction commits, SQLite WAL durability guarantees the event persists across process restarts.
   - In-flight uncommitted transactions and rolled-back nested savepoints leave zero rows in `activity_events`.

---

## F. Migration 092 Implementation

- File `src/bun/migrations/092_company_activity_journal.sql`: creates table `activity_events` with `CHECK` constraints and indexes keyed by `(column, sequence_id)`.
- File `src/bun/migrations/092_company_activity_journal.ts`: runs DDL and installs `activity_events_no_replace`, `activity_events_no_update`, and `activity_events_no_delete` triggers.
- Registered in `src/bun/migrations/index.ts` with ID `092_company_activity_journal`.

---

## G. Idempotency Mechanism

Every event has a mandatory `idempotency_key TEXT NOT NULL UNIQUE` constraint:
- Deterministic keys are derived from domain entities:
  - `hiring_proposal:${id}:approved`
  - `employee:${id}:archived:${now}` / `employee:${id}:unarchived:${now}`
  - `assignment:${assignmentId}:${revision}`
  - `pm_proposal:${proposalId}:created`
  - `assignment_proposal:${id}:created` / `assignment_proposal:${id}:approved` / `assignment_proposal:${id}:rejected`
  - `execution:${id}:reviewed`
  - `execution:${id}:approved:${revision}`
  - `execution:${id}:started:${runId}`
  - `execution:${id}:indeterminate`
  - `run:${runId}:finished`
  - `turn:${id}:proposed`
  - `turn:${id}:approved:${revision}`
  - `turn:${id}:submitted`
  - `turn:${id}:indeterminate`
- `ActivityJournalCore.record()` checks for existing `idempotency_key` before insertion and also catches concurrent `UNIQUE` / trigger conflicts on the same `idempotency_key`, returning `{ event: existing, created: false }` without emitting duplicate SSE notifications.

---

## H. Backend API Specification

Read-only authenticated endpoints mounted on `src/bun/server.ts` (`/activity` and `/activity-events`):

### 1. `GET /activity`
Returns a paginated list of activity events matching validated query filters.

**Authentication**: Bearer token (`Authorization: Bearer <API_TOKEN>`).
**Query Parameters** (all strictly validated; unknown or malformed parameters return `400 Bad Request`):
- `limit`: integer between `1` and `100` (default: `50`).
- `cursor`: positive integer string representing `sequenceId` (`"1"`, `"42"`, etc.).
- `direction`: `"backward"` (default, `ORDER BY sequence_id DESC`) or `"forward"` (`ORDER BY sequence_id ASC`).
- `projectPath`: non-empty string, filters by exact `project_path`.
- `actorType`: `"owner" | "project-manager" | "employee" | "system"`.
- `actorId`: non-empty string.
- `employeeId`: non-empty string, matches `employee_id = ?` or employee actor/target.
- `targetType`: `"company" | "project" | "employee" | "task" | "proposal" | "execution" | "turn"`.
- `targetId`: non-empty string.
- `taskId`: non-empty string.
- `runId`: non-empty string.
- `eventType`: single supported `ActivityEventType` or comma-separated list of supported `ActivityEventType`s.
- `since` (or alias `from`): non-negative integer timestamp in milliseconds (`created_at >= ?`).
- `until` (or alias `to`): non-negative integer timestamp in milliseconds (`created_at <= ?`).

**Response (`200 OK`)**:
```json
{
  "events": [
    {
      "sequenceId": 42,
      "id": "c1f7b...",
      "eventType": "task.assignment.approved",
      "schemaVersion": 1,
      "projectPath": "/path/to/project",
      "actorType": "owner",
      "actorId": "owner",
      "targetType": "proposal",
      "targetId": "prop-123",
      "taskId": "task-456",
      "runId": null,
      "executionId": null,
      "turnId": null,
      "employeeId": "emp-789",
      "idempotencyKey": "assignment_proposal:prop-123:approved",
      "sourceEventId": null,
      "payload": {
        "proposalId": "prop-123",
        "taskId": "task-456",
        "employeeId": "emp-789",
        "assignmentId": "assign-1",
        "assignmentRevision": 1
      },
      "createdAt": 1729940000000
    }
  ],
  "nextCursor": "41",
  "hasMore": true
}
```

### 2. `GET /activity/:id`
Returns a single activity event by its UUID or `sequenceId`.

**Status Codes**:
- `200 OK`: `{ "event": ActivityEvent }`.
- `400 Bad Request`: Invalid path or query filter parameter.
- `401 Unauthorized`: Missing or invalid Bearer token.
- `404 Not Found`: Event does not exist.
- `405 Method Not Allowed`: Returned for any mutative HTTP method (`POST`, `PUT`, `DELETE`, `PATCH`).

---

## I. Filtering and Stable Pagination

- Ordering uses the strictly monotonic primary key `sequence_id`:
  - `direction = "backward"` (default): `WHERE sequence_id < ? ORDER BY sequence_id DESC`
  - `direction = "forward"`: `WHERE sequence_id > ? ORDER BY sequence_id ASC`
- Cursor format: bare positive integer string `${sequence_id}`.
- Guaranteed properties:
  - Stable across concurrent insertions (no page shifting or missing items).
  - No duplicate records across page boundaries.
  - Zero skips when multiple events share identical millisecond `created_at` timestamps.

---

## J. Post-Commit SSE Integration (`app_events`)

- When `ActivityJournalCore.record()` inserts a new row (`created: true`), it queues the event in a per-`Database` pending notification map and schedules `ActivityJournalCore.flushNotifications(db)`.
- **Post-Commit & Rollback-Safe Invariant**:
  1. `flushNotifications(db)` refuses to dispatch while `db.inTransaction` is `true` (deferring until the outermost transaction finishes).
  2. Once `!db.inTransaction`, `flushNotifications(db)` queries committed SQLite state (`SELECT sequence_id FROM activity_events WHERE id = ? AND sequence_id = ? AND idempotency_key = ? LIMIT 1`).
  3. If the outer transaction or an inner `SAVEPOINT` rolled back, the row is absent from committed storage and the notification is discarded without broadcasting.
  4. Confirmed committed events are deduplicated by `event.id` and broadcast as flat metadata summaries:
     ```ts
     broadcastAppEvent({
       type: "activity_event",
       eventId: event.id,
       eventType: event.eventType,
       projectPath: event.projectPath,
       actorType: event.actorType,
       actorId: event.actorId,
       targetType: event.targetType,
       targetId: event.targetId,
       sequenceId: event.sequenceId,
       ts: event.createdAt,
     });
     ```
- **Recovery via REST**: SSE is a best-effort live signal, not a durable source of truth. Clients recover any missed events after reconnect via `GET /activity?cursor=<lastSequenceId>&direction=forward`.

---

## K. Security, Privacy, and Payload Sanitization

`ActivityJournalCore.record()` and `sanitizePayload()` enforce defense-in-depth payload protection:
1. **Per-`event_type` Allowlist Schema (`EVENT_PAYLOAD_SCHEMAS`)**:
   - Every supported `ActivityEventType` has an explicit map of permitted field names and primitive/string-array types (`"string" | "number" | "boolean" | "string[]"`).
   - Unknown `eventType` values are rejected with `ActivityJournalError` (`400`).
   - Unknown payload keys, unexpected value types, and unvalidated nested objects/arrays are stripped.
2. **Forbidden Key Denylist**:
   - Keys matching `prompt`, `promptMarkdown`, `adaptedPrompt`, `userPrompt`, `systemPrompt`, `markdown`, `password`, `passwd`, `secret`, `clientSecret`, `client_secret`, `token`, `accessToken`, `access_token`, `refreshToken`, `refresh_token`, `apiKey`, `api_key`, `accessKey`, `access_key`, `privateKey`, `private_key`, `authorization`, `auth`, `credential`, `credentials`, `keychain`, `cookie`, `session_key`, `bearer`, `stdout`, `stderr`, `stack`, `stacktrace`, `raw_output`, `cli_output`, `env`, `message`, `content`, `metadata`, `description`, and `error` are unconditionally stripped at all depths.
3. **Prompt Safe Digest**:
   - If a raw `prompt` string is supplied on `turn.proposed` (or top-level `sanitizePayload`), only `promptSha256` (64-char hex SHA-256) and `promptLength` (character count) are stored; the raw prompt string is discarded.
4. **String Secret Redaction & Stack Stripping**:
   - All allowed string values pass through `sanitizeStringValue()`, which strips stack trace frames (`\n\s+at ...`) and redacts PEM private keys, OpenAI/Anthropic `sk-*` keys, GitHub `ghp_*` / `github_pat_*` tokens, AWS `AKIA*` keys, Slack `xox*` tokens, Google `AIza*` keys, GitLab `glpat-*` tokens, `Bearer`/`Basic` tokens, JWTs (`eyJ...`), URL credentials, and `key=value` secret assignments.
5. **Structural & Size Bounds (`PAYLOAD_LIMITS`)**:
   - Max depth: `3` levels (`maxDepth: 3`).
   - Max keys per object: `20` (`maxObjectKeys: 20`).
   - Max items per array: `20` (`maxArrayItems: 20`).
   - Max string length: `500` chars (`maxStringChars: 500`), array item strings: `200` chars (`maxArrayStringChars: 200`).
   - Max serialized JSON payload size: `4096` bytes (`maxPayloadBytes: 4096`).

---

## L. Future Localization Contract (EN / RU)

In alignment with parallel task **FO-I18N01**:
- The Activity Journal is strictly **language-agnostic** at the event classification and schema level (`eventType`, `actorType`, `targetType`, and structured payload keys).
- Zero frontend or translation files are modified by this backend module.
