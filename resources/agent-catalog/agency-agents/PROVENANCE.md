# Provenance and License Notice — Agency Agents Catalog

## 1. Upstream Source Information

- **Repository**: [https://github.com/msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
- **Source Commit SHA**: `b37b5bb33b78f2c1d6567d98e25ca818e3259219`
- **Imported At**: `2026-10-25T22:34:37+05:00`
- **Vendored Location**: `resources/agent-catalog/agency-agents/`
- **ForgeOrbit Task**: `FO-014A: Vendor Complete Agency Agents Catalog`

## 2. Licensing Compliance

The imported catalog is licensed under the **MIT License**.
Original copyright notice and license terms are preserved verbatim in [`LICENSE`](./LICENSE):

```
MIT License

Copyright (c) 2025 AgentLand Contributors
```

All 283 original Markdown role profiles and strategy documents retain their verbatim text, author attributions, and frontmatter without modification.

## 3. Scope of Vendored Assets

The vendored catalog consists strictly of static reference files:
1. **18 Division Directories**:
   - `academic` (6 profiles)
   - `design` (10 profiles)
   - `engineering` (66 profiles)
   - `finance` (5 profiles)
   - `game-development` (21 profiles, including engine subdirectories: `blender`, `godot`, `roblox-studio`, `unity`, `unreal-engine`)
   - `gis` (13 profiles)
   - `healthcare` (3 profiles)
   - `marketing` (37 profiles)
   - `paid-media` (7 profiles)
   - `product` (6 profiles)
   - `project-management` (7 profiles)
   - `research` (1 profile)
   - `sales` (9 profiles)
   - `security` (12 profiles)
   - `spatial-computing` (6 profiles)
   - `specialized` (59 profiles)
   - `support` (6 profiles)
   - `testing` (9 profiles)
2. **Metadata**:
   - `divisions.json`: Canonical definition of divisions, icons, and colors.
   - `tools.json`: Supported tool taxonomy and contracts.
   - `README.md`: Upstream reference documentation.
   - `LICENSE`: Original MIT license.
3. **Strategy & Runbooks**:
   - `strategy/runbooks.json`: Machine-readable NEXUS scenario team rosters.
   - `strategy/runbooks/*.md`: Detailed operational scenario playbooks.
   - `strategy/playbooks/*.md`: Project lifecycle phase playbooks.
   - `strategy/coordination/*.md`: Handoff templates and activation prompts.
   - `strategy/nexus-strategy.md`, `EXECUTIVE-BRIEF.md`, `QUICKSTART.md`.

Excluded from import:
- Upstream `.git` repository and history.
- Upstream shell scripts (`scripts/install.sh`, conversion tools).
- Generated tool output integrations (`integrations/`).
- CI workflows (`.github/`).
- Third-party installer scripts and scratch examples.

## 4. Runtime Independence & Security Boundaries

- **Zero Runtime Dependencies**: No git submodules, no GitHub API calls, no network fetching, and no auto-update daemon.
- **Untrusted Content**: All prompts, markdown templates, and strategy notes are treated as passive, untrusted textual data.
- **No Automatic Installation**: No files are copied to user tool configuration directories (`~/.claude/`, `~/.codex/`, `~/.cursor/`, `~/.gemini/`, `~/.antigravity/`).
- **No Command Execution**: No code blocks or shell commands embedded within the catalog are executed during import or runtime.
- **Isolation**: Stored completely separate from ForgeOrbit runtime state (`~/.agetor`, SQLite databases, active worktrees).

## 5. Verification

Integrity is validated and recorded in [`catalog-manifest.json`](./catalog-manifest.json):
- 100% profile file retention (283/283 profiles present).
- Bit-identical SHA-256 checksum matching for all 304 source files.
- 100% slug resolution for all runbook rosters (36/36 unique slugs, 64/64 roster positions resolved).
