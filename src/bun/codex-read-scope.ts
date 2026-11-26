/**
 * Explicit opt-in: restricted tool-command filesystem scope for Codex.
 *
 * Codex's built-in `read-only` and `workspace-write` sandboxes let a model-run
 * command READ everything the macOS user can read (home folder, credential
 * files, the ForgeOrbit data folder, other projects). Setting
 * `FORGEORBIT_CODEX_READ_SCOPE=restricted` for the core process replaces
 * `--sandbox <mode>` with a managed Codex permission profile that grants only:
 *
 *   - system libraries (Codex's own `:minimal` set),
 *   - the working directory (write for `auto`, read for `ask`),
 *   - the Codex executable directories (Codex runs a filesystem helper inside the profile),
 *   - the Bun runtime directories (Developer only, so `bun test` can run),
 *
 * and explicitly denies `/private/tmp` and `/private/var/folders`. Network for
 * tool commands stays disabled. Login is separate: the Codex launcher itself
 * reads `CODEX_HOME`; model-driven tool commands cannot.
 *
 * Fails closed. If the opt-in value is unknown, the mode has no restricted
 * equivalent, or a pre-launch self-test with Codex's own `sandbox` command does
 * not show the expected denials, nothing is started. There is no fallback to
 * the broad built-in profiles, and `AGETOR_CODEX_ARGS` stays refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./db.ts";

export const CODEX_READ_SCOPE_ENV = "FORGEORBIT_CODEX_READ_SCOPE";

export class CodexReadScopeError extends Error {
  constructor(message: string) {
    super(`${message} Nothing was started, and ForgeOrbit does not fall back to the broad Codex sandbox.`);
    this.name = "CodexReadScopeError";
  }
}

export type CodexScopeRole = "developer" | "reader";

export interface CodexReadScope {
  role: CodexScopeRole;
  profileName: string;
  cwd: string;
  /** `-c` pairs placed on `codex exec` and on the self-test. */
  args: string[];
  /** Human-readable grants, for the Owner review and the QA record. */
  reads: string[];
  writes: string[];
  denied: string[];
  digest: string;
}

export function codexReadScopeRestricted(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CODEX_READ_SCOPE_ENV];
  if (value === undefined || value === "") return false;
  if (value === "restricted") return true;
  throw new CodexReadScopeError(`${CODEX_READ_SCOPE_ENV} must be "restricted" or unset, not "${value.slice(0, 40)}".`);
}

/** What the Owner review and the permission disclosure record for this process. */
export function currentReadScope(env: NodeJS.ProcessEnv = process.env): "restricted" | "broad" {
  return codexReadScopeRestricted(env) ? "restricted" : "broad";
}

const TMP_DENIES = ["/private/tmp", "/private/var/folders"];

function toml(value: string): string {
  // Reject what a TOML basic string cannot carry safely instead of escaping it.
  if (/[\u0000-\u001f\u007f"\\]/.test(value)) throw new CodexReadScopeError("A path contains a character that cannot be placed in the permission profile.");
  return `"${value}"`;
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Directories holding an executable and its real location, so a tool or helper can exec it. */
function executableRoots(found: string | null | undefined): string[] {
  if (!found) return [];
  const roots = new Set<string>([path.dirname(found)]);
  try { roots.add(path.dirname(realpathSync(found))); } catch { /* keep the unresolved directory */ }
  return [...roots].filter((root) => path.isAbsolute(root) && root !== "/" && root.split(path.sep).length >= 3);
}

function bunRoots(): string[] { return executableRoots(Bun.which("bun")); }

/** Codex runs its own filesystem helper (instruction loading) inside the profile, so it must be able to exec itself. */
export function codexRoots(bin: string): string[] {
  return executableRoots(path.isAbsolute(bin) ? bin : Bun.which(bin));
}

export function buildCodexReadScope(input: {
  mode: string;
  cwd: string;
  bunRoots?: string[];
  codexRoots?: string[];
  scratchPath?: string | null;
  readOnlyRoots?: readonly string[];
}): CodexReadScope {
  if (input.mode !== "auto" && input.mode !== "ask") {
    throw new CodexReadScopeError(`The restricted read scope exists only for Codex modes auto and ask, not "${input.mode}".`);
  }
  let cwd: string;
  try {
    cwd = realpathSync(input.cwd);
    if (!path.isAbsolute(cwd) || !statSync(cwd).isDirectory() || cwd === "/" || cwd.split(path.sep).length < 4) throw new Error("unsuitable");
  } catch {
    throw new CodexReadScopeError("The working directory is missing or too broad for a restricted read scope.");
  }
  const role: CodexScopeRole = input.mode === "auto" ? "developer" : "reader";
  const reads: string[] = ["system libraries (Codex :minimal)"];
  const writes: string[] = [];
  const entries: string[] = [`":minimal"="read"`, `":project_roots"={"."=${toml(role === "developer" ? "write" : "read")}}`];
  (role === "developer" ? writes : reads).push(`the working directory ${cwd}`);
  if (role === "developer" && input.scratchPath) {
    let scratch: string;
    try {
      scratch = realpathSync(input.scratchPath);
      if (!path.isAbsolute(scratch) || !statSync(scratch).isDirectory() || scratch === "/" || scratch.split(path.sep).length < 4) {
        throw new Error("unsuitable");
      }
    } catch {
      throw new CodexReadScopeError("The task scratch directory is missing or too broad for a restricted read scope.");
    }
    entries.push(`${toml(scratch)}="write"`);
    writes.push(`the task scratch directory ${scratch}`);
  }
  const granted = new Set<string>();
  const grant = (root: string, label: string) => {
    if (granted.has(root)) return;
    granted.add(root);
    entries.push(`${toml(root)}="read"`);
    reads.push(`${label} ${root}`);
  };
  for (const root of input.codexRoots ?? []) grant(root, "Codex executable");
  if (role === "developer") {
    for (const root of input.bunRoots ?? bunRoots()) grant(root, "Bun runtime");
    for (const root of input.readOnlyRoots ?? []) {
      try {
        const real = realpathSync(root);
        if (path.isAbsolute(real) && statSync(real).isDirectory() && real !== "/" && real.split(path.sep).length >= 3) {
          grant(real, "read-only project tools");
        }
      } catch { /* ignore unavailable optional read-only root */ }
    }
  }
  const denied: string[] = [];
  for (const tmp of TMP_DENIES) {
    if (inside(cwd, tmp)) continue;
    entries.push(`${toml(tmp)}="none"`);
    denied.push(tmp);
  }
  const profileName = `forgeorbit_read_scope_${role}`;
  const args = ["-c", `default_permissions=${toml(profileName)}`, "-c", `permissions.${profileName}.filesystem={${entries.join(",")}}`];
  return {
    role, profileName, cwd, args, reads, writes, denied,
    digest: createHash("sha256").update(JSON.stringify({ role, args, cwd })).digest("hex"),
  };
}

const SELF_TEST_TTL_MS = 30_000;
const passed = new Map<string, number>();

export function clearCodexReadScopeSelfTestCache(): void { passed.clear(); }

/**
 * Runs Codex's own `sandbox` command with the exact `-c` configuration of the
 * launch and proves the denials before any model-driven command can exist.
 * The canary sits at the top of the ForgeOrbit data folder, next to the
 * database and the API token file, and is created by ForgeOrbit, not a tool.
 */
export async function assertCodexReadScopeUsable(input: {
  bin: string;
  env: Record<string, string | undefined>;
  scope: CodexReadScope;
  /** Test seam. */
  dataDirectory?: string;
}): Promise<void> {
  const { scope } = input;
  const key = `${scope.digest}\0${input.bin}`;
  const cached = passed.get(key);
  if (cached !== undefined && Date.now() - cached < SELF_TEST_TTL_MS) return;

  const base = input.dataDirectory ?? dataDir;
  const canary = path.join(base, `.codex-read-scope-canary-${randomBytes(6).toString("hex")}`);
  const outsideWrite = `${canary}.write`;
  if (scope.cwd === base) throw new CodexReadScopeError("The working directory is the ForgeOrbit data folder.");
  try {
    writeFileSync(canary, "canary-do-not-read", { mode: 0o600 });
  } catch {
    throw new CodexReadScopeError("The read-scope self-test could not create its canary file.");
  }
  const script = [
    `if cat ${shq(canary)} >/dev/null 2>&1; then echo READ_OUTSIDE=readable; else echo READ_OUTSIDE=denied; fi`,
    `if (echo x > ${shq(outsideWrite)}) 2>/dev/null; then echo WRITE_OUTSIDE=writable; else echo WRITE_OUTSIDE=denied; fi`,
    `if (echo x > ./.forgeorbit-scope-selftest) 2>/dev/null; then echo WRITE_CWD=writable; rm -f ./.forgeorbit-scope-selftest; else echo WRITE_CWD=denied; fi`,
    `echo SELFTEST_DONE`,
  ].join("\n");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) if (value !== undefined) env[name] = value;
  let output = "";
  let code: number | null = null;
  try {
    const proc = Bun.spawn(
      [input.bin, "sandbox", "-C", scope.cwd, "-P", scope.profileName, ...scope.args, "--", "/bin/sh", "-c", script],
      { env, cwd: scope.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    output = out;
    code = exit;
    if (!out.includes("SELFTEST_DONE")) {
      throw new CodexReadScopeError(`Codex rejected the restricted permission profile (${firstLine(err) || `exit ${exit}`}).`);
    }
  } catch (error) {
    if (error instanceof CodexReadScopeError) throw error;
    throw new CodexReadScopeError("Codex could not run its sandbox self-test.");
  } finally {
    rmSync(canary, { force: true });
    rmSync(outsideWrite, { force: true });
  }
  const expected: Record<string, string> = {
    READ_OUTSIDE: "denied",
    WRITE_OUTSIDE: "denied",
    WRITE_CWD: scope.role === "developer" ? "writable" : "denied",
  };
  for (const [name, want] of Object.entries(expected)) {
    const got = new RegExp(`^${name}=(\\w+)$`, "m").exec(output)?.[1] ?? "missing";
    if (got !== want) throw new CodexReadScopeError(`The restricted permission profile did not hold in the pre-launch self-test (${name} was ${got}, expected ${want}; exit ${code}).`);
  }
  passed.set(key, Date.now());
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 200) ?? "";
}

export function describeCodexReadScope(scope: CodexReadScope): string {
  return `Restricted Codex tool scope (${scope.role}): reads ${scope.reads.join("; ")}; writes ${scope.writes.join("; ") || "nothing"}; denies ${scope.denied.join(", ") || "temp folders by location"}; tool-command network disabled.`;
}
