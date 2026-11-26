# FO-014C — Project Team Builder & Hiring Proposals Architecture

## 1. Overview & Core Mission

FO-014C introduces the Project Team Builder into ForgeOrbit. It enables Project Managers (PMs) to recommend specialized AI teams composed from the local Agency Agents catalog (`resources/agent-catalog/agency-agents/`) using pre-configured NEXUS scenario runbooks.

Crucially, **no employee is ever automatically hired or executed without Owner approval**:
- Recommendations parsed from Project Manager turns become inert `pending` proposals in `hiring_proposals`.
- The Owner inspects, edits, approves, or rejects each proposal.
- Upon Owner approval, an employee record is created in `ai_employees`, and an immutable initial professional profile revision is created in `ai_employee_professional_profiles` and `ai_employee_profile_revisions`.
- No tasks are automatically created or assigned; the Task Runtime is unaffected.

---

## 2. Canonical Runbooks Matrix

All runbook blueprints are loaded offline strictly from `strategy/runbooks.json`. The four canonical runbooks are:

| Slug | Title | Mode | Duration | Summary |
|---|---|---|---|---|
| `startup-mvp` | Startup MVP Build | NEXUS-Sprint | 4-6 weeks | Idea to live product with real users, fast — without skipping QA. |
| `enterprise-feature` | Enterprise Feature Development | NEXUS-Sprint | 6-12 weeks | Major feature in enterprise product with compliance and quality gates. |
| `marketing-campaign` | Multi-Channel Marketing Campaign | NEXUS-Sprint | 2-4 weeks | Coordinated multi-channel campaign across platforms. |
| `incident-response` | Incident Response | NEXUS-Micro | Minutes to hours | Detection through post-mortem for production incident containment. |

When an Owner or PM selects a runbook scenario, the Project Manager receives structured context inside the `## Project data` block as untrusted project data (delimited by `--- BEGIN project-manager-data <nonce> ---` and `--- END project-manager-data <nonce> ---`). It is never injected as privileged instructions.

---

## 3. Unified Validation Contract (FO-INT01-01)

- **Prompt Size Limit**: Both Employee Professional Profiles and Hiring Proposals enforce an exact `512 KiB` (`524,288` UTF-8 bytes) limit (`MAX_PROMPT_BYTES`).
- **UTF-8 Byte Measurement**: Measured via `Buffer.byteLength(prompt, "utf-8")` or `new TextEncoder().encode(prompt).length`, never JavaScript `String.prototype.length` code units.
- **Strict Verification Points**: Enforced at PM reply parsing, HTTP create (`POST /hiring-proposals`), HTTP edit (`PATCH /hiring-proposals/:id`), and HTTP approval (`POST /hiring-proposals/:id/approve`).
- **Zero Silent Truncation**: No field is silently truncated with `.slice()`. Any over-length string triggers an explicit 4xx error (`400` or `413`).
- **Strict Optional Fields**: Invalid types (e.g., `promptMarkdown: 42`) are strictly rejected with HTTP `400` instead of falling back to old or undefined values.

---

## 4. SQLite Concurrency & Deduplication (FO-INT01-02, FO-INT01-05)

- **Write Transactions**: All write operations in `HiringProposalCore` and `EmployeeProfileCore` execute inside `db.transaction(fn).immediate()`. This serializes concurrent SQLite connections at transaction start, preventing deadlocks and concurrent race conditions.
- **In-Transaction Active Duplicate Check**: Inside the `immediate()` write transaction, `checkActiveDuplicateEmployee` verifies whether an active employee with the same `(project_path, role_slug)` was already committed by another connection. If detected, approval fails with `409 Conflict`.
- **Database Index Constraints (Migration 089)**:
  - `idx_hiring_proposals_pending_role`: Partial unique index `(project_path, catalog_role_slug) WHERE status = 'pending'`.
  - `idx_hiring_proposals_pm_replay`: Partial unique index `(project_path, source_message_id, catalog_role_slug) WHERE source_message_id IS NOT NULL`.
- **PM Replay Idempotency**: Re-processing the same PM message returns existing proposals without duplicating entries or creating duplicate employees.
- **Optimistic Concurrency & Revision Precondition**:
  - Reassigning an existing employee profile requires `expectedRevision`. Omitting it returns `400 Bad Request`.
  - Profile updates and proposal state transitions use Compare-And-Swap (`WHERE id = ? AND current_revision = ?`). Mismatches return `409 Conflict`.
  - Re-approving an already approved proposal with identical options is an idempotent 200 no-op. Re-approving with conflicting payload returns `409 Conflict`.

---

## 5. Canonical Scope & Boundary Enforcement (FO-INT01-04)

- **Prefix Collision Prevention**: Project boundaries are strictly validated using `isWithin(projectPath, targetPath)`, preventing collisions such as `/work/app` vs `/work/app-other`.
- **Task Identity Validation**: Related task references must resolve to exactly one active task within the project's canonical root. Unresolved references (`0` matches) and ambiguous references (`>1` matches) are rejected. Tasks belonging to foreign projects or marked as archived are rejected.

---

## 6. Migration Ledger & Rollback Protocol (FO-INT01-06)

> [!CAUTION]
> **DO NOT EXECUTE `DROP TABLE hiring_proposals` OR MANUAL `DROP TABLE` STATEMENTS.**
> ForgeOrbit does NOT use automated reverse migrations (down-migrations). Modifying tables directly corrupts SQLite schema integrity and orphan records.

- **Ledger Authority**: ForgeOrbit's migration ledger is `_migrations` (NOT `schema_migrations`). Never delete or edit records in `_migrations`.
- **Rollback Requirements**: Rolling back any database migration or corrupted state strictly requires:
  1. A verified, consistent database backup made prior to applying the migration.
  2. Checking out a compatible codebase commit.
  3. Explicit Owner approval and verification before restoring data.
- **Migration History**:
  - `087_employee_professional_profiles.sql`: Professional profiles and monotonic prompt revisions.
  - `088_employee_hiring_proposals.sql`: Hiring proposals and append-only event ledger.
  - `089_hiring_proposal_dedup.sql`: Partial unique indexes for pending proposals and PM replay deduplication.
