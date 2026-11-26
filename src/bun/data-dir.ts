import { homedir } from "node:os";
import path from "node:path";

/** Shared, filesystem-free profile selection for native, headless and CLI.
 * Explicit overrides retain their exact values and precedence. Never discover,
 * inspect or import a legacy profile merely because it exists on disk.
 */
export function resolveDataDir(context: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): string {
  const env = context.env ?? process.env;
  const explicit = env.FORGEORBIT_DATA_DIR ?? env.AGETOR_DATA_DIR;
  if (explicit !== undefined) return explicit;

  const platform = context.platform ?? process.platform;
  const homeFromEnv = env.HOME;
  const home =
    context.home ??
    (typeof homeFromEnv === "string" && homeFromEnv.length > 0 ? homeFromEnv : homedir());
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "ForgeOrbit");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base = local && path.win32.isAbsolute(local) ? local : path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "ForgeOrbit");
  }
  // XDG paths must be absolute; never select a profile relative to project cwd.
  const xdg = env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share"), "forgeorbit");
}
