# ForgeOrbit development and release constraints

ForgeOrbit is a personal, single-developer macOS project developed directly in
`main`. The primary repository is public on GitHub
(`https://github.com/cbrwvy/forgeorbit`).

## Branching, publishing, and history policy

- Develop all ForgeOrbit changes, tests, and commits directly on `main`. Do not
  create extra local development branches or worktrees for ForgeOrbit itself
  (product support for linked worktrees in target user projects remains intact).
- Verified changes are published to GitHub via ordinary `git push origin main`
  only upon explicit Owner instruction. Never run `git push`, `git tag`, or
  publication automatically from build/release scripts. Never use `force push`.
- Never use the local private historical archive (`~/ForgeOrbit-Archive/`) as a
  Git history source for public `main` — never merge, rebase, or import commits
  from the old private history into the public repository.
- Use the repo-local GitHub noreply author email for commits in this repository
  without modifying global Git configuration.

## Privacy and pre-commit / pre-push hygiene

- Never commit or publish secrets, API keys, OAuth tokens, cookies, signing
  certificates, private keys, Owner Trust receipts or Secure Enclave metadata,
  personal filesystem paths, real AI profile directories/names, SQLite
  databases, commercial project configurations, or private QA artifacts.
- **Before every commit:** inspect the exact list of staged/added files
  (`git status` and `git diff --cached --name-only`).
- **Before every push:** audit outgoing commits and diffs to verify zero
  private data, personal paths, commercial identifiers, or secrets are included.
- Store local QA reports, screenshots, and evidence exclusively in gitignored
  directories (`docs/qa/`, `docs/design/evidence/`, `docs/ux/evidence/`,
  `.forgeorbit-local/`).
- Store personal integrations, staging adapter settings, and machine-local
  overrides outside public Git (see `docs/personal-configuration.md`).

## Local builds, signing, and CI/CD boundaries

- Versioning, build-number allocation, provenance, builds, tests, signing, and
  notarization run locally. Do not create or modify `.github/workflows`, add
  GitHub Actions/CI/CD, or make the build/release process depend on GitHub APIs.
- ForgeOrbit's in-app Pipelines orchestrate AI agents and are unrelated to
  CI/CD. Preserve them. See `docs/release-versioning.md` for the local release
  contract.
- Official public releases, App Store distribution, Apple Developer Program,
  Developer ID, and notarization are not required for personal daily use.
- Use `bun run build:local` for an ad-hoc sealed, production-identity
  (`app.forgeorbit`) app on the existing dev channel with bundled views and
  updates disabled.
- The Owner's installed personal macOS application continues using the local
  `ForgeOrbit Local Owner` certificate and local Owner Trust (pinned outside the
  repository). Keep the separate stable signing/notarization gates intact;
  personal builds must not consume stable identities or claim notarization.

## Build artifact hygiene and recovery retention

- Do not accumulate unnecessary historical build outputs in `build/`.
- After a personal macOS app installation is verified, delete temporary build
  candidates and obsolete `build/*.retained-*` directories that are no longer
  needed for recovery.
- Retain required signed rollback backups and profile snapshots in
  `~/ForgeOrbit-Recovery/` (and provenance receipts in
  `~/Applications/ForgeOrbit.receipts/`).
- Never delete the installed working app (`~/Applications/ForgeOrbit.app`),
  working profile (`~/Library/Application Support/ForgeOrbit`), `vendor/`
  caches, or Owner Trust / Keychain data during cleanup.
- Never commit or publish build artifacts, private QA materials, personal
  configurations, or secrets; audit outgoing changes for private data before
  every `git push`.
