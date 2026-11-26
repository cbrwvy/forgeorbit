# ForgeOrbit Personal Mac Update & Rollback Checklist

**Canonical procedure** for updating `~/Applications/ForgeOrbit.app` on the Owner's personal Mac.
All other installation and rollback notes ([release-versioning.md](release-versioning.md), [owner-signing-setup.md](owner-signing-setup.md), [personal-1.0-checklist.md](personal-1.0-checklist.md), [FO-UPGRADE01](qa/fo-upgrade01-results.md)) defer to this checklist.

**Non-negotiable rules**

1. **Personal use on one Mac only.** Automatic updates stay **disabled** (`channel: dev`, `FORGEORBIT_ENABLE_UPDATES` unset). Do not add Developer ID, Apple notarization, App Store distribution, or GitHub release/CI traffic.
2. **Never open a migrated or newer database with an older bundle.** Current builds check `_migrations` before `PRAGMA journal_mode` and refuse unknown schema IDs (`SCHEMA_AHEAD`), while historical builds lack that guard.
3. **Never split SQLite from `-wal` / `-shm`, and never run reverse DDL.** Always back up via a verified in-app snapshot or a complete `ditto` byte copy of the **closed** profile directory.
4. **Preserve the `ForgeOrbit Local Owner` Keychain pin.** Reuse the existing certificate and `app.forgeorbit.local-owner-anchor`. Never choose **Always Allow** in a Keychain prompt; answer **Allow** once per prompt (two prompts total per signing run: helper + app).
5. **Never replace a running app.** Verify all ForgeOrbit processes, locks, and listeners have exited before copying or replacing any bundle or profile bytes.

---

## Phase 1 — Prepare and verify the candidate (before touching the daily app or working profile)

1. **Confirm clean committed source.** Ensure all intended code changes are committed on local `main` (`git status -s` clean on build inputs; never push or tag without an explicit Owner instruction).
2. **Confirm Owner signing preflight.**
   ```sh
   bun scripts/signing-preflight.ts
   bun scripts/local-owner-identity.ts --status
   ```
   Confirm `productionSigning: "local-owner-ready"`, `anchorMatchesIdentity: true`, and only `login.keychain-db` in `security list-keychains -d user`.
3. **Build from the final committed source.**
   ```sh
   bun run build:local
   ```
   Verify pre-sign ad-hoc provenance and embedded build identity:
   ```sh
   bun --no-env-file scripts/verify-provenance.ts build/local/ForgeOrbit.app build/local
   ```
   Confirm `build/local/ForgeOrbit.app/Contents/Resources/forgeorbit-build.json` and `build/local/forgeorbit-provenance.json` match the expected `productVersion`, `buildNumber`, `macBundleVersion`, `sourceRevision` (full `HEAD` SHA), `channel: "dev"`, `identifier: "app.forgeorbit"`, `localBuild: true`, and `src/bun/migrations/index.ts` migration ceiling.
4. **Sign with the `ForgeOrbit Local Owner` certificate.**
   ```sh
   bun scripts/sign-macos-app.ts --app=build/local/ForgeOrbit.app --channel=local-owner
   ```
   - macOS asks for the private key **twice** (1: `app.forgeorbit.owner-trust` helper; 2: `app.forgeorbit` bundle). Let the Owner answer **Allow** for each. **Never select Always Allow.**
5. **Verify the signed candidate and record a post-sign receipt.**
   ```sh
   bun scripts/verify-local-owner.ts --app=build/local/ForgeOrbit.app
   codesign --verify --strict --verbose=2 build/local/ForgeOrbit.app
   codesign --verify --strict --verbose=2 build/local/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust
   codesign -dv --verbose=4 build/local/ForgeOrbit.app
   codesign -dv --verbose=4 build/local/ForgeOrbit.app/Contents/Resources/app/bin/forgeorbit-owner-trust
   ```
   Confirm `ok: true`, `authoritative: true`, `code: "local-owner-verified"`, `Authority=ForgeOrbit Local Owner`, matching `certSha256` / `anchorSha256`, `TeamIdentifier=not set`, and `version.json` (`channel: "dev"`, `hash: "dev"`).
   *(Note: `build:local` writes `build/local/forgeorbit-artifact-manifest.json` for the pre-sign ad-hoc bundle. Signing changes signature bytes, so write and verify a post-sign provenance receipt in a separate receipt directory before archiving or installing.)*
6. **Verify candidate UI, disabled updater, and migration/rollback on disposable data.**
   - In a packaged window on an isolated disposable profile (`HOME`, `TMPDIR`, `FORGEORBIT_DATA_DIR`, `AGETOR_DATA_DIR` outside the working profile, fake drivers, `FORGEORBIT_USAGE_OFFLINE=1`), verify **Settings → Advanced → Diagnostics** shows `version`, `build`, `sourceRevision`, `migrationCeiling`, `channel`, and `Automatic updates: Disabled` matching the candidate's `forgeorbit-build.json`.
   - Confirm `GET /updates/status` is `idle`, `POST /updates/check` returns `idle` with zero outbound/loopback fetches, and `POST /updates/apply` returns `409`.
   - Rehearse forward migration from a disposable profile matching the installed app's schema to the candidate ceiling, then rehearse rollback using the matching **older** bundle and pre-upgrade snapshot/profile (and confirm `SCHEMA_AHEAD` refuses opening the migrated database with an older build).
7. **Document before requesting approval:**
   - Candidate revision, version, build number, pre-sign & post-sign manifest SHA-256, Owner certificate SHA-256, and migration ceiling;
   - Private recovery location (outside Git and outside `~/Applications`), including retained old bundle path, snapshot directory, and closed byte-copy path;
   - Exact **rollback triggers** (see Phase 6).

---

## Phase 2 — Snapshot & verification (while the old app is open and healthy)

1. With the **existing** `~/Applications/ForgeOrbit.app` open and healthy, record baseline details (old revision/receipt, profile path — normally `~/Library/Application Support/ForgeOrbit` unless `FORGEORBIT_DATA_DIR` / `AGETOR_DATA_DIR` is set — project/task counts, and whether any Owner enrollment exists).
2. Create an in-app snapshot: **Settings → Advanced → Backup & Recovery → Choose folder… → Create backup…** (choose a destination outside the profile and outside Git).
3. Verify the snapshot in the app (**Verify** / **Import profile → Verify snapshot**). Confirm `manifestVersion: 4`, `coverage: "complete-profile"`, the expected `schemaVersion`, `0` issues, and `Integrity: verified`.
4. *(Alternative only when the old app is already closed and should not be launched before backup, e.g. recovering from an earlier exit):* Run the sandboxed offline backup tool (`docs/qa/evidence/fo-upgrade02/offline-sandbox.sh` + `offline-backup.ts`) on the **closed** profile, confirm `verified: true` with `0` issues, and verify the closed profile files are byte-identical before and after.
5. Stop making edits in the old app.

---

## Phase 3 — Full quit & closed-profile byte copy

1. Quit ForgeOrbit cleanly (`Cmd+Q` or **ForgeOrbit → Quit**).
2. Verify **all** ForgeOrbit processes, locks, and port listeners have exited:
   ```sh
   pgrep -fl "ForgeOrbit|agetor" || true
   ls -la "$HOME/Library/Application Support/ForgeOrbit/agetor-core.json" "$HOME/Library/Application Support/ForgeOrbit/agetor.pid" 2>/dev/null || true
   lsof -nP -iTCP:4317 -sTCP:LISTEN || true
   lsof +D "$HOME/Library/Application Support/ForgeOrbit" 2>/dev/null || true
   ```
   If `agetor.pid` exists, verify its PID is not alive before proceeding; `agetor-core.json`, active `ForgeOrbit` / `launcher` / `bun` processes, open handles on the profile, and API port listeners must all be absent.
3. Re-verify the pre-upgrade snapshot is intact, and take a complete **closed-profile byte copy** (preserving SQLite, `-wal`, `-shm`, `brain/`, `attachments/`, and `owner-trust/owner-se-key.bin`, which snapshots intentionally omit):
   ```sh
   ditto "$HOME/Library/Application Support/ForgeOrbit" "<recovery-root>/profile-<schema>-bytes"
   ```
4. Verify the closed byte copy (e.g., `PRAGMA integrity_check` read-only on the copy, migration count, and file hashes) so the recovery set is proven usable **before** modifying `~/Applications/ForgeOrbit.app`.

---

## Phase 4 — Bundle replacement

1. **Stage and verify the candidate** beside `~/Applications`:
   ```sh
   stamp=$(date +%Y%m%d-%H%M%S)
   stage="$HOME/Applications/ForgeOrbit.next-$stamp.app"
   test ! -e "$stage" || exit 1
   ditto build/local/ForgeOrbit.app "$stage"
   bun scripts/verify-local-owner.ts --app="$stage"
   codesign --verify --strict --verbose=2 "$stage"
   codesign --verify --strict --verbose=2 "$stage/Contents/Resources/app/bin/forgeorbit-owner-trust"
   ```
   *(If installing an un-signed ad-hoc build instead of Owner-signed, run `codesign --verify --deep --strict "$stage"` and `bun --no-env-file scripts/verify-provenance.ts "$stage" build/local`.)*
2. **Retain the closed old bundle and its receipts** outside `~/Applications` (so LaunchServices does not keep launching the old bundle):
   ```sh
   mv "$HOME/Applications/ForgeOrbit.app" "<recovery-root>/ForgeOrbit.retained-$stamp.app"
   ```
   Keep the old bundle's manifest and provenance receipts in `~/Applications/ForgeOrbit.receipts/<old-manifest-sha256>/` and `<recovery-root>/`.
3. **Install the verified stage** and archive its post-sign receipt:
   ```sh
   mv "$stage" "$HOME/Applications/ForgeOrbit.app"
   bun scripts/verify-local-owner.ts --app="$HOME/Applications/ForgeOrbit.app"
   ```
   Save the candidate's manifest and provenance JSON under `~/Applications/ForgeOrbit.receipts/<manifest-sha256>/` (do not delete old receipt directories).

---

## Phase 5 — First launch & post-upgrade checks (no live inference)

1. Launch `~/Applications/ForgeOrbit.app` normally from Finder / Spotlight / `open ~/Applications/ForgeOrbit.app`.
2. **Check visible identity in Settings → Advanced → Diagnostics:**
   - `ForgeOrbit version`, `Build number`, `Source revision`, `Migration ceiling`, `Release channel`, and `Automatic updates: Disabled` must match the installed candidate's `forgeorbit-build.json` and provenance receipt.
3. **Verify migration, integrity, and non-resumption (no live AI calls):**
   - Existing projects, tasks, assignments, Brain files, and settings load and remain accessible;
   - Pending schema migrations applied cleanly once (`PRAGMA integrity_check` = `ok`);
   - **No work resumed:** zero running runs, paused batches stay paused, zero new runs, zero spawned provider processes, zero unintended grants;
   - **Owner enrollment check:** inspect whether an active enrollment existed before the upgrade and whether it survived intact (same certificate pin). If none existed before, state so explicitly — never claim preservation or create an enrollment silently;
   - Updater remains disabled (`status: "idle"`, zero update requests).
4. **Quit cleanly (`Cmd+Q`)** and confirm all processes, `agetor-core.json`, and port listeners exit cleanly.
5. **Reopen once** (normal steady-state check) and confirm zero repeat migrations, no stall warnings, and clean quit.

---

## Phase 6 — Rollback triggers & recovery

### Rollback triggers (stop immediately)
Execute rollback instead of continuing to work in the profile if **any** of the following occurs:
- The new app crashes, exits unexpectedly, or fails to open its window or API;
- A database migration fails or `PRAGMA integrity_check` is not `ok`;
- Existing projects, tasks, assignments, Brain data, or a pre-existing Owner enrollment are missing or corrupted;
- Any task, run, batch, or provider process spawns or resumes unexpectedly;
- Installed bundle/helper signatures or provenance fail verification.

### Preserve the failed profile first
1. Quit ForgeOrbit completely and verify all ForgeOrbit processes and API port listeners have exited (Phase 3 Step 2).
2. **Do not open the migrated or failed profile with the older bundle.** Rename it and lock it read-only for diagnosis:
   ```sh
   mv "$HOME/Library/Application Support/ForgeOrbit" "$HOME/Library/Application Support/ForgeOrbit-FAILED-UPGRADE-$stamp"
   chmod -R a-w "$HOME/Library/Application Support/ForgeOrbit-FAILED-UPGRADE-$stamp"
   ```

### Restore with the matching older bundle
1. Move the failed new `~/Applications/ForgeOrbit.app` aside (`<recovery-root>/ForgeOrbit.failed-$stamp.app`) and restore the retained **older** bundle matching the pre-upgrade schema back to `~/Applications/ForgeOrbit.app` (verify its signature and provenance receipt).
2. Restore pre-upgrade data using one of these two verified paths:
   - **Path A — Exact closed pre-upgrade byte copy (same Mac, preserves WAL and any `owner-trust/` key file):**
     ```sh
     ditto "<recovery-root>/profile-<schema>-bytes" "$HOME/Library/Application Support/ForgeOrbit"
     ```
   - **Path B — Verified in-app snapshot (`Import profile` into a new folder):**
     Launch the retained **older** bundle against a clean empty profile (`FORGEORBIT_DATA_DIR=<empty-dir>`), go to **Settings → Advanced → Backup & Recovery → Import profile**, verify and restore the pre-upgrade snapshot into a new folder, then launch the retained older bundle with `FORGEORBIT_DATA_DIR` pointing at that restored folder. *(Note: snapshot restores seal any pre-existing Owner enrollment to `restored-inactive` and omit writes made after the snapshot was taken.)*
3. **Verify recovery:** confirm `_migrations` matches the pre-upgrade schema ceiling, `PRAGMA integrity_check` is `ok`, logs show no unexpected migrations or resumed runs, key records match baseline notes, 0 running runs, and 0 provider spawns. Keep `ForgeOrbit-FAILED-UPGRADE-$stamp` untouched until root cause is resolved.
