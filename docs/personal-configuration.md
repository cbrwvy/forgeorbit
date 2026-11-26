# Personal Configuration Outside Public Git

ForgeOrbit's public repository is intentionally free of personal paths, real AI
account profiles, local certificates, and private infrastructure definitions.
Keep all personal runtime overrides and custom staging integrations outside Git.

## Recommended local layout

Store machine-local configuration under a private directory outside the
repository (mode `0700` for directories, `0600` for files):

```text
~/.config/forgeorbit/
├── env.sh                  # Optional shell exports loaded before local CLI/dev runs (0600)
├── deploy/                 # Optional Owner-maintained local staging scripts (outside Git)
└── catalogs/               # Optional published-images.env catalogs (0600, outside Git)
```

For workspace-local development experiments, `.env.local`, `.forgeorbit-local/`,
`local-config/`, and `docs/qa/` are listed in `.gitignore` and must never be
force-added to Git.

## External staging integration configuration (`external-staging-v1`)

ForgeOrbit exposes a generic, fail-closed staging integration contract
(`external-staging-v1`) without hardcoding any private infrastructure or project
slugs in source control:

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `FORGEORBIT_DEPLOYMENT_STAGING_ADAPTER` | Select `"external"` (or `"fake"` for synthetic tests) | unset (`NOT_CONFIGURED`) |
| `FORGEORBIT_DEPLOYMENT_EXTERNAL_LOCAL_PREFLIGHT` | Set to `"1"` to allow read-only local preflight / `--dry-run` subprocesses on a trusted local script | unset (config-only) |
| `FORGEORBIT_DEPLOYMENT_ALLOWED_SLUGS` | Optional comma-separated allowlist of valid lowercase project slugs | unset (any valid slug pattern) |
| `FORGEORBIT_DEPLOYMENT_TRUSTED_ENTRYPOINTS` | Optional comma-separated extra trusted script basenames (in addition to `deploy-staging.sh` and `deploy-staging-fixture.sh`) | unset |

Image catalogs (`published-images.env`) resolve immutable `@sha256:` references
dynamically from each configured `projectSlug` (`<SLUG_PREFIX>_SHA` /
`EXPECTED_SHA`, `<SLUG_PREFIX>_APP_IMAGE` / `<SLUG_PREFIX>_IMAGE` / `APP_IMAGE`,
and optional `<SLUG_PREFIX>_WEB_IMAGE` / `WEB_IMAGE`).

## Unchanged security boundaries

Externalizing personal configuration does **not** weaken Owner Trust or
deployment authorization boundaries:

- Live remote deployment execution remains unconditionally blocked in the
  application core (`owner-channel-unsupported`); review-only manual handoff
  packets (`executionAuthorized: false`) never grant or invoke execution.
- Local macOS Owner Trust continues to require `app.forgeorbit` signed with the
  Owner's login-keychain `ForgeOrbit Local Owner` certificate (SHA-256 pinned
  outside the repository) and Secure Enclave enrollment stored in the working
  profile (`~/Library/Application Support/ForgeOrbit`).
