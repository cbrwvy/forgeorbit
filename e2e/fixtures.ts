import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type WriteStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { E2E_BASE_URL, E2E_API_PORT_OFFSET } from "../playwright.config";
import { isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";

export { expect } from "@playwright/test";
export type { APIRequestContext, Locator, Page } from "@playwright/test";

/**
 * Worker-scoped headless-backend fixture (docs/plans/e2e-per-worker-backends
 * .md §3). Each Playwright worker spawns its own `bun src/bun/headless.ts`
 * on a dedicated data dir + port + token, so `bunx playwright test` can run
 * every spec file's worker in parallel without any of them racing shared
 * SQLite preference/task state. Vite stays single-instance and shared — see
 * `playwright.config.ts`'s `webServer` block.
 */
export interface E2EBackend {
  apiPort: number;
  apiToken: string;
  apiBase: string;
  bootBase: string;
  dataDir: string;
  /** Port the per-worker/per-test stub GitHub API server should (or does)
   *  listen on — see `e2e/github-stub.ts`. The backend is launched with
   *  `AGETOR_GITHUB_API_BASE` pointed at this port, so a spec that starts
   *  `startGitHubStub(backend.githubStubPort, routes)` transparently becomes
   *  the app's GitHub API for the lifetime of that backend. */
  githubStubPort: number;
  /** Directory `POST /refs/pick` returns from in this headless backend.
   *  Use `plantPicks` — it clears first; the dir is worker-shared, so a
   *  spec that writes into it directly can leak stale files into a later
   *  spec's "files" pick. See the seam in server.ts. */
  fakePickDir: string;
  /** Clears `fakePickDir` (it's worker-shared, so a spec's leftover files
   *  would otherwise leak into the next spec's "files"-mode pick) and
   *  replants it with the given `{ name: content }` entries, returning
   *  their absolute paths in the same key order. Call this instead of
   *  writing into `fakePickDir` by hand before exercising the
   *  Files/Folder picker buttons. */
  plantPicks: (files: Record<string, string>) => Promise<string[]>;
  /** Where `POST /bundle/export/save` with `target: "downloads"` writes in
   *  this backend (`AGETOR_DOWNLOADS_DIR`, docs/plans/agents-pipelines-
   *  import-export.md). Not created up front — the server creates it on the
   *  first save, exactly like a missing `~/Downloads`. */
  downloadsDir: string;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Disjoint from 4317 (packaged app default), 4318 (legacy single-shared e2e
// port), and 4399-4531 (bun unit tests, one static port per file).
const BASE_API_PORT = 4600 + E2E_API_PORT_OFFSET;

// Overridable so a slow/loaded machine (many concurrent worker backends
// booting at once) can widen the budget without editing source — mirrors the
// old webServer timeout, which this fixture's health poll effectively
// replaced per worker.
const HEALTH_TIMEOUT_MS = Number(process.env.E2E_HEALTH_TIMEOUT_MS ?? 60_000);
const HEALTH_POLL_INTERVAL_MS = 200;
const TEARDOWN_GRACE_MS = 4_000;
/** The fake fx storm's pause and the fx auto-resume delay this fixture sets
 *  on every backend (`AGETOR_FAKE_FX_RECOVERY_PAUSE_MS`,
 *  `AGETOR_FX_AUTO_RESUME_DELAY_MS` below). Exported so
 *  `e2e/fx-recovery.spec.ts` sizes its waits from the same numbers. */
export const E2E_FX_STORM_PAUSE_MS = 6_000;
export const E2E_FX_AUTO_RESUME_DELAY_MS = 6_000;
const FINAL_KILL_WAIT_MS = 2_000;
const PREFLIGHT_TIMEOUT_MS = 2_000;

// Harness homes, the fx stub, `HOME` and the core's env all come from
// `e2e/isolated-env.ts` — shared with specs that boot their own core.
export { seedIsolatedHarnessHomes } from "./isolated-env";

async function tailFile(filePath: string, maxBytes = 4_000): Promise<string> {
  if (!existsSync(filePath)) return `<${filePath} not found>`;
  try {
    const contents = await readFile(filePath, "utf8");
    return contents.slice(-maxBytes);
  } catch {
    return `<${filePath} unreadable>`;
  }
}

/** headless.ts's real diagnostics (bind failures, shutdown reason, idle
 *  reaper errors) go through `daemonLog` to `<dataDir>/daemon.log`, NOT to
 *  the piped stdout/stderr in `backend.log` — most startup failures leave
 *  backend.log empty and the useful signal in daemon.log. Tail both so a
 *  failure message always points at the actual cause. */
async function formatLogTails(logFile: string, daemonLogFile: string): Promise<string> {
  const [stdoutTail, daemonTail] = await Promise.all([tailFile(logFile), tailFile(daemonLogFile)]);
  return (
    `--- stdout/stderr tail (${logFile}) ---\n${stdoutTail}\n` +
    `--- daemon log tail (${daemonLogFile}) ---\n${daemonTail}`
  );
}

/** Pre-flight guard against adopting a stale/foreign backend: `/health` is
 *  unauthenticated, so if anything is already listening on this worker's
 *  port (an orphaned headless.ts from a prior interrupted run, most likely)
 *  the post-spawn health poll would happily treat it as "ours" — the token
 *  mismatch would only surface later, on the first authenticated request,
 *  far from this fixture and hard to diagnose. Fail fast here instead. */
async function assertPortFree(apiBase: string, apiPort: number): Promise<void> {
  let answered: boolean;
  try {
    await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    answered = true;
  } catch {
    answered = false; // connection refused/timed out — port is free, proceed
  }
  if (!answered) return;
  throw new Error(
    `port ${apiPort} is already serving something (pre-flight GET ${apiBase}/health got a ` +
      `response before we spawned anything) — a stale headless.ts from a prior run is the ` +
      `likely cause. Recover with:\n  lsof -ti :${apiPort} | xargs kill`,
  );
}

async function waitForHealth(apiBase: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `headless backend at ${apiBase} never became healthy within ${HEALTH_TIMEOUT_MS}ms` +
      (lastError ? ` (last poll error: ${String(lastError)})` : ""),
  );
}

/** SIGTERM, wait up to TEARDOWN_GRACE_MS for a clean exit, SIGKILL fallback.
 *  Resolves once the process has exited (or we've waited as long as we're
 *  willing to), so the caller can `rm -rf` the data dir right after without
 *  racing a still-shutting-down SQLite connection. Never hangs: a child that
 *  never spawned (`pid === undefined`, e.g. `bun` missing from PATH raised
 *  ENOENT) has nothing to wait for, and the post-SIGKILL wait is bounded —
 *  a process wedged in uninterruptible I/O would otherwise stall teardown
 *  forever. */
async function killGracefully(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  let settled = false;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // ENOENT-style spawn failures can emit 'error'+'close' without ever
    // firing 'exit'; listen for both so we don't wait on the one that never
    // comes.
    child.once("exit", done);
    child.once("close", done);
  });

  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false as const),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), TEARDOWN_GRACE_MS)),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, FINAL_KILL_WAIT_MS))]);
  }
}

/**
 * Spawns one `headless.ts` backend on `apiPort`/`apiToken`, waits for it to
 * become healthy, hands it to `use()`, and tears it down afterward. Shared by
 * both `backend` (worker-scoped — one long-lived instance reused by every
 * test in a worker) and `freshBackend` (test-scoped — a brand-new instance
 * per test; see that fixture's doc comment for why it exists) below.
 * `logLabel` only affects log/error messages (e.g. "worker 2" vs a test
 * title) so a startup failure or mid-suite-death report points at the right
 * instance. `extraEnv` (default `{}`) is merged on top of the base env
 * below — additive, spread last so a spec-supplied value always wins — for
 * a test that needs a seam env var (e.g.
 * `AGETOR_FAKE_CLAUDE_SPAWN_DELAY_MS`, see `docs/plans/task-details-blank-
 * while-session-restores.md` §5 E1) on its own dedicated backend rather than
 * the worker-shared one. See the `backendEnv` fixture option below.
 */
async function provisionBackend(
  apiPort: number,
  apiToken: string,
  githubStubPort: number,
  logLabel: string,
  use: (backend: E2EBackend) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const apiBase = `http://127.0.0.1:${apiPort}`;

  await assertPortFree(apiBase, apiPort);

  const dataDir = await mkdtemp(path.join(tmpdir(), "agetor-e2e-"));
  const logFile = path.join(dataDir, "backend.log");
  const daemonLogFile = path.join(dataDir, "daemon.log");
  // Must happen before the spawn below — see writeFxStubBin's doc comment.
  const fxStubBinPath = writeFxStubBin(dataDir);
  // Backs the `/refs/pick` test seam (src/bun/server.ts) — a spec plants
  // files here, then clicks the picker's Files/Folder button, and the
  // headless backend returns them instead of opening a native panel that
  // doesn't exist in this environment. Created up front (like the fx stub
  // bin above) so a spec can write into it before the backend even boots.
  const fakePickDir = path.join(dataDir, "fake-picks");
  mkdirSync(fakePickDir, { recursive: true });
  // Save to Downloads target for the bundle export (see `downloadsDir`).
  const downloadsDir = path.join(dataDir, "fake-downloads");

  const logStream: WriteStream = createWriteStream(logFile);
  await new Promise<void>((resolve, reject) => {
    logStream.once("open", () => resolve());
    logStream.once("error", reject);
  });

  const seed = seedIsolatedHarnessHomes(dataDir, fxStubBinPath);
  if (!seed.ok) {
    logStream.end();
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(`could not initialize isolated test accounts: ${seed.stderr}`);
  }

  const child = spawn("bun", ["src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    // Own SQLite, own HOME, every harness/tmux binary stubbed, fake drivers,
    // usage poller offline, and nothing FORGEORBIT_*/AGETOR_*/credential-like
    // inherited from the shell (see `isolatedCoreEnv`).
    env: isolatedCoreEnv({
      dataDir,
      apiPort,
      apiToken,
      fxBin: fxStubBinPath,
      extra: {
        // Test seam for the fx auto-resume engine (`docs/plans/fx-recovery-
        // follow-ups.md` §3, `orchestrator.ts`'s `fxAutoResumePrefs`) — shrinks
        // the auto-resume delay from the 120s default down to 2s so
        // `e2e/fx-recovery.spec.ts` can observe a scheduled/cancelled/fired
        // auto-resume within a normal test timeout instead of waiting out the
        // production default. Read once per schedule/re-arm, so it applies to
        // every fx task this worker's backend ever runs, not just one spec's
        // tasks — no other spec file in this fixture starts an fx run.
        // 6s rather than the 2s it once was: the spec has to see the countdown
        // and click Cancel inside this window, and a loaded machine (load ~40)
        // spent most of 2s on the panel's poll round-trips alone.
        AGETOR_FX_AUTO_RESUME_DELAY_MS: String(E2E_FX_AUTO_RESUME_DELAY_MS),
        // Test seam for the fake fx storm (`src/bun/agents.ts`,
        // `fakeFxRecoveryPauseMs`): pause at 6s instead of 1.5s, so the live
        // "retrying" notice `e2e/fx-recovery.spec.ts` asserts stays up long
        // enough to be seen under load. Only that spec runs the storm.
        AGETOR_FAKE_FX_RECOVERY_PAUSE_MS: String(E2E_FX_STORM_PAUSE_MS),
        // Test seam for the fake fx driver's recovery scenario (`src/bun/
        // agents.ts`'s `FAKE_FX_RECOVERY_URL_PROMPT_MARKER` doc comment) —
        // process-wide equivalent of the per-task prompt marker, so every
        // `active`/`paused` recovery message this worker's fake fx driver
        // emits carries a fake Gateway URL suffix
        // (" · upgrade at https://example.invalid/upgrade"), letting
        // `e2e/fx-recovery.spec.ts` exercise the notice's clickable-link
        // rendering without a real Gateway URL. Off (unset) would leave every
        // such message byte-identical to before this constant existed — on
        // is what this spec's tests are written against.
        AGETOR_FAKE_FX_RECOVERY_URL: "1",
        // Points every GitHub REST/GraphQL call this backend makes at a local
        // stub server instead of the real api.github.com (see
        // src/bun/github.ts's `GITHUB_API_BASE` seam and e2e/github-stub.ts).
        // Specs that never open the Git dialog never hit this — it's inert
        // until something calls startGitHubStub(backend.githubStubPort, ...).
        AGETOR_GITHUB_API_BASE: `http://127.0.0.1:${githubStubPort}`,
        // Test seam for `/refs/pick` (src/bun/server.ts) — see fakePickDir
        // above. Never set in production launches.
        AGETOR_FAKE_PICK_REFS_DIR: fakePickDir,
        // Test seam for the bundle export's Save to Downloads — see
        // downloadsDir above. Never set in production launches.
        AGETOR_DOWNLOADS_DIR: downloadsDir,
        // Spec-supplied overrides/additions (see `extraEnv`'s doc above) —
        // spread last so they can override any of the defaults above too.
        ...extraEnv,
      },
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Surfaces a backend that dies mid-suite (crash, OOM, someone `kill`s
  // it by hand) instead of leaving it silent — later tests would just
  // see ECONNREFUSED and point at the wrong thing. Guarded by
  // `tearingDown` so our own intentional kill in the teardown path below
  // isn't misreported as a mid-suite death.
  let tearingDown = false;
  // Boxed in an object (rather than a bare reassigned `let`) so TS
  // doesn't narrow the read below back to `null` across the intervening
  // `await use(backend)` — a plain closure-mutated `let` loses that
  // narrowing.
  const deathReport: { info: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    info: null,
  };
  child.on("exit", (code, signal) => {
    if (!tearingDown) deathReport.info = { code, signal };
  });

  // Race the health poll against an early exit/spawn failure (e.g. `bun`
  // not on PATH, or headless.ts throwing before it binds) so a
  // misconfigured child fails fast with a useful error instead of
  // burning the full health-poll timeout. `.catch(() => {})` on the
  // standalone reference keeps a late rejection (the child exiting
  // normally during teardown, well after the race has already resolved)
  // from surfacing as an unhandled rejection.
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`headless backend exited early (code=${code}, signal=${signal})`));
    });
  });
  spawnError.catch(() => {});

  try {
    await Promise.race([waitForHealth(apiBase), spawnError]);
    // `/health` answered, but confirm it was actually *our* child that
    // answered it and not some other process that raced in and bound
    // the port after assertPortFree's pre-flight check but before (or
    // during) our own spawn — e.g. our child crashed immediately after
    // binding and something else grabbed the now-free port before this
    // check ran.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${apiBase}/health answered but our child (pid ${child.pid}) had already exited ` +
          `(code=${child.exitCode}, signal=${child.signalCode}) — another process owns that port.`,
      );
    }
  } catch (err) {
    const tails = await formatLogTails(logFile, daemonLogFile);
    tearingDown = true;
    await killGracefully(child);
    logStream.end();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${(err as Error).message}\n${tails}`);
  }

  // Backs `E2EBackend.plantPicks` — see its JSDoc on the interface above.
  // Closes over `fakePickDir` so callers never have to pass it themselves.
  async function plantPicks(files: Record<string, string>): Promise<string[]> {
    await rm(fakePickDir, { recursive: true, force: true });
    await mkdir(fakePickDir, { recursive: true });
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(fakePickDir, name);
      await writeFile(filePath, content);
      paths.push(filePath);
    }
    return paths;
  }

  const backend: E2EBackend = {
    apiPort,
    apiToken,
    apiBase,
    bootBase: `${E2E_BASE_URL}/#api=${apiPort}&token=${apiToken}`,
    dataDir,
    githubStubPort,
    fakePickDir,
    plantPicks,
    downloadsDir,
  };

  await use(backend);

  if (deathReport.info) {
    const tails = await formatLogTails(logFile, daemonLogFile);
    // eslint-disable-next-line no-console -- deliberate loud stderr so the
    // report points at infrastructure, not a flaky test.
    console.error(
      `[e2e] backend for ${logLabel} died mid-suite: ` +
        `code=${deathReport.info.code} signal=${deathReport.info.signal}\n${tails}`,
    );
  }

  tearingDown = true;
  await killGracefully(child);
  logStream.end();
  if (process.env.E2E_KEEP_DATA_DIR) {
    console.log(`[e2e] E2E_KEEP_DATA_DIR set — keeping ${dataDir}`);
  } else {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Disjoint from BASE_API_PORT's worker range (4600 + up to ~workers) with a
// wide gap — `freshBackend` below is test-scoped, so at most a handful of
// these run concurrently even on a many-worker machine.
const FRESH_BASE_API_PORT = 4700 + E2E_API_PORT_OFFSET;

// Disjoint from BASE_API_PORT (4600+) and FRESH_BASE_API_PORT (4700+) above —
// each worker's (and each freshBackend test's) stub GitHub API server gets
// its own port so parallel workers/tests never collide on it, mirroring how
// the two API-port ranges stay disjoint from each other.
const GITHUB_STUB_BASE_PORT = 4800 + E2E_API_PORT_OFFSET;
const FRESH_GITHUB_STUB_BASE_PORT = 4900 + E2E_API_PORT_OFFSET;

export const test = base.extend<
  { freshBackend: E2EBackend; backendEnv: Record<string, string> },
  { backend: E2EBackend }
>({
  backend: [
    async ({}, use, workerInfo) => {
      // `parallelIndex` is the stable 0..(workers-1) slot this worker
      // process occupies for the whole run; `workerIndex` increments every
      // time Playwright restarts a worker (e.g. after a crash), so a
      // restarted worker could reuse another worker's still-live
      // `workerIndex`-derived port. `parallelIndex` never collides with a
      // concurrently-running worker, which is what a port assignment needs.
      const apiPort = BASE_API_PORT + workerInfo.parallelIndex;
      // Random, not deterministic: a deterministic per-worker token would
      // let a stale backend still bound to this port (see assertPortFree
      // above) silently authenticate as "ours" if the pre-flight check ever
      // raced it. A random token makes any such impostor fail auth loudly
      // instead.
      const apiToken = `e2e-w${workerInfo.parallelIndex}-${randomUUID()}`;
      const githubStubPort = GITHUB_STUB_BASE_PORT + workerInfo.parallelIndex;
      await provisionBackend(apiPort, apiToken, githubStubPort, `worker ${workerInfo.parallelIndex}`, use);
    },
    { scope: "worker" },
  ],

  // Test-scoped: a brand-new headless backend + SQLite DB spawned for this
  // one test and torn down right after, unlike `backend` above (worker-
  // scoped, shared by every test in the file). theme/font-size/quote reset
  // the one preference they care about before each test and are fine sharing
  // a DB. Onboarding can't do that: `resolveOnboardingVisibility` (src/
  // mainview/lib/onboarding.ts) branches on whether `onboardingDismissed` has
  // *ever* been written (`dismissedPref === undefined`), and there is no
  // "unset preference" API — once any test writes that key (directly, via
  // Skip/Dismiss, or via the auto-dismiss-when-all-steps-done effect), no
  // later test sharing that DB could ever observe the "never evaluated"
  // state again. Several onboarding.spec.ts cases need exactly that state
  // independently (fresh welcome dialog, skip-then-persist, existing-user
  // auto-dismiss), so each gets its own virgin backend instead of fighting
  // over one shared DB.
  // Additive test option (not a fixture with real setup/teardown of its
  // own — `{ option: true }` makes it configurable via
  // `test.use({ backendEnv: {...} })`), consumed by `freshBackend` below.
  // Defaults to `{}` so every existing `freshBackend` consumer spawns its
  // backend exactly as before.
  backendEnv: [{}, { option: true }],

  freshBackend: async ({ backendEnv }, use, testInfo) => {
    const apiPort = FRESH_BASE_API_PORT + testInfo.parallelIndex;
    const apiToken = `e2e-fresh-w${testInfo.parallelIndex}-${randomUUID()}`;
    const githubStubPort = FRESH_GITHUB_STUB_BASE_PORT + testInfo.parallelIndex;
    await provisionBackend(apiPort, apiToken, githubStubPort, `test "${testInfo.title}"`, use, backendEnv);
  },
});
