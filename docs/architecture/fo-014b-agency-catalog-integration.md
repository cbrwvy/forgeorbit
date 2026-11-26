# FO-014B — Agency Agents Catalog Integration Architecture

## 1. Context & Motivation

FO-014A vendored the complete upstream Agency Agents catalog (18 divisions, 283 professional agent profiles, metadata, and NEXUS scenario runbooks) into `resources/agent-catalog/agency-agents/`.

The goal of FO-014B is to integrate this catalog into ForgeOrbit's organizational core (`ai_employees`, `employee_executions`, and Owner approval flows) while strictly maintaining:
- **Zero runtime network dependencies**: Everything is read from local vendored resources.
- **Prompt immutability & isolation**: Original vendor markdown profiles are read-only; custom adaptations live in ForgeOrbit's database.
- **Owner boundary authority**: Only the Owner can authorize hiring new employees or modifying employee prompts.
- **Audit reproducibility**: Every task execution captures an immutable snapshot of the active prompt version.

---

## 2. Local Catalog Reader Architecture

### 2.1 File System & Indexing
The Bun backend runtime accesses catalog resources under `resources/agent-catalog/agency-agents/`.

```
resources/agent-catalog/agency-agents/
├── catalog-manifest.json   <-- Master index and integrity verification
├── divisions.json          <-- Division definitions, icons, brand colors
├── tools.json              <-- Tool contracts
├── strategy/               <-- NEXUS runbooks and team compositions
└── <division>/<agent>.md   <-- 283 original Markdown role profiles
```

### 2.2 `RoleCatalogService`
A singleton service in `src/bun/catalog/role-catalog.ts` provides local, cached catalog access:
- **Initialization**: On backend start, `RoleCatalogService` parses `catalog-manifest.json` into memory. No directory scanning on every request.
- **Lazy Profile Parsing**: Frontmatter (YAML delimited by `---`) and body sections (Role, Objectives, Tools, Personality, Deliverables) are parsed on demand and cached by role slug.
- **Security Sanitization**: Profiles are treated as passive, untrusted textual templates. Markdown rendering in the webview sanitizes script tags, links, and shell snippets.

---

## 3. Role Catalog in the User Interface

### 3.1 Division & Role Browser
Located in the Company Management section (`src/mainview/components/workspace/company/RoleCatalog.tsx`):
- **Division Sidebar / Grid**: Displays 18 divisions with their canonical Lucide icon and brand accent color from `divisions.json`.
- **Search & Filters**: Full-text search across role titles, descriptions, and specializations.
- **Role Cards**: Shows display title, division badge, summary, and primary capabilities.
- **Role Detail Drawer**: Shows the complete role overview, deliverables, operational workflows, and recommended runbook squads.

### 3.2 Strategy Runbook Browser
Exposes the 4 NEXUS scenario runbooks (`startup-mvp`, `enterprise-feature`, `marketing-campaign`, `incident-response`):
- Displays multi-agent squad compositions (Core Team, Growth Team, Support Team).
- Highlights which roles are currently filled in the organization and which are missing.

---

## 4. Selecting a Role for an Employee

When creating or editing an employee via `EmployeeFormDialog`:
1. **Catalog Role Selector**: The user can choose a template from the Role Catalog or start from scratch.
2. **Field Autofill**:
   - `job_title`: Derived from the role title (e.g., "Frontend Developer").
   - `role_category`: Mapped to the catalog division (e.g., "engineering").
   - `specializations`: Pre-populated JSON array of capability tags.
   - `description`: Pre-populated summary from the role profile.
3. **Template Association**: The employee record saves a soft reference to the catalog role slug (`role_slug: "engineering-frontend-developer"`).

---

## 5. Storage & Separation of Adapted Prompts

### 5.1 Principle of Clean Separation
The original vendor markdown file remains 100% untouched on disk. All adaptations, overrides, and customizations are persisted in SQLite.

### 5.2 Proposed Schema: `ai_employee_prompts`
A new table manages prompt revisions per employee:

```sql
CREATE TABLE IF NOT EXISTS ai_employee_prompts (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES ai_employees(id),
  base_role_slug TEXT NOT NULL,         -- e.g. "engineering-frontend-developer"
  base_prompt_sha256 TEXT NOT NULL,     -- Hash of original upstream markdown
  custom_instructions TEXT NOT NULL,    -- Project-specific or role customizations
  effective_system_prompt TEXT NOT NULL,-- Composed final prompt
  revision INTEGER NOT NULL DEFAULT 1,  -- Monotonic revision counter
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('owner', 'pm-proposal', 'system')),
  UNIQUE(employee_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_employee_prompts_active
  ON ai_employee_prompts(employee_id, revision DESC);
```

### 5.3 Prompt Composition Strategy
When synthesizing the active prompt:
```
[Base Catalog Role Persona (from vendor markdown)]
                +
[Company & Project Guidelines (from project settings)]
                +
[Employee Specific Customizations (from ai_employee_prompts)]
                =
[Effective System Prompt]
```
The UI provides a side-by-side diff between the original upstream catalog prompt and the employee's customized version.

---

## 6. PM Employee Proposal Lifecycle

### 6.1 Triggering a Proposal
- **Backlog Analysis**: A Project Manager (PM) or Head of Project Management analyzes project task requirements or squad needs (e.g. following a NEXUS runbook).
- **Gap Detection**: If required skills (e.g., "DevOps Automator" or "Security Auditor") are missing from the project team, the PM formulates a hiring proposal.
- **Proposal Generation**: The PM invokes an internal action that generates an entry in `organization_assignment_proposals` (or `ai_employee_hiring_proposals`).

### 6.2 Proposal Payload
```json
{
  "type": "hire_employee",
  "project_path": "/path/to/forgeorbit",
  "recommended_role_slug": "engineering-devops-automator",
  "suggested_name": "DevOps Specialist",
  "job_title": "DevOps Automator",
  "department": "Engineering",
  "rationale": "Required for CI/CD pipeline automation defined in Sprint 3",
  "custom_instructions": "Focus on Bun and Electrobun build packaging workflows",
  "status": "pending_owner_approval"
}
```

---

## 7. Owner Review & Approval Flow

### 7.1 Single-Tenant Security Model
ForgeOrbit follows a strict local Owner security boundary:
- Employees and PM agents cannot self-spawn or hire other agents without Owner consent.
- Proposals remain inert in `pending_owner_approval` status until explicitly reviewed.

### 7.2 Owner Review Interface
- The Owner sees an "Agent Hiring Proposal" notification card in the Company Management tab.
- The modal allows the Owner to:
  1. Inspect the upstream catalog role specification.
  2. Modify the employee's name, department, or job title.
  3. Review and edit the proposed prompt additions.
  4. Approve or reject the proposal with an optional comment.

### 7.3 Approval Execution
- **API Call**: `POST /api/employees/proposals/:id/confirm` with Bearer authentication.
- **Transaction**:
  1. Validates CAS revision of the proposal.
  2. Inserts new record into `ai_employees` with status `active`.
  3. Inserts initial revision 1 into `ai_employee_prompts`.
  4. Marks proposal as `approved`.
  5. Records append-only event in `ai_employee_events`.

---

## 8. Preserving Prompt Versions in Task Executions

### 8.1 Execution Attribution & Auditability
In `employee_executions` (migration 085), task runs are bound to the employee and assignment. To guarantee full historical reproducibility:
- Each execution records:
  - `prompt_id`: ID of the prompt record used.
  - `prompt_revision`: Exact revision of the prompt at runtime start.
  - `prompt_sha256`: SHA-256 hash of the effective system prompt.
- **Prompt Freeze**: When a task execution transitions to `awaiting-approval` and `starting`, the effective prompt text is frozen in the execution inputs bundle (`inputs_key`).
- **Post-Hoc Editing Safety**: If the Owner edits an employee's prompt while a run is in progress or after it finishes, past runs permanently retain their original prompt snapshot.

---

## 9. FO-014B Implementation Plan Summary

| Phase | Focus Area | Deliverables |
|---|---|---|
| **Phase 1** | Local Catalog Service | `RoleCatalogService.ts`, parsing `catalog-manifest.json`, unit tests |
| **Phase 2** | UI Role Catalog Browser | `RoleCatalog.tsx`, division cards, profile modal, search/filtering |
| **Phase 3** | Employee Creation Binding | Integration with `EmployeeFormDialog.tsx`, role slug binding |
| **Phase 4** | Prompt Separation Storage | Migration for `ai_employee_prompts`, prompt editor UI with upstream diff |
| **Phase 5** | PM Hiring Proposals | Proposal schema expansion, PM squad proposal prompts |
| **Phase 6** | Supervised Execution Freeze | Snapshotting prompt revision and hash in `employee_executions` |
