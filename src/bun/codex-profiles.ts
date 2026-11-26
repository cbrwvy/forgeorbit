import { stripVTControlCharacters } from "node:util";
/** FO-MULTIACCOUNT01. AccountCore remains the registry; Harness remains the resource. */
import { activeProviderRefusalsForHarness } from "./provider-refusals.ts";
import { lstatSync, realpathSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { AccountCore, AccountCoreError } from "./account-core.ts";
import { db, harnesses, dataDir } from "./db.ts";
import { resolveBin } from "./agents.ts";
import type { Harness } from "../shared/types.ts";
import type { CodexProfileView } from "../shared/accounts/codex-profile.ts";

const PREFIX = "codex-profile-";
import { CODEX_AUTH_ENV, CODEX_FILE_AUTH } from "../shared/accounts/codex-profile.ts";
import { syntheticRecordedAuthentication } from "./provider-runtime/synthetic-auth.ts";
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const reject = (message: string): never => { throw new AccountCoreError(message, 409); };
const PERMISSION_DENIED = new Set(["EPERM", "EACCES"]);
type RealpathFn = (candidate: string) => string;
let realpathImpl: RealpathFn = (candidate) => realpathSync(candidate);

/** Test-only. Production uses `fs.realpathSync`. A thrown `EPERM` here is the macOS TCC seam. */
export function __setCodexProfileRealpathForTest(fn: RealpathFn | null): void {
  realpathImpl = fn ?? ((candidate) => realpathSync(candidate));
}

function errnoOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

interface ComparablePath {
  path: string;
  /** Set only when a non-symlink exists but realpath is permission-denied. */
  opaque?: { dev: string; ino: string };
}

type ListedStat = { isSymbolicLink(): boolean; isDirectory(): boolean; dev: unknown; ino: unknown };
type Listed = { kind: "stat"; stat: ListedStat } | { kind: "missing" } | { kind: "denied" };

function lstatOrNull(candidate: string): Listed {
  try {
    const stat = lstatSync(candidate);
    return stat ? { kind: "stat", stat } : { kind: "denied" };
  } catch (error) {
    return { kind: errnoOf(error) === "ENOENT" ? "missing" : "denied" };
  }
}

/** Resolve a comparison path. Never treats an unresolved path as "no overlap". */
function resolveComparable(raw: string): ComparablePath {
  const lexical = path.resolve(raw);
  const listed = lstatOrNull(lexical);
  if (listed.kind === "missing") return { path: lexical };
  if (listed.kind === "denied") return reject("A protected path could not be inspected. Registration is refused.");
  try {
    return { path: realpathImpl(lexical) };
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return { path: lexical };
    if (code && PERMISSION_DENIED.has(code) && !listed.stat.isSymbolicLink()) {
      return { path: lexical, opaque: { dev: String(listed.stat.dev), ino: String(listed.stat.ino) } };
    }
    return reject("A protected path could not be resolved. Registration is refused.");
  }
}

function overlapsComparable(protectedPath: ComparablePath, directory: string): boolean {
  if (overlaps(protectedPath.path, directory)) return true;
  if (!protectedPath.opaque) return false;
  const seen = new Set<string>();
  let cursor = directory;
  for (;;) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const listed = lstatOrNull(cursor);
    if (listed.kind !== "stat" || listed.stat.isSymbolicLink()) return true;
    if (String(listed.stat.dev) === protectedPath.opaque.dev && String(listed.stat.ino) === protectedPath.opaque.ino) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export function isCodexProfile(h: Pick<Harness, "id">): boolean { return h.id.startsWith(PREFIX); }

function validatedDirectory(core: AccountCore, raw: unknown, except?: string): { directory: string; directoryIdentity: string } {
  if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw) || path.normalize(raw) !== raw) return reject("Choose an existing absolute canonical CODEX_HOME directory.");
  const home = resolveComparable(process.env.HOME ?? homedir());
  if (home.opaque) return reject("A protected path could not be resolved. Registration is refused.");
  const ownerHome = home.path;
  let directory: string;
  let selectedDenied = false;
  try {
    directory = realpathImpl(raw);
    if (directory !== raw || !lstatSync(raw).isDirectory()) return reject("Profile roots must be real canonical directories, without symlink aliases.");
  } catch (error) {
    if (error instanceof AccountCoreError) throw error;
    const listed = lstatOrNull(raw);
    if (listed.kind === "stat" && (listed.stat.isSymbolicLink() || !listed.stat.isDirectory())) return reject("Profile roots must be real canonical directories, without symlink aliases.");
    if (listed.kind !== "stat") return reject("Profile directory is missing or unreadable.");
    // The selected directory must be canonicalized. Keep checking forbidden overlap so an
    // unreadable protected directory reports that rejection, then refuse it either way.
    selectedDenied = true;
    directory = raw;
  }
  if (!inside(ownerHome, directory) || directory === ownerHome) return reject("Choose a dedicated profile directory inside your home.");
  const defaultHome = path.join(ownerHome, ".codex");
  if (overlaps(defaultHome, directory) && directory !== defaultHome) return reject("Profile roots must not overlap the default Codex profile.");
  const forbidden = [dataDir, path.join(ownerHome, ".Trash"), path.join(ownerHome, ".ssh"), path.join(ownerHome, ".aws")].map(resolveComparable);
  if (["worktrees", "tmp", ".tmp", "attachments"].some(p => inside(path.join(defaultHome, p), directory))) return reject("Disposable Codex workspace roots cannot be authentication profiles.");
  // A temporary test HOME is deliberately supported. Ordinary /tmp roots are outside login HOME.
  const worktreeRoot = path.join(defaultHome, "worktrees");
  for (const row of core.db.query<{ p: string }, []>("SELECT path AS p FROM projects UNION SELECT workdir AS p FROM tasks UNION SELECT worktree_path AS p FROM tasks WHERE worktree_path IS NOT NULL").all()) {
    const resolved = resolveComparable(row.p);
    if (!(directory === defaultHome && !resolved.opaque && inside(worktreeRoot, resolved.path))) forbidden.push(resolved);
  }
  if (forbidden.some(p => overlapsComparable(p, directory))) return reject("Persistent profiles cannot overlap app data, projects or disposable task workspaces.");
  if (selectedDenied) return reject("Profile directory is missing or unreadable.");
  for (let dir = directory; dir !== ownerHome; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return reject("A Git workspace cannot be a persistent authentication profile.");
  }
  const auth = path.join(directory, "auth.json");
  try {
    const st = lstatSync(auth);
    if (!st.isFile() || st.nlink !== 1) return reject("Authentication files must be regular, independent files, never links.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const a of core.listAccounts()) {
    if (a.id === except || !a.codexProfile) continue;
    if (overlaps(directory, a.codexProfile.directory)) return reject("This profile overlaps another registration.");
  }
  const archivedResources = new Set(core.listAccounts(true).filter(a => a.archivedAt !== null).map(a => a.codexProfile?.harnessId));
  for (const h of harnesses.list()) {
    if (archivedResources.has(h.id)) continue;
    if (h.id === PREFIX + except || h.id === "codex" || h.kind !== "codex") continue;
    const other = h.env?.CODEX_HOME ?? (h.home ? path.join(h.home, ".codex") : defaultHome);
    if (overlapsComparable(resolveComparable(other), directory)) return reject("This profile overlaps an existing Codex resource.");
  }
  const st = statSync(directory);
  return { directory, directoryIdentity: `${st.dev}:${st.ino}` };
}

/** Non-mutating directory check. Does not create an account or read credential bytes. */
export function validateCodexProfileDirectory(directory: string, core = new AccountCore(db)): { directory: string; directoryIdentity: string } {
  return validatedDirectory(core, directory);
}

/** Also catches direct Harness edits/removal/re-enabling; never falls back to built-in Codex. */
export function selectedCodexAccount(h: Harness, core = new AccountCore(db)) {
  if (!isCodexProfile(h)) return null;
  const account = core.listAccounts().find(a => a.codexProfile?.harnessId === h.id);
  if (!account || h.kind !== "codex" || !h.enabled || h.home !== null || !core.bindings(account.id).some(b => b.harnessId === h.id)) return reject("Codex profile registration is unavailable. No fallback.");
  const metaRow = core.db.query<{ data: string }, [string]>("SELECT data FROM account_execution_meta WHERE account_id = ?").get(account.id);
  if (metaRow) {
    try { if ((JSON.parse(metaRow.data) as { disabled?: boolean }).disabled === true) return reject("Codex profile is disabled. No fallback."); } catch { /* ignore */ }
  }
  const live = harnesses.get(h.id);
  if (!live?.enabled || live.bin !== h.bin || live.home !== h.home || JSON.stringify(live.env) !== JSON.stringify(h.env)) return reject("Codex resource changed before launch. Review again.");
  const p = account.codexProfile!;
  if (h.env.CODEX_HOME !== p.directory || Object.keys(h.env).length !== 1) return reject("Codex resource configuration changed. Register its directory again and review execution.");
  const checked = validatedDirectory(core, p.directory, account.id);
  if (checked.directoryIdentity !== p.directoryIdentity) return reject("Codex profile directory was replaced. Register it again and review execution.");
  return account;
}

/** Command prefix unsets inherited alternate credentials in the child, including tmux's server environment. */
export function profileCodexCommand(h: Harness, bin: string): string[] {
  if (!isCodexProfile(h)) return [bin];
  selectedCodexAccount(h);
  return ["/usr/bin/env", ...CODEX_AUTH_ENV.flatMap(k => ["-u", k]), bin, ...CODEX_FILE_AUTH];
}

// Ephemeral, exact-profile status only. Passive recommendations never spawn a CLI.
const authenticationChecks = new Map<string, { key: string; at: number; status: CodexProfileView["authentication"] }>();
function authenticationKey(h: Harness) { return JSON.stringify([resolveBin(h), h.home, h.env, selectedCodexAccount(h)?.codexProfile]); }
export function cachedCodexAuthentication(h: Harness, now = Date.now()): CodexProfileView["authentication"] {
  try {
    const saved = authenticationChecks.get(h.id);
    return saved && saved.key === authenticationKey(h) && saved.at <= now && now - saved.at < 30_000 ? saved.status : "unknown";
  } catch { return "unknown"; }
}

export class CodexProfiles {
  constructor(readonly core = new AccountCore(db)) {}
  list(): CodexProfileView[] { return this.core.listAccounts().filter(a => a.codexProfile).map(a => this.view(a.id)); }
  view(id: string): CodexProfileView {
    const a = this.core.getAccount(id), p = a.codexProfile;
    if (!p || a.archivedAt !== null) return reject("Codex profile registration not found.");
    const h = harnesses.get(p.harnessId);
    let available = false;
    try { if (h) { selectedCodexAccount(h, this.core); available = true; } } catch { /* unavailable, no credential access */ }
    return { accountId: a.id, displayName: a.displayName, harnessId: p.harnessId, directory: p.directory,
      authentication: "unknown", availability: available ? "unchecked" : "unavailable", checkedAt: null, quota: "unknown",
      providerRefusal: activeProviderRefusalsForHarness(p.harnessId)[0] ?? null,
      setupCommand: `CODEX_HOME=${quote(p.directory)} codex -c 'cli_auth_credentials_store="file"' login` };
  }
  register(raw: unknown, id?: string): CodexProfileView {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["displayName", "directory"].includes(k))) return reject("Only display name and CODEX_HOME are accepted.");
    const v = raw as Record<string, unknown>;
    if (id && !this.core.getAccount(id).codexProfile) return reject("Codex profile registration not found.");
    const config = validatedDirectory(this.core, v.directory, id);
    const base = harnesses.get("codex");
    if (!base) return reject("Built-in Codex resource is missing.");
    return this.core.db.transaction(() => {
      const a = id ? this.core.updateAccount(id, { displayName: v.displayName }) : this.core.createAccount({ provider: "openai", displayName: v.displayName });
      const harnessId = a.codexProfile?.harnessId ?? PREFIX + a.id;
      if (id) harnesses.update(harnessId, { label: `Codex · ${a.displayName}`, home: null, env: { CODEX_HOME: config.directory } });
      else harnesses.insert({ id: harnessId, kind: "codex", label: `Codex · ${a.displayName}`, bin: base.bin, env: { CODEX_HOME: config.directory } });
      this.core.configureCodex(a.id, { harnessId, ...config });
      this.core.bindHarness(a.id, harnessId);
      return this.view(a.id);
    })();
  }
  remove(id: string): void { this.view(id); this.core.archiveAccount(id); }
  async check(id: string): Promise<CodexProfileView> {
    const before = this.view(id);
    if (before.availability === "unavailable") return before;
    const h = harnesses.get(before.harnessId)!;
    const checkedKey = authenticationKey(h);
    // The same resolver the launch uses (agents.ts), so the status check and the run cannot name different binaries.
    const bin = resolveBin(h);
    const recorded = syntheticRecordedAuthentication("codex", bin, before.directory);
    if (recorded) {
      authenticationChecks.set(h.id, { key: checkedKey, at: Date.now(), status: recorded });
      return { ...before, authentication: recorded, diagnostic: "recorded-fixture", checkedAt: Date.now(), availability: "ready" };
    }
    const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: before.directory };
    for (const k of CODEX_AUTH_ENV) delete env[k];
    let authentication: CodexProfileView["authentication"] = "unknown";
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let diagnostic: CodexProfileView["diagnostic"];
    try {
      // No shell, no login, no credential read, no model call; never serialize raw CLI output.
      proc = Bun.spawn([bin, ...CODEX_FILE_AUTH, "login", "status"], { env, cwd: before.directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      timer = setTimeout(() => { timedOut = true; proc?.kill("SIGKILL"); }, 5000);
      const limited = async (stream: ReadableStream<Uint8Array>) => {
        let text = "", bytes = 0;
        const reader = stream.getReader();
        try { for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; bytes += chunk.length; if (bytes > 16384) { proc?.kill("SIGKILL"); throw new Error("Bounded status"); } text += new TextDecoder().decode(chunk); } } finally { reader.releaseLock(); }
        return text;
      };
      const [out, err, code] = await Promise.all([limited(proc.stdout as ReadableStream<Uint8Array>), limited(proc.stderr as ReadableStream<Uint8Array>), proc.exited]);
      const statusText = stripVTControlCharacters(out + "\n" + err);
      if (!timedOut && code === 0 && /^Logged in using (ChatGPT|an API key)/m.test(statusText)) authentication = "authenticated";
      else if (!timedOut && code !== 0 && /Not logged in/i.test(statusText)) authentication = "required";
      else diagnostic = timedOut ? "status-timeout" : "status-unrecognized";
    } catch { diagnostic = "status-unavailable"; }
    finally { clearTimeout(timer); }
    const after = this.view(id);
    if (after.directory !== before.directory || after.availability === "unavailable" || authenticationKey(harnesses.get(before.harnessId)!) !== checkedKey) return { ...after, availability: "unavailable" };
    authenticationChecks.set(h.id, { key: checkedKey, at: Date.now(), status: authentication });
    return { ...after, authentication, ...(diagnostic ? { diagnostic } : {}), checkedAt: Date.now(), availability: authentication === "authenticated" ? "ready" : authentication === "required" ? "authentication-required" : "unavailable" };
  }
}

export async function assertCodexProfileAuthentication(h: Harness): Promise<void> {
  const a = selectedCodexAccount(h);
  if (!a) return;
  if ((await new CodexProfiles().check(a.id)).availability !== "ready") return reject("Selected Codex profile authentication is unavailable. Check this profile in Accounts. No default fallback.");
}
