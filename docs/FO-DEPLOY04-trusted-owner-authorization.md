# FO-DEPLOY04 — Trusted Owner authorization feasibility and safe handoff

**Outcome: BLOCKED — NO TRUSTWORTHY OWNER CHANNEL**

Real staging and production execution remain prohibited. This milestone implements a
fail-closed application boundary and a review-only manual handoff, not native Owner
authentication. Synthetic success is not evidence of macOS authorization security.

## Scope and inspected architecture

Baseline: `b8de3a3c00a755c10fe9dabd89dc1fdea8441d6b`, existing local `main`.
Read `AGENTS.md`, `docs/ROADMAP.md`, `docs/release-versioning.md`, FO-DEPLOY01
request/preflight code and tests, FO-DEPLOY02 compatibility and adapter, FO-DEPLOY03
executor documentation/code/tests, and the following bounded trust paths:

| Surface | Current implementation | Actual guarantee / limitation |
| --- | --- | --- |
| Desktop host | `src/bun/native-bootstrap.ts`, `src/bun/index.ts`, `electrobun.config.ts` | Electrobun launcher/Bun backend and WKWebView. Kernel instance lock prevents duplicate data owners; it does not authenticate the human Owner. Local personal builds are ad-hoc sealed, with bundled views and updates disabled. |
| HTTP API | `src/bun/api-config.ts`, `server.ts`, `core-creds.ts` | Per-launch shared Bearer, constant-time comparison. Deployment routes require the Authorization header, not query-token auth. Token enters WebView boot globals/hash and a mode-0600 CLI discovery file. Mode 0600 separates users, not processes of the same UID. No authenticated actor role. |
| Native RPC | `patches/electrobun-1.18.1/{socket,browser}.ts`, `scripts/electrobun-rpc-security.ts` | Loopback, per-WebView HMAC upgrade proof, short replay window, encrypted exchange and socket ownership checks protect the RPC transport. They identify a view possessing a process-provisioned key, not a human or a deployment-specific user-presence event. |
| Confirmation UI | `DeploymentRequestsPanel.tsx` | Requested role is proposal metadata. Acknowledging a plan and `confirmOwner` do not establish identity. DOM clicks and AI-generated text confer no privilege. |
| Agents | `src/bun/agents.ts`, `src/shared/execution/permissions.ts` and CLI launch adapters | Harness-specific restrictions vary; explicitly selected full-access modes can execute local commands with user privileges. There is no universal different-UID boundary around agents. Assume normal API access and local code execution, as requested. |
| Plans and attempts | `deployment-request-core.ts`, migrations 101–103, shared plan/artifact modules | Digests detect mismatches when checked, but are public hashes, not signatures or Owner capabilities. SQLite, config paths and development source are not protected from arbitrary code with the user's filesystem permissions. Attempts persist local evidence; they do not prove remote success. |
| external staging entrypoint and authority | `deployment-external-staging-{adapter,executor}.ts` | Existing path predicate resolves a path and checks a basename/existence. It does **not** validate ownership, code signature, immutable content or controller dependencies. Environment gates and shared API configuration are not Owner identity. Remote credential isolation has not been established. |

No secrets, actual credential files, real server configuration or other external staging
repositories were inspected. `.github` contains `FUNDING.yml`; no workflow files
exist in the inspected checkout. None were added. In-app Pipelines are unrelated
and unchanged.

## Threat model and macOS feasibility

An agent may know the API token, choose any role label, send arbitrary HTTP bodies,
read/write ordinary same-user files, start a Bun process, substitute an ordinary
helper executable or modify its own copy of the development code. It may cancel,
replay, race or alter a proposal. We do not assume arbitrary code can bypass the
Secure Enclave, protected Keychain access controls, macOS privilege separation, or
forge an independent protected verifier's signature. We also do not claim those
protections have been configured in ForgeOrbit.

Apple's [LocalAuthentication framework](https://developer.apple.com/documentation/localauthentication)
provides OS-mediated user authentication. Apple's
[Secure Enclave key documentation](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
describes non-exportable keys and access-controlled signing. Apple's
[code-signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html)
explains that the resource's verifier must enforce code requirements; merely
signing code does not establish every policy.

**Feasibility conclusion (inference from those primitives and the inspected code):**
macOS offers useful building blocks, but the current app has no protected native
confirmation/verifier/executor chain. No LocalAuthentication/Keychain signing or
privileged XPC deployment helper implementation was found in the inspected
`src`, `native`, `scripts` or Electrobun configuration. Returning `true` from a new
Swift helper to the same mutable Bun process would allow a substituted helper or
modified local runner to claim success. Moving that boolean to RPC, an environment
variable or a same-user token file would not fix it. An agent could also bypass
that checker and invoke a user-accessible external staging controller with user-accessible
credentials. No such bypass was executed.

A secure future design must protect both the decision **and the execution authority**:
independently installed/enforced native code or an independently trusted executor,
authenticated IPC peers/code identity, protected credentials or signing key,
Owner enrollment, a protected display of the exact operation, fresh OS-mediated
presence, verification of a canonical signed request, a nonce, an expiry, durable
atomic single-use consumption and replay protection. The displayed request must
include cluster/project, staging, full SHA, immutable image references, integration
identity, plan digest and action. A generic login prompt cannot prove agreement to
another request. A signed response from a helper alone is also insufficient if the
agent can bypass its verifier or execute using the same credentials.

This is a concrete missing trust chain, not a claim that all same-user IPC is
inherently insecure or that Apple Developer membership is required for personal
use. No new provisioning, stable identity, signing gate or broad audit is introduced.
No real OS authentication challenge was attempted or natively verified.

## Implemented fail-closed boundary

- `authorizeExecution` only permits non-privileged grants for an explicitly bound
  `forgeorbit-fake-staging-v1` integration. Eligible external staging grant requests are denied with
  HTTP 403, code `owner-channel-unsupported`, including `confirmOwner: true`, Owner/PM/Head
  proposal labels and integrations whose real execution configuration flags are true.
  Malformed bodies and requests without an authorization-ready plan fail earlier
  with 400/409; none can create a trusted grant.
- `executeStaging` rejects external staging before dispatch, including old persisted
  `ready_to_execute` rows and attempts to select the fake adapter for an external staging plan.
  Injecting `executionEnabled: () => true` does not bypass this invariant.
- `externalStagingExecuteDeploy` itself unconditionally returns a failed/unsupported
  result without spawning. The old real dispatch branch was removed from the core.
  There is no new environment switch, native-success HTTP field, auth provider or
  automatic fallback. The old external staging runtime flag cannot reopen this path.
- Production execution and manual production handoff are prohibited. Existing
  production plan acknowledgement is not production execution authorization.
- Public API `ownerConfirmation` always reports method `unavailable`, result
  `unsupported`, real readiness false and no expiry. No privileged material,
  reusable passwords or authentication credentials are created or returned.
- A local arbitrary-code agent can still change its own source or invoke generic
  subprocess tools. This application-level refusal is **not OS containment** and
  cannot secure unrelated externally accessible deployment credentials.

Plan digest calculation now also includes the external staging project slug and entrypoint
reference. Before synthetic authorization/execution and external staging review export, the core
recomputes the plan digest and compares the request, SHA, environment, integration
ID/type/target, slug, entrypoint and catalog path. Changed old plans must be proposed
again; there is no automatic grandfathering of prior digests.

## Safe manual execution handoff

`GET /deployment-requests/:id/manual-handoff` requires the ordinary Bearer because
it exposes project metadata, but performs no authorization mutation or subprocess.
It requires an acknowledged, valid staging external staging plan without a failed dry-run,
validates the plan/integration binding, then re-resolves and compares immutable
catalog contents. Config-only mode can export a review packet with all execution
and subprocess flags off; its dry-run is explicitly `UNSUPPORTED`, never upgraded
to success. Failed dry-runs cannot be exported. Changed or missing artifacts fail closed.

The response is a review-only JSON snapshot with `executionAuthorized: false`,
`action: deploy-staging`, exact target IDs/names/path, full SHA, full image references,
image catalog digest/path, integration ID/type/label/slug/entrypoint, plan digest and
generation time and actual dry-run outcome. It contains no runnable command, SSH
parameters, private auth data or bearer capability. Creation, viewing, closing or copying the packet cannot change
the request to ready, consume a grant, create an attempt or claim remote execution.

The Owner must independently review this **untrusted proposal** on a separate
Owner-controlled execution surface where agent code cannot access credentials or
replace the verifier/controller. Revalidate the complete target, SHA, image digests,
controller provenance and plan digest there; stale packets are not authority. This
milestone neither provisions such a surface nor instructs its immediate use. Any
actual execution still needs a separate direct Owner instruction. There is no
"mark deployed" control or fabricated reconciliation result.

## Synthetic lifecycle (not Owner authentication)

The existing fake workflow remains useful for regression testing. Its publicly
computable execution digest can only enable the in-process fake adapter. A grant
expires exactly five minutes after its persisted authorization timestamp; future
clock timestamps are rejected. The UI shows its expiry and issued/consumed/revoked
or absent status separately from the unsupported trusted channel. Expiry is
checked on execution, including after reopening the database. This uses the local
clock and writable SQLite and is not a tamper-resistant security clock.

`cancel-execution` on a pending/ready request clears the grant, increments its
generation and leaves a revoked message; a new explicit fake authorization is
required. Running fake cancellation retains the existing abort/attempt lifecycle.
Grant consumption and attempt creation now share an immediate SQLite transaction
with state/digest/generation/time compare-and-swap: one grant creates at most one
attempt, and a failed insert rolls back consumption. A consumed digest is cleared;
new core instances and a fresh Bun process reopening SQLite cannot recreate it.
Existing attempts, results, recovery and manual reconciliation are preserved. PM delegation, FO-AUTO01 and QC PASS do not
create an external staging capability.

For **real authorization**, issue, success, binding, expiry and consumption are
**not implemented / not applicable** because no trusted capability is issued.
Cancellation or failed/unavailable authentication cannot grant execution. Do not
interpret synthetic lifecycle tests as satisfying native capability acceptance.

## Owner interface

`DeploymentRequestsPanel` shows unsupported verification method/result, blocked
real readiness, no trusted expiry or issued capability, exact project/cluster IDs,
full Git SHA, full plan digest, immutable image references and integration ID.
Only fake integrations expose the button **Authorize synthetic execution**.
**Acknowledge plan** replaces the misleading approval label. The role selector
explicitly says it is not authentication. external staging requests expose **Review manual
handoff**; the packet states that it is not authorization and can be closed without
mutation. Existing execution results and reconciliation warnings remain visible.

## external staging compatibility and remaining first-staging blockers

Read-only source inspection; no real controller, SSH, remote API or image publishing:

| Area | Finding |
| --- | --- |
| argv | Fixed array: `<entrypoint> preflight <slug> --sha <40-hex> --images-file <catalog>`; dry-run uses `deploy` plus `--dry-run`; deployment argv builder omits that switch; status uses `status <slug>`. Synthetic fixture confirms these forms only. No `sh -c`. |
| Trusted entrypoint | Basename/path check is insufficient provenance. Need independently protected controller, dependencies and config, with verified owner/mode/content and no writable replacement or TOCTOU window. |
| Images | `imagesCatalogRef` is mandatory for external staging subprocess dry-run/deploy; config-only preflight may omit it and cannot establish readiness. SHA/digest parsing and plan/catalog hashes exist. Review export rechecks current catalog. Mutable catalog between validation and subprocess read remains a future execution TOCTOU blocker. |
| Transport | Current executor invokes a **local executable**. No authenticated remote SSH transport or verified remote peer is implemented here. The documented VPS path is not automatically a usable local entrypoint. |
| Read-only modes | Optional local preflight/dry-run flag is off by default; this task uses only the checked-in fixture. A basename does not guarantee a script is read-only. Do not point it at agent-writable scripts or a real server in this milestone. |
| Timeout/cancel | Generic transport has timeout/AbortSignal and kills the direct child. It does not demonstrate descendant/process-group termination; pipe draining and remote completion after disconnect remain uncertain. Cancellation is not rollback. |
| Attempts/recovery | Persistent attempts and `reconciliation_required` exist; synthetic success/failure/ambiguity tests pass. Restart does not establish a remote outcome. Current reconciliation marks uncertainty; it does not query or prove actual server state. |
| Fallback | Fake execution requires both the explicit fake adapter and fake-bound integration/plan. It cannot substitute for external staging. external staging deploy facade/core are unconditionally blocked. |
| External prerequisites | Protected Owner trust chain, independent credential custody and execution surface, verified controller transport/provenance, deployed config and secret ownership, published immutable images, server-state reconciliation and a separate Owner-authorized staging acceptance campaign remain unverified. |

FO-DEPLOY02/03 documentation is historical; FO-DEPLOY04 supersedes its claim that
runtime flags plus a Bearer/`confirmOwner` can enable real deployment. Real flags
were never enabled in this verification. No stable signing/notarization work,
remote external staging repository modifications, tags, push or publication occurred.

## Verification

See [FO-DEPLOY04 results](qa/fo-deploy04-results.md) for final counts, the required
regression matrix, native limitations and cleanup. This milestone stops here.

## FO-INFRA-AUTO01 recheck

FO-INFRA-AUTO01 rechecked the same boundary before adding Git, CI, and deployment
planning. `src/` still has no LocalAuthentication or Secure Enclave signing path.
The only LocalAuthentication reference remains the native-computer policy that
refuses `com.apple.LocalAuthentication` as a computer-use target. Electrobun RPC
still authenticates a webview key. A same-UID helper that returns a boolean is
not an independent Owner action.

No trusted channel was added. `TRUSTED_OWNER_CHANNEL.available` is false.
`infra_authorizations.channel` accepts only `synthetic`. Synthetic grants reach
the in-process fake adapter, expire in five minutes, and are consumed once with
the attempt insert. GitHub Actions dispatch, manual adapters, and every
production authorize or dispatch stay refused. The manual handoff remains
review-only (`executionAuthorized: false`, no commands). A simulated health pass
is state `simulated` with provenance `fake-adapter`. It is not evidence that
remote deployment is secure. Live remote execution stays **BLOCKED**.

## FO-OWNER-TRUST01 provider channel

The sections above remain the deployment and infrastructure finding. They are not rewritten.

FO-OWNER-TRUST01 adds a separate provider-execution channel. It does not make `TRUSTED_OWNER_CHANNEL.available` true and it does not authorize deployment, GitHub Actions, or a remote adapter. The provider gate is `assessTrustedLiveAuthorization` in `src/bun/provider-runtime/live-launch.ts`. It verifies a P-256 proof over a canonical operation. A dialog boolean, bearer token, database field, and environment variable are refused.

The native helper is `native/owner-trust/main.swift`. `status` and `inspect` do not sign. `approve` shows the operation in an `NSAlert`, then calls `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`, then signs with a Secure Enclave key created with `userPresence` and `privateKeyUsage` when the platform allows it. There is no software-key fallback. The helper built for this milestone is ad-hoc (`Signature=adhoc`, `TeamIdentifier` not set). Existing `ForgeOrbitQA-dev.app` is `app.forgeorbit.qa` and ad-hoc. Existing `build/local/ForgeOrbit.app` is `app.forgeorbit` and ad-hoc. Neither identity is a Developer ID production enrollment, so `executionReady` stays false. See [owner trust](architecture/owner-trust.md).

FO-OWNER-LOCAL01 is the personal-use successor for this Mac. Public Apple distribution requirements are not part of the product. A login-keychain certificate can satisfy application verification without Developer ID. That change does not authorize deployment, and it does not make `TRUSTED_OWNER_CHANNEL.available` true. Setup and limits are in [Owner signing setup](owner-signing-setup.md).
