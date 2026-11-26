/**
 * Subprocess-only ForgeOrbit profile-activation probe (FO-P2-005-A).
 *
 * The caller must supply an isolated HOME/TMPDIR/FORGEORBIT_DATA_DIR before
 * this process starts. It never starts a server, spawns an agent, or touches
 * any real profile. Modes are used by real-process crash/concurrency tests and
 * by the synthetic activation round trip.
 */

import path from "node:path";
import { existsSync } from "node:fs";

type Mode =
  | "startup"
  | "open-db"
  | "prepare"
  | "rollback"
  | "inspect-active"
  | "inspect-candidate"
  | "paths"
  | "hold-lock"
  | "hold-pinned-paths"
  | "resolve-active";

function emit(value: unknown): void {
  console.log("ACTIVATION_PROBE " + JSON.stringify(value));
}

function baseDataDir(): string {
  return process.env.FORGEORBIT_DATA_DIR ?? process.env.AGETOR_DATA_DIR ?? "";
}

async function serviceForActive(): Promise<{
  service: import("../profile-activation.ts").ProfileActivationService;
}> {
  const { ProfileActivationService } = await import("../profile-activation.ts");
  const { resolveActiveDataDir } = await import("../profile-activation-state.ts");
  const { resolveDataDir } = await import("../data-dir.ts");
  const active = resolveActiveDataDir();
  return {
    service: new ProfileActivationService({
      activeDataDir: active,
      baseDataDir: resolveDataDir(),
    }),
  };
}

async function run(): Promise<void> {
  const mode = process.argv[2] as Mode | undefined;
  const argument = process.argv[3];
  switch (mode) {
    case "startup": {
      const { resolveStartupProfile } = await import("../profile-activation.ts");
      const resolution = resolveStartupProfile({ baseDataDir: baseDataDir() });
      emit({
        baseDataDir: resolution.baseDataDir,
        activeDataDir: resolution.activeDataDir,
        controlDir: resolution.controlDir,
        recovered: resolution.recovered,
        recoveredFrom: resolution.recoveredFrom,
        selection: resolution.selection
          ? {
              generation: resolution.selection.generation,
              activeProfilePath: resolution.selection.activeProfilePath,
              previousProfilePath: resolution.selection.previousProfilePath,
              transitionId: resolution.selection.transitionId,
            }
          : null,
        journal: resolution.journal
          ? {
              transitionId: resolution.journal.transitionId,
              action: resolution.journal.action,
              state: resolution.journal.state,
              startupAttempts: resolution.journal.startupAttempts,
            }
          : null,
        warnings: resolution.warnings,
      });
      return;
    }
    case "open-db": {
      // Importing db.ts performs the startup resolution before SQLite opens.
      const module = await import("../db.ts");
      const taskCount = module.db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks;").get()?.count ?? 0;
      const migrations = module.db.query<{ count: number }, []>("SELECT count(*) AS count FROM _migrations;").get()?.count ?? 0;
      emit({
        dataDir: module.dataDir,
        baseDataDir: module.baseDataDir,
        startup: module.startupProfileInfo,
        taskCount,
        migrations,
        journalMode: module.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get()?.journal_mode ?? null,
      });
      module.db.close();
      return;
    }
    case "prepare": {
      if (!argument) throw new Error("prepare requires a candidate path");
      const { service } = await serviceForActive();
      emit(service.prepareActivation({ candidatePath: argument }));
      return;
    }
    case "rollback": {
      const { service } = await serviceForActive();
      emit(service.requestRollback());
      return;
    }
    case "inspect-active": {
      const { service } = await serviceForActive();
      emit(service.inspectActiveProfile());
      return;
    }
    case "inspect-candidate": {
      if (!argument) throw new Error("inspect-candidate requires a candidate path");
      const { service } = await serviceForActive();
      emit(service.inspectCandidate(argument));
      return;
    }
    case "paths": {
      const module = await import("../db.ts");
      const { coreCredsPath } = await import("../core-creds.ts");
      const { githubTokensPath } = await import("../github-tokens.ts");
      const { daemonLogPath } = await import("../daemon-log.ts");
      emit({
        dataDir: module.dataDir,
        baseDataDir: module.baseDataDir,
        credsFilePath: module.credsFilePath,
        coreCredsPath: coreCredsPath(),
        githubTokensPath: githubTokensPath(),
        daemonLogPath,
        pidFilePath: module.pidFilePath,
      });
      module.db.close();
      return;
    }
    case "hold-pinned-paths": {
      if (!argument) throw new Error("hold-pinned-paths requires a trigger file path");
      const trigger = argument;
      const dbModule = await import("../db.ts");
      const { resolveActiveDataDir } = await import("../profile-activation-state.ts");
      const { getPinnedRuntimeActiveDataDir } = await import("../profile-paths.ts");
      const { coreCredsPath } = await import("../core-creds.ts");
      const { githubTokensPath } = await import("../github-tokens.ts");
      const { daemonLogPath } = await import("../daemon-log.ts");
      const snapshot = () => ({
        dataDir: dbModule.dataDir,
        pinned: getPinnedRuntimeActiveDataDir(),
        resolver: resolveActiveDataDir(),
        credsFilePath: dbModule.credsFilePath,
        coreCredsPath: coreCredsPath(),
        githubTokensPath: githubTokensPath(),
        daemonLogPath,
        pidFilePath: dbModule.pidFilePath,
        sqlitePath: path.join(dbModule.dataDir, "agetor.sqlite"),
      });
      emit({ phase: "initial", ...snapshot() });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (existsSync(trigger)) break;
        await Bun.sleep(25);
      }
      if (!existsSync(trigger)) throw new Error("hold-pinned-paths timed out waiting for trigger");
      emit({ phase: "after-selection-change", ...snapshot() });
      dbModule.db.close();
      return;
    }
    case "resolve-active": {
      const { validateDurableActivationState } = await import("../profile-activation-state.ts");
      const { resolveDataDir } = await import("../data-dir.ts");
      const state = validateDurableActivationState({ env: process.env });
      emit({
        baseDataDir: state.baseDataDir,
        activeDataDir: state.activeDataDir,
      });
      return;
    }
    case "hold-lock": {
      const { activationControlDir, acquireTransitionLock } = await import("../profile-paths.ts");
      const controlDir = activationControlDir(baseDataDir());
      const lock = acquireTransitionLock(controlDir, 5_000);
      emit({ ready: true, controlDir, pid: process.pid });
      const keepAlive = setInterval(() => {}, 1_000);
      process.on("SIGTERM", () => {
        clearInterval(keepAlive);
        lock.release();
        process.exit(0);
      });
      process.on("SIGINT", () => {
        clearInterval(keepAlive);
        lock.release();
        process.exit(0);
      });
      // Never let the top-level `process.exit(0)` release the lock; the parent
      // stops this holder explicitly.
      await new Promise<void>(() => {});
      return;
    }
    default:
      throw new Error(`unknown probe mode: ${String(mode)}`);
  }
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const record = error as { code?: unknown; message?: unknown };
  console.error(
    "ACTIVATION_PROBE_ERROR " +
      JSON.stringify({
        code: typeof record?.code === "string" ? record.code : "ERROR",
        message: typeof record?.message === "string" ? record.message : String(error),
        path: process.argv[3] ? path.basename(process.argv[3]) : null,
      }),
  );
  process.exit(3);
}
