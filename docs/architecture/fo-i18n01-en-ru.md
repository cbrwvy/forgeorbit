# FO-I18N01 — English / Russian interface localization

Implemented on `task/fo-i18n01-en-ru`, starting from `e95b0f05dc97e271f8096e0f3db638d79b54744a`. This report records local source and isolated Chromium acceptance. Native acceptance, real providers and release acceptance are outside this evidence; **NATIVE-005 remains BLOCKED**.

## A. Existing UI audit

The application boots through `src/mainview/main.tsx` into `App.tsx`. App already loads preferences through `api.listPreferences()` and owns existing theme/font initialization. Settings already writes preferences through the existing API. There was no reusable centralized EN/RU interface dictionary at the base. A small frontend locale store/provider therefore fits without adding a dependency, native IPC, database migration or second preferences service.

The audit covered navigation and Overview; Company/Head and Portfolio; projects and project managers; employees, assignments and hiring; Team Builder; professional catalog/profile revision displays; tasks, runs, sessions and professional turns; accounts, quotas, models and harness metadata; Settings; knowledge, clusters, resources, environments, infrastructure, pipelines and bundles; Git dialogs; confirmations, notifications, forms, errors and accessibility attributes.

The initial AST inventory identified 3,009 static JSX text/attribute occurrences (2,170 distinct normalized strings). The final audit is committed as [coverage JSON](fo-i18n01-coverage.json). This is a static-source inventory, not a count of every sentence a backend/provider could return or an exhaustive interactive-path acceptance.

## B. I18n architecture

`src/mainview/i18n/core.ts` owns `Locale = "en" | "ru"`, the external store, dictionary lookup, interpolation and Intl helpers. `TranslationKey` derives from the English dictionary. The Russian dictionary must satisfy the same key contract; tests also assert runtime parity.

`react.tsx` supplies `LocaleProvider`, `useLocale`, `I18nText`, preference writes and the language shortcut. The provider wraps the existing confirmation provider and App. Subscriptions rerender existing components without remounting dialogs, drafts or approval state. Pure presentation helpers look up the active locale at render time; memoized UI includes locale dependencies where necessary.

Interpolation replaces named parameters once as text. It uses own properties and never evaluates code, recursively interprets parameter content or injects HTML. React escapes the result. Missing translations fall back to English; development builds warn once per missing locale/key. Unknown external machine values remain visible rather than being invented.

## C. Translation coverage inventory

| Class | Treatment |
| --- | --- |
| A. Static interface | Typed dictionary entries for headings, labels, controls, hints, empty/loading states, dialogs, tooltips and accessible text. |
| B. Dynamic status labels | Explicit code/state mappings and presentation adapters; canonical values remain unchanged. |
| C. Backend errors | Stable code first, HTTP status fallback, with original diagnostic evidence retained. |
| D. Validation | Frontend-authored validation localized; raw backend/free-form detail preserved. |
| E. Dates/numbers | Intl formatters and contextual count/plural helpers; canonical input/storage unchanged. |
| F. User-authored content | Names, tasks, notes, paths, prompts and custom requirements preserved. |
| G. AI-generated content | Messages, captions, Markdown profiles, transcripts and generated source bodies preserved. |
| H. Developer diagnostics | Raw errors, identifiers, provenance and technical evidence preserved. |

Final source statistics:

| Metric | Result |
| --- | ---: |
| Dictionary keys in each locale | 4,164 |
| EN/RU key parity | Exact |
| Different EN/RU values | 4,105 |
| Identical values, including technical labels | 59 |
| Audited application TSX files | 157 |
| Translation references in audited TSX | 4,654 |
| Remaining raw technical/endonym occurrences | 58 |
| Distinct remaining raw technical/endonym values | 47 |
| Unapproved raw static JSX text/attributes found | 0 |

The reference count includes translation calls and `I18nText` usage, not unique strings. The 59 identical dictionary values and 47 raw invariant values are different inventories and must not be added together as a missing-translation count. The audit checks authored JSX text and selected string attributes; it does not prove all computed strings or all server output are Russian.

`scripts/audit-i18n.ts` contains the reviewed invariant list and fails on unapproved raw static text/attributes or key mismatch. The JSON records each invariant location and namespace totals. The largest namespace is `common` (1,792 keys), followed by `tasks` (431), `projects` (219) and `employees` (218). The inventory includes the FO-014D/FO-014E execution and turn-review surfaces.

## D. Language selection

Settings → General → Language offers the endonyms `Русский` and `English`, shows the current value and switches immediately. `Alt+Shift+L` provides the same switch while a confirmation dialog is open; Settings describes the shortcut.

The first boot uses the existing browser environment: primary `navigator.languages` entry, falling back to `navigator.language`. `ru`/`ru-*` select Russian; other or unavailable values select English. A valid persisted preference wins over system detection. No native locale IPC was added. A provisional system-language render can occur before existing asynchronous preference loading completes.

## E. Persistence

The existing preferences API stores `locale: "en" | "ru"`. App reconciles the result of its existing preference read; there is no extra settings fetch and no separate localStorage registry. Missing/invalid preferences fall back to the detected language.

Choosing a locale publishes it immediately and queues writes in order. A late bootstrap response cannot overwrite an explicit selection. Older failed writes cannot roll back a newer selection. If the latest write fails, the store returns to the last confirmed language and shows a localized save-failure toast. Tests cover consecutive failures and races. QA used only disposable preference databases, never the owner's settings.

## F. Translation key structure

Keys use functional prefixes: `common`, `navigation`, `settings`, `projects`, `employees`, `accounts`, `models`, `tasks`, `execution`, `turns`, `approvals`, `errors`, `portfolio`, `resources`, `knowledge`, `clusters`, `pipelines`, `environment`, `estimates` and others listed in the coverage JSON. Profile/catalog interface strings live with their employee/approval/execution surfaces. `activity` currently has only two preparatory keys.

New interface copy should use a semantic key and whole-message parameters. Use explicit typed count keys for new pluralized messages instead of concatenating English suffixes. Display adapters for pre-existing shared metadata live in `i18n/options.ts`, `model-options.ts`, `environment.ts`, `infrastructure.ts` and `estimation.ts`; lazy label getters allow cached metadata to follow hot switching. Canonical IDs, order, defaults and eligibility remain unchanged.

`presentation.ts`'s `staticLabel` is an adapter for explicitly selected canonical interface metadata. Do not apply it to arbitrary user/AI prose or error messages. Prefer a direct translation key for new code.

To add a locale, extend `Locale`/Intl configuration and the validated preference/detection/selection paths, provide the same dictionary keys and plural forms, then extend parity and browser fixtures. Execution contracts do not need to change.

## G. English and Russian dictionaries

The complete checked-in dictionaries are `src/mainview/i18n/en.ts` and `ru.ts`; both include typed supplemental entries from `messages.ts`. They are the authoritative 4,164-row source, rather than a duplicated table in this report.

| Key | English | Russian |
| --- | --- | --- |
| `settings.language` | Language | Язык |
| `common.unknown` | Unknown | Неизвестно |
| `activity.title` | Activity Journal | Журнал активности |
| `activity.taskAssigned` | Project Manager assigned a task to {employee}. | Менеджер проекта назначил задачу сотруднику {employee}. |

Owner is rendered as Владелец, Project Manager as Менеджер проекта, Employee as Сотрудник. Run/turn labels use their execution/message context. Brands and identifiers such as Codex, Claude Code, Gemini, Git, CLI, SHA-256, Run ID and UUID remain recognizable. Proper professional role names and profile source text remain original content.

## H. Dates and pluralization

`Intl.DateTimeFormat`, `NumberFormat`, `RelativeTimeFormat` and `PluralRules` use `en-US` or `ru-RU`. Formatters never impose a new timezone, change timestamps or rewrite stored values. Browser evidence explicitly retains `UTC` through language changes. This client application does not add a server-rendered date representation.

Count helpers provide one/few/many/other forms for 13 common nouns. Tests exercise Russian 1/2/5/21 and fractional counts, English singular/plural, relative time and date/number output. Byte labels now use locale grouping/decimal formatting; existing English expectations were updated to grouped `1,023 B` and `2,048.00 GB` deliberately. Russian token summaries use Intl compact formatting.

Form parsing, request numbers and monetary storage stay canonical. Account money inputs retain their existing syntax. Russian money display formats integer minor units without introducing floating-point rounding; tests include `Number.MAX_SAFE_INTEGER` minor units. English exact monetary display is preserved.

## I. Error handling

Frontend `ApiError` retains status, body and original diagnostic. Russian presentation first maps a stable `body.code`, then uses a compatible HTTP-status category (authorization, not found, conflict, validation or server error). It appends the code/status and full original diagnostic. English keeps the existing diagnostic. No backend protocol was changed and arbitrary English parsing is not the primary translation mechanism.

Known validation issues and execution/preflight states have explicit mappings. Unknown external reasons may remain in their original language alongside localized interface context. Security, billing, provenance and delivery evidence must not be silently discarded. The Russian usage notice explains unknown pricing/limits and displays the entire original notice beneath it; this changes no acknowledgement policy.

## J. Owner Approval and Runtime UI

Owner review, assignment/hiring confirmation, professional revision attribution, execution preparation/recovery, turn history, indeterminate delivery and unsupported Gemini-mode explanations have localized interface copy. Canonical default execution-approval copy has a translated display; custom Owner requirements retain their exact text.

The confirmation provider stores a render factory for live copy, allowing language changes while open. Dialog state, input drafts, acknowledgement checkboxes, IDs and request payloads remain separate from translated labels. Typed tests assert canonical option/request/approval invariance. Browser fixtures verify no Run exists before explicit confirmation, one durable Run after confirmation, unchanged historical profile/transcript content and unchanged prior turn records.

Locale changes do not execute, retry, approve, reconcile or grant authority. The backend, shared contracts, CLI and migrations are unchanged. No second Runtime, Portfolio Manager or account registry was introduced. Native notification headings use localized interface copy; agent captions remain original. Delivery of native notifications was not exercised.

## K. Future Activity Journal contract

Only `activity.title` and `activity.taskAssigned` are prepared. There is no activity table, event collector or journal UI in this change.

FO-015A should persist structured facts:

```json
{
  "event_type": "task_assigned",
  "actor": { "kind": "project_manager", "id": "pm-fixture" },
  "target": { "kind": "employee", "id": "employee-fixture", "name": "Backend Developer" },
  "resource_ids": { "task_id": "task-fixture", "project_id": "project-fixture" },
  "timestamp": 1793000000000,
  "parameters": {}
}
```

At display time the same event selects `activity.taskAssigned` with `{employee: event.target.name}`. English becomes “Project Manager assigned a task to Backend Developer.” Russian becomes “Менеджер проекта назначил задачу сотруднику Backend Developer.” The target name stays original. Localized phrases must never become the canonical event source; timestamps, actor/target identity and resource links remain independent facts.

## L. Backward compatibility

Existing users without a locale preference use system detection. Unknown preference values are ignored. English remains the fallback; unknown status codes and raw diagnostics remain inspectable. Existing preferences and API infrastructure are reused without migrations or dependency changes.

Locale adapters affect display only. Shared model/harness/permission values, numeric parsing, historical professional Markdown, audit/transcript rows, run/session links and execution gates remain canonical. No changes were made under `src/bun`, `src/shared` or `src/cli`, or to package/lock/native/Playwright configuration relative to the expected base.

## M. Accessibility and visual behavior

The language picker is a labelled native select with an explicit active value. `document.documentElement.lang` follows the active locale; loading text and accessible control names are translated. The documented keyboard shortcut also works in open dialogs. Existing semantic controls and focus behavior remain in use.

Long labels wrap with minimum button heights; there is no global redesign. Chromium checks cover Settings in EN/RU, light/dark, widths 1,280 and 390, plus a narrow Russian Owner-review panel. Assertions found no document-level horizontal overflow in the exercised pages. Settings tabs may scroll within their own container; long reviews retain their intended internal vertical scroll. These are viewport checks, not physical-device, Cocoa/WebKit, screen-reader or exhaustive modal acceptance.

Selected synthetic screenshots are in [the QA evidence folder](../qa/fo-i18n01/README.md).

## N. Targeted tests

All executable QA used `scripts/qa-i18n.ts`. It creates a disposable HOME/data parent, uses both data-directory overrides, fake drivers/CLI stubs, isolated SQLite and offline settings, then removes only its own temporary parent. E2E uses per-test `freshBackend`, projects beneath each backend's data directory, separate backend ports and temporary browser profiles. The installed Chromium executable is read from its existing cache. No real AI CLI, including `--version`, native app, provider API, production database, credentials, Keychain or account switching was used.

| Command | Accepted result |
| --- | --- |
| `bun scripts/qa-i18n.ts unit` | 624 passed, 0 failed, 1,780 expectations, 25 explicitly listed files |
| `bun scripts/qa-i18n.ts typecheck` | `tsc --noEmit` passed |
| `bun scripts/qa-i18n.ts build` | Vite build passed; existing large-chunk warning remains |
| `bun scripts/qa-i18n.ts e2e` | 11 Chromium scenarios passed across four targeted specs |
| `bun scripts/audit-i18n.ts` | Key parity true; no unapproved static JSX text/attributes |
| `git diff --check` | Passed |

The full Bun suite was not run. Unit scope includes locale detection/override, persistence/races/rollback, hot copy, key parity/fallback, plurals/Intl/timezone, escaping, status/error mappings, option invariants, exact money, custom Owner copy and notification captions, plus directly affected existing frontend helpers.

Five new browser scenarios cover system-language selection and persistence; EN and RU main-page/Settings/theme/viewport checks; Russian Employee Execution/profile/history/Owner review; and Russian Team Builder/hiring confirmation. Existing Team Builder, professional execution and professional-turn regression specs add six scenarios. They use synthetic agents and fake runs. Unsupported Gemini and indeterminate warnings use an explicitly read-only route projection; this proves their UI display, not provider behavior or an actual Gemini failure. Historical content and stored turn data are compared before/after language switching.

The accepted browser run includes the final canonical approval/usage-notice copy. Subsequent notification-heading/helper changes have final unit/typecheck/build acceptance; native notification delivery was not browser-tested. Accepted command excerpts are committed in [validation evidence](../qa/fo-i18n01/validation.txt). Initial sandbox launch failures were resolved for the isolated Chromium run; they are not counted as successful scenarios.

## O. Remaining untranslated content and limits

Intentional original-language content includes user/project/task/employee names and notes; model/harness names; file paths, Git refs, commands and identifiers; original/adapted professional Markdown and catalog role names; saved prompts and current/historical user/AI messages; agent captions; knowledge-template/runbook source bodies; custom Owner requirements; raw backend/provider diagnostics, provenance JSON and free-form planning/resource evidence without a stable translation code.

Labels and surrounding workflows for these fields are translated. Their contents can still contain English in the Russian interface. Unknown machine values remain literal. The exact 58 raw static occurrences/47 unique values are listed in the coverage JSON, including brands, command/token examples and language endonyms. These exceptions are not claims of missing provider evidence or translated transcripts.

The static audit is deliberately narrower than exhaustive runtime-language coverage. It does not discover every computed sentence or exercise every dialog, error path and backend integration. No native/manual/release readiness is inferred from source, build or Chromium results. There are no known unapproved static JSX strings in the audit scope; runtime prose exceptions above remain explicit.

## P. Integration readiness

The change is ready for source review and isolated web integration review with the evidence above. Runtime and Owner authority contracts are unchanged in source and in the exercised synthetic scenarios. Real CLI/provider behavior, production data, native macOS rendering/containment, OS notification delivery and release packaging were not tested. **NATIVE-005 remains BLOCKED**. Nothing was fetched, pushed, merged or published.

## Q. Git status

The expected base and branch were verified before implementation. Local code commits:

1. `ab92b354e64ac3fdd403675f278d3329e07031e7` — `feat(i18n): add persistent english and russian locale support`
2. `b6fe09ed586190b945e5366c58db9e9f427075b8` — `feat(ui): localize forgeorbit application surfaces`
3. `4b1f146` — `fix(i18n): localize approval requirements and notifications`

The working tree was clean after these code commits. This report, coverage JSON and selected synthetic screenshots are saved in a separate documentation commit. Final status is checked after that commit. No remote operations or main integration were performed.
