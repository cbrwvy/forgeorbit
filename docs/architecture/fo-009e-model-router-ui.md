# FO-009E — Model Router Preview & Resource Selection UI

## Architecture

The interface calls the existing FO-009D `POST /model-router/preview` and
`POST /model-router/portfolio-preview` endpoints through ForgeOrbit's bearer
transport. It adds no routing algorithm, model catalog, quality ranking,
prices, schema, execution path, or provider acquisition.

- `src/mainview/lib/model-router-api.ts`: typed request/response client,
  AbortSignal forwarding, no preview retries, and request generation guard.
- `src/mainview/lib/model-router-preview.ts`: calculation input validation
  and response presentation; candidate order stays the backend's order.
- `src/mainview/components/router/`: task form, candidate evidence cards,
  portfolio comparison, and a local evidence expiry clock.
- Integration is limited to TaskDetails in RunPanel, PortfolioDashboard,
  and the existing API object. App.tsx and manager prompt construction are untouched.

## Task details and routing policy

AI Resource Recommendation is an expandable Liquid Glass section in the
existing task panel. Its requirements form exposes task type, Unknown by
default complexity, explicit capabilities/tools, required/allowed permissions,
context token count, and exact quota ID/amount demands. The task's title is
never analyzed or sent as a planning requirement. ID and project path come
from the loaded task, not an editable path field. Archived tasks, pipeline
steps and tasks without an attributed project cannot request a preview.
The server independently enforces exact project registration and task ownership.

All five FO-009D policies have explanations: Quality-first, Balanced,
Cost-efficient, Fastest-eligible and Preserve-limited-resources. Changes to
the form or policy invalidate/abort the old calculation. Requirements used
and effective Owner constraints are displayed from the server response.
Closing the section discards its result; reopening requires an explicit
new calculation. Nothing is saved into task metadata.

## Candidates, abstention and effort

The backend's verified recommendation, verified alternatives, conditional
alternatives and exclusions remain distinct. No first-candidate fallback is
used. No Verified Candidate is a normal result: the interface presents actual
backend unknowns and exclusion reasons, without inventing missing evidence.

Expandable candidate cards show harness, Account UUID and a display name only
when available from the authorized registry, model ID, eligibility at snapshot,
verification assessment, effort, quota evidence, provenance, conflicts,
approvals, unknowns and confirmed cost/duration/quality evidence. Long values
wrap and many candidates scroll inside bounded groups.

Effort comes solely from the candidate response. Confirmed values are shown
verbatim; conditional support reads **Not verified for this model** and an
absent parameter reads **No effort parameter**. No universal effort list is
offered and no effort value is passed to a CLI.

## Owner and employee compatibility

Preview controls support harness/account allowlists, spending, currency-bound
maximum expected cost, global concurrency, explicit project priority and
required approvals. Permission restrictions are passed through the existing
requirements contract. The effective saved budget and spending policy remain
server-owned and cannot be loosened by these calculation inputs. Empty
allowlists display **None allowed**, not unrestricted access.

The assignment reader reuses FO-010C and shows employee name, role, project
and assignment revision. No assignment and an unreadable assignment are
separate states; missing employee details stay Unknown. Resource selection
does not write to employee identity, assignment, or run history.

Harness choices reuse the task panel's already loaded registry snapshot.
Opening this section does not call legacy `GET /harnesses`, which performs
CLI availability/version probes. Account metadata and assignment readers do
not request provider quota refreshes.

## Portfolio comparison and estimates

The Portfolio page offers task checkboxes from its loaded snapshot, per-project
priority and routing policy. Compare sends one portfolio-preview request.
Returned order, recommendations, task/project priorities, resource conflicts,
quota competition, concurrency notes and unresolved constraints are displayed.
Incomplete project priorities retain the backend's withheld-allocation state.

Saved planning estimates remain separate from candidate cost evidence. Their
confidence/missing-data notes and expected additional cash are explicitly
planning figures. Subscription commitments are never summed per task. Simulated
quota consumption inside the backend calculation is not a reservation.

## Freshness and execution boundary

Every surface states:

> Preview only — no resources reserved, no agents started.

All verification and recommendations describe the returned snapshot, not a
guarantee about a future run. Quota timestamps, expiry/reset, source,
provenance, verification and underlying observations remain inspectable.
Unknown/unverified capacity never becomes Available. Conflict remains
Conflict; stale evidence never becomes current.

A one-shot local timer invalidates current labels at known quota expiry/reset
boundaries; focus/visibility checks handle suspended pages. A recommendation
with expired quota evidence is explicitly historical and asks for recalculation.
This does not re-evaluate candidate eligibility locally. There is no network
polling, automatic router calculation or provider quota refresh in the new UI.

The current FO-009D response does not expose numeric concurrency occupancy/caps
or individual non-quota evidence expiry timestamps. The UI therefore shows
returned concurrency notes and Unknown for absent numeric data, and identifies
other evidence as verified **at snapshot**. `ranking.reserve` is a quota
fraction, never concurrency or an actual reservation.

## Security and cancellation

The calculation body contains only existing endpoint fields. It contains no
credentials, token paths, CLI homes, commands, or verified resource facts.
Preview responses must declare read-only/preview-only semantics. Responses
must match the requested task/project identities; portfolio membership comes
from loaded snapshot tasks. Abort plus a generation guard prevents a late
response from replacing newer input, including when a transport ignores abort.
Portfolio unmount and snapshot membership changes invalidate pending work.

No launcher, account switching, permission-mode changes, reservation, task write,
assignment write, database migration or Employee Run History is added.
Existing legacy app status/usage behavior is outside this feature's scope.

## Validation

Run the explicit, sequential, isolated unit/integration list with:

```sh
bun scripts/test-model-router-ui.ts
```

It covers the new presentation/client plus Model Router, Portfolio, task/workspace,
assignments, Accounts and Estimation regressions. Endpoint tests guard against
external network/process acquisition and compare SQLite bytes around previews.
No full suite, real AI CLI (including version probes), or real provider API is
used. Browser backends use isolated HOME/data/harness homes, fake drivers,
stub binaries and offline usage.

Targeted browser commands use `CI=1` and the four specs:
`model-router-preview`, `portfolio-dashboard`, `accounts-dashboard` and
`employee-assignments`. Router coverage includes real backend abstention and
restrictions, fixture verified evidence/effort, assigned/unassigned/unreadable
employees, local expiry, loading, cancellation, 401, empty/many candidates,
long IDs, policies, portfolio priorities, keyboard focus, light/dark themes,
390/768/1024/1440 widths and reduced motion/transparency.

Exact counters, source digests and accepted validation results are recorded in
`fo-009e-validation.json`. Vite's existing native-config `__dirname` and large
chunk warnings remain; native/Electrobun packaging is outside this check.

## Limits and integration with FO-011E

FO-009D currently has no production acquisition source that proves an exact
harness/account/model login and effort vocabulary. A real No Verified Candidate
is expected until those sources exist; verified browser cards are fake fixtures,
not proof of a live account or launch.

FO-011E integration should retain the two small RunPanel/Portfolio insertions
and the additive API members, then reconcile any adjacent imports. There are
no changes to Knowledge Picker/UI, App.tsx, Project/Portfolio Manager prompts,
or migrations 076–082. Run the targeted integration checks on the combined
branch before a separately authorized integration into main.

Future execution work must acquire fresh exact-resource evidence, re-read Owner
policies/approvals, atomically recheck/reserve shared quota and concurrency,
and enter the existing supervised execution path. Actual resource identity
belongs on a confirmed run; preview state must never become run history.

FO-MULTIACCOUNT02 pins a requested account, model, harness, and mode in Router 2.0.
If that resource is ineligible, the result is no selection. A sibling account is
not substituted. The Owner router card states that the selection stays frozen.
See [multiaccount-2](multiaccount-2.md).
