# FO-015A.2 — Company Activity Journal UI

Date: 2026-10-27 (UTC). Base: `c1a53badb18008f3b1122af29426f624f7e0650b`.
Branch: `task/fo-015a2-activity-ui`.

## A. Architecture and audit

The existing FO-015A.1 `ActivityJournalCore`, migration 092, authenticated
`GET /activity`, `GET /activity/:id`, and post-commit `activity_event` are the
only journal backend. No backend, schema, event producer, or approval code changes.

Audited integration points:

- `CompanyPage` owns dashboard/chart/staff tabs, employee focus, and keyboard tab navigation.
  The fourth tab hosts `activity/ActivityJournal.tsx` independently of organization metadata loading.
- `useCompanyData` supplies current employees (including archived) and registered project teams.
  Journal events remain usable by ID/path if registry metadata fails.
- Workspace navigation stays in `App.tsx`. Project Overview adds a link to Company with an
  immutable project scope. Company sidebar entry clears that scope and returns to Dashboard.
- Existing `EmployeeCard`, `ProjectOverview`, `AssignmentProposals`, project Manager,
  Kanban task panel, and its `RunsList` are reused as destinations.
- The existing FO-I18N01 `LocaleProvider` and EN/RU dictionaries own language selection.
- Existing glass surfaces, Button, border tokens, theme and accessibility media rules are reused.
- `lib/api.ts` uses the existing `j` bearer transport and recovery logic. New journal methods
  are GET-only; existing destination GETs gain optional AbortSignals.
- `activity-journal.ts` holds pure event/status, merge, date-range and grouping helpers.
  `useActivityJournal` owns per-filter request/cursor state.

## B. Event mapping

All canonical `ActivityEventType` values are exhaustively mapped in `EVENT_STATUS`.
Presentation keys are `activity.event.<canonical event_type>`; no canonical record is translated.
Statuses describe the recorded event, not an inferred current task state.

| Canonical event | Displayed status | Meaning |
| --- | --- | --- |
| employee.hired | Included | Recorded hiring action |
| employee.archived | Archived | Employee archived |
| employee.unarchived | Included | Employee restored |
| employee.assigned | Included | Employee included in task assignment |
| employee.unassigned | Removed | Employee removed from assignment |
| task.proposal.created | Proposed | Proposed tasks, no approval inferred |
| task.assignment.proposed | Proposed | Assignment awaiting a decision |
| task.assignment.approved | Approved | Owner approved assignment |
| task.assignment.rejected | Rejected | Owner rejected assignment |
| execution.reviewed | Reviewed | Execution review recorded |
| execution.approved | Approved | Approval only; not proof of start |
| execution.started | Started | Start confirmed; not proof of completion |
| run.completed | Completed | That Run succeeded; no inference about the overall task |
| run.failed | Failed | That Run failed |
| turn.proposed | Proposed | New Turn proposed |
| turn.approved | Approved | New Turn approved |
| turn.submitted | Submitted | Turn sent; task completion explicitly unconfirmed |
| delivery.indeterminate | Indeterminate | Delivery remains unknown |

Manual employee creation does not produce `employee.hired` in FO-015A.1; the journal
never fills this gap with synthetic UI activity. The browser live-event test archives
and restores a fixture employee through existing backend endpoints.

## C. Localization

`i18n/activity.ts` is merged into the existing `en.ts` and `ru.ts` dictionaries.
FO-I18N01 subscription changes the current feed immediately without remounting or
refetching journal rows. Locale preferences use the existing preference transport.

Event text, status, filters, errors, action labels and dates translate. Employee/project
names, recorded task/proposal titles, IDs and paths remain verbatim escaped React text.
Current registry names are used where available; the explicitly allowed recorded
employee name is a fallback. Names are not represented as immutable historical identities
when they come from the current registry. Actor kind and actor ID remain distinct from
the subject employee. A missing employee/manager actor ID displays Unknown.

## D. Filtering

The UI sends only supported API parameters: `projectPath`, `actorType`, optional
`actorId`, `employeeId`, `eventType`, `from`, `to`, `limit`, `cursor`, `direction`.
Blank filters are omitted. Actor kind and exact actor identifier can be combined.
Employee selection includes archived registry employees.

Date controls use local calendar boundaries: start of the first day through the last
millisecond of the final day, respecting DST transitions. An inverted range shows a
localized validation error and sends no request.

Each serialized filter owns its own state and AbortController. Filter changes hide
previous-scope rows synchronously, abort outstanding requests and reset both cursors.
A locked Project Overview entry cannot be broadened using the project selector;
merged rows are additionally checked against its exact project path.

## E. Navigation

Each row exposes source links in a keyboard-operable native details element. Before
navigation, `GET /activity/:id` verifies the source and the destination is checked with
an existing read API. Failed/deleted/inaccessible entities show a localized unavailable
message; raw server errors are not displayed.

- Actor/subject employee → existing Employee Details.
- Project → existing Project Overview, only if still registered.
- Task → existing task panel after checking the task and recorded project path.
- Run → existing task panel / Run history, after verifying that exact Run belongs to the task.
  The journal displays the recorded Run ID. The existing panel controls its own history UI;
  this change introduces no new exact-run transcript selection route.
- Assignment proposal → existing project's approval section, after confirming the proposal
  occurs in the supported project proposal list.
- Task proposal → existing project Manager page after verifying the proposal in Manager state.
- Sources without a supported destination retain their recorded reference and explain that
  no supported direct route exists. Execution/Turn records use their task/Run links.

Navigation does not approve or submit anything. Existing destination screens retain their
normal behavior, including project document discovery and marking a task as read. Those
are tested separately from journal requests; approval rows, task execution fields,
execution attempts and Runs remain unchanged.

## F. Live updates

App's existing `subscribeAppEvents` forwards notification, connect and disconnect signals
through `activity-events.ts`. The Journal never opens EventSource or adopts notification
payloads as rows. The optional disconnect callback does not change other SSE consumers.
An existing App effect can replace a closed stream during lifecycle changes; the test
checks one active app stream, rather than counting every historical stream object.

On notification/reconnect/focus/visibility restoration/browser-online, the hook reads
`GET /activity` forward from the highest API-confirmed sequence, draining all pages.
The newest cursor is independent of the backward history cursor. Empty history refreshes
backward without emitting the unsupported cursor 0. Requests are serialized, notifications
coalesced into a trailing refresh, and IDs deduplicated. A missed SSE notification alone
never becomes a journal record.

Disconnects show an offline/live-unavailable notice while preserving cached history.
EventSource owns reconnection; there is no new polling loop. Unmount/filter changes abort
requests and remove bus/window/document subscriptions. A failed partial recovery keeps
already confirmed pages and can continue from its last confirmed sequence.

## G. Pagination and ordering

Initial and older pages use backward sequence cursors with a page size of 50. Load older
merges into previous rows instead of replacing them. Live forward paging never overwrites
`nextCursor` for older history. Refresh also preserves loaded older rows.

The backend orders by `sequenceId`, not timestamp. The UI retains this canonical descending
order even for equal or non-monotonic timestamps. Contiguous local-date groups may repeat
if the source clock goes backwards. Date groups have stable date/occurrence keys so an
ordinary same-day prepend or older-page append preserves open details and keyboard focus.

## H. Security

The Journal has no creation/edit/delete, execution, permission, approval or Turn-submit
control. It reads committed API data through the existing bearer transport. Backend
history, SQLite, runtime selection and Owner consent contracts are unchanged.

Rows render selected structured references and the explicit backend-allowlisted user
fields `taskTitle`, `employeeName`, and task-proposal `title`. They never enumerate/print
payloads, raw prompts, rationale, notes, tokens, credentials, idempotency keys or error
bodies. React escapes titles and names. Sensitive injected payload fields are tested
with server-side rendering independently of backend sanitization.

## I. UI/UX

The feed uses the current subtle glass Company surface and compact bordered date lists.
Filters use available container width instead of only viewport breakpoints (the sidebar
and composer can consume most of a 1024px viewport). Long Russian text wraps.

Native labelled form controls, ordered lists, headings, time elements, focus rings,
status/alert announcements, tab roving focus with arrows/Home/End, and details/summary
provide keyboard and screen-reader semantics. Date inputs inherit explicit light/dark
color schemes. Loading, empty, error, offline, invalid-filter and unavailable states are
localized. No new animation or backdrop effect is introduced; existing reduced-motion
and reduced-transparency rules apply.

History is loaded on demand. It is not virtualized: all explicitly loaded records remain
in the DOM. Tests exercise 135 history entries and forward catch-up exceeding two pages.

## J. Tests and reproducibility

Use the committed isolation wrapper (dependencies/browser binaries must already exist):

```sh
bun scripts/check-activity-ui.ts unit
bun scripts/check-activity-ui.ts browser
bun scripts/check-activity-ui.ts typecheck
bun scripts/check-activity-ui.ts build
git diff --check
```

The wrapper uses `isolatedCoreEnv`, temporary HOME/data/SQLite, fixture harness homes,
all fake drivers, stub binaries, offline usage and disabled updates. It defaults to API
port offset 15000 (override with `FORGEORBIT_E2E_API_PORT_OFFSET`). Browser tests use
`freshBackend`, backend-owned project paths, localhost:5173, the installed Chromium cache,
and blocked non-local browser requests. Only the stateless Vite server may be reused.

Targeted coverage:

- 43 Bun tests across journal helpers/rendering and directly affected i18n core/contracts:
  18 event mappings, status distinctions, dictionary parity, language changes, immutable
  canonical/approval data, grouping, same-time ordering, deduplication, strict project scope,
  date boundaries, bus cleanup, escaping and sensitive-field suppression.
- 8 Journal Playwright scenarios: all types/attribution/EN-RU; filter/cursor/long history;
  confirmed SSE plus noncanonical notification rejection; reconnect recovery through three
  forward pages; offline and cleanup; missing entity/error/retry; locked project and
  employee/task navigation; existing Owner approval and Run history; stale-response races
  and real aborts; keyboard focus retained during same-day live insertion.
- 1 existing Company navigation/organization smoke test, including its four viewport checks.
- Journal screenshot matrix: RU, light/dark, 390/768/1024/1440; reduced motion and reduced
  transparency emulated in Chromium. Semantic labels and keyboard paths are automated;
  actual assistive technology has not been manually certified.

Results: 43/43 targeted Bun tests PASS; 9/9 targeted Chromium tests PASS; TypeScript,
Vite production build and `git diff --check` PASS. Browser screenshots remain in ignored
`test-results/`, not in the source commit. Initial Chromium launches were blocked by the
macOS sandbox MachPort restriction; the isolated targeted run succeeded with approved
execution outside that sandbox. Initial fixture expectations were corrected to reflect
actual event producers and existing destination-screen behavior.

Existing Vite warnings about `__dirname` native config loading and large chunks remain.
No full suite, Native packaging or Native app launch was performed.

## K. Limitations

- Events are limited to those actually written by FO-015A.1; no backfill or invented history.
- Older deleted actors absent from the registry remain identifiable by recorded ID/name;
  employee selector options come from the current archived-inclusive registry.
- Proposal verification uses existing lists; an older proposal omitted by a truncated list
  is unavailable through this UI until a dedicated existing-source route is supported.
- No new exact-Run transcript or exact-proposal scroll/focus route is introduced. Existing
  destination pages and their own history/approval controls remain responsible for display.
- Reconnection tests combine real backend SSE delivery, browser offline/online transitions,
  and deterministic injected lifecycle callbacks on the same EventSource. They do not prove
  a real network outage of arbitrary duration or native WebKit behavior.
- The UI keeps the sequence contract when wall-clock time moves backwards; repeated day
  headings are intentional in that exceptional case.
- Very large, explicitly loaded histories are not virtualized or benchmarked at production scale.
- Provider, real CLI/account, production, release and Native/manual acceptance remain unverified.

## L. Integration readiness

READY FOR OWNER REVIEW for this isolated frontend change against the specified base.
Backend FO-015A.1 remains the source of truth. Existing Owner approvals and execution
contracts were not modified. No global redesign, second event system, second SSE
connection, new task screen or employee screen is introduced.

**NATIVE-005 remains BLOCKED.** Browser/unit/build success does not clear native isolation,
packaging, release or manual acceptance requirements. No real AI CLI (including version
probes), provider request, credential/Keychain access, user SQLite or `~/.agetor` access,
Native launch, push/fetch/pull, merge, rebase/reset/clean or worktree removal was performed.

## M. Git status

Initial HEAD matched the expected base exactly and the working tree was clean. Changes
are limited to the Company/Project Overview integration, existing frontend transport,
new activity UI/helpers/localization, targeted tests, isolation wrapper and this document.
No backend/shared canonical type/migration/lockfile change is required.

Requested local commit subject:
`feat(activity): add localized company activity journal interface`.

The final local commit hash and post-commit working-tree status are reported with the
execution result. Ignored build outputs, test screenshots and local dependency caches
are not staged. There is no remote publication or main integration in this task.
