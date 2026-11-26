# FO-UX-SIMPLIFY01 — Product UX simplification audit

Status: **audit and design proposal for Owner decision.** No UI code, backend, authorization rule, Keychain or signing identity was changed. Base: `main` @ `b2e8276f`.

Builds on, and does not replace: `docs/design/fo-ux01-audit.md` (visual and layout defects), `docs/design/fo-ux02d-ia-proposal.md` (IA variants A/B/C, awaiting Owner decision), `docs/architecture/fo-i18n01-en-ru.md` (localization contract).

## 0. How this audit was done, and its limits

| Source | What it gives | Tag used below |
|---|---|---|
| Isolated headless core (temp data dir, stubbed harness binaries, fake drivers, offline usage poller) plus Vite, viewed in the in-app browser at **Russian locale, empty profile, one demo project, ~800×600 viewport** | Real rendered text and structure of every rail page, all 9 Settings sections, the project workspace header and the legacy Manager page | **O** (observed) |
| Source under `src/mainview/` and `src/shared/` | Everything O cannot reach: populated states, English strings, conditional UI | **C** (code) |
| `docs/` | Roadmap, prior UX work, architecture | **D** |

**Not done, stated plainly:**
- The packaged `.app` was **not** launched. Native-only surfaces (the Owner Touch ID review, the native helper) were not seen. NATIVE-005 remains blocked in the roadmap; nothing here changes that.
- The English UI was read from dictionaries and code, not rendered.
- The profile was empty, so populated cards (task cards, Run panel, hiring proposals, execution history, populated Accounts) were audited from code only.
- The user's real profile, Keychain and installed app were never touched. The isolated core and Vite were started for this audit and stopped at the end.
- The "32 roadmap directions" are not enumerated as a numbered list in `docs/ROADMAP.md` (it has completed/partial/missing/blocked sections and ~70 FO-* entries). Section 13 therefore states a preservation rule instead of a mapping to 32 named items.

## 1. Current UI inventory

### 1.1 Shell
- **Title bar:** harness chips (e.g. "Claude Code", "Antigravity"), running-task counter, **New task** button, icon-only **Git**, **Worktrees**, **Pipelines**, **Settings** (O, C `App.tsx`).
- **Head of PM orb/dock**, bottom-right (`HeadOfPmDock`): scope selector (workspace / clusters / projects / tasks), history, composer, a "One-turn access" disclosure, status states, "Needs you" link.
- **Left rail**, 12 global items (O): Overview · Needs you · Company · Portfolio · Clusters · Analytics · Missions · Knowledge · Brain ("Память") · Browser · Native computer · All tasks; then the project list; then Add project / Clone repository.
- **Project workspace tabs**, 9 controls (O/C `ProjectHeader`): Overview · Board · Estimates · Environment · *Open Head of PM* (an action, not a tab) · "Legacy Manager" · Settings · Knowledge · Brain. Above the tabs: breadcrumb, name, truncated path, cluster, **New task ⌘N**, and a project lifecycle bar ("AI execution: Active", Start / Stop buttons).
- **Emergency stop**: the only control is inside Mission Control → Autonomy policy panel (C: `grep -i emergency` in `src/mainview` matches only `AutonomyControlPanel.tsx` and `PracticalCyclePanel.tsx`; the latter only says the stop "lives in autonomy control", O).

### 1.2 Global pages (O unless noted)
| Rail item | Content | Sub-structure |
|---|---|---|
| Overview | Project list + "All tasks" button; empty state | — |
| Needs you | Attention list; "Resources and quotas" info block; link to Portfolio | — |
| Company | Owner/CEO card, Head of PM card, org chart, staff, hiring, role catalog, activity journal | Tabs: Dashboard · Organization · Staff · Activity journal |
| Portfolio | Read-only totals; per-harness resource cards; attention | Tabs: Overview · Head settings; link "Accounts and resources" |
| Clusters | Cluster directory; cluster dashboard | Tabs (cluster): Overview · Projects · Organization · Knowledge · Infrastructure |
| Analytics | Page titled "AI Resources" with provider capability matrix | Tabs: AI Resources · Forecasts · Analytics |
| Missions | "Multi-Project Mission Control": Autonomy policy, Owner authorization, Practical cycle, Self-improvement, Infra operations, Live execution approval, then missions | one long page |
| Knowledge | Company Markdown note library | filters, note editor |
| Brain | Company memory: records, candidates, vector index, search modes | Tabs: Records · Candidates |
| Browser | Owner browser session; agent browser access | — |
| Native computer | Owner native session; app picker; permission status | — |
| All tasks | Kanban across projects | filters ×6 |

### 1.3 Project pages
Overview (stats, environment, project docs, team, assignment proposals, recent tasks) · Board · Estimates · Environment · Settings (project rules) · Knowledge · Brain · **Legacy Manager** (sub-tabs: Conversation history · Project inbox · Plan and queue · Runs; plus hiring proposals, assignment proposals, project-context settings, decisions) (O).

### 1.4 Settings dialog: 9 sections (O)
General · Harnesses ("Среда провайдеров") · Accounts & resources (7 sub-views + Codex profiles + Execution profiles) · AI router 2.0 · Agents (profiles) · Pipelines · Git integration · Saved prompts · Backup and restore.

### 1.5 Dialogs and flows (C)
Welcome dialog + Onboarding checklist · Project wizard (project → docs → environment → launch → review, optional AI interview) · Clone repository · New task sheet / pinned panel · Task details (Run panel) · Task context menu · Git/PR dialog · Worktrees dialog · Pipelines page + editor + run view · Bundle import/export · Quit confirmation · Employee, Head, Cluster, Infrastructure resource forms · Hiring/Team-builder · Diff/Plan dialogs · Usage popover.

## 2. Main usability problems

Severity: **P0** = blocks understanding or safety-relevant access; **P1** = repeatedly confuses everyday use; **P2** = polish. "Keep" = the underlying capability stays; the column says where.

### 2.1 Navigation and information architecture
| ID | Sev | Problem | Evidence | Keep → where |
|---|---|---|---|---|
| N1 | P0 | **Emergency stop is not reachable from everyday screens.** The Owner must open Missions and scroll past the policy form to find it. | C | Keep → persistent title-bar control (§3.4) |
| N2 | P1 | Rail has 12 global items of mixed kind (objects, tools, reports, sessions). | O | All reachable (§3) |
| N3 | P1 | **Knowledge and Brain are two rail items and two project tabs**; the Owner must know that "Знания" = Markdown notes and "Память" = learned memory with candidates. | O, C | Merge into one Knowledge area with two tabs |
| N4 | P1 | **Overview / Portfolio / Clusters / Company / Mission Control** all answer "how is my company doing"; none is the obvious start. | O | Home + Projects + AI Team (§3) |
| N5 | P1 | **A working surface is labelled "Legacy".** The "Прежний менеджер" tab still hosts Plan and queue, Runs (autonomous execution), hiring proposals and assignment proposals. A label that says "legacy" signals "do not use" for the exact place the everyday workflow lives. | O | Keep → rename and promote to "Plan and runs" |
| N6 | P1 | The project tab strip mixes pages with an action ("Open Head of PM") and has 9 controls; at 800 px the last tabs are clipped. | O | Reduce to 5 + "More" |
| N7 | P1 | **Analytics page title mismatch:** rail "Аналитика" opens a page titled "AI Resources" whose third tab is "Аналитика". | O | Rename; one title per page |
| N8 | P1 | **Three autonomy-mode selectors**: Mission Control policy ("Под контролем / Автономный / Полная автономия"), AI router ("Supervised / Autonomous / Full Autonomy"), and per-batch autonomy grant in project Runs. The router's is only a *preference* ("Preference: supervised. Enforced execution: supervised."). | O, C | Keep all semantics; one Owner-facing "Autonomy" page (§6) |
| N9 | P1 | Resource facts live in four places: Portfolio resource cards, Settings → Accounts, Analytics → AI Resources, "Needs you → Resources and quotas". | O | Single "Capacity" view; others link to it |
| N10 | P2 | Browser and Native computer are rail items although they are Owner sessions and per-message access grants, not daily destinations. | O | Move to Settings → Tools and access; contextual entry in Head dock |
| N11 | P2 | Git, Worktrees, Pipelines are icon-only title-bar buttons without labels (O: only tooltips). | O, D | Keep visible; label or group in a "Tools" menu |
| N12 | P2 | Infrastructure inventory is a Clusters tab, and infra operations sit inside Mission Control. | C | Contextual to cluster/project |

### 2.2 Technical leakage (implementation detail in everyday screens)
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| T1 | P0 | **Owner authorization panel is a 12-row diagnostic dump** shown on Mission Control: bundle id, expected bundle id, certificate SHA-256, helper identifier, Secure Enclave, enrollment state, channel code, plus a 17-field operation block (ids, `mode`, `scope`, cost coverage). Raw values surface: `unestablished`, `not pinned`, `none`, `application-identity-unestablished`. | O, C `OwnerTrustPanel.tsx:84-136` |
| T2 | P1 | Portfolio resource cards print raw enums: "Происхождение квоты: unknown", "Доступность: unavailable", harness ids `claude-code`, `codex`, `cursor`. | O |
| T3 | P1 | Brain page headline status exposes the embedding stack: "384d transformers-local, Xenova/paraphrase-multilingual-MiniLM-L12-v2". | O |
| T4 | P1 | Mission policy form exposes tooling internals: "Требовать фиксированный наблюдаемый тест Bun", "QC PASS", "Пределы: 1 · 20000ms · 24000" (unitless third value), "0/8 candidates · 0/3 activations". | O |
| T5 | P1 | Raw state strings are rendered directly in JSX in many components (128 `{x.status/state/mode/scope/kind/phase}` expressions in `components/`; not all are user-visible, but the pattern is the root cause of T1/T2). | C |
| T6 | P1 | Settings → Harnesses is a provider-adapter inspector ("fo-providers-runtime01", adapter, CLI version, "Привязка аккаунта") rather than "which AI tools are ready". | O |
| T7 | P2 | Task and mission titles are followed by internal ids (`{taskTitle} · {taskId}`, "rev N"). | C |
| T8 | P2 | Project header shows the (truncated) absolute folder path on every tab. | O |

### 2.3 Language and terminology
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| L1 | P0 | **Mission Control is partly hard-coded English** in a Russian UI: "Refresh", "Authorize Plan", "Start Mission", "Pause", "Resume", "Cancel", raw uppercase status chip, English `|| "…"` fallbacks. The i18n audit reports "0 unapproved raw static text", so the page post-dates or escapes that gate. | O, C `MissionControlPage.tsx:228-303` |
| L2 | P1 | Backend sentences leak untranslated into Russian pages: "No valid stored quota snapshot.", "The account behind this harness is not identified. It may share an account…" (repeated once per harness), "The owner is a person, not an AI account…" (Company), "This is a development or QA build…" (twice in a row, Mission Control). | O |
| L3 | P1 | **Kanban columns are English in the Russian UI**: "BACKLOG", "INBOX" beside "ГОТОВ", "ВЫПОЛНЯЕТСЯ", "ЗАБЛОКИРОВАНО", "ПРОВЕРИТЬ", "ЗАВЕРШЕНО"; project stats show "Backlog Inbox Ready Running Blocked Review Done". | O |
| L4 | P1 | Accounts dashboard sub-views are raw English identifiers in Russian: "Accounts / Subscriptions / Quotas / Quota Sources / Resource Availability / Unassigned Usage / Archived Accounts". | O, C `AccountsDashboard.tsx:48-56` |
| L5 | P1 | AI router mixes Title-Case Russian ("Максимальное Качество"), English enum labels ("Supervised/Autonomous/Full Autonomy") and English sentences. | O |
| L6 | P1 | Legacy Manager page: English status chips (Pending/Approved/Rejected/Withdrawn/Stale/All), "Project identity", "Not found in the project.", "Board tasks", "no launch profile is configured". | O |
| L7 | P1 | **Five nouns for "who does the work"**: Employee (company specialist), Agent (launch profile), Harness ("Среда CLI"/"Среда провайдеров"), Account/Profile, Model. "Среда" also collides with project "Окружение" (environment). | O |
| L8 | P1 | **Four names for the planner:** "Head of PM", "Руководитель управления проектами" (Company), "руководитель проектов" (project page), "Менеджер"/"Прежний менеджер", "Настройки руководителя" for its settings tab. | O |
| L9 | P2 | Mixed Latin/Cyrillic labels: "Закрепить панель New task", "Claude Code (claude-code)", `Head of PM` kept Latin in subtitles. | O |
| L10 | P2 | Several pages begin with defensive meta-statements before the task ("Статус адаптера не означает живое подключение…", five "≠" sentences on Accounts). The honesty is valuable; the placement before the primary content is not. | O |

### 2.4 Safety presentation
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| S1 | P1 | The same disclaimer pair ("Живой запуск провайдера недоступен… / Нативная авторизация владельца подписывает одну точную операцию…") is repeated verbatim on Settings → Harnesses and Analytics → AI Resources, and re-explained in Mission Control. Repetition trains the Owner to skip it. | O |
| S2 | P1 | A blocked state is often explained by a second sentence next to a disabled button ("Запуск недоступен: проект уже активен.") instead of a single control that states its state. | O |
| S3 | P1 | The Owner-trust "next action" is a developer instruction ("Rebuild the application so forgeorbit-owner-trust is inside the bundle.", "Sign the helper with the same local Owner certificate") shown to the Owner as the primary text. | C `en.ts:230-239` |
| S4 | P2 | Several status chips encode meaning by colour alone (mission status chip tones). | C |
| S5 | P2 | "Unknown" is rendered as a flat word in many places; it is correct but gives no consequence ("what does this stop me from doing?"). | O |

### 2.5 Settings, forms, defaults, confirmations
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| F1 | P1 | Settings → General has ~33 controls, mixing language/theme with tmux source, macOS TCC disclaim, fx auto-resume. | O |
| F2 | P1 | **Operational controls inside Settings and settings inside operations**: autonomy policy sits on the Missions page; project Start/Stop is in the header while "project rules" are a separate Settings tab; router "Save policy" lives in Settings but affects a running mission. | O |
| F3 | P1 | Mission policy form shows ~22 inputs at once (allowed projects, providers, models, accounts, workers/runs/minutes, expected time, API budget, 4 "require…" toggles, QC, self-improvement) with no presets. | O |
| F4 | P1 | The Head dock puts up to five per-message access pickers (Brain, Knowledge, Browser, Native, memory opt-in) next to the composer behind "One-turn access". Correct for safety; heavy for everyday asking. | C |
| F5 | P1 | Project wizard: 5 steps + optional AI interview before the first project exists. The "launch profile" step asks harness/model/effort questions before the Owner has stated a goal. | C |
| F6 | P2 | New task offers a pinned 320 px panel, a title-bar button, a project button and ⌘N (four entries). | O |
| F7 | P2 | Number inputs without units (minutes, USD "ориентир", workers/runs/minutes). | O |

### 2.6 Workflow
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| W1 | P0 | There is no single "describe a goal → see the plan → approve → watch" path. Goal entry is the Head dock; plan and queue are inside a manager tab labelled legacy; batch approval, autonomy grant and Owner confirmation are three separate acts on different surfaces (D: roadmap FO-AUTO02/FO-AUTONOMY-FULL01; C items 23–24, 31 in CLAUDE.md). | O, C, D |
| W2 | P1 | "What is waiting for me" is split across the "Needs you" page, kanban Answer/Review buttons, toasts, the orb badge and Portfolio "Требуется внимание". | O |
| W3 | P1 | Quality-control results and "accept result" are inside ExecutionCard/Review within the manager tab, not where progress is watched. | C |
| W4 | P1 | Onboarding describes a kanban for CLI agents ("Каждая задача состоит из промпта, папки проекта и агента — Claude Code, Codex…"), not delegating to a company. It does not mention Head of PM. | O |
| W5 | P1 | First useful action depends on harness/account state (Settings → Harnesses/Accounts) that the Owner must understand first. | O, C |
| W6 | P2 | Mission Control shows six administrative panels before the list of missions. | O (text order) |

### 2.7 Visual, responsive, accessibility (additions to FO-UX01)
| ID | Sev | Problem | Evidence |
|---|---|---|---|
| V1 | P1 | `MissionControlPage.tsx` uses 47 literal palette classes (e.g. `red-500`, `emerald-600`); 87 across `components/`. `CLAUDE.md` forbids them (single-theme tuning, silent breakage in the other theme). AI router has 20. | C |
| V2 | P1 | Project tab strip clips at 800 px; Russian labels are longer than English and make it worse. | O |
| V3 | P2 | Text sizes 10/11 px make up ~⅓ of text nodes (FO-UX01 metric, not re-measured). | D |
| V4 | P2 | A permanent status line ("ИИ-выполнение: Активен") plus two buttons occupies the project header on every tab. | O |
| V5 | P2 | Dialog and page titles are not consistent in level (some `h1`, some `h2`, some none). | C |

**Total: 12 + 8 + 10 + 5 + 7 + 6 + 5 = 53 issues** (N1–N12, T1–T8, L1–L10, S1–S5, F1–F7, W1–W6, V1–V5).

What already works and must not be lost: truthful "unknown ≠ zero / ≠ unlimited" wording; the exact-operation native confirmation; the orb with Needs-owner state; per-message access grants; read-only portfolio; "recommendation is not execution" disclaimers (just move them).

## 3. Proposed navigation structure

### 3.1 Decision
The requested model (Home · Projects · AI Team · Tasks · Missions · Analytics · Settings) fits the evidence **with two repository-driven changes**:
1. **Knowledge stays a first-class area** (company-wide, used by every manager, not a setting) — an 8th item that merges today's Knowledge and Brain.
2. **Home *is* the attention center.** "Needs you" becomes the first block of Home plus a persistent badge, instead of a separate destination (the page remains as the full list, reachable from Home and the badge).

| Rail | Replaces / contains | Notes |
|---|---|---|
| **Home** | Overview, Needs you, Portfolio totals, Head of PM entry | "What needs me, what is running, what changed" |
| **Projects** | Project list, Portfolio overview, Clusters (as grouping), project workspace | Cluster dashboard remains, reached from the project list's group header |
| **Tasks** | All tasks (kanban) | Pipelines/Workflows entry here |
| **Missions** | Mission Control (missions, plan review, run control) | Policy/security panels leave this page (§6) |
| **AI Team** | Company (org, staff, hiring, roles), Head of PM settings, Agent profiles | Employees are the Owner-facing noun |
| **Knowledge** | Knowledge notes + Brain memory | Two tabs: **Notes**, **Memory** |
| **Insights** | Analytics, Forecasts, Capacity (AI resources, accounts view, quota) | Rail label "Analytics" kept per request; page titled once |
| **Settings** (bottom of rail) | See §6 | |

Rail goes from 12 global items to 7 + Settings. Items hidden from the rail remain reachable (§3.3).

### 3.2 Project workspace tabs: 9 → 5 (+ More)
**Overview · Tasks · Plan and runs · Team · More ▾** where More = Estimates, Environment, Knowledge (project), Memory (project), Settings (project rules). "Open Head of PM" becomes a header button (it is an action). "Legacy Manager" is renamed **Plan and runs** and its Conversation-history sub-tab moves to Head's history; Project inbox, Plan and queue, Runs, hiring and assignment proposals stay.

### 3.3 Reachability map (nothing disappears)
| Today | Tomorrow |
|---|---|
| Needs you | Home → Needs you; title-bar badge; orb |
| Overview | Home |
| Portfolio → Overview | Projects (summary row) |
| Portfolio → Head settings | AI Team → Head of PM |
| Clusters / cluster dashboard | Projects → group header; same dashboard |
| Cluster → Infrastructure | Stays on the cluster; inventory also linked from Project → More |
| Company (all tabs) | AI Team |
| Analytics / Forecasts / AI Resources | Insights tabs |
| Missions | Missions |
| Mission Control → Autonomy policy, Emergency stop | Settings → Autonomy and safety; **Emergency stop in title bar** |
| Mission Control → Owner authorization | Settings → Autonomy and safety → Owner confirmation; status chip on Home when action is needed |
| Mission Control → Practical cycle / Self-improvement | Missions → mission detail ("Quality cycle") / Settings → Advanced |
| Knowledge, Brain | Knowledge → Notes / Memory |
| Browser, Native computer | Settings → Tools and access (+ contextual start from Head dock) |
| Settings → Harnesses, Accounts, AI router | Settings → Providers and accounts (one page, sub-sections) |
| Settings → Agents, Pipelines | AI Team → Agents; Tasks → Workflows |
| Git / Worktrees / Pipelines title-bar icons | Kept; labelled; grouped under one "Tools" menu |

### 3.4 Emergency stop
A red **Stop all** button always visible in the title bar (right of New task). One click performs the existing emergency stop (`emergencyStopAutonomy`); the *clear* action requires explicit confirmation, not the stop. State is shown on the button ("Stopped · Resume…"). It must be keyboard reachable first-in-order from the title bar and announced via `aria-live`. No backend change: both API calls already exist (C `AutonomyControlPanel.tsx:264-269`). Also replace the hard-coded English reason `"Owner emergency stop"` with a translated string.

## 4. Progressive disclosure (three levels)

| Level | Audience | Contains | Mechanism |
|---|---|---|---|
| **1 Everyday** | Owner delegating work | Goals, plans, who is working, progress, what needs me, results, simple status words, one primary action per screen | Default |
| **2 Advanced settings** | Owner tuning | Providers/accounts/quota sources, router policy, autonomy limits, environments, infrastructure, pipelines, integrations, bundles, backup | Settings sections; per-page "Advanced" accordion collapsed by default |
| **3 Developer diagnostics** | Owner debugging / support | Ids, hashes, fingerprints, raw codes, execution traces, protocol and adapter details, certificate/bundle identifiers, embedding model names, logs | **"Details" disclosure** on the owning component + a global *Show technical details* toggle in Settings → Advanced (stored as a layout-chrome preference in `localStorage` per the repo's convention; it gates **visibility only**, never a security decision) |

Rules:
1. A raw value never appears at Level 1 without a mapped label; the raw value is shown at Level 3 beside the label, copyable.
2. A blocked operation is **always** shown as disabled with a one-line reason at Level 1; it is never hidden (see §13).
3. Safety warnings that change what the Owner may safely do stay at Level 1 (once, with a link to the longer explanation at Level 2).

## 5. Page-by-page recommendations

For each: *Simplify* → *Keep & where*.

| Page | Simplify | Keep & where |
|---|---|---|
| **Home** (new, from Overview + Needs you) | Top: "Needs you" cards; next: running work; then projects with one status word each; one big "Ask Head of PM" entry. Drop the "All tasks" button duplicate of the rail. | Attention page logic (`collectAttention`, owner actions) unchanged; full list = "See all". |
| **Projects** | One list with group headers (clusters), search, status word, running/needs-you counts; project card opens workspace. | Portfolio read-only analysis, cluster dashboards, comparison tables — as sections/tabs under the list ("Compare"). |
| **Project workspace** | Header: name, one status word, one **Start/Pause AI work** toggle (replaces two buttons + sentence), New task, Ask Head. Path/cluster into a "Details" popover. | Lifecycle API and states unchanged; path copy button stays. |
| **Tasks** | Translate column names; default filter "Active"; collapse the five filters into "Filters". | Every column and filter retained. |
| **Missions** | Mission list and the selected mission first. Single primary action per status ("Approve plan" → "Start" → "Pause"). Remove policy/trust/self-improvement/infra panels from this page. | Same missions API; panels move per §3.3. |
| **AI Team** | Staff as cards with job title + current task + a plain status; Head of PM as one card; "Hire" proposals first. Employee professional profile and execution history under "Details". | Org chart, role catalog, assignment proposals, hiring, runbook scenarios, execution history. |
| **Knowledge** | Notes and Memory tabs; Memory hides index/model details (Level 3). Shared "what this can and cannot do" strip once. | Records, candidates, rebuild index, search modes, archive. |
| **Insights** | Title once. Tabs: Usage · Forecasts · Capacity. Capacity is the single resource view. Model-id filter lists collapsed behind "More filters". | All tables, forecasts, quota source views. |
| **Settings** | See §6. | All nine existing sections' functions. |
| **Head of PM dock** | Composer-first. "One-turn access" shows a single summary chip ("Access for this message: none") expanding to the five pickers. | Per-message grants stay exactly as today. |
| **Project wizard** | Ask for the folder and a one-line goal first; docs/environment/launch become "Set up later" cards with sensible defaults; review remains. | All steps, AI interview, doc writing, launch profile — reachable from project → More. |
| **Onboarding** | Rewrite the welcome: "Describe a goal; your AI company plans it; you approve." Checklist: Connect an AI tool → Add a project → Ask Head of PM. | Same readiness checks. |

## 6. Settings restructure (9 → 6 sections)

| New section | Contains (all existing functions) |
|---|---|
| **General** | Language, theme, density, font size, default AI tool, pinned New-task panel, sticky messages |
| **AI providers and accounts** | Harnesses, accounts, subscriptions, quotas, quota sources, execution profiles, Codex profiles, router policy (routing profile, quota policy), saved-account views |
| **Autonomy and safety** | Autonomy policy (+ the router's autonomy *preference*, presented as one control with the *enforced* level shown beside it), Owner confirmation (status, enroll, review), emergency stop status, spending limits |
| **Tools and access** | Browser session, Native computer session, Git hosts (tokens), Pipelines/Workflows entry, Worktrees |
| **Library** | Saved prompts, Agent profiles (also in AI Team), bundles import/export |
| **Advanced** | Backup and restore, tmux source, macOS permission delegation, fx auto-resume, diagnostics toggle, database compact/retention, runtime matrix, self-improvement |

Agent-profile editing remains under Settings → Library and AI Team → Agents (one component, two entries).

## 6.1 Features to merge
| Merge | Into | Preserve |
|---|---|---|
| Needs you + Overview + Portfolio attention + orb badge | Home (attention center) | `collectAttention`, owner-actions sources, toast/notification routes |
| Knowledge + Brain (global and project) | Knowledge (Notes / Memory) | Separate data stores and APIs; consent/approval rules for model transmission |
| Portfolio overview + Clusters directory | Projects | Read-only snapshot, comparison, cluster dashboards |
| Accounts + Harnesses + AI router + Usage resources | Providers and accounts / Capacity | Evidence/provenance fields at Level 3 |
| Three autonomy-mode surfaces | Autonomy and safety | Distinct semantics: *preference* (router) vs *enforced* (policy) vs *grant* (batch); show all three in one place, never conflate |
| Legacy Manager + proposals + plan/queue/runs | Project → Plan and runs | `data-testid`s, `manager-tab-*` ids |
| Head settings (Portfolio tab) + Company Head card + Head dock settings link | AI Team → Head of PM | Binding semantics (FO-012B) |

## 6.2 Features to move into Settings
Autonomy policy, Owner confirmation, router policy, Browser/Native sessions, Git tokens, Pipelines management, Agent profiles, bundles, backup.

## 6.3 Features to move into Advanced / Diagnostics
Certificate SHA-256, bundle ids, helper identifier, enrollment state code, channel code, operation raw fields (`mode`, `scope`, `costCoverage`, ids), embedding model/dimension, adapter ids and CLI versions, quota-origin enums, `rev N`, mission/task ids, JSON bundles, raw backend sentences, protocol codes (`owner-se-key-storage-unavailable`, `unknown-subscription`, `executionReady`), execution traces, runtime matrix, DB compact/retention, tmux source, TCC delegation, fx auto-resume.

## 6.4 UI elements that are truly redundant
Presentation duplicates, not capabilities:
1. Verbatim provider-runtime/Owner-signing disclaimer pair on Harnesses and Analytics (S1) → one shared component with link.
2. The "Запуск недоступен: проект уже активен." sentence beside a disabled Start button (S2) → a single state toggle.
3. "The account behind this harness is not identified…" repeated per harness (L2) → one notice above the list.
4. "Все задачи" button on Overview duplicating the rail item.
5. Welcome dialog stacked over the Onboarding checklist (same content twice).
6. "Open Head of PM" as a tab-looking button (an action posing as a page).
7. Four New-task entry points where the pinned panel is optional (kept contextually; panel optional per UX02-D).
8. Page title/tab title collision on Analytics (N7).

**No functionality was found to be obsolete.** "Legacy" describes naming, not unused code: its surfaces are live (N5). `onOpenX && …` guards and `tr(…) || "English"` fallbacks (3 occurrences) are cleanup items, not features.

## 7. Terminology (RU / EN)

Principles: one noun per concept; no Title Case in Russian; status in a verb or adjective ("Готов", "Ждёт вас"), never the enum; raw value only at Level 3.

### 7.1 Concept glossary
| Concept | EN | RU | Notes |
|---|---|---|---|
| Human | Owner | Владелец | Not "CEO" at Level 1 |
| AI planner | Head of PM | Руководитель проектов | Retire "Менеджер", "руководитель управления проектами", "Head" mixes |
| AI worker | Employee / AI specialist | Сотрудник / ИИ-специалист | Company-facing noun |
| Reusable launch preset | Agent profile | Профиль агента | Do not call it "Agent" alone |
| Installed CLI tool | AI tool | ИИ-инструмент | Replaces "Среда CLI/провайдеров"; "harness" is Level 3 |
| Billing identity | Account | Аккаунт | |
| Model | Model | Модель | |
| Cluster | Cluster | Кластер | Keep (existing, documented) |
| Plan review | Approve plan | Утвердить план | |
| Environment (project) | Local environment | Среда запуска проекта | Resolves the "среда" collision |
| Kanban columns | Backlog / Inbox / Ready / Running / Blocked / Review / Done | Бэклог / Входящие / Готово к запуску / Выполняется / Заблокировано / На проверке / Готово | Board headers are half-localized and the project stat bar is fully English today (L3); use one set everywhere |

### 7.2 Message rewrites (examples; originals stay at Level 3)
| Raw / current | RU | EN |
|---|---|---|
| `owner-se-key-storage-unavailable` | Не удалось настроить подтверждение владельца | Could not set up Owner confirmation |
| `executionReady: false` | Запуск пока недоступен | Running isn't available yet |
| `unbound provider subject` | Аккаунт не подтверждён | Account isn't confirmed |
| `unknown-subscription` | Расход подписки неизвестен | Subscription usage is unknown |
| `application-identity-unestablished` | Приложение ещё не подтверждено как ваше | This app isn't verified as yours yet |
| `not pinned` / `none` / `unestablished` | Не задано | Not set |
| "Происхождение квоты: unknown" | Источник квоты не определён | Quota source unknown |
| "Доступность: unavailable" | Сейчас недоступен | Not available right now |
| "Preference: supervised. Enforced execution: supervised." | Выбрано: под контролем. Действует: под контролем. | Chosen: supervised. In effect: supervised. |
| "Rebuild the application so forgeorbit-owner-trust is inside the bundle." | Установите версию приложения с подтверждением владельца. Подробности — в «Диагностике». | Install a build that includes Owner confirmation. Details are in Diagnostics. |
| `{n} candidates · {m} activations` | Кандидатов: {n}, включений: {m} | Candidates: {n}, activations: {m} |
| "Пределы: 1 · 20000ms · 24000" | До 1 исполнителя · 20 с · 24 000 токенов | Up to 1 worker · 20 s · 24,000 tokens |

The "unknown ≠ available" semantic stays: the UI must say what the unknown *prevents* ("Запуск пока недоступен: аккаунт не подтверждён").

Missing-string hygiene (milestone M0): extend `scripts/audit-i18n.ts` to fail on (a) JSX text inside `components/orchestration/**`, (b) `tr(…) || "…"` fallbacks, (c) literal palette classes (V1).

## 8. Everyday Owner workflows

Click counts are my estimates from the observed UI (O/C), not measured telemetry.

| # | Step | Today | Proposed |
|---|---|---|---|
| 1 | Create project | Add project → wizard (5 steps + optional interview) ≈ 8–12 interactions | Pick folder → name/one-line goal → Create (docs/env/launch as "Set up later" cards) ≈ 4 |
| 2 | Describe goal to Head of PM | Orb → pick scope → type; scope not obvious | Home "Ask Head of PM" or project header button; scope pre-filled from where you are |
| 3 | AI plans | Reply + proposal card inside dock/manager | A **Plan card** in Home → Needs you and in project **Plan and runs** (same data) |
| 4 | Review plan | Proposal → "Show plan" → plan view | One review screen: tasks, order, who, estimate (unknown labelled), limits |
| 5 | Approve resources and permissions | Batch approve, separate start, autonomy grant, resource review, Owner confirmation on different surfaces | **One "Approve" step that shows resources, permission level, limits, unknown-cost notices and then performs the same mandatory acts in order**; Owner native confirmation stays the last, separate, exact-operation step |
| 6 | Employees work within boundaries | Batch/mission running; boundaries only visible on policy page | Plain-language "Working inside: 2 workers, until 18:00, no spending beyond subscription" chip on the run |
| 7 | Real-time progress | Board, Run panel, mission page | Home "Running" block + project Plan and runs timeline; progress words, ids behind Details |
| 8 | Exceptional permission requests | Toasts, orb, Answer buttons, Needs you page | One **Needs you** feed, card has the exact operation and Allow once / Deny; badge on title bar |
| 9 | Inspect QC results | Inside ExecutionCard/Review | Result card shows "Quality check: passed / failed / not run" with link to evidence (Level 2) |
| 10 | Accept result | ExecutionCard Accept → Done | Same control on the result card; remains Owner-only |

**Confirmations.** Keep: Owner native confirmation, delete/clear-emergency, spending-above-subscription, anything irreversible. Reduce: confirmations that restate a choice already made on the same screen (e.g. repeated "are you sure" after a card that already shows the exact operation); cancellable actions get an Undo toast instead where the backend supports it. No mandatory check is removed.

**Defaults.** Mission policy ships three presets (*Under supervision* (default), *Autonomous within limits*, *Custom*) mapping to the existing policy fields; "Full autonomy" stays reachable only via Custom and keeps its warnings. Defaults for project launch profile follow the portfolio default harness.

## 9. Accessibility and responsive layout
1. Tab strips: wrap or collapse to "More" at narrow widths; verified clipping at 800 px (V2). Roving `tablist` semantics for Company/Portfolio/Clusters tabs (partial today).
2. Russian expands labels ~20–30 %: test every header, tab, button and chip with RU and the largest font size Settings allows; no fixed-width labels.
3. Emergency stop: first focusable in the title bar, `aria-live="assertive"` on state change, target ≥ 32 px (density Compact is 32).
4. Status chips pair colour with text/icon (S4); remove literal palette classes (V1) so both themes keep contrast; re-run the 2-theme contrast check used in UX02-D.
5. One `h1` per page; `h2` per section; dialogs labelled; remove duplicated disclaimers from the reading order (S1).
6. Respect `prefers-reduced-motion` on the orb and any new status animation (already used elsewhere; extend).
7. Level-3 "Details" are `<details>`-style disclosures with keyboard operation and copy buttons; do not rely on hover.
8. Rail: collapsed (icon) state needs visible tooltips and the badge's accessible name; compact overlay mode already exists (`compact`).
9. Responsive: below ~900 px the rail becomes an overlay (existing); the New-task pinned panel is off.

## 10. Migration and deep-link compatibility

| Surface | Today | Plan |
|---|---|---|
| `localStorage["agetor:workspace"]` (`WorkspaceSelection`: `scope`, `page` ∈ 16 values) | Parsed by `parseWorkspace`; unknown values ignored | Add a one-way alias table: `portfolio`→Projects, `attention`→Home, `brain`→Knowledge/Memory, `browser`/`native-computer`→Settings → Tools, `manager`→Plan and runs, `usage`→Insights. Old keys keep working; no storage migration needed |
| `agetor:projectSidebarCollapsed` | boolean | Unchanged |
| Preferences (`locale`, `theme`, density, `fxAutoResume`, `disclaimSpawnedAgents`, …) | server preferences API | Unchanged; the new "technical details" flag is layout chrome → `localStorage` |
| Window URL `#api=…&token=…` | boot channel | Unchanged (load-bearing; see CLAUDE.md) |
| OS notification / toast `open_task` deep links, pipeline attention landings | `openPipelineAttention`, `openTaskById` | Unchanged; routes resolve to the same components under new parents |
| CLI (`forgeorbit`, `agetor`) | command names | Unchanged (UX is webview-only) |
| `data-testid`s | ~104 e2e specs; UX02-D measured 12 (A) to 43 (B) specs touched by moving elements | Keep testids on moved elements; change the *entry path* in specs, not selectors |
| i18n contract | 4,164 keys EN/RU parity (`contracts.test.ts`, `scripts/audit-i18n.ts`) | Add keys in both locales; never rename existing keys that tests reference |

## 11. Risks of breaking existing behavior
| Risk | Mitigation |
|---|---|
| Hiding a blocked action makes it look available or vanish | Rule §13: disabled + one-line reason; add an e2e per moved action asserting visibility of state |
| Moving autonomy/Owner-trust panels changes where approvals are made | No logic change; move components wholesale; keep `owner-trust-*`, `autonomy-*` testids; native confirmation path untouched |
| Merging "preference" and "enforced" autonomy into one control hides the difference | Show both values side by side (§6); unit-test the presenter |
| Knowledge/Brain merge blurs the data-transmission consent rules | Separate tabs, separate consent copy, existing grant routes untouched |
| Raw → friendly mapping drops information | Level 3 always shows the raw value; mapping tables have a default branch that prints the raw token |
| Emergency stop moved to title bar → accidental trigger | Stop is intentionally one click (fast), resume needs confirmation; show "Stopped" state; announce via aria-live |
| ~12–43 e2e specs depend on element placement | Milestone order (§12) keeps IA moves behind aliases until specs are updated |
| i18n gate misses new surfaces (as Mission Control shows) | Extend `audit-i18n.ts` first (M0) |
| Packaged WKWebView differs from dev browser | Native acceptance (NATIVE-005 still blocked) must be re-run after IA milestones; cannot be claimed from this audit |

## 12. Prioritized implementation milestones and acceptance criteria

Each milestone is independently shippable. "Preserved" = functionality and where it remains.

**M0 — Language and leak hygiene (no IA change).**
Do: translate Mission Control and the English leaks in L1–L6; map raw enums (T1, T2, T4, T5) through presenters; replace literal palette classes with tokens (V1); translate the emergency-stop reason; extend `audit-i18n.ts` (components/orchestration, `|| "…"`, palette classes).
Accept: i18n audit fails on a seeded English string in `MissionControlPage` and passes after fix; no `text-red-*`/`bg-emerald-*` in changed files; EN/RU key parity holds; no unmapped enum appears in a Russian-locale walk of all rail pages; every raw value still reachable (Level 3 or tooltip).
Preserved: all fields, all testids.

**M1 — Persistent Emergency stop and attention badge.**
Accept: Stop-all visible on every page in both locales; one click invokes the existing stop API; state change announced; resume requires confirmation; badge count equals the Needs-you page count; keyboard reachable.
Preserved: Mission Control autonomy panel retains its emergency button until M4.

**M2 — Diagnostics layer.**
Do: shared `TechnicalDetails` disclosure; Settings → Advanced toggle; refactor `OwnerTrustPanel` into status headline + Details (T1, S3); presenters for Portfolio/Brain/Mission (T2–T4).
Accept: Owner-trust page at Level 1 shows ≤ 4 rows (status, what to do, execution allowed yes/no, Review); Details shows every previous field; `owner-trust-*` testids unchanged; no change to authorization requests/responses (diff-reviewed).
Preserved: every Owner-trust field.

**M3 — Navigation consolidation.**
Do: rail 12→7 + Settings; Home as attention center; Knowledge merge; Projects with groups; Analytics rename (N7); alias table (§10).
Accept: every old page reachable ≤ 2 clicks (checklist from §3.3); stored `agetor:workspace` of every old value opens the mapped page; rail has ≤ 8 items; project tabs ≤ 5 + More with no clipping at 800 px (RU); affected e2e updated by entry path only.
Preserved: all pages and their functions.

**M4 — Settings restructure.**
Do: 9 → 6 sections; move autonomy policy, Owner confirmation, Browser/Native sessions, Git hosts; unify autonomy controls (N8).
Accept: every previous setting findable from the new sections via a search/jump list; policy save semantics unchanged (golden API calls); router *preference* and *enforced* values visible together.
Preserved: all settings.

**M5 — Project workspace simplification.**
Do: "Legacy Manager" → Plan and runs; single Start/Pause toggle; header details popover; defaults and presets in the mission policy form (F3).
Accept: lifecycle states and API unchanged; disabled states still explain why; `manager-tab-*` ids preserved; mission form shows ≤ 6 fields by default with presets, all fields reachable in Custom.
Preserved: plan/queue/runs, proposals, hiring, lifecycle.

**M6 — Everyday workflow path.**
Do: goal → plan card → single approval step → progress → needs-you feed → result card (§8).
Accept: the ten-step journey (§8) completes without visiting Settings; the approval step lists resources, permission level, limits and unknown-cost notices before enabling Approve; the Owner native confirmation is still a separate exact-operation step; fake-driver e2e covers the journey.
Preserved: every mandatory check; no new approval path.

**M7 — Onboarding and empty states.**
Accept: first-run text mentions goal → plan → approve; checklist ≤ 3 items; every empty state states the next action in one sentence.

**M8 — Cleanup.**
Accept: no duplicated disclaimer components; removed dead guards/fallbacks; roadmap and CLAUDE.md updated; packaged acceptance re-run on an isolated profile.

## 13. Preservation rule (applies to every recommendation)

- **No backend, authorization, signing or Keychain change** is part of this plan; presentation only.
- **All roadmap capabilities remain** (the repository has no numbered list of 32 directions; the rule is applied per ROADMAP section): moved surfaces keep their components, APIs and testids; the §3.3 table is the acceptance checklist.
- **No fake controls**; no setting is replaced by a stub.
- **Blocked operations stay visible**, disabled, with a one-line reason; the diagnostic cause is at Level 3.
- **Security warnings are consolidated, not removed.**

## 14. Open questions for the Owner
1. Rail: 8 items as proposed (with Knowledge), or fold Knowledge under AI Team to hit exactly 7?
2. Is **Home = attention center** acceptable, or keep a separate "Needs you" rail item (UX02-D variant A)?
3. Where should Browser/Native sessions live: Settings → Tools and access (proposed) or stay as rail items?
4. Rename "Legacy Manager" → "Plan and runs", or a different name?
5. Emergency stop: one-click stop (proposed) vs confirm-to-stop?
6. Language: keep "Head of PM" in Latin in Russian, or standardize "Руководитель проектов"?

## 15. Uncertainties
- Populated-state screens (task cards, Run panel, hiring, accounts with data) were not rendered.
- The Analytics page showed the Clusters page once on first navigation in my scripted walk and the correct page on the second; I did not establish whether this is a real stale-render bug or a timing artifact of my script.
- `unknown-subscription` and `executionReady` come from the Owner-trust/estimation protocol codes (`src/shared/owner-trust/protocol.ts`, `src/shared/estimation/validate.ts`); I did not trace every UI path that can print them.
- Click-count estimates are from reading the UI, not measurement.
- Packaged-app behavior (WKWebView, native helper prompts) is unverified.

## 16. Implementation status

**M0 (FO-UX-SIMPLIFY02-M0) — done locally.** Owner decisions approved for the later milestones: navigation Home · Projects · Tasks · Missions · AI Team · Knowledge · Analytics · Settings; Home is the attention center; Browser and Native Computer move to Settings → Tools and Access with contextual shortcuts; "Legacy Manager" → "Plan and Execution" / "План и выполнение"; Emergency Stop persistent, one click, confirmed resume; "Head of PM" in English and "Руководитель проектов" in Russian; everything stays reachable through progressive disclosure.

Resolved in M0: L1–L6, T1–T4, V1 (all literal palette classes), S3 and the safety-neutral parts of S1. Partly resolved: L2 (known server sentences are mapped; arbitrary backend prose still shows verbatim), T5 (the presenters exist and the affected screens use them; a repo-wide sweep of the ~128 `{x.status}` expressions is not done). Not in M0: every navigation change (N1–N12), the project-header and settings restructure, the duplicated disclaimer banners (S1), and the global Emergency Stop (M1).

Column names in Russian follow the existing welcome copy ("Бэклог, Входящие, Готово к запуску, Выполняется, Заблокировано, Проверка, Выполнено"), not the glossary in §7.1, so board, stats and the onboarding text agree.

**M1 (FO-UX-SIMPLIFY02-M1) — done locally.** The title bar carries an Emergency Stop on every page (one click, no confirmation; a visible "Stopped" state; lifting it asks first, in the title bar and in Mission Control) and a "Needs you" indicator with the same count as the rail badge and the page. The control is named "Emergency stop", not "Stop all", because the existing backend stop covers autonomous missions and autonomous launches only; tasks started by hand keep running and the tooltip says so. Not verified in the packaged app.

**M2 (FO-UX-SIMPLIFY02-M2) — done locally.** One global, presentation-only setting, Settings → General → "Show technical details" / "Показывать технические сведения" (`agetor:technical-details` in `localStorage`, default off): every `TechnicalDetails` / `TechnicalDisclosure` block starts open when it is on, and stays one click or Enter away when it is off. Owner authorization now reads status, running allowed or blocked, why it is blocked, what to do, the safety line and Review; the protocol explanation and all diagnostic rows are behind disclosures with their `owner-trust-*` ids. Mission history shows plain event names with the raw name and JSON in a disclosure; dependencies show task titles and a plain condition; mission id, plan revision, raw status and project folder moved into details. The provider-launch notice is one shared component (the launch sentence visible, the Owner-channel explanation one click away) on Settings → Harnesses, Analytics and once per Mission queue instead of once per task. An unrecognized Brain origin is no longer shown as "Owner". Not done: `orchestrated-status` and `allocation-plan-status` still print raw status codes (existing e2e asserts the codes), the supervised-run id in `ExecutionCard`, the Brain context history status, Accounts harness `id · kind`, and the repo-wide sweep of T5. No backend, authorization or schema change. Not verified in the packaged app.

**M3 (FO-UX-SIMPLIFY02-M3) — done locally.** The rail is Home · Projects · Tasks · Missions · AI Team · Knowledge · Analytics, with Settings at the bottom (the title-bar gear is gone; one Settings button). Stored `agetor:workspace` page ids are unchanged, so old values open the same screen under its new destination (`src/mainview/lib/navigation.ts`). Merged pages are in-page tabs: Projects = All projects / Portfolio overview / Groups (clusters); Knowledge = Notes / Memory; Browser and Native Computer open from Settings → Tools. Missions shows missions first and keeps every administrative panel below. Results: `docs/qa/fo-ux-simplify02-m3-results.md`. Not in M3: the Settings restructure (M4), the project workspace tabs (M5), moving the mission administrative panels into Settings (M4).

**M4 (FO-UX-SIMPLIFY02-M4) — done locally.** Settings has six sections (General · AI providers and accounts · Autonomy and safety · Tools and access · Library · Advanced) with a localized search/jump list; the pre-M4 section ids still work as deep links. The autonomy policy, Owner authorization and self-improvement moved out of Missions into Settings; Missions keeps start, review, quality results and operation review, and opens Owner authorization with the exact mission/task context. Map and results: `docs/qa/fo-ux-simplify02-m4-results.md`. Not verified in the packaged app.

**M5 (FO-UX-SIMPLIFY02-M5) — done locally.** A project has four primary tabs (Overview, Tasks, Plan and Execution, Team) plus a More menu (Estimates, Environment, Notes, Memory, Project rules); no page id changed. The project header leads with the name and one work-status line, and the folder, repository and exact lifecycle values are behind Details. Results: `docs/qa/fo-ux-simplify02-m5-results.md`.

**M6 (FO-UX-SIMPLIFY02-M6) — done locally.** Home asks for an explicit project (or All projects) before opening the Head of PM; waiting plans are listed on Home and in the Head panel; the goal journey shows each task's stage, quality-check outcome and next step, and offers **Accept result** only after a QC PASS (QC PASS is never acceptance). Results: `docs/qa/fo-ux-simplify02-m6-results.md`.

**M7 (FO-UX-SIMPLIFY02-M7) — done locally.** One getting-started block on Home (add a project, set up an AI tool, give the Head of PM a goal) replaces the welcome dialog and the board checklist; every destination has a useful empty state that does not claim zero usage or readiness. Results: `docs/qa/fo-ux-simplify02-m7-results.md`.

**M8 (FO-UX-SIMPLIFY02-M8) — done locally; closes the track.** One acceptance pass in the packaged QA app (WKWebView, isolated profile, fake drivers). The first run, project registration, the Head of PM goal → plan → approve → admit → assign → prepare → confirm → QC → Owner acceptance path, Emergency Stop and its confirmed resume, the seven destinations, Settings search, 800 px, light and English were observed natively. Fixed: Settings opened on a panel scrolled its own title, search and close button out of view; an open task panel covered the title bar (Emergency Stop and Needs-you); the Head panel squeezed its composer/Send away and always showed the long Owner-channel paragraph; the Settings search input let macOS autocorrect swallow Return; known English sentences in the Russian add-project wizard, task workflow and plan card; "Backlog / Ready / Inbox" next to «Бэклог / Готово к запуску / Входящие» in Russian. Results, the native-vs-Chromium split, what could not be verified and the remaining presentation backlog: `docs/qa/fo-ux-simplify02-m8-results.md`.

## M3.5 — visual direction (done: FO-UX-VISUAL01, see `fo-ux-visual01-results.md`)

Owner decision, 2026-11-12: the visual reference for ForgeOrbit's interface is **JetBrains New UI** (IntelliJ IDEA / Rider / Fleet). It is a separate design-system milestone after M3; M3 itself changed navigation only.

Wanted:
- Premium, modern dark desktop UI; light theme stays supported.
- Smooth rounded panels and subtle separators.
- Compact but readable layouts; consistent spacing, alignment and typography.
- Soft hover and selection states.
- Subtle purple ForgeOrbit accents.
- Collapsible and resizable work areas where useful.
- Clean title bar and navigation; minimal visual noise.
- Smooth, restrained transitions; accessible controls.

Limits:
- ForgeOrbit is an AI company management app, not an IDE. The principles are applied to projects, missions, AI employees, tasks, analytics and Head of PM. No code-editor layout.
- No JetBrains branding, logos, icons or names.
- Built on the current design tokens (`index.css` + `tailwind.config.js`, semantic status tokens) and the existing ForgeOrbit identity.
- Must work in light and dark themes, in English and Russian, and in compact macOS windows.
