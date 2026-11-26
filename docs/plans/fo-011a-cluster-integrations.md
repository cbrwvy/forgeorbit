# FO-011A — Knowledge and infrastructure hooks

Cluster ids from migration 077 are the stable owner key. This stage does not store documents or servers. Membership changes do not copy files, read project markdown into a model, or open a network connection.

## Knowledge (FO-011C)

- Address documents as `{ kind: "company" | "cluster" | "project", id }`. Company id is `company:forgeorbit`. Cluster id is the cluster UUID. Project id is the registered project path.
- Store note bodies under the ForgeOrbit data directory. SQLite holds id, owner ref, title, revision, and timestamps. Do not write the note into the project git tree unless the owner explicitly exports it.
- Default context for a project manager is Company, then that project's cluster, then that project. An unassigned project gets Company plus its own notes. A manager in another cluster does not receive this cluster's notes.
- Moving a project changes which cluster notes it can see. Notes stay on the cluster that owns them. Nothing is copied.
- Treat markdown as untrusted data. Quote it, do not promote it to instructions, and do not let it change permissions, accounts, or execution mode.
- Pass a bounded excerpt with source, revision, and time. Record what was left out. Do not send secrets or whole repositories to a harness.
- Do not index or embed project files in this stage. A later reader must be a separate, permissioned action.

## Infrastructure (FO-011D)

- VPS, domains, deployment environments, and CI targets are their own rows. A cluster does not imply a machine. One cluster may reference several VPS rows, and one VPS may be referenced by projects in several clusters.
- The foreign key is the cluster UUID (and the registered project path for project bindings), not the cluster name.
- Unknown provider, region, cost, and status stay unknown. A stored row is not "online". Old observations stay labeled with the time they were recorded.
- Secrets (SSH keys, tokens, `.env`) are not columns on these rows and are not copied into knowledge notes.
- This registry does not SSH, start Docker, or call a cloud API. Those actions need a later, explicit permission.

## Integration with FO-009B

FO-011A appends migration `077_cluster_registry` after `076_account_quota_core`. If FO-009B also claims 077, renumber this migration when the branches merge. Do not edit FO-009B's file. Cluster tables do not reference account or quota tables. Account deletion and quota history are unchanged. A cluster summary reads the existing portfolio snapshot; it does not allocate accounts or switch CLIs.
