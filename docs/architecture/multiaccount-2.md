# Multi-account execution profiles

FO-MULTIACCOUNT02 separates eight facts that AccountCore used to leave easy to conflate.

| Fact | Where it lives | What it is not |
| --- | --- | --- |
| Provider | `resource_accounts.provider` | Not a harness id and not a verified person |
| Registered profile | AccountCore id, display name, Codex or Claude profile reference | Not proof of a provider subject |
| Authentication storage | `CODEX_HOME` or `CLAUDE_CONFIG_DIR` on the child only | Credentials are not copied into the database, logs, prompts, or the journal |
| Verified identity | `verifiedSubject` | Stays null. Login status is not an identity document |
| Configured identity | Owner-supplied label on execution metadata | Labeled Configured, never Verified |
| Execution resource | The harness row bound to that profile | The ambient default harness is not a silent substitute |
| Model eligibility | Per-profile allow-list when the Owner sets one | Another profile's models are not inherited |
| Observed usage and verified quota | Existing quota observations | Unknown remaining stays Unknown. An unverified number is not shown as remaining capacity |

## Codex

Multiple existing `CODEX_HOME` directories register as they did in FO-MULTIACCOUNT01. Launch sets that directory on the child, forces file credential storage, and strips known alternate credential variables. A path change, a disabled profile, a failed status check, or an account id that does not match the harness blocks the launch. Two successful `login status` results are not two verified subjects. Local registrations alone leave provider account independence Unknown.

## Claude

`CLAUDE_CONFIG_DIR` can be registered and bound on the child. Support is **PARTIAL**. Auth status must report that same directory before a launch, and the Owner must explicitly accept the existing HOME-access disclosure. Acceptance does not widen filesystem policy and does not read the keychain. The verified subject stays Unknown. A profile without acceptance, or whose status check fails, does not fall back to the default Claude account.

## Router, scheduling, and Full Autonomy

Router 2.0 scores candidates per account. If the request names an account, model, harness, or mode, the selection is that exact resource or nothing. A higher-scored sibling is not substituted.

The mission scheduler keeps the FO-ORCH-SCALE01 per-account cap and also honors a profile concurrency limit and a shared provider cap. An active reservation is not replaced by a second worker, and a reused reservation keeps the requested account id. Restart restores registrations and project preferences. Cached authentication expires, so a restored profile does not become execution-ready by itself.

Full Autonomy may choose only accounts named by the active policy. A revoked, disabled, or mismatched profile does not switch to another account. Supervised launches that do not name an account keep the previous default harness path.

A restored profile does not regain execution authority. Cursor and DeepSeek stay execution-blocked. Claude multi-account subject binding stays partial. An environment flag is not Owner consent for a live request.

## Runtime isolation (FO-PROVIDERS-RUNTIME01)

Codex profiles with distinct `CODEX_HOME` directories may be planned together. Two registrations of one directory may not. Claude profiles serialize on one credential-store lock because `CLAUDE_CONFIG_DIR` does not isolate `~/.claude.json` or the macOS credential store. A session id from one profile cannot resume on another. The ambient default is not a substitute for a requested account. fx keeps the gateway account separate from the upstream provider account, which stays Unknown unless a recorded fixture names a non-secret upstream subject. See [provider runtime](provider-runtime.md).

Cursor and DeepSeek stay execution-blocked. This milestone does not run live inference.

Head of PM answers account questions from these records. It does not invent a subject, a remaining balance, or an execution history.

## Usage analytics

The [usage analytics architecture](usage-analytics.md) describes how the Owner views AccountCore evidence and compares eligible Router resources before execution. Pricing revisions and run accounting are separate from the launch binding.

[AI resource evidence](ai-resource-evidence.md) documents quota histories, revisioned manual observations, and the capability inventory. A harness association for providers without a profile launcher is metadata only.


## Portfolio planning and resource changes

Forecasts reuse Router 2.0 eligibility and AccountCore typed observations. They retain the registered account ID even when the display label changes. Shared pool identity comes from stored acquisition evidence. A common provider, subscription tier or model label alone cannot establish a shared balance. Exact native units and observation windows remain distinct. Current slot occupancy and unknown external consumption are exposed separately.

An Owner can preview a different allocation and review a digest-bound proposal for an unstarted Backlog task. The proposal requires an exact eligible profile and preserves the harness kind and permission mode. Apply rechecks the selected account and task and saves the selection to Backlog. Frozen mission changes require separate Owner reauthorization. See [forecast architecture](usage-analytics.md).
