import { Updater } from "electrobun/bun";
import { publishGlobalEvent } from "./orchestrator.ts";
import type { UpdateStatus } from "../shared/types.ts";

/**
 * Wraps Electrobun's `Updater` with the tiny surface our UI needs:
 *
 *   - A coarse-grained status (`UpdateStatus`) that hides the ~25 substates
 *     the underlying state machine emits — the UI only renders "is there
 *     something to install, yes/no" + an error fallback.
 *   - One periodic poller that runs on app start + every 6 hours.
 *   - A single public broadcast channel (the global SSE stream) so the
 *     webview learns about updates without polling.
 *
 * The Electrobun `Updater` is stateful and singleton-shaped — every fn here
 * touches the same instance. We keep the latest status + version cached
 * here too so a fresh client (SSE is live-only, no replay) can `GET
 * /updates/status` and render the current state without waiting for the
 * next event tick.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface UpdaterSnapshot {
  status: UpdateStatus;
  version: string | null;
  /** Last error message, surfaced for diagnostics. Cleared on next successful tick. */
  error: string | null;
  /** Wall-clock ts of the last check (success or failure). */
  lastCheckedAt: number | null;
}

let snapshot: UpdaterSnapshot = {
  status: "idle",
  version: null,
  error: null,
  lastCheckedAt: null,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function setStatus(status: UpdateStatus, opts: { version?: string | null; error?: string | null; message?: string | null } = {}) {
  snapshot = {
    status,
    version: opts.version !== undefined ? opts.version : snapshot.version,
    error: opts.error !== undefined ? opts.error : (status === "error" ? snapshot.error : null),
    lastCheckedAt: status === "checking" ? snapshot.lastCheckedAt : Date.now(),
  };
  publishGlobalEvent({
    kind: "update",
    status,
    version: snapshot.version,
    message: opts.message ?? snapshot.error ?? null,
    ts: Date.now(),
  });
}

export function getUpdateSnapshot(): UpdaterSnapshot {
  return { ...snapshot };
}

export const ALLOWED_UPDATE_BASE_URL_PREFIX =
  "https://github.com/cbrwvy/forgeorbit/releases/";

/**
 * Guard that ensures ForgeOrbit never checks, downloads, or applies updates
 * from upstream `alamops/agetor` or any unverified update feed.
 */
export function isAllowedUpdateBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl || typeof baseUrl !== "string") return false;
  const normalized = baseUrl.trim().replace(/\/+$/, "") + "/";
  if (normalized.includes("alamops/agetor")) return false;
  return normalized.startsWith(ALLOWED_UPDATE_BASE_URL_PREFIX);
}

/**
 * Probe the update feed; if a newer hash is published, download the bundle
 * so it's staged for `applyUpdate()`. Coalesces concurrent callers onto a
 * single in-flight check — the periodic timer and a manual UI trigger can
 * race otherwise.
 */
export async function checkForUpdate(): Promise<void> {
  if (
    process.env.FORGEORBIT_DISABLE_UPDATES === "1" ||
    process.env.AGETOR_DISABLE_UPDATES === "1"
  ) {
    setStatus("idle");
    return;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      setStatus("checking");
      const baseUrl = await Updater.localInfo.baseUrl();
      if (!isAllowedUpdateBaseUrl(baseUrl)) {
        // Never contact upstream alamops/agetor or an unconfigured feed.
        setStatus("idle");
        return;
      }
      const info = await Updater.checkForUpdate();
      if (info.error) {
        // Before the first release is published on cbrwvy/forgeorbit, GitHub
        // returns 404 for latest/download/*-update.json, which Electrobun
        // surfaces as "Failed to fetch update info from ...". Treat an
        // unpublished feed as idle ("no update available") rather than an
        // alarming error banner.
        if (info.error.startsWith("Failed to fetch update info from ")) {
          setStatus("idle");
          return;
        }
        setStatus("error", { error: info.error, message: info.error });
        return;
      }
      if (!info.updateAvailable) {
        setStatus("idle", { version: info.version });
        return;
      }
      if (info.updateReady) {
        setStatus("ready", { version: info.version });
        return;
      }
      // Update available but not yet downloaded — fetch the bundle now so
      // the UI's "Restart now" button is instant when the user clicks.
      setStatus("downloading", { version: info.version });
      try {
        await Updater.downloadUpdate();
        setStatus("ready", { version: info.version });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error", { error: msg, message: `update download failed: ${msg}` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The most common error here in dev is "channel === 'dev', updates
      // disabled" — Updater short-circuits but doesn't throw, so this
      // branch is reserved for real failures (network down, malformed
      // update.json, etc).
      setStatus("error", { error: msg, message: msg });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Apply the staged update: Electrobun replaces the .app on disk, quits, and
 * relaunches into the new bundle. There's no return path — by the time the
 * underlying promise resolves the process is already exiting. Callers are
 * responsible for checking `getUpdateSnapshot().status === "ready"` first;
 * we don't re-guard here because the only caller is a route handler that
 * already does the synchronous check and would have rejected the request
 * back to the client at that point.
 */
export async function applyUpdate(): Promise<void> {
  const baseUrl = await Updater.localInfo.baseUrl();
  if (!isAllowedUpdateBaseUrl(baseUrl)) {
    throw new Error(
      `Refusing to apply update from untrusted baseUrl: ${baseUrl || "(empty)"}`,
    );
  }
  await Updater.applyUpdate();
}

/**
 * Kick off the initial check and arm the periodic poller. Idempotent — a
 * second call is a no-op so test fixtures that import `index.ts` twice
 * don't end up with two timers running.
 */
export function startUpdaterLoop(): void {
  if (pollTimer) return;
  // Defer the first check past app-start critical-path so it doesn't slow
  // window open / DB warmup. 5 s is well under the user's first interaction.
  setTimeout(() => { void checkForUpdate(); }, 5_000);
  pollTimer = setInterval(() => { void checkForUpdate(); }, CHECK_INTERVAL_MS);
}

/** Test hook: stops the timer so tests don't leak handles. */
export function stopUpdaterLoop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
