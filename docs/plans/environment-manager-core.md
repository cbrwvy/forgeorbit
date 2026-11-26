# Plan — Local Environment Manager core (FO-004A)

| Field | Value |
| --- | --- |
| Date | 2026-10-23 |
| Source | FO-004A task prompt |
| Branch | task/fo-004-environment-core |
| Scope | Backend core only. No routes, no UI, no SQLite migration, no Project Wizard. |

## 1. What this core is

`EnvironmentManager` starts, stops, restarts, and rediscovers one local environment per launch profile. A profile is either a local process (`executable` + `args` + `cwd` + an allowlisted env) or a Docker Compose project addressed by an explicit project name, project directory, and compose file.

The manager does not listen on a port, does not poll in the background, and does not open a browser. A future Project Workspace calls it and renders the status it returns.

Pure types and checks live in `src/shared/environment` so the webview can validate a profile later without importing Bun. Spawning, `ps`, Docker, and the lifecycle live in `src/bun/environment`.

## 2. Recorded phase vs observed runtime

`EnvironmentStatus.recordedPhase` is the phase ForgeOrbit last committed (`stopped`, `starting`, `running`, `degraded`, `stopping`, `error`, `unknown`). `observed` is the latest probe: ownership class, whether the process looked alive, and a detail string. A successful `spawn` is not `running`. `running` is set only after the required health checks pass. An optional check can fail and leave the phase `degraded` while required checks stay up. URLs follow their own health-check id, so one optional service does not hide the website link.

Legal transitions are `ENVIRONMENT_TRANSITIONS` in `src/shared/environment/state.ts`. Same-phase commands are not transitions: Start of an already-running environment re-checks health and does not spawn again; Stop of a stopped environment returns success and does not signal. `unknown → stopping` is refused unless the caller just re-proved ownership.

Each profile has its own slot. A per-slot lock is taken synchronously before the first await. A second Start joins that in-flight promise. The lock is cleared before the promise resolves, so `restart` (Stop, then Start) and any awaited follow-up command start a new operation instead of replaying the previous result.

## 3. Local processes

`Bun.spawn` receives an argv array. `commandRejection` refuses a shell command string and a shell invoked with `-c`, `-lc`, `--command`, or `/c`. Arguments may contain `$`, spaces, and `;`; they stay separate argv entries and are not interpolated.

Environment variables are an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TMP`, `TEMP`, `BUN_INSTALL`) plus the profile's explicit `inherit` or `literal` bindings. Parent secrets and `COMPOSE_*` are not copied. ForgeOrbit adds `FORGEORBIT_ENV_ID`, `FORGEORBIT_ENV_TOKEN`, and `FORGEORBIT_ENV_PROFILE`.

When `stop.processGroup` is true and `/usr/bin/perl` exists, the child is a perl supervisor that calls `setsid`, then `fork`/`exec` of the user program. The ownership token is its own argv field, after the script and before the user executable, so `ps -ww -o command=` can show it. macOS `ps` does not reveal another process's environment, so a token only in the environment cannot be re-checked after ForgeOrbit restarts. The supervisor ignores TERM/INT/HUP and waits; a group `SIGTERM` reaches the child. `SIGKILL` follows only after `graceMs` if `killAfterGrace` is set, and only for a pid this slot still owns.

If perl is missing, or `processGroup` is false, only the direct pid is signalled. A descendant that calls `setsid` leaves the group. This core does not search by process name or by port, and it does not call `pkill`.

After a ForgeOrbit restart there is no live `Bun.spawn` handle. Recovery classifies the stored pid as:

- **proven / prior-forgeorbit** — the command line still contains this launch's token immediately followed by the executable, or the env token matches when a probe can see it. The process is left running.
- **dead** — `ps` has no such pid. The record becomes `stopped`. Nothing is signalled.
- **foreign** — the pid is alive and a different token is present. Nothing is signalled. The phase becomes `unknown`.
- **unverified** — the pid is alive and the token cannot be shown. Nothing is signalled.

A PID alone is never enough to kill.

## 4. Docker Compose

Every Compose invocation is `docker compose --project-name <name> --project-directory <cwd> --file <file>` plus an allowlisted subcommand: `version`, `ps`, `up`, `stop`, `logs`. `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE` are not inherited. `assertSafeDockerArgv` rejects `down`, `kill`, `rm`, `system`, `volume`, `prune`, `-v`, `--volumes`, `--remove-orphans`, and `--rmi` before spawn.

`up` is `up -d` for the profile's services only, after `inspect`. An override file under the manager's marker directory adds `forgeorbit.managed`, `forgeorbit.profile`, and `forgeorbit.token`. It is not written into the user's project. Stop is `docker compose stop` for those services, then a second inspect. Containers that are gone, or still present but not running and still labelled as ours, count as stopped. There is no `down -v`, no volume deletion, and no `docker kill` of a container that failed to stop.

Before `up` or `stop`, containers are classified:

- **absent** — nothing for this project name. `up` may create them.
- **managed** — Compose project, working directory, and config files match, and either our token label or the exact stored container ids match. `up` is skipped when they are already running. `stop` is allowed.
- **external** — the same Compose identity is running without our token or ids. `up` is refused (it would recreate someone else's stack). `stop` is refused.
- **foreign / drift** — a different project, directory, config file, or an extra container id. Refused.

`docker ps -aq` ids must match `^[a-f0-9]{12,64}$` before they are passed to `docker inspect`.

## 5. Health checks and URLs

Checks are `tcp`, `http` (GET or HEAD), `process-alive`, and `docker-service`. Each has a timeout, an interval, and a maximum number of attempts, and the run also has a deadline. The default HTTP success list is 200, 201, 202, 203, 204, 206. HTTP 500 is a failure unless the profile lists that status explicitly. Redirects are not followed. Targets must be loopback (`127.0.0.1`, `localhost`, `::1`) with no userinfo. An `AbortSignal` cancels further attempts.

The manager adds an implicit process-alive check for a local profile, and one docker-service check per declared Compose service, unless the profile already has that check. Tests can replace the health function.

URLs have an id, a display name, a role (`website`, `api`, `admin`, `docs`, `other`), a loopback URL, an optional health-check id, and an optional flag. Availability is `up`, `down`, or `unknown`. Nothing opens a browser.

## 6. Persistence seam

`EnvironmentRepository` is `loadAll` / `save` / `remove` of a JSON `StoredEnvironment` (`profile` + `runtime`). `MemoryEnvironmentStore` clones on the way in and out. FO-004A does not add a table. A later SQLite adapter implements the same interface.

`restore()` loads those rows, re-validates each profile, and `reconcile()` probes. It does not spawn and does not signal.

## 7. FO-004B integration

Do this in a follow-up, after FO-003 has landed, and not in this worktree while that work is in progress:

1. Add a SQLite migration and an `EnvironmentRepository` adapter. Do not reuse task rows. One profile id is unique per data directory.
2. Construct one `EnvironmentManager` in the Bun process (the same process as `src/bun/index.ts`), with a marker directory under the data dir, and call `restore()` next to `reconcileOrphans()`. Do not start a second HTTP server or a poll loop.
3. Add routes on the existing localhost API, behind the existing bearer token, without editing Project Wizard, `App.tsx`, or `ProjectSidebar` until the workspace UI task:
   - `GET /projects/:id/environment` — profiles and status for that project path.
   - `GET /projects/:id/environment/:profileId` — status.
   - `POST .../start`, `POST .../stop`, `POST .../restart`.
   - `GET .../logs`, `GET .../urls`.
4. Map `EnvironmentOperationResult.code` to HTTP status (`not-found` 404, `busy` 409, `foreign-process` / `external-environment` / `foreign-compose-project` 409, validation 400, docker and health failures 422 or 503). Return the status body either way so the UI can show the phase.
5. Stream logs later by tailing the same `LogBuffer` over the existing SSE channel. Do not add an event bus for this.
6. Project Workspace buttons: Start, Stop, Restart, Open Website (the client calls the existing `openExternal` only when the user clicks), View Logs. Enable Stop only when `ownership` is `session` or `prior-forgeorbit`. An `external` or `unverified` environment is shown, not stopped.
7. Do not point this manager at ExampleApp, ExamplePortal, ExampleService, or any other running user stack until the workspace task has an explicit per-project opt-in. A profile's `projectName` must be chosen so it cannot collide with a stack the user already runs by hand (`fo-` prefix plus the project id is the suggested default, still overridable).

## 8. Out of scope until a later profile kind exists

Makefile, Python, a native macOS app, arbitrary custom commands, and multi-service local process groups are rejected at validation (`kind is not implemented`) rather than coerced into a shell string. Adding one means a new arm on the launch union, a matching stop strategy, and a host that still cannot signal a process it cannot prove it owns.
