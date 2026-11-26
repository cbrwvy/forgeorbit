# ForgeOrbit development and release constraints

ForgeOrbit is a personal, single-developer macOS project whose verified source
code is published on GitHub (`cbrwvy/forgeorbit`). Versioning, build-number
allocation, provenance, builds, tests, signing and notarization run locally.
Do not create or modify `.github/workflows`, add GitHub Actions/CI/CD, or make
the release process depend on GitHub APIs. Tags, `git push`, and publication
require an explicit Owner instruction; local build/release commands must not
perform those actions automatically.

ForgeOrbit's in-app Pipelines orchestrate AI agents and are unrelated to CI/CD.
Preserve them. See `docs/release-versioning.md` for the local release contract.

Personal daily use does not require Apple Developer Program, Developer ID,
notarization or official binary distribution. Use `bun run build:local` for an
ad-hoc sealed, production-identity app on the existing dev channel, with bundled
views and updates disabled. Keep the separate stable signing/notarization gates
intact; personal builds must not consume stable identities or claim notarization.

## Privacy and repository hygiene

Never commit secrets, API tokens, cookies, certificates, Owner Trust receipts,
personal home paths, personal AI profile directories, SQLite databases, local
QA evidence archives, or private commercial infrastructure configs into this
public repository. Keep personal configurations and custom deployment adapters
outside Git (for example in `~/.config/forgeorbit/` or untracked `.env.local`).
