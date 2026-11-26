/** FO-MULTIACCOUNT02. Register an existing CLAUDE_CONFIG_DIR. Partial isolation. No credential copy. */
import { lstatSync, realpathSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { AccountCore, AccountCoreError } from "./account-core.ts";
import { db, harnesses, dataDir } from "./db.ts";
import { resolveBin } from "./agents.ts";
import type { Harness } from "../shared/types.ts";
import type { Account } from "../shared/accounts/types.ts";
import { CLAUDE_PROFILE_LIMITATIONS, type ClaudeProfile, type ClaudeProfileView } from "../shared/accounts/claude-profile.ts";
import { syntheticRecordedAuthentication } from "./provider-runtime/synthetic-auth.ts";

const PREFIX = "claude-profile-";
const reject = (message: string): never => { throw new AccountCoreError(message, 409); };
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export type { ClaudeProfileView };

export function isClaudeProfile(harness: Pick<Harness, "id">): boolean {
  return harness.id.startsWith(PREFIX);
}

function validatedDirectory(core: AccountCore, raw: unknown, except?: string): { directory: string; directoryIdentity: string } {
  if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw) || path.normalize(raw) !== raw) {
    return reject("Choose an existing absolute canonical CLAUDE_CONFIG_DIR.");
  }
  const ownerHome = realpathSync(process.env.HOME ?? homedir());
  let directory: string;
  try {
    directory = realpathSync(raw);
    if (directory !== raw || !lstatSync(raw).isDirectory()) return reject("Profile roots must be real canonical directories, without symlink aliases.");
  } catch (error) {
    if (error instanceof AccountCoreError) throw error;
    return reject("Profile directory is missing or unreadable.");
  }
  if (!inside(ownerHome, directory) || directory === ownerHome) return reject("Choose a dedicated profile directory inside your home.");
  const defaults = [path.join(ownerHome, ".claude"), path.join(ownerHome, ".claude.json")];
  if (defaults.some((root) => overlaps(root, directory) && directory !== root && !root.endsWith(".json"))) {
    return reject("Profile roots must not overlap the default Claude config directory.");
  }
  const forbidden = [dataDir, path.join(ownerHome, ".Trash"), path.join(ownerHome, ".ssh"), path.join(ownerHome, ".aws")];
  for (const row of core.db.query<{ p: string }, []>("SELECT path AS p FROM projects UNION SELECT workdir AS p FROM tasks UNION SELECT worktree_path AS p FROM tasks WHERE worktree_path IS NOT NULL").all()) {
    if (row.p) forbidden.push(row.p);
  }
  for (const root of forbidden) {
    if (!root || !existsSync(root)) continue;
    let resolved = root;
    try { resolved = realpathSync(root); } catch { /* compare the recorded path */ }
    if (overlaps(resolved, directory)) return reject("Persistent profiles cannot overlap app data, projects, or credential directories.");
  }
  for (let dir = directory; dir !== ownerHome; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return reject("A Git workspace cannot be a persistent authentication profile.");
  }
  for (const account of core.listAccounts()) {
    if (account.id === except || !account.claudeProfile) continue;
    if (overlaps(directory, account.claudeProfile.directory)) return reject("This profile overlaps another Claude registration.");
  }
  const stat = statSync(directory);
  return { directory, directoryIdentity: `${stat.dev}:${stat.ino}` };
}

export function claudeAccountForHarness(harness: Harness, core = new AccountCore(db)): Account | null {
  if (!isClaudeProfile(harness)) return null;
  return core.listAccounts().find((account) => account.claudeProfile?.harnessId === harness.id) ?? null;
}

/** Launch binding. Throws instead of falling back to the ambient Claude config. */
export function selectedClaudeAccount(harness: Harness, core = new AccountCore(db)): Account {
  const account = claudeAccountForHarness(harness, core);
  const profile = account?.claudeProfile;
  if (!account || !profile || harness.kind !== "claude-code" || !harness.enabled || harness.home !== null || !core.bindings(account.id).some((binding) => binding.harnessId === harness.id)) {
    return reject("Claude profile registration is unavailable. No fallback.");
  }
  const metaRow = core.db.query<{ data: string }, [string]>("SELECT data FROM account_execution_meta WHERE account_id = ?").get(account.id);
  if (metaRow) {
    try { if ((JSON.parse(metaRow.data) as { disabled?: boolean }).disabled === true) return reject("Claude profile is disabled. No fallback."); } catch { /* ignore */ }
  }
  if (!profile.homeAccessAccepted) return reject("Claude profile launch is blocked until the Owner accepts the existing HOME-access disclosure. No broader filesystem access was granted.");
  const live = harnesses.get(harness.id);
  if (!live?.enabled || live.home !== harness.home || JSON.stringify(live.env) !== JSON.stringify(harness.env)) return reject("Claude resource changed before launch. Review again.");
  if (harness.env.CLAUDE_CONFIG_DIR !== profile.directory) return reject("Claude resource configuration changed. Register its directory again and review execution.");
  const checked = validatedDirectory(core, profile.directory, account.id);
  if (checked.directoryIdentity !== profile.directoryIdentity) return reject("Claude profile directory was replaced. Register it again and review execution.");
  return account;
}

const authenticationChecks = new Map<string, { key: string; at: number; status: ClaudeProfileView["authentication"] }>();
function authenticationKey(profile: ClaudeProfile) {
  return JSON.stringify([profile.directory, profile.directoryIdentity, profile.homeAccessAccepted]);
}
export function cachedClaudeAuthentication(harnessId: string, profile: ClaudeProfile, now = Date.now()): ClaudeProfileView["authentication"] {
  const saved = authenticationChecks.get(harnessId);
  return saved && saved.key === authenticationKey(profile) && saved.at <= now && now - saved.at < 30_000 ? saved.status : "unknown";
}

type ClaudeAuthProbe = (directory: string) => Promise<{ loggedIn: boolean; configDirectory: string | null }>;
let probe: ClaudeAuthProbe | null = null;
/** Test-only. Production uses `claude auth status` and does not read credential files. */
export function __setClaudeAuthProbeForTest(next: ClaudeAuthProbe | null): void {
  probe = next;
}

async function probeAuthentication(bin: string, directory: string): Promise<ClaudeProfileView["authentication"]> {
  if (probe) {
    const status = await probe(directory);
    if (status.loggedIn && status.configDirectory === directory) return "authenticated";
    if (!status.loggedIn) return "required";
    return "unavailable";
  }
  if (syntheticRecordedAuthentication("claude-code", bin, directory)) return "authenticated";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: directory };
    child = Bun.spawn([bin, "auth", "status"], { env, cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const proc = child;
    timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* exited */ } }, 5000);
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream<Uint8Array>).text()]);
    let status: { loggedIn?: boolean; configDirectory?: string; authMethod?: string; apiProvider?: string } | null = null;
    try { status = JSON.parse(output); } catch { status = null; }
    if (code === 0 && status?.loggedIn === true && status.configDirectory === directory && status.authMethod === "claude.ai" && status.apiProvider === "firstParty") return "authenticated";
    if (status?.loggedIn === false) return "required";
    return "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export class ClaudeProfiles {
  constructor(readonly core = new AccountCore(db)) {}

  list(): ClaudeProfileView[] {
    return this.core.listAccounts().filter((account) => account.claudeProfile).map((account) => this.view(account.id));
  }

  view(id: string): ClaudeProfileView {
    const account = this.core.getAccount(id);
    const profile = account.claudeProfile;
    if (!profile || account.archivedAt !== null) return reject("Claude profile registration not found.");
    const harness = harnesses.get(profile.harnessId);
    let available = false;
    try { if (harness && account && harness.enabled) { validatedDirectory(this.core, profile.directory, account.id); available = true; } } catch { available = false; }
    const authentication = harness ? cachedClaudeAuthentication(harness.id, profile) : "unknown";
    let availability: ClaudeProfileView["availability"] = available ? "unchecked" : "unavailable";
    if (available && !profile.homeAccessAccepted) availability = "acceptance-required";
    else if (available && authentication === "authenticated") availability = "ready";
    else if (available && authentication === "required") availability = "authentication-required";
    else if (available && authentication === "unavailable") availability = "unavailable";
    return {
      accountId: account.id,
      displayName: account.displayName,
      harnessId: profile.harnessId,
      directory: profile.directory,
      homeAccessAccepted: profile.homeAccessAccepted,
      support: "partial",
      authentication: available ? authentication : "unavailable",
      availability,
      checkedAt: null,
      verifiedSubject: null,
      limitations: [...CLAUDE_PROFILE_LIMITATIONS],
      setupCommand: `CLAUDE_CONFIG_DIR=${quote(profile.directory)} claude auth status`,
    };
  }

  register(raw: unknown, id?: string): ClaudeProfileView {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return reject("Only display name, CLAUDE_CONFIG_DIR, and the HOME-access acceptance flag are accepted.");
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["displayName", "directory", "homeAccessAccepted"].includes(key))) return reject("Unsupported Claude profile field.");
    const homeAccessAccepted = value.homeAccessAccepted;
    if (typeof homeAccessAccepted !== "boolean") return reject("homeAccessAccepted must be an explicit boolean. It is not implied.");
    if (id && homeAccessAccepted && Object.keys(value).length === 1) {
      const account = this.core.getAccount(id);
      const profile = account.claudeProfile;
      if (!profile || account.archivedAt !== null) return reject("Claude profile registration not found.");
      if (!profile.homeAccessAccepted) this.core.configureClaude(id, { ...profile, homeAccessAccepted: true });
      return this.view(id);
    }
    if (id && !this.core.getAccount(id).claudeProfile) return reject("Claude profile registration not found.");
    const config = validatedDirectory(this.core, value.directory, id);
    const base = harnesses.get("claude-code");
    if (!base) return reject("Built-in Claude resource is missing.");
    return this.core.db.transaction(() => {
      const account = id ? this.core.updateAccount(id, { displayName: value.displayName }) : this.core.createAccount({ provider: "anthropic", displayName: value.displayName });
      const harnessId = account.claudeProfile?.harnessId ?? PREFIX + account.id;
      const env = { CLAUDE_CONFIG_DIR: config.directory };
      if (id) harnesses.update(harnessId, { label: `Claude · ${account.displayName}`, home: null, env });
      else harnesses.insert({ id: harnessId, kind: "claude-code", label: `Claude · ${account.displayName}`, bin: base.bin, env });
      this.core.configureClaude(account.id, { harnessId, ...config, homeAccessAccepted });
      this.core.bindHarness(account.id, harnessId);
      return this.view(account.id);
    })();
  }

  remove(id: string): void {
    this.view(id);
    this.core.archiveAccount(id);
  }

  async check(id: string): Promise<ClaudeProfileView> {
    const before = this.view(id);
    if (!before.homeAccessAccepted) return reject("Accept the Claude HOME-access disclosure before checking this profile.");
    if (before.availability === "unavailable") return before;
    const profileKey = authenticationKey(this.core.getAccount(id).claudeProfile!);
    const harness = harnesses.get(before.harnessId);
    if (!harness) return { ...before, availability: "unavailable", authentication: "unavailable" };
    // The same resolver the launch uses (agents.ts).
    const bin = resolveBin(harness);
    const authentication = await probeAuthentication(bin, before.directory);
    const account = this.core.getAccount(id);
    const profile = account.claudeProfile;
    if (!profile || account.archivedAt !== null || authenticationKey(profile) !== profileKey) {
      return reject("Claude profile changed during the authentication check. Check again.");
    }
    authenticationChecks.set(harness.id, { key: profileKey, at: Date.now(), status: authentication });
    const after = this.view(id);
    return { ...after, authentication, checkedAt: Date.now() };
  }
}

export async function assertClaudeProfileAuthentication(harness: Harness): Promise<void> {
  if (!isClaudeProfile(harness)) return;
  const account = selectedClaudeAccount(harness);
  const checked = await new ClaudeProfiles().check(account.id);
  if (checked.availability !== "ready") return reject("Selected Claude profile is not execution-ready. No default Claude account was substituted.");
}
