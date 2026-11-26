# FO-009A — Account identity and quota core

Implemented against `main` at `23c702d7134a3cf01aa9e5ce3b0e75835eacc891`.
This is metadata and read-only resource analysis. It does not select accounts,
modify execution environments, start agents, authenticate with providers or
implement FO-009B/C.

## Architecture audit and reuse

| Existing component | Decision |
| --- | --- |
| `db.ts` Agent Profiles, migrations 052/053 | Preserve all settings and task snapshots. Add a separate association keyed by profile UUID; never update the profile from the account service. |
| Harness rows and `agents.ts` configuration | Harness ID identifies a configuration, not a provider account. Bind by ID, without accepting home paths, environment maps or credentials. |
| `account-usage.ts`, migration 054 | Reuse persisted transcript rollups as historical token consumption. Do not scan files from the new service, expose configuration paths, or infer an account from a directory. |
| `usage/poller.ts`, `harness_usage` | Keep the existing poller, provider registry, refresh behavior, cache and SSE event. Extend its existing writer with an atomic sanitized version journal. No second poller or live connector. |
| `portfolio-adapter.ts` and FO-008B resource model | Add account resources and a detailed `accountResources` view. Retain unassigned harness resources. Resolve only explicitly associated planning profiles; historical runs retain unknown account identity. |
| FO-008A estimation | No engine changes. Existing project estimation subscription inputs remain their own declared inputs; account subscription commitments are reported separately and are never added to the same estimate a second time. |
| Global Portfolio Manager | Reads the same snapshot. Resource text identifies user-declared identity, shared subscription identity and unknown capacity. |
| Project Manager, Agent Runner and preflight | No behavior changes. An association is metadata, not proof that a CLI is currently signed into that account. No automatic account switching or probes. |
| HTTP authentication | Mount `/account-core/*` in the existing Bun server. Exact bearer header is required using the server's constant-time token comparison. Query-token fallback is not accepted for these endpoints. |
| SSE | Existing `harness_usage` event remains unchanged. Account metadata has no new background monitor or SSE event in A. Clients refetch after explicit writes. |
| Settings UI | Unchanged. Existing profile settings continue to work. Account dashboard is deferred to B. |
| SQLite registry | Append migration `076_account_quota_core`; do not edit applied migrations or invent a new database. |

## Account, bindings and model capability

`AccountCore` receives a SQLite connection and clock. Its dependencies contain
no process launcher, provider connector, credential reader, CLI-home reader or
runner. Shared types and resolution functions live under `shared/accounts`.

Accounts have internal UUIDs, provider, display name, optional external identity,
provenance, verification, declared availability and creation/update/archive
timestamps. Equal names, emails or plan labels never merge records. Provider is
immutable because changing it would move existing evidence across providers.
Supported harness configurations are derived from explicit bindings.

The vocabulary supports `unknown`, `user-provided`, `observed`, `verified` and
separate verification status. The public manual writer accepts only unknown or
user-provided account identity. Email and home/profile names cannot promote it
to verified. No verification mechanism is implemented in A. Legacy observation
provenance can be observed while its account identity remains unknown.

One account can bind several harness configurations, and one harness can bind
several accounts. Bindings are explicit user declarations. They enumerate
possible resources and do not select an execution account. A profile has at most
one account association, requires a matching harness binding, and cannot be
silently reassigned. If the profile's harness changes, resolution fails closed.
Deleting a binding removes its associations and declared model capabilities via
FK cascades, leaving profiles, tasks, projects, runs and costs untouched.

Model capability is separate from the configured model. The core can retain
user declarations, source, verification and expiry, but these declarations are
not projected as confirmed model support. No model probes occur.

## Subscriptions

Subscriptions have their own UUID, provider, plan label, optional currency,
optional integer recurring cost in minor units, billing period, renewal/reset
information, provenance, verification and timestamps. Unknown price is null;
explicit zero is accepted with currency. Metadata updates retain subscription
identity. Account membership is an explicit many-to-many relationship with a
provider consistency check.

Shared subscription commitments are counted once by ID. Equal plan names do not
merge independent subscriptions. Totals stay separate by currency and billing
period; unknown costs are listed separately. An association used by historical
quota definitions cannot be removed (409), preserving ownership of evidence.
Archiving a subscription preserves records but prevents its old quota evidence
from supplying current capacity.

## Quotas, observations and freshness

Quota definitions have immutable identity, account ID, optional linked
subscription ID, scope, typed unit and declared window. Separate definitions
remain independent even when labels match. Correct a definition by archiving it
and creating a new one; rewriting a unit underneath old observations is forbidden.

Supported units:

- requests, tokens and concurrency;
- compute time in seconds or milliseconds;
- money in integer minor units of an explicit currency;
- a named provider-specific unit.

Observations are append-only UUID records with source, provenance, verification,
confidence, observed/expiry/reset timestamps, nullable limit/used/remaining, and
an optional typed percent-used or percent-remaining indicator. The manual API
sets source to `manual` and provenance to user-provided; clients cannot forge
provider verification or source attribution. Unknown values stay null. No
percentage is converted to tokens or exhaustion, and limit minus used does not
manufacture a remaining balance.

Current resolution considers each source's newest report and retains timestamp
ties. Contradictory current facts produce `conflict` with no selected current
capacity. Separate quota definitions are never pooled. Missing expiry is not
proof of freshness. Expiry or a passed reset invalidates the old observation;
it remains queryable as history. A reset never proves replenishment. Reset may
be unknown. No provider reset schedule is inferred.

Pure helpers resolve quota evidence, compare explicit resource identities,
check demand against an exact quota with a known remaining value, and deduplicate
subscription commitments. They only compute and cannot schedule anything.

## Persistence and legacy integration

Migration 076 adds:

- `resource_accounts`, `account_harness_bindings`, `account_profile_associations`;
- `resource_subscriptions`, `account_subscriptions`;
- `quota_definitions`, `quota_observations`, `account_model_capabilities`;
- `harness_usage_history`, a version journal of the existing usage stream.

Relational identity and membership keys use primary/unique keys and foreign
keys. Typed metadata is stored as validated JSON alongside these keys. The
migration is additive and idempotent, including the backfill. Existing valid
cached meter fields are preserved as unassigned historical observations;
malformed original cache rows remain untouched. No account is automatically
created, and no profile is migrated.

`harnessUsage.upsert` writes the compatibility cache and sanitized journal in one
transaction. Exact repeated snapshots are deduplicated. A failed cache write
rolls back the journal write as well. Deleting a disposable cache row does not
delete history. The bridge excludes provider errors, arbitrary provider payloads,
plan text, configuration paths and credentials. Old history that the prior
single-row cache had already overwritten cannot be recovered.

Legacy meter freshness uses an explicit local five-minute policy, matching the
former portfolio policy; it is not a provider guarantee. Every meter retains its
own reset time and remains a percentage. Transcript rollups are exposed from
existing SQL rows as unassigned historical consumption, without home scans,
quota conversion, or inventing a precise observation timestamp the old schema
never stored. Cursor pagination covers observations sharing timestamps.

Account deletion archives metadata and removes bindings. Quota definitions,
observations and subscription relationships remain for history. Physical deletes
that would orphan evidence are rejected by foreign keys.

## HTTP contract

All paths below start with `/account-core`. Mutating JSON bodies are limited to
16 KiB. Unknown fields are rejected. Errors do not echo request content or SQLite
exceptions. No endpoint accepts a path to credentials, shell command, token or
provider authentication material.

| Path | Methods and behavior |
| --- | --- |
| `/accounts` | GET active accounts (`?archived=true` includes archived); POST create |
| `/accounts/:id` | GET; PATCH metadata; DELETE archive |
| `/accounts/:id/harnesses` | GET; POST `{harnessId}` explicit binding |
| `/accounts/:id/harnesses/:harnessId` | DELETE unbind |
| `/accounts/:id/profiles` | GET; POST `{profileId}` explicit association |
| `/accounts/:id/profiles/:profileId` | DELETE unbind |
| `/subscriptions` | GET subscriptions and deduplicated commitments; POST create |
| `/subscriptions/:id` | GET; PATCH metadata; DELETE archive |
| `/accounts/:id/subscriptions` | GET; POST `{subscriptionId}` explicit membership |
| `/accounts/:id/subscriptions/:subscriptionId` | DELETE membership if no historical quota depends on it |
| `/quotas` | POST immutable definition |
| `/quotas/:id` | GET definition; DELETE archive |
| `/accounts/:id/definitions` | GET definitions (`?archived=true` includes archived) |
| `/accounts/:id/quotas` | GET current states, warnings and supporting latest observations |
| `/quotas/:id/observations` | POST manual observation; GET history with `?before=<nextCursor>` |
| `/accounts/:id/models` | GET model declarations; mutation remains a core-service seam |
| `/identity?harnessId=...&profileId=...` | GET explicit planning identity or unknown |
| `/legacy-usage`, `/legacy-tokens` | GET unassigned history, paginated by `before` |
| `/capabilities` | GET local source capability contract |

Example manual quota definition:

```json
{"accountId":"<uuid>","subscriptionId":null,"scope":"account","unit":{"kind":"requests"},"window":"user-declared-window"}
```

Example observation (timestamps are explicit epoch milliseconds):

```json
{"observedAt":1792790000000,"expiresAt":1792790300000,"resetAt":null,"remaining":0,"confidence":"high"}
```

This remains user-provided evidence even with high confidence. All current reads
are side-effect free. Read endpoints do not refresh providers.

## Portfolio behavior and limits

`GET /portfolio/analysis` adds `accountResources` containing accounts, explicit
bindings, associations, current quota states, model declarations, subscriptions
and deduplicated commitments. The existing snapshot gains account/harness rows.
Planning tasks in backlog/ready/blocked can resolve explicit profile identity.
Historical runs and tasks already executing or reviewed are not retroactively
assigned to an account. Without captured execution identity, account occupancy
is unknown if any related harness has running work.

The old resource shape accepts only one quota. A single current account-wide
requests/tokens remaining observation can be projected exactly; percent-used
stays a percentage. Multiple independent windows, scopes, monetary/provider
units and percent-remaining remain in the detailed view and yield unknown in
the old single-quota field. Failed, stale and passed-reset legacy evidence
cannot supply capacity or leak provider error text through that field.

A single-harness account with one current `scope=account`, `window=instant`
concurrency definition exposes that cap. When an account spans several harnesses,
the cap remains in the detailed account view and the old per-harness slots remain
unknown: multiplying the shared cap would invent capacity. Shared subscription
IDs are retained; they do not prove identical quota pools. Multiple subscriptions
are retained as a list in the detailed view rather than arbitrarily choosing one.
Account-declared availability does not prove the harness binary is ready.

## Source capabilities and FO-009C contract

These capabilities describe this implementation, not every API a provider may
have. They are based on the repository audit, with no live verification.

| Harness kind | Safe stored usage | New live quota acquisition | Identity/model verification |
| --- | --- | --- | --- |
| Claude Code | Existing stored meters and transcript SQL aggregates | User-provided only | Unsupported |
| Codex | Existing stored meters | User-provided only | Unsupported |
| Cursor | Existing stored meters | User-provided only | Unsupported |
| Gemini, fx, Antigravity | Unsupported in the bridge | User-provided only | Unsupported |
| Unrecognized kind | Unknown | Unknown | Unsupported |

The existing providers include undocumented endpoints and credential/cookie
access. The new core never calls or imports them as acquisition mechanisms.
Their presence is not evidence of a supported identity verification API.

A future approved connector must provide a documented source contract, explicit
account attribution and binding evidence, typed quota units/window/scope,
observation timestamps and freshness semantics. Provider credentials must stay
outside this metadata store. Observed identity and verified identity require
different evidence. No connector may relabel old unassigned data merely because
a binding was added later. Model support needs model-specific evidence and expiry;
a model's presence in configuration is insufficient. Shared subscription quota
pools require explicit pool identity, not matching labels or units.

## Validation and next stages

Targeted tests exercise empty and multiple-account registries, explicit shared
bindings, identity/provenance, profile drift, shared/independent subscriptions,
unknown/zero/known quotas, both percent directions, expiry/reset, conflicts,
units/currencies, capabilities, legacy compatibility, subscription deduplication,
archival/unbinding, migration/backfill/FKs, exact bearer authorization, secret
field rejection, atomic usage writes, pagination, and no process/external calls.
Migration fixtures include nonempty projects, tasks, runs and events to verify
history preservation. Existing migration, portfolio, usage, profile, estimation
and both manager regressions run in separate Bun test processes with isolated
SQLite, temporary homes, offline usage and fake drivers. Final results: 406 passed, 0 failed across 14 targeted suites. See
`fo-009a-validation.json` for suite counts and source SHA-256 digests. `bun run typecheck` and
`git diff --check` are required gates. UI is unchanged, so Playwright is not run.

FO-009B can build manual account/subscription/quota forms and history views over
this API, including identity warnings and conflict/freshness states. FO-009C
must separately establish approved provider capabilities, verified identity,
explicit acquisition attribution, shared quota pool identity and model evidence.
Neither stage is started here. No production/provider acceptance, real account
switching, model routing, automatic allocation, new background monitoring,
paid requests or live CLI behavior is claimed by these tests.

FO-MULTIACCOUNT02 builds on this registry. A Codex or Claude profile reference
stays metadata. Verified subject and verified remaining quota are separate
fields and stay Unknown unless this core already has a verified observation.
See [multiaccount-2](multiaccount-2.md).
