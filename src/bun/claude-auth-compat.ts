/** Explicit persistent QA configuration and fail-closed non-inference probing.
 * Never discover another store, copy credentials or change configuration.
 * The historical undocumented selector remains explicit-only for legacy callers;
 * the supported QA path excludes it and uses documented CLAUDE_CONFIG_DIR.
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export const CLAUDE_QA_CONFIG_SETTING = "FORGEORBIT_CLAUDE_QA_CONFIG_DIR";
export const CLAUDE_QA_AUTH_HOME_SETTING = "FORGEORBIT_CLAUDE_QA_AUTH_HOME";
export const CLAUDE_QA_HOME_ACCEPTANCE_SETTING = "FORGEORBIT_CLAUDE_QA_AUTH_HOME_ACCEPTANCE";
export const CLAUDE_SECURE_STORAGE_SELECTOR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/** Explicit configuration only; never discover, create, copy or clean a profile. */
export function configuredClaudeQaDirectory(source: Record<string, string | undefined>, ambient: Record<string, string | undefined> = process.env): string | undefined {
  return source[CLAUDE_QA_CONFIG_SETTING] ?? ambient[CLAUDE_QA_CONFIG_SETTING];
}
export function configuredClaudeQaAuthHome(source: Record<string, string | undefined>, ambient: Record<string, string | undefined> = process.env): string | undefined {
  return source[CLAUDE_QA_AUTH_HOME_SETTING] ?? ambient[CLAUDE_QA_AUTH_HOME_SETTING];
}
export function claudeQaHomeAccessAccepted(source: Record<string, string | undefined>, ambient: Record<string, string | undefined> = process.env): boolean {
  return (source[CLAUDE_QA_HOME_ACCEPTANCE_SETTING] ?? ambient[CLAUDE_QA_HOME_ACCEPTANCE_SETTING]) === "allow-home-access";
}
export function assertClaudeQaHomeExecutionAccepted(source: Record<string, string | undefined>, ambient: Record<string, string | undefined> = process.env): void {
  if (configuredClaudeQaAuthHome(source, ambient) !== undefined && !claudeQaHomeAccessAccepted(source, ambient)) {
    throw new Error(`Claude QA login HOME exposes user files and is not an OS sandbox. Explicit Owner acceptance (${CLAUDE_QA_HOME_ACCEPTANCE_SETTING}=allow-home-access) and existing execution authorization are required before inference.`);
  }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function overlap(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }

export function validateClaudeQaDirectory(directory: string, env: Record<string, string | undefined>, authHome?: string, cwd?: string): void {
  const invalid = () => new Error(`${CLAUDE_QA_CONFIG_SETTING} and optional ${CLAUDE_QA_AUTH_HOME_SETTING} require existing absolute persistent directories separate from isolated backend HOME, data, temporary and project paths; no fallback or inference.`);
  try {
    if (!directory || !path.isAbsolute(directory) || directory.includes("\0") || !statSync(directory).isDirectory()) throw invalid();
    const canonical = realpathSync(directory);
    if (canonical === path.parse(canonical).root || !env.HOME || !path.isAbsolute(env.HOME)) throw invalid();
    const persistentHome = authHome === undefined ? undefined : realpathSync(authHome);
    if (authHome !== undefined && (!path.isAbsolute(authHome) || !statSync(authHome).isDirectory()
      || persistentHome === path.parse(persistentHome!).root || inside(canonical, persistentHome!)
      || !env.TMPDIR || !(env.FORGEORBIT_DATA_DIR || env.AGETOR_DATA_DIR) || !cwd)) throw invalid();
    const disposable = [env.HOME, env.FORGEORBIT_DATA_DIR, env.AGETOR_DATA_DIR, env.TMPDIR, ...(authHome !== undefined ? [cwd] : [])];
    for (const value of disposable) {
      if (!value) continue;
      if (!path.isAbsolute(value) || !statSync(value).isDirectory()) throw invalid();
      const root = realpathSync(value);
      // Reject both a disposable profile and a cleanup root inside the profile.
      if (overlap(root, canonical) || (persistentHome !== undefined && overlap(root, persistentHome))) throw invalid();
    }
  } catch { throw invalid(); }
}
export function copyClaudeStorageCompatibility(source: Record<string, string | undefined>, target: Record<string, string>): void {
  const value = source[CLAUDE_SECURE_STORAGE_SELECTOR];
  if (value !== undefined) target[CLAUDE_SECURE_STORAGE_SELECTOR] = value;
}
export async function assertBoundedClaudeAuthentication(bin: string, env: Record<string, string>, opts: { qaConfigDirectory?: string; cwd?: string } = {}): Promise<void> {
  let reason = "probe failed or timed out";
  const failure = () => new Error(`Bounded Claude authentication could not be established with 'auth status': ${reason}; no fallback or inference was submitted.`);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (opts.qaConfigDirectory !== undefined && env.CLAUDE_CONFIG_DIR !== opts.qaConfigDirectory) { reason = "QA directory was not propagated"; throw failure(); }
    child = Bun.spawn([bin, "auth", "status"], { cwd: opts.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const probe = child;
    timer = setTimeout(() => { try { probe.kill("SIGKILL"); } catch { /* exited */ } }, 5000);
    // No identity fields, tokens, raw stdout or stderr leave this compatibility boundary.
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text()]);
    let status;
    try { status = JSON.parse(output); } catch { /* fail closed below */ }
    if (status?.loggedIn === false) { reason = "selected profile is not logged in"; throw failure(); }
    if (code !== 0 || status?.loggedIn !== true) { reason = "probe exited unsuccessfully or returned invalid status"; throw failure(); }
    if (opts.qaConfigDirectory !== undefined && status.configDirectory !== opts.qaConfigDirectory) { reason = "CLI selected an unexpected config directory"; throw failure(); }
    if (opts.qaConfigDirectory !== undefined && (status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty")) { reason = "selected authentication is not claude.ai on firstParty"; throw failure(); }
  } catch { throw failure(); }
  finally { clearTimeout(timer); }
}
