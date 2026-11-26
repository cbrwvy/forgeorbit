# Owner trust

FO-OWNER-TRUST01 is the provider-execution authorization channel. It does not authorize deployment, infrastructure, or a remote adapter. Those stay on the unsupported channel described in [FO-DEPLOY04](../FO-DEPLOY04-trusted-owner-authorization.md).

## Trust boundary

Eight parties stay distinct:

1. The human Owner.
2. The trusted native macOS application.
3. The embedded WKWebView.
4. The local ForgeOrbit backend.
5. Head of PM and other agent text.
6. Provider processes.
7. Any other local process that can call `127.0.0.1`.
8. Imported or restored application state, including a disposable QA app.

A loopback HTTP request is not trusted because it came from localhost. The API bearer token proves that the caller saw this launch's window URL. It does not prove that the Owner authenticated. A button in the webview is not that authentication. A model-generated sentence is not that authentication. An arbitrary native IPC caller is not the Owner.

The native helper is the only component that may display the operation and ask macOS to authenticate. The backend verifies the signature. It does not trust `approved: true`.

## Threat model

The local attacker this channel is designed to resist can:

- Send HTTP to the loopback API, including with the bearer token if the attacker can read the window URL or the webview.
- Write SQLite fields, including an `approved` column or a copied grant row.
- Set environment variables, including `AGETOR_PROVIDER_LIVE_SPAWN`.
- Replay an old HTTP body or an old signature.
- Edit a task, mission, model, account, role, workspace, or permission after a proof was signed.
- Restore a backup onto another directory or another machine.
- Run an unsigned or QA-signed build and ask it to enroll.

The channel does not claim to resist an attacker who already controls the Owner's unlocked session, the Secure Enclave, or the operating system. A process running as the Owner can still attack the machine by other means. This design does not disable macOS security settings and does not collect the account password.

## Application identity

`readApplicationIdentity` walks from the process executable to a bundle `Info.plist`, then runs `codesign -dv --verbose=4`. The trust class is:

| Condition | Class |
| --- | --- |
| Bundle `app.forgeorbit`, not ad-hoc, leaf SHA-256 equal to the login-keychain Owner anchor | `production` |
| Bundle `app.forgeorbit.qa` | `qa-dev` |
| Ad-hoc, unsigned, unpinned, or any other bundle | `unestablished` |

`executionReady` requires all of these at once: the enrolled key is class `production`, its protection is `secure-enclave-user-presence`, its application identity is `app.forgeorbit`, the stored certificate fingerprint matches the process that is verifying the proof, and the current process identity is that same production class. A QA bundle never satisfies it. A synthetic key never satisfies it. An ad-hoc binary that happens to use the production bundle id does not satisfy it. A TeamIdentifier is not required and is not fabricated.

An ordinary build of the helper is ad-hoc until the Owner signs the bundle with the local certificate. `build/qa-native/ForgeOrbitQA-dev.app` is `app.forgeorbit.qa` and ad-hoc. `build/local/ForgeOrbit.app` and the installed application are `app.forgeorbit` and ad-hoc. None of those matches the local Owner anchor, so none of them is an enrollment.

## Key lifecycle

Enrollment of a production key happens only inside the helper's `approve` command, after the Owner confirms the alert and `LAContext` succeeds. The key is an elliptic-curve P-256 key created with CryptoKit's `SecureEnclave.P256.Signing.PrivateKey` and access-control flags `userPresence` and `privateKeyUsage`.

**Why not a keychain item:** a self-signed application cannot use the data-protection keychain. `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` and `kSecAttrAccessControl` returns `errSecMissingEntitlement` (-34018) for a bundle signed with `ForgeOrbit Local Owner`; the file-based keychain returns `EPERM` for Secure Enclave keys. CryptoKit does not require that entitlement: it returns an SE-encrypted `dataRepresentation` blob. The helper stores that blob at `<dataDir>/owner-trust/owner-se-key.bin` with mode 0600, and restores it on later operations with the same authenticated `LAContext`. The blob is not the private key: it is machine-bound and usable only with user presence on this Mac. A backup or a restored profile on another Mac cannot use it. The private key is not exported to JavaScript, SQLite, JSON, the environment, logs, or backups as a usable key.

If the Secure Enclave key or its blob cannot be created, the helper exits `secure-enclave-unavailable`. It does not fall back to a software key.

The backend stores the public SPKI, the trust class, the application identity, the protection label, and the signing-certificate SHA-256. It cannot create a trusted private key. `enrollSynthetic` throws unless the caller is an explicit test service, and it throws if that service's identity is production. The production singleton is created with `allowSynthetic: false`.

Removing an enrollment sets it to `removed` and revokes its open grants. A later challenge for that key is `owner-revoked`. Rotation sets `rotated` and later proofs return `owner-key-rotated`. A new key does not revive an old proof.

## Authentication flow

1. The backend parses the operation and stores a challenge. The nonce is 32 random bytes. The challenge expires at the earlier of the operation expiry and two minutes.
2. The Owner starts confirmation. The helper hashes the operation file and refuses if the hash does not match the digest the backend computed.
3. An `NSAlert` shows the project, task, mission, role, provider, account, model, mode, workspace, filesystem, terminal, browser, Computer Use, git, deployment, cost, expiry, and whether an external process will start. Cancel returns `authentication-cancelled` and creates no grant.
4. `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` runs. Touch ID, Optic ID, Apple Watch when the policy allows it, or the macOS password sheet are the system UI. Failure returns `authentication-failed`. ForgeOrbit does not show its own password field and does not record the password.
5. The helper signs the canonical proof payload with `ecdsaSignatureMessageX962SHA256` and prints the public key, payload, and signature.
6. The backend verifies the signature with the enrolled public key, then re-reads the task, mission, policy, account binding, and project lifecycle.

`status` only calls `canEvaluatePolicy`. It does not prompt and does not sign. `inspect` only checks the file digest and prints the display lines.

The web panel can show the same categories. Its button posts an approval request without a proof. The server answers `owner-proof-invalid`. That page is not the trusted display.

## Challenge and operation digest

The document schema is `forgeorbit-owner-trust-v1`. Canonical form sorts object keys, allows only safe integers, rejects NUL, and rejects duplicate JSON keys. The operation digest is SHA-256 of that canonical operation. The signed payload contains the schema, nonce, operation digest, enrollment id, application identity, issued time, expiry, scope, policy revision, task digest, and mission digest.

Scope for one operation is `single:<role>:<provider>:<account>:<model>`. Scope for a bounded mission is `mission:<missionId>:<policyRevision>`. A bounded mission names `policy-envelope` for the role, provider, account, model, filesystem, and task. It does not authorize every future operation. A child must match the mission, policy revision, and envelope digest, and it cannot add terminal, browser, Computer Use, git publication, or deployment.

A single operation lasts at most 15 minutes. A bounded grant lasts at most 24 hours. The challenge itself lasts at most two minutes.

Terminal, browser, Computer Use, git publication, and deployment are rejected at parse time with `owner-privileged-excluded`. A Reviewer operation must be `read-only`. A Developer operation must be `workspace-write`. Cursor and DeepSeek cannot be named as the provider or the model.

## Verification and grant consumption

`admit` rejects an invalid signature, an unknown key, a QA or synthetic key when the caller asked for production trust, a mismatched application identity, an expired or future-dated challenge, a replayed challenge, a changed digest, and a consumed challenge. After the signature checks, admission still applies emergency stop, project pause, mission pause, account binding, router eligibility, sandbox limits, a completed run id, mission revision, task digest, policy status, policy revision, concurrency, and budget. A valid proof does not skip those checks.

Policy, mission, and task staleness, and a revoked policy, burn the challenge so it cannot be reused after the state changes back. Emergency stop, pause, concurrency, and budget refuse without treating the proof as consumed.

Consumption is a SQLite transaction: the challenge row must still be `open` and unconsumed, then the grant row is inserted. A single-operation grant is inserted as consumed. A bounded grant is inserted as issued, and each child use is unique on grant, task, role, and run. A second use returns `owner-already-consumed`.

`executionReady` is computed after that. A synthetic success returns `verified-fixture` and `executionReady` false. The fixture runner refuses to call its fixture if `executionReady` is true, so a production-ready proof cannot be turned into the test transport.

## Restart and restore

The profile row stores the SHA-256 of the data-directory path and the SHA-256 of a machine id. Opening the same file in another directory or with another machine id sets `sealed` and marks active enrollments `restored-inactive`. The hashes are not rewritten to the new location. `completeRestore` also calls `sealRestoredOwnerTrustFile` on the destination database. The snapshot file itself is not rewritten. Private keys are not in the snapshot because they were never in SQLite. A restored public key cannot sign. Consumed, expired, and revoked rows stay in those states. Task and run history is not deleted by this seal.

## Activity Journal

Material decisions are written as `owner.trust.enrolled`, `owner.trust.approved`, `owner.trust.refused`, `owner.trust.consumed`, and `owner.trust.revoked`. The payload carries the request id, operation digest, enrollment id, method category, result code, scope, policy revision, task, provider, and account. It does not carry a private key, a password, a bearer token, biometric data, or a provider credential. A failed or cancelled authentication is recorded as a refusal when the helper returns one. `owner_trust_decisions` remains if the journal write throws. Historical decision rows are not rewritten when a mission changes.

## What is not claimed

A signed proof is not launch permission by itself. Router eligibility, AccountCore, the sandbox, Full Autonomy, project lifecycle, concurrency, budget, and emergency stop still apply at the final admit. This milestone did not complete a real `LAContext` success and did not start Codex or Claude.

## Embedded helper and native IPC (FO-OWNER-TRUST02)

The helper is `forgeorbit-owner-trust`. The application build compiles it and copies `vendor/owner-trust` to `Contents/Resources/app/bin`. Production builds sign it as `app.forgeorbit.owner-trust`. Disposable QA builds sign it as `app.forgeorbit.qa.owner-trust`. `FORGEORBIT_OWNER_TRUST_HELPER` is refused. A `PATH` lookup is not used. `DYLD_INSERT_LIBRARIES` and `DYLD_LIBRARY_PATH` are refused by the helper.

The backend starts that embedded Mach-O with `PATH`, `HOME`, `TMPDIR`, and `LANG` only. There is no Owner-signing HTTP server and no extra daemon. The helper checks its parent with `proc_pidpath`, walks to the `.app`, and reads `SecCode` signing information for the parent bundle and for itself. The helper's real path must be the embedded path. The helper identifier must be the parent bundle id plus `.owner-trust`. For a non-ad-hoc signature, the parent and helper certificate SHA-256 values must match, and `app.forgeorbit` must match the login-keychain anchor. The helper validates the parent and helper signatures structurally with `SecStaticCodeCheckValidity` (signature and bundle seal) and compares the signing identifier explicitly. It deliberately does not evaluate a `SecRequirement` for the certificate leaf: that would consult the keychain search list for the untrusted self-signed chain and made a disposable test helper prompt for the Owner's real keychain item. The certificate pin is the SHA-256 match above. An ad-hoc `app.forgeorbit` parent is refused before LocalAuthentication. A caller that is not ForgeOrbit receives `caller-identity-rejected` and no dialog. A missing TeamIdentifier is not treated as ad-hoc.

The webview sends `POST /api/owner-trust/review` with a locale. The backend loads the operation from SQLite. The helper displays that file. Cancel is the default button and returns `authentication-cancelled` before `LAContext`. A signature is verified against the returned public key and then against the enrolled key. `POST /api/owner-trust/enroll` stays refused. A body that carries `approved`, `proof`, `signature`, or a public key is refused. The loopback bearer token is not an Owner proof.

On a production identity with no active enrollment, the backend reserves an enrollment id and a fresh challenge before the dialog. The public key is stored only after the helper signature verifies and `enrollFromHelper` accepts the production helper. A QA identity cannot take that path. A restored or revoked key stays inactive. Key rotation marks the previous production key rotated and revokes its outstanding issued grants.

`executionReady` still requires the production class, a Secure Enclave user-presence key, bundle id `app.forgeorbit`, the pinned certificate fingerprint, and this process in that same class. A transport fixture used by tests is labeled `transport-fixture-not-hardware` and is rejected by the production singleton. The mission tick does not open a live lease. If a proof ever becomes execution-ready, that tick returns `live-lease-withheld` and starts no process. `observeAuthorizedTransportForTest` calls `admit` and a spy. It does not call `spawnCodexViaTmux` or `spawnClaudeViaTmux`.

## Build identity

| Channel | Bundle id | Signing | Helper id | Enrollment | Provider execution |
| --- | --- | --- | --- | --- | --- |
| Development | `app.forgeorbit` | ad-hoc | `app.forgeorbit.owner-trust` | refused | refused |
| Disposable QA | `app.forgeorbit.qa` | ad-hoc | `app.forgeorbit.qa.owner-trust` | refused for production | refused |
| Signed personal app | `app.forgeorbit` | login-keychain certificate `ForgeOrbit Local Owner`, leaf SHA-256 pinned in the keychain | `app.forgeorbit.owner-trust` signed by that same certificate | after explicit Owner authentication | after that proof and the remaining policy checks |
| Stable personal install | `app.forgeorbit` | the same local Owner certificate; Apple notarization is not a personal-use requirement | same helper | same enrollment | same gate |

The historical bundle `app.forgeorbit.legacy` is not migrated and is not accepted. Keychain tags stay `app.forgeorbit.owner-trust.signing` and `app.forgeorbit.qa.owner-trust.signing`. QA tags are not production Owner keys. No installed application is renamed.

## Local Owner certificate (FO-OWNER-LOCAL01)

ForgeOrbit is a personal-use macOS application. Public Apple distribution requirements are not part of the product.

The personal trust anchor is the self-signed code-signing certificate `ForgeOrbit Local Owner` in the login keychain, pinned by SHA-256 in the keychain item `app.forgeorbit.local-owner-anchor`. The pin is not stored in git, SQLite, or ordinary preferences. Enrollment copies that fingerprint onto the enrollment row. A restored profile stays sealed. A different fingerprint cannot rotate an existing enrollment. The private key is not exported and is not written into the repository.

This is weaker than an Apple Developer ID. Gatekeeper does not identify the publisher, and the self-signed certificate is deliberately not added to the system trust store; signing selects it by pinned SHA-256/SHA-1 with `codesign --keychain <login>`. A same-user process with the login keychain unlocked can replace the anchor before the first enrollment. After enrollment, the enrollment row keeps the certificate fingerprint that was current then, so a replacement certificate cannot rotate or take over that enrollment, and a proof is accepted only from the pinned application identity. After an explicit Owner revocation, a fresh enrollment under a replacement certificate is possible; every new enrollment rotates the Secure Enclave key, so the revoked key stays revoked. The Secure Enclave key itself is guarded by user presence rather than by the bundle's code signature, so any process running as the Owner can trigger a presence prompt for that key tag; it still cannot make ForgeOrbit accept the resulting proof unless it is the pinned application.

The signing key is intentionally **not** pre-authorized for codesign (no `-T`, no partition list). The Owner answers the Keychain prompt for each of the two codesign processes. Granting permanent access would let any same-user process sign a bundle with the pinned certificate, and the verifier would accept that bundle's identity; the per-signing Owner prompt is the boundary. The trust verification code lives in this repository, so an AI agent with write access can change it — but it still cannot install a trusted build without that Owner confirmation. The setup and the limits are in [Owner signing setup](../owner-signing-setup.md).

## Remaining activation

The Owner creates the certificate from an interactive Terminal with `bun scripts/local-owner-identity.ts --create --confirm-owner-action`. `bun scripts/signing-preflight.ts` reports that without printing a private key. `scripts/sign-macos-app.ts --channel=local-owner` signs nested code, then the helper, then the app in two codesign processes, preserving nested entitlements. It refuses ad-hoc, QA, and Developer ID names. It does not use `codesign --deep`. After a signed `app.forgeorbit` is launched, the Owner confirms one exact operation and completes the macOS prompt. That is the first enrollment. Opening Settings, AI Resources, Analytics, or Forecasts does not start it. Cursor and DeepSeek stay blocked.
