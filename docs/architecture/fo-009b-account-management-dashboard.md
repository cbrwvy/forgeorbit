# FO-009B — Account Management Dashboard

Base: `main` at `e923fd12b6afc2b75b76e738194b4c221d5f721b`.

## Architecture

The global **Settings → Accounts & Resources** section works without a selected
project. Portfolio links into that section, and the section links back to
Portfolio. The implementation reuses FO-009A's AccountCore, SQLite migration 076,
shared identity/evidence types, quota resolver and authorized HTTP endpoints.
There is no new persistence model, backend endpoint, provider connector, account
switcher or model-routing behavior.

- `lib/account-api.ts` defines a typed client over the existing bearer transport.
  Every mutation disables transport retries, including append-only observations
  and record creation. IDs are encoded in paths; pagination uses server cursors.
- Reads reuse `/portfolio/analysis`'s complete `accountResources` projection. If
  unrelated Portfolio validation or response size rejects it (422/413), the
  client falls back to existing AccountCore readers, with at most four accounts
  loading concurrently. Authorization errors never trigger this fallback.
- Harness configuration comes from Settings' existing payload. The dashboard
  does not call `/harnesses` itself, because that endpoint probes CLI status.
  Existing application startup/Settings behavior remains in place.
- `AccountsDashboard.tsx` owns snapshots, explicit refresh, search/pagination,
  overview metrics and navigation. `AccountDetails.tsx` owns account details and
  archive history; `AccountSubscriptions.tsx` renders subscription evidence and
  deduplicated commitments. `AccountForms.tsx` contains metadata/manual forms;
  `AccountEvidence.tsx` renders observations and cursor-based history.
- Successful writes refetch the API. Requests have generation/unmount guards.
  Reads are manual/on mount; there is no new background network poller. A local
  timeout at evidence expiry/reset invalidates displayed capacity without any
  network request. Focus also re-evaluates local time.

## Owner workflows and evidence semantics

**Accounts.** Create, edit metadata, inspect and archive cards with independent
UUIDs. Equal display names never merge. Account cards show provider, identity
provenance/verification, declared availability, harnesses, profiles, subscription
IDs, quota summary and latest observation. Search covers name, provider and ID;
active accounts render in pages of 12. Archived Accounts exposes retained
identity metadata and quota history.

**Harnesses and profiles.** Explicit many-to-many harness bindings support
multiple accounts per harness and shared accounts across harnesses. Unbinding
explains the backend's cascading removal of profile/model declarations. A profile
association never edits a profile or changes CLI authentication. The warning
“This association does not switch the CLI account.” is visible during association
and in details. A changed/missing profile harness is displayed as unreliable and
counted as a resource conflict; an unknown identity is a separate condition.
Backend validation prevents silent reassignment or a missing required binding.

**Subscriptions.** Create, edit, archive and explicitly associate/remove account
memberships. Provider is immutable, and membership obeys the existing provider
consistency and historical-quota guards. Cards show currency, cost, billing
period, renewal/reset timestamps, source, provenance and verification. Blank cost
is Unknown; explicit zero remains zero. The UI converts decimal money strings
with BigInt and the currency's decimal exponent, rejecting excess precision and
unsafe values instead of rounding. Commitments deduplicate by Subscription ID,
separate currency AND billing period, and use BigInt to avoid sum overflow. Two
same-label subscriptions remain separate.

**Quotas.** Typed requests, tokens, compute time, money, concurrency and named
provider units retain independent definition IDs, scope and window. Definitions
are created or archived, never edited in place. Observation forms append manual
records with explicit observed/expiry/reset times and confidence. Monetary quota
observations use integer minor units; concurrency also requires integer input.
No credential, provider-verification or arbitrary-source controls are offered.

Current evidence displays limit, used, remaining, both percentage directions,
reset, source, observed/expiry times, provenance, verification, freshness and
conflict status. Unknown stays Unknown; confirmed zero stays `0`. Percent-used
and percent-remaining remain separate indicators. Limit minus used never creates
a remaining balance. No invented progress bars, unit conversions, pooled windows
or reset replenishment are shown. Stale/conflicting evidence remains available
as supporting history while current capacity is Unknown. Small positive values
are not rounded into zero for display.

**History.** Append-only observations page by the API's `nextCursor`, including
201 observations sharing the same timestamp. Archived definitions and accounts
retain a GUI path to this history. A history selection focuses its heading.

**Resource Availability.** Harness rows show configuration, registered account
IDs, declared availability, per-definition known/unknown balances, profile
associations, model evidence counts, conflicts and freshness warnings. Shared
account capacity is explicitly not multiplied across harnesses. Authentication
and executable readiness remain Unknown. Account details display model
capabilities as read-only evidence, with provenance and expiry; there are no
model-editing or discovery endpoints in the UI.

**Legacy usage.** Existing compatibility endpoints display saved harness meters
and daily transcript consumption separately as **Unassigned Usage**. No account
is inferred from a harness, binding, provider, plan or name. Saved percentages
remain percentages; daily rollups have Unknown precise observation time and
Unknown quota capacity. No live usage refresh is invoked.

**Portfolio.** Existing resources retain Account IDs, every linked shared
Subscription ID, account identity provenance/verification and quota provenance.
No assignment, estimation or execution algorithm changes.

## UI and security

The section uses existing Button, Input, Select, Dialog and confirmation
components, theme tokens and glass-column cards. Repeated cards add no backdrop
blur. Existing reduced-motion/transparency rules continue to apply. Layouts wrap
long IDs/names; desktop Settings navigation also wraps long section labels, and
mobile navigation scrolls within its own rail. Forms use associated labels,
native required inputs, focus trapping/restoration, keyboard dismissal, dirty
form confirmation and submission guards. Loading, empty, no-match and error
states are explicit. Errors are sanitized static messages; raw SQLite/transport
messages and request contents are never rendered.

All writes use the application's bearer authentication. No credentials are
stored in localStorage, SQLite or logs by this feature. No real AI CLI, provider
request, model probe, Docker operation or user project execution was used for
validation. Unit API integration guards reject process/network calls. Browser
fixtures use fake drivers, offline usage, stub binaries and temporary SQLite,
HOME and harness directories. Existing application status checks can run only
against those stubs. No production CORS/security allowlist was changed.

## Validation and reproducibility

See `fo-009b-validation.json` for accepted results and source digests.
Accepted results: 327 unit/integration tests across 15 targeted suites and 57
unique Chromium scenarios (11 new account scenarios and 46 existing regressions).
The final account rerun passed all 11 after fixing a missing import introduced
while splitting components; all 46 regression scenarios passed in the combined
run. Typecheck, production Vite build and whitespace checks passed.
Run only the targeted suites, in isolated sequential processes:

```sh
bun scripts/test-account-dashboard.ts
bun run typecheck
CI=1 bunx --bun playwright test e2e/accounts-dashboard.spec.ts e2e/portfolio-dashboard.spec.ts e2e/settings-subpage-guard.spec.ts e2e/agent-profiles-settings.spec.ts e2e/theme.spec.ts --workers=1 --output=/tmp/fo009b-playwright
git diff --check
```

The script prints the temporary log directory and writes per-suite counters.
Playwright's `CI=1` configuration starts its own Vite and rejects reuse of an
existing server. Its existing backend fixtures isolate each worker/test; all new
account tests use a fresh backend per test. Chromium may require execution
outside the macOS filesystem sandbox to register its Mach rendezvous port.
Do not weaken application CORS or attach an unrelated Vite to work around that.

Coverage maps to the requested scenarios:

| Scenarios | Evidence |
| --- | --- |
| 1–7 Empty/one/multiple accounts, shared harnesses, duplicate names, unverified identity | New API integration and account-form Playwright |
| 8–9 Profile association and invalid/harness-drift association | New API integration, helper units and profile Playwright |
| 10–13 Shared/independent subscriptions, unknown price, currencies | Money units, API integration, subscription/Portfolio Playwright |
| 14–22 Unknown/zero/known remaining, both percentages, stale/expired/conflict, missing reset | Quota helper units, FO-009A regressions, quota-evidence Playwright |
| 23 History pagination | API integration and Playwright, 201 equal-time observations |
| 24 Unassigned legacy usage | Compatibility regressions, sanitized meter/daily-rollup Playwright |
| 25–29 Archival, form validation, unauthorized API, no secret exposure or CLI probes | New API integration, AccountCore endpoint regressions, archive/error Playwright; isolated test fixtures |
| 30–33 Portfolio navigation and Settings/Agents/Portfolio regression | New navigation/identity Playwright and the four existing targeted regression specs |
| 34–35 Responsive layout and keyboard accessibility | 390/768/1024/1440 light/dark screenshots, long-name registry, reduced preferences, narrow observation form, focus/dirty-dialog Playwright |

Additional browser coverage advances the local clock past quota/model expiry,
asserts Unknown capacity/Expired evidence, and verifies that this causes no
AccountCore or Portfolio network read. No full test suite was run.

## Limits and FO-009C recommendations

This is manual metadata/evidence management. It does not authenticate accounts,
switch CLI homes/accounts, verify model support, acquire live quota data or
prove executable readiness. Records from other windows require explicit refresh.
History is preserved, not editable; archived records are not restored by B.
Browser evidence is Chromium on the local development UI, not packaged-app or
live-provider acceptance.

FO-009C should first establish approved documented source capabilities, explicit
account attribution, account/model verification evidence, window/scope/unit and
freshness semantics, and shared quota-pool identity. Provider credentials must
remain outside this metadata store. Legacy unassigned observations must never
be retroactively attributed from a new harness binding. Live acquisition,
renewal/reset verification and provider-specific error policy require their own
approval and acceptance tests. FO-009C was not started.
