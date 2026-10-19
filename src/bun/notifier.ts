/**
 * Resolves and builds argv for AgetorNotifier.app — our own native arm64
 * helper (native/notifier/, built by scripts/build-notifier.ts) that posts a
 * notification whose click opens `agetor://task/<id>` (see deep-link.ts).
 * Electrobun's own `Utils.showNotification` cannot carry a click URL, and
 * terminal-notifier's only prebuilt release is x86_64-only — so we ship our
 * own signed arm64 UNUserNotificationCenter helper. No third-party binary, no
 * Rosetta.
 *
 * Pure and side-effect-free at import time so both functions are trivially
 * unit-testable without spawning anything.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The helper's executable path inside the packaged .app, mirroring
 * tmux-resolution.ts's bundled-path shape: binaries are copied under
 * `Contents/Resources/app/bin` at build time (electrobun.config.ts build.copy
 * maps `vendor/notifier` there, giving `bin/AgetorNotifier.app`).
 */
const NOTIFIER_APPS = ["ForgeOrbitNotifier.app", "AgetorNotifier.app"] as const;

function bundledNotifierCandidates(): string[] {
  const bin = path.join(path.dirname(process.execPath), "..", "Resources", "app", "bin");
  return NOTIFIER_APPS.map((app) => path.join(bin, app, "Contents", "MacOS", "notifier"));
}

function devNotifierCandidates(): string[] {
  const vendor = path.join(import.meta.dir, "..", "..", "vendor", "notifier");
  return NOTIFIER_APPS.map((app) => path.join(vendor, app, "Contents", "MacOS", "notifier"));
}

/**
 * Single source of truth for the notifier helper path. Precedence:
 *   1. FORGEORBIT_NOTIFIER_BIN or AGETOR_NOTIFIER_BIN env override (tests + power users)
 *   2. The helper bundled inside the packaged app.
 *   3. The locally-built helper under vendor/ (dev runs from source).
 */
export function resolveNotifier(): string | null {
  const override = process.env.FORGEORBIT_NOTIFIER_BIN ?? process.env.AGETOR_NOTIFIER_BIN;
  if (override) return override;

  for (const candidate of [...bundledNotifierCandidates(), ...devNotifierCandidates()]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The resolved helper's `.app` bundle path (the parent of Contents/MacOS/…),
 * or null when the helper isn't a real bundle.
 */
export function resolveNotifierApp(): string | null {
  const exe = resolveNotifier();
  if (!exe) return null;
  const isNotifierBundle = NOTIFIER_APPS.some((app) =>
    exe.endsWith(path.join(app, "Contents", "MacOS", "notifier")),
  );
  if (!isNotifierBundle) return null;
  // <app>/Contents/MacOS/notifier -> <app>
  return path.dirname(path.dirname(path.dirname(exe)));
}

export interface NotifierOptions {
  title: string;
  body?: string;
  subtitle?: string;
  /**
   * The helper plays the default sound unless muted. Only an explicit
   * `silent === true` passes `--silent`; `false`/`undefined` let the sound
   * play (the normal case — the /notifications route sends a real boolean).
   */
  silent?: boolean;
  /** Deep-link URL to open on click, e.g. buildTaskDeepLink(taskId). */
  url?: string;
}

/**
 * Builds the argv to pass to the notifier helper AFTER its path. Flag order is
 * fixed (title, message, subtitle, url, silent) so output is deterministic and
 * easy to assert on in tests. The helper requires `--message` (empty allowed).
 * Identity/icon come from the helper's own signed bundle ("Agetor"), so there
 * is no `--sender`.
 */
export function buildNotifierArgs(o: NotifierOptions): string[] {
  const args: string[] = ["--title", o.title, "--message", o.body ?? ""];

  if (o.subtitle) args.push("--subtitle", o.subtitle);
  if (o.url) args.push("--url", o.url);
  if (o.silent === true) args.push("--silent");

  return args;
}
