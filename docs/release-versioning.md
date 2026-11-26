# Local release versioning

ForgeOrbit is a personal, single-developer project. All version allocation,
provenance, builds, tests, signing and notarization run locally. There is no
GitHub Actions/CI/CD dependency. Local commands never create tags, push commits
or publish assets. Those actions require a separate, direct Owner instruction.
The product's AI-agent Pipelines are unrelated and remain supported.

## Personal macOS installation

Owner's current distribution policy is personal use only: no official release,
Apple Developer Program, Developer ID, notarization or GitHub publication is
required. The existing stable pipeline below remains intact as a separate,
unused option; it is not a personal installation gate.

```sh
bun run build:local
```

This produces `build/local/ForgeOrbit.app`, plus its manifest/provenance and
`local-build.json`. Product/build remain package.json values (currently 1.0.3 /
counter 4). It uses the existing **dev** channel with `localBuild: true`, SDK
hash `dev`, production `app.forgeorbit`, name `ForgeOrbit`, ordinary bootstrap,
real Bun/helpers and mandatory NATIVE-003/004 transforms. Local configuration
always loads packaged views, even beside a running Vite server. There is no QA
bootstrap, fake driver, baked data directory, new channel or stable reservation.
The local mode is invalid for stable metadata; stable signing gates still apply.

ForgeOrbit is a personal-use macOS application. Public Apple distribution
requirements are not part of the product. `build:local` is ad-hoc and is not
the Owner identity. After you choose to sign, use the local Owner certificate
described in [Owner signing setup](owner-signing-setup.md). That step is
manual. It does not run as part of `build:local`, and it does not replace the
installed app.

Opt-in **QA-identity** packaging (fake drivers, non-persistent WebKit, no
production URL schemes) uses a separate baked runtime root:

```sh
bun run build:qa-native
```

Output defaults to `build/qa-native/ForgeOrbitQA-dev.app` with
`build/qa-native/runtime/` and `qa-native-build.json`. Launch only through the
NATIVE-005 environment (`docs/qa/fo-native-qa02-results.md`). This does not
replace or modify `build/local/ForgeOrbit.app`.

The command creates a private plain source/dependency/vendor copy, includes
PostCSS/Tailwind config in the source digest, and gives build tools an empty
HOME with a sanitized environment. Repository `.env*`, signing/provider env and
runtime profiles are not copied. Vendor helpers are prepared locally, Vite
styles must be processed, then the secure SDK builder verifies its receipts.
The final dev bundle is renamed/restamped **before** an ad-hoc deep seal and
complete manifest generation. Installed SDK/repository dependencies are not
edited. Build prerequisites must already be installed locally; vendor source
downloads, if needed, retain their existing pinned checksums. Failed capsules
and prior `build/local.retained-*` outputs are preserved for diagnosis.

Follow the single canonical [Personal Mac Update & Rollback Checklist](personal-update-checklist.md) for pre-upgrade snapshot creation and verification, full quit verification, closed-profile byte backup, Owner signing (`sign-macos-app.ts --channel=local-owner`), bundle staging and replacement, first-launch checks, and rollback. Never replace a running app, never split SQLite from `-wal`/`-shm`, and never open a migrated database with an older bundle.

Retain both detached JSON receipts alongside the app in a separate receipt directory (`~/Applications/ForgeOrbit.receipts/<manifest-sha256>/`). Note that `build:local` writes `build/local/forgeorbit-artifact-manifest.json` for the pre-sign ad-hoc seal; after signing with `sign-macos-app.ts --channel=local-owner`, verify with `bun scripts/verify-local-owner.ts` and `codesign --verify --strict` and capture a post-sign manifest receipt before archiving or installing. Manual app replacement leaves `~/Library/Application Support/ForgeOrbit` (or explicit `FORGEORBIT_DATA_DIR` / `AGETOR_DATA_DIR`) in place; do not import `~/.agetor` or copy credentials.

Open the exact installed app from Finder or `open ~/Applications/ForgeOrbit.app`. If Gatekeeper refuses a future quarantined copy, use the standard individual Open Anyway approval in macOS; never disable Gatekeeper, SIP or TCC globally. Only the current Mac/macOS version is accepted; a minos 14.0 load command is not macOS 14 testing.

The updater stays disabled (dev channel plus default-off policy). Local builds
can share a product version/counter while having different manifest identities;
retain the matching receipt for each. They are never stable release identities.
Claude Code/Antigravity use the existing manual harness/model flow. Codex is
discoverable but initially disabled by the existing defaults: Owner can enable
it in Settings → CLI environments. Codex live and verified-quota routing are
not claimed. Unknown quota stays Unknown; installation runs no AI task.

## Identity and ordering

`package.json` is the single source of `version` and `forgeorbitBuildNumber`.
The Electrobun config and both macOS plist hooks derive their values from it.

| Field | Contract | Ordering role |
| --- | --- | --- |
| Product version | Canonical release SemVer `X.Y.Z`; each component 0..9999; no leading zeros or prerelease/build suffix | Numeric SemVer comparison |
| Build number | Global integer counter 1..99,990,000, committed with the product version | Must increase for every new stable release |
| CFBundleShortVersionString | Product version | macOS display metadata; not the SDK updater comparator |
| CFBundleVersion | Numeric Apple 4.2.2 representation of the counter | Monotonic macOS build metadata |
| Source revision | Full local Git HEAD SHA | Provenance, never a numeric build number |
| Source tree SHA-256 | Sorted build-input paths, modes and file SHA-256 values | Binds actual inputs, including dirty dev overlays |
| Channel | `dev` or `stable` | Strict isolation; no cross-channel updates |
| Artifact identity | SHA-256 of detached final runtime bundle manifest | Binds all bundle bytes, modes and internal symlinks |
| Build timestamp | UTC ISO timestamp | Diagnostic only; no ordering role |
| Electrobun hash | SDK opaque token (`dev` in dev builds) | SDK archive/cache key, not artifact SHA-256 |

For counter `b`, let `n=b-1`. CFBundleVersion is
`(1+floor(n/10000)).floor((n%10000)/100).(n%100)`.
Thus counters 1, 4, 100, 101, 10001 map to `1.0.0`, `1.0.3`, `1.0.99`,
`1.1.0`, `2.0.0`. VERSION01 initializes counter **4**, above the historical
`1.0.2` plist build. Product `1.0.3` is the first prepared version under this
policy; it has not been published.

A stable release identity is `(bundle identifier, platform, architecture,
product version)`, associated with exactly one global build counter, source
and final artifact manifest. Every distinct stable attempt requires a new
product version **and** higher build counter, including a rebuild of identical
source with new signing timestamps. Never replace assets under an existing
identity. Production bundle ID remains `app.forgeorbit`; disposable QA uses
`app.forgeorbit.qa`. Stable acceptance currently supports macOS arm64.

## Allocate locally

From the existing local checkout:

```sh
bun run version:next          # patch version + build counter
bun run version:next minor    # minor version + build counter
bun run version:next 1.2.0    # explicit higher product version + build counter
bun run version:build         # counter only, for dev work
```

These commands edit only package.json. Review and commit the intended build
inputs before a stable attempt. `scripts/bump-patch.ts` is a compatibility
entrypoint for local patch allocation. Concurrent allocation is unsupported;
the single Owner allocates serially. Stable reservation independently rejects
reused/nonincreasing identities even if a counter was allocated incorrectly.

`.forgeorbit-release/identities/` is an ignored, append-only local reservation
registry. **Retain and back it up separately** from replaceable build/artifact
folders and restore it when moving this checkout. It is not a GitHub service.
A stable attempt exclusively locks the registry, validates history and writes
a reservation before invoking the SDK. Failed attempts consume the identity;
allocate a new version/build for a retry. Do not delete reservations to retry.
A stale `.forgeorbit-release/identities.lock` fails closed: inspect for an active
owned build before manually recovering the lock; no command removes another
owner's lock. A lost registry cannot prove historical uniqueness; reconcile
retained receipts and previously published identities before another stable
attempt. Automatic publication is absent; the Owner must preserve immutable
identities during any separately authorized manual publication.

## Build and verify

```sh
bun run build                # local dev artifact; existing vendor prerequisites
bun run build:stable         # future signed/notarized local stable artifact
bun run release              # local stable build + verification only
```

The last two commands intentionally require the existing Developer ID,
vendor-signature and notarization gates. They must not be used for unsigned
stable QA. Missing credentials, dirty build inputs, a QA identity/root, disabled
signing/notarization, conflicting versions or unreviewed SDK code refuse stable
acceptance. Reservation is consumed once SDK execution begins. `release` does
not allocate a version, commit, tag, push, call GitHub APIs or publish anything.
The old `release:upload-only` entrypoint refuses publication. Canary builds are
removed from the supported contract; channels are dev/stable.

Use `scripts/build-native-secure.ts --env=dev` after preparing Vite/vendor
inputs for isolated disposable QA. The approved QA bootstrap and NATIVE-003,
004 and 005 package checks still apply. Dev QA may use a plain source copy and
`FORGEORBIT_BUILD_SOURCE_REPOSITORY` to read the original checkout's revision
and file list; copied inputs are hashed and always marked dirty. Stable forbids
that override. `bun run dev` preserves SDK dev/watch with metadata supplied by
`dev-native.ts`; watch hooks refresh diagnostic source metadata. Watch output
is not an accepted distributable artifact.

The secure wrapper validates the installed SDK contract, config loading,
security transform receipts, package content, source stability and metadata.
Hooks embed `Resources/forgeorbit-build.json` before signing (inner and outer
macOS bundles). SDK version.json is written after postBuild. After SDK signing,
the wrapper inventories the final inner runtime bundle without editing it.
Stable output is an extractor: inspection unpacks a copy into a sibling
`verify-inner-*` directory, never executes it and refuses unsafe paths/links.
The current non-CEF archive layout requires no archive symlinks/hardlinks;
a future layout change needs review. No signed bytes are restamped.

Receipts beside the dev bundle, and in stable `artifacts/`, are:

- `forgeorbit-artifact-manifest.json`: sorted complete runtime .app inventory,
  including embedded metadata and signatures; no self-reference or timestamp.
- `forgeorbit-provenance.json`: source/build metadata, exact SDK version.json,
  manifest SHA-256; stable also lists SHA-256 of final shipping tar/DMG bytes.
- Stable `stable-macos-arm64-update.json`: unchanged SDK version/hash/platform/
  arch fields plus additive `forgeorbit` metadata and manifest identity.

For a flat dev bundle or an already inspected inner stable bundle:

```sh
bun run verify:provenance /absolute/path/ForgeOrbit.app /absolute/path/receipts
bun scripts/verify-release.ts  # stable outer/inner, shipping hashes/feed and existing signing gates
```

Keep the original app, shipping archives and receipts together in a durable
local archive before the next SDK build replaces output folders. Compare the
receipt source SHA with the intended full commit and the recorded source tree.
A dirty dev artifact names its base commit plus actual input digest; it must
never be described as a clean build of that commit. Detached hashes detect
mismatches against retained receipts; they are not an independent trust anchor
if an attacker can replace both artifact and receipts.

## SDK updater compatibility

Audited Electrobun **1.18.1** compares hash inequality, not SemVer or plist build
numbers. Its non-dev hash uses wyhash of a pre-signing bundle archive, with a
filename-only fallback; it is not a SHA-256 of the delivered app. Dev uses
`hash=dev` and does not fetch updates. VERSION01 pins Updater.ts, CLI source and
the actual macOS arm64 embedded CLI; SDK changes require a fresh audit.

ForgeOrbit keeps this updater framework and feed layout. A guard wraps the SDK
check itself, including SDK-internal download/apply rechecks. It validates local
metadata, stable channel/identity/platform, increasing SemVer **and** counter,
rejects downgrade/same-version recuts/legacy feeds without provenance, and pins
the selected feed metadata through one operation. A timestamp never wins an
ordering comparison. The configured ForgeOrbit GitHub download URL remains a
future distribution endpoint; local builds do not read a feed or require
GitHub APIs. Delta generation remains off.

The updater is **disabled by default**. `FORGEORBIT_ENABLE_UPDATES=1` is an
explicit opt-in; either disable flag still wins. Do not opt in for production
until separate signed end-to-end updater acceptance. Offline policy/mock tests
do not prove actual SDK download, replacement, relaunch, network trust or
manifest verification of downloaded bytes. Production auto-updater is
**NOT TESTED**. Existing 1.0.2 clients lack the new guard; use a manual upgrade
for the first signed RC and do not assume they can reject an old feed.

## Manual rollback and data

Use the canonical rollback procedure in [Personal Mac Update & Rollback Checklist](personal-update-checklist.md#phase-6--rollback-triggers--recovery). Data invariants:

- Close ForgeOrbit normally and verify all owned processes, locks, and port listeners have exited before touching files.
- Retain both a verified in-app snapshot (created while the old app was open, or via the sandboxed offline backup on a closed profile) **and** a complete closed-profile byte copy (`ditto`, including SQLite, `-wal`, `-shm`, `brain/`, and `owner-trust/`).
- App replacement leaves `~/Library/Application Support/ForgeOrbit` in place; explicit `FORGEORBIT_DATA_DIR` and `AGETOR_DATA_DIR` remain authoritative.
- **Never open a migrated or newer database with an older bundle.** Current builds fail closed (`SCHEMA_AHEAD`) before `PRAGMA journal_mode`, and historical builds lack that guard. Never run reverse DDL, truncate ledgers, or delete `-wal` / `-shm` files.
- On rollback, preserve the failed/migrated profile aside (renamed `…-FAILED-UPGRADE` and read-only), restore the matching older bundle, and restore either the exact pre-upgrade closed byte copy or the verified pre-upgrade snapshot into a new folder for the older bundle. Preserve Task/Run/Turn/Journal durable IDs and migration history. Never scan or import `~/.agetor` automatically.
