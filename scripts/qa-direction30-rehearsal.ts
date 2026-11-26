/**
 * Direction 30: Candidate verification and disposable upgrade + rollback rehearsal.
 * Never opens, reads, or modifies ~/Applications/ForgeOrbit.app, the Owner's
 * working profile, ~/Library/WebKit/app.forgeorbit, or provider homes.
 *
 * Usage:
 *   bun --no-env-file scripts/qa-direction30-rehearsal.ts verify-candidate <app> <preSignDir> <signedReceiptDir>
 *   bun --no-env-file scripts/qa-direction30-rehearsal.ts rehearse <oldBuildDir> <newBuildDir> [signedReceiptDir]
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import { evaluateLocalSignature } from "../src/bun/owner-trust/local-signature.ts";
import { migrations } from "../src/bun/migrations/index.ts";
import { verifyPackage, verifyProvenance, writeProvenance } from "./release-metadata.ts";

const REPO = path.resolve(import.meta.dir, "..");
const OWNER_PATHS = [
  path.join(homedir(), "Applications/ForgeOrbit.app"),
  path.join(homedir(), "Library/Application Support/ForgeOrbit"),
  path.join(homedir(), "Library/WebKit/app.forgeorbit"),
  path.join(homedir(), ".agetor"),
  path.join(homedir(), ".forgeorbit"),
  path.join(homedir(), ".claude"),
];

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const stamp = (target: string): string => {
  try {
    const s = statSync(target);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
};
const walkFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
    .sort();
};
const treeHashes = (dir: string): Record<string, string> =>
  Object.fromEntries(walkFiles(dir).map((file) => [path.relative(dir, file), sha256(readFileSync(file))]));

function runCmd(cmd: string[], cwd = REPO): string {
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd.join(" ")}\n${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function entitlementsOf(target: string): string {
  const res = spawnSync("codesign", ["-d", "--entitlements", "-", target], { encoding: "utf8" });
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
}

function migrationCeilingInBundle(appPath: string): { lastExpected: string; embedded: Record<string, boolean> } {
  const bunIndex = path.join(appPath, "Contents/Resources/app/bun/index.js");
  assert.equal(existsSync(bunIndex), true, `Missing bundled bun/index.js in ${appPath}`);
  const text = readFileSync(bunIndex, "utf8");
  const lastExpected = migrations.at(-1)!.id;
  const checks = [
    "142_run_terminations",
    "143_router_issued_plans",
    "144_improvement_evaluation_traceability",
    lastExpected,
  ];
  const embedded = Object.fromEntries(checks.map((id) => [id, text.includes(id)]));
  assert.equal(embedded[lastExpected], true, `Expected migration ceiling ${lastExpected} missing in bundle`);
  return { lastExpected, embedded };
}

function verifyCandidate(appPathRaw: string, preSignDirRaw: string, signedReceiptDirRaw?: string) {
  const appPath = path.resolve(appPathRaw);
  const preSignDir = path.resolve(preSignDirRaw);
  const preSignProvenance = JSON.parse(readFileSync(path.join(preSignDir, "forgeorbit-provenance.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const headSha = runCmd(["git", "rev-parse", "HEAD"]);

  const actualPkg = verifyPackage(appPath, preSignProvenance.metadata);
  assert.equal(actualPkg.metadata.productVersion, pkg.version);
  assert.equal(actualPkg.metadata.buildNumber, pkg.forgeorbitBuildNumber);
  assert.equal(actualPkg.metadata.sourceRevision, headSha);
  assert.equal(actualPkg.metadata.channel, "dev");
  assert.equal(actualPkg.metadata.identifier, "app.forgeorbit");
  assert.equal(actualPkg.metadata.localBuild, true);
  assert.equal(actualPkg.sdk.hash, "dev");
  assert.equal(actualPkg.sdk.channel, "dev");

  const sig = evaluateLocalSignature(appPath, { requireOwnerCn: true });
  assert.equal(sig.ok, true, `Local Owner signature check failed: ${sig.reason}`);
  assert.equal(sig.authoritative, true);
  assert.equal(sig.code, "local-owner-verified");
  assert.equal(sig.verifyOk, true);
  assert.equal(sig.helperVerifyOk, true);
  assert.equal(sig.requirementOk, true);
  assert.equal(sig.adhoc, false);
  assert.equal(sig.helperAdhoc, false);
  assert.equal(sig.teamId, null);
  assert.equal(sig.appCertSha256, sig.anchorSha256);
  assert.equal(sig.helperCertSha256, sig.anchorSha256);

  const helperPath = path.join(appPath, "Contents/Resources/app/bin/forgeorbit-owner-trust");
  runCmd(["codesign", "--verify", "--strict", "--verbose=2", appPath]);
  runCmd(["codesign", "--verify", "--strict", "--verbose=2", helperPath]);
  for (const target of [
    appPath,
    path.join(appPath, "Contents/MacOS/launcher"),
    path.join(appPath, "Contents/MacOS/bun"),
    helperPath,
  ]) {
    const ent = entitlementsOf(target);
    assert.equal(ent.includes("application-identifier"), false, `${target} has unexpected application-identifier`);
    assert.equal(ent.includes("keychain-access-groups"), false, `${target} has unexpected keychain-access-groups`);
  }

  const ceiling = migrationCeilingInBundle(appPath);
  let signedReceipt: Record<string, unknown> | null = null;
  if (signedReceiptDirRaw) {
    const receiptDir = path.resolve(signedReceiptDirRaw);
    mkdirSync(receiptDir, { recursive: true });
    const written = writeProvenance(appPath, receiptDir, actualPkg.metadata);
    const verified = verifyProvenance(appPath, receiptDir);
    assert.equal(verified.artifactManifestSHA256, written.artifactManifestSHA256);
    signedReceipt = {
      receiptDir,
      artifactManifestSHA256: written.artifactManifestSHA256,
    };
  }

  return {
    appPath,
    preSignArtifactManifestSHA256: preSignProvenance.artifactManifestSHA256,
    signedReceipt,
    metadata: actualPkg.metadata,
    sdk: actualPkg.sdk,
    signature: sig,
    migrationCeiling: ceiling,
  };
}

type AxNode = {
  AXRole?: string;
  AXTitle?: string;
  AXDescription?: string;
  AXValue?: string | number;
  AXEnabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxNode[];
};
const entries = (node: AxNode | undefined): AxNode[] => (node ? [node, ...(node.children ?? []).flatMap(entries)] : []);
const labels = (node: AxNode) =>
  [node.AXTitle, node.AXDescription, node.AXValue].filter((v): v is string => typeof v === "string" && v.length > 0);

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeoutMs = 30_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(250);
  }
  throw new Error(`${label}${last ? `: ${last}` : ""}`);
};

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function buildIsolatedEnv(root: string, dataDir: string, apiPort: number, homeDir = path.join(root, "home")): Record<string, string> {
  const tmpDir = path.join(root, "tmp");
  const stubDir = path.join(root, "stubs");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  mkdirSync(stubDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    HOME: homeDir,
    TMPDIR: tmpDir,
    CODEX_HOME: homeDir,
    CLAUDE_CONFIG_DIR: homeDir,
    CURSOR_CONFIG_DIR: homeDir,
    GEMINI_CLI_HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    XDG_DATA_HOME: homeDir,
    XDG_STATE_HOME: homeDir,
    XDG_CACHE_HOME: homeDir,
    FORGEORBIT_DATA_DIR: dataDir,
    AGETOR_DATA_DIR: dataDir,
    FORGEORBIT_API_PORT: String(apiPort),
    AGETOR_API_PORT: String(apiPort),
    FORGEORBIT_EMBEDDING_MODEL_ROOT: path.join(root, "no-models"),
    FORGEORBIT_USAGE_OFFLINE: "1",
    AGETOR_USAGE_OFFLINE: "1",
  };
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) {
    env[`AGETOR_${kind}_DRIVER`] = "fake";
  }
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "ANTIGRAVITY", "TMUX", "NOTIFIER", "DISCLAIM"]) {
    const stub = path.join(stubDir, kind.toLowerCase());
    writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
    env[`AGETOR_${kind}_BIN`] = stub;
  }
  const fxStub = path.join(stubDir, "fx");
  writeFileSync(fxStub, "#!/bin/sh\necho 'Fast, native coding agent for the terminal'\n", { mode: 0o755 });
  env.AGETOR_FX_BIN = fxStub;
  return env;
}

interface RunningApp {
  launcherPid: number;
  corePid: number;
  port: number;
  token: string;
  logPath: string;
  bindingFile: string;
  axHelper: string;
}

async function launchPackaged(
  root: string,
  appPath: string,
  dataDir: string,
  port: number,
  logName: string,
  opts: { withWindow?: boolean; homeDir?: string } = {},
): Promise<RunningApp> {
  const env = buildIsolatedEnv(root, dataDir, port, opts.homeDir);
  const logPath = path.join(root, "logs", `${logName}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, "");
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(path.join(appPath, "Contents/MacOS/launcher"), [], {
    cwd: path.join(appPath, "Contents/MacOS"),
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();

  const credsFile = path.join(dataDir, "agetor-core.json");
  await poll(`Backend did not become healthy for ${logName}`, async () => {
    if (!existsSync(credsFile)) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) });
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }, 60_000);

  const creds = JSON.parse(readFileSync(credsFile, "utf8")) as { pid: number; port: number; token: string };
  assert.equal(creds.port, port);

  const axHelper = path.join(root, "qa-native-pid");
  if (!existsSync(axHelper)) {
    runCmd([
      "/usr/bin/clang",
      "-fobjc-arc",
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      path.join(REPO, "scripts/qa-native-pid.m"),
      "-o",
      axHelper,
    ]);
  }
  const bindingFile = path.join(root, "binding.json");
  if (opts.withWindow) {
    const candidateFile = path.join(root, "candidate.json");
    writeFileSync(
      candidateFile,
      JSON.stringify({ launcherPid: child.pid, corePid: creds.pid, artifact: appPath, bundleIdentifier: "app.forgeorbit" }),
      { mode: 0o600 },
    );
    const binding = await poll(`Packaged window did not appear for ${logName}`, () => {
      try {
        const out = spawnSync(axHelper, [candidateFile, "identify"], { encoding: "utf8" }).stdout;
        const parsed = out ? JSON.parse(out) : null;
        return parsed?.windowId ? parsed : null;
      } catch {
        return null;
      }
    }, 30_000);
    assert.ok(binding.axTrusted, "macOS Accessibility must be trusted for packaged window verification");
    writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
    spawnSync(axHelper, [bindingFile, "focus"], { encoding: "utf8" });
    spawnSync(axHelper, [bindingFile, "resize", "1280", "880"], { encoding: "utf8" });
  }
  return { launcherPid: child.pid!, corePid: creds.pid, port, token: creds.token, logPath, bindingFile, axHelper };
}

async function api<T = any>(app: RunningApp, method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${app.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function stopApp(root: string, dataDir: string, running: RunningApp, kill9 = false): Promise<{ stopped: boolean; credsGone: boolean; listeners: string[] }> {
  if (kill9) {
    try { process.kill(-running.launcherPid, "SIGKILL"); } catch {}
    try { process.kill(running.corePid, "SIGKILL"); } catch {}
    spawnSync("pkill", ["-9", "-f", `${root}/apps/`]);
  } else {
    try {
      await fetch(`http://127.0.0.1:${running.port}/daemon/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${running.token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
    try { process.kill(-running.launcherPid, "SIGTERM"); } catch {}
    await poll("App exit", () => {
      const alive = spawnSync("pgrep", ["-f", `${root}/apps/`], { encoding: "utf8" }).stdout.trim();
      return alive.length === 0 ? true : null;
    }, 20_000).catch(() => {
      spawnSync("pkill", ["-9", "-f", `${root}/apps/`]);
    });
  }
  await Bun.sleep(800);
  const remaining = spawnSync("pgrep", ["-f", `${root}/apps/`], { encoding: "utf8" }).stdout.trim();
  const listeners = (spawnSync("lsof", ["-nP", `-iTCP:${running.port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter(Boolean);
  return {
    stopped: remaining.length === 0,
    credsGone: !existsSync(path.join(dataDir, "agetor-core.json")),
    listeners,
  };
}

function dbSummary(dataDir: string) {
  const dbPath = path.join(dataDir, "agetor.sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const migrationsApplied = (db.query("SELECT id FROM _migrations ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    const projects = db.query("SELECT path, name FROM projects ORDER BY path").all();
    const tasks = db.query('SELECT id, title, "column", agent, run_id FROM tasks ORDER BY created_at, id').all();
    const runs = db.query("SELECT id, task_id, status, agent FROM runs ORDER BY started_at, id").all();
    const runningRuns = (db.query("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }).n;
    const assignments = db.query("SELECT id, task_id, employee_id, status, revision FROM employee_task_assignments ORDER BY id").all();
    const employees = db.query("SELECT id, name, job_title FROM ai_employees ORDER BY id").all();
    const theme = db.query("SELECT value FROM preferences WHERE key = 'theme'").get() as { value: string } | null;
    const brainIndexPath = path.join(dataDir, "brain", "index.sqlite");
    let brainMemories: unknown[] = [];
    if (existsSync(brainIndexPath)) {
      const brainDb = new Database(brainIndexPath, { readonly: true });
      try {
        brainMemories = brainDb.query("SELECT id, title, revision, scope_kind FROM brain_memories ORDER BY id").all();
      } finally {
        brainDb.close();
      }
    }
    const enrollments = db.query("SELECT COUNT(*) AS n FROM owner_trust_enrollments").get() as { n: number };
    const grants = db.query("SELECT COUNT(*) AS n FROM owner_trust_grants").get() as { n: number };
    return {
      migrationCount: migrationsApplied.length,
      lastMigration: migrationsApplied.at(-1) ?? null,
      integrity,
      sqliteSha256: sha256(readFileSync(dbPath)),
      projects,
      tasks,
      runs,
      runningRuns,
      assignments,
      employees,
      theme: theme?.value ?? null,
      brainMemories,
      ownerTrustEnrollments: enrollments.n,
      ownerTrustGrants: grants.n,
    };
  } finally {
    db.close();
  }
}

const PRESSABLE_ROLES = new Set([
  "AXDisclosureTriangle",
  "AXPopUpButton",
  "AXComboBox",
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXTab",
  "AXMenuItem",
  "AXLink",
]);

function createAxDriver(running: RunningApp) {
  const ax = (...args: string[]) => runCmd([running.axHelper, running.bindingFile, ...args]);
  const inspectWeb = () => JSON.parse(ax("inspect")).web as AxNode;
  const collectStrings = () =>
    entries(inspectWeb()).flatMap((n) => labels(n).map((l) => l.trim())).filter(Boolean);
  const pressButton = async (name: string, timeoutMs = 20_000, fromEnd = false) => {
    try {
      const match = await poll(`AX control "${name}"`, () => {
        const hits = entries(inspectWeb()).filter(
          (n) =>
            !!n.AXRole &&
            PRESSABLE_ROLES.has(n.AXRole) &&
            [n.AXTitle, n.AXDescription].includes(name) &&
            n.AXEnabled !== false,
        );
        return (fromEnd ? hits.at(-1) : hits[0]) ?? null;
      }, timeoutMs);
      const point = match.frame ? [String(Math.round(match.frame.x + match.frame.width / 2)), String(Math.round(match.frame.y + match.frame.height / 2))] : [];
      ax("focus");
      try {
        ax("press", match.AXRole!, name, ...point);
      } catch {
        try {
          ax("press", match.AXRole!, name);
        } catch {
          assert.ok(match.frame, `Missing clickable bounds for "${name}"`);
          ax("click", String(Math.round(match.frame.x + match.frame.width / 2)), String(Math.round(match.frame.y + match.frame.height / 2)));
        }
      }
      await Bun.sleep(400);
    } catch (err) {
      let seen = "";
      try { seen = ` (visible strings: ${JSON.stringify(collectStrings().slice(0, 25))})`; } catch {}
      throw new Error(`${err instanceof Error ? err.message : String(err)}${seen}`);
    }
  };
  const waitText = async (part: string, timeoutMs = 20_000) => {
    try {
      await poll(`AX text "${part}"`, () => {
        return collectStrings().some((l) => l.includes(part)) ? true : null;
      }, timeoutMs);
    } catch (err) {
      let seen = "";
      try { seen = ` (visible strings: ${JSON.stringify(collectStrings().slice(0, 25))})`; } catch {}
      throw new Error(`${err instanceof Error ? err.message : String(err)}${seen}`);
    }
  };
  const openSettingsSection = async (sectionTitle: string) => {
    await poll(`Settings dialog or trigger ready`, () => {
      const strs = collectStrings();
      if (strs.some((s) => s.includes("Settings sections"))) return "open";
      const btn = entries(inspectWeb()).find(
        (n) =>
          !!n.AXRole &&
          PRESSABLE_ROLES.has(n.AXRole) &&
          [n.AXTitle, n.AXDescription].includes("Settings") &&
          n.AXEnabled !== false,
      );
      return btn ? "button" : null;
    }, 20_000);
    if (!collectStrings().some((s) => s.includes("Settings sections"))) {
      await pressButton("Settings");
      await waitText("Settings sections");
    }
    await pressButton(sectionTitle);
  };
  return { ax, inspectWeb, collectStrings, pressButton, waitText, openSettingsSection };
}

async function createAndVerifySnapshotViaWindow(
  root: string,
  running: RunningApp,
  backupParent: string,
): Promise<{ snapshotPath: string; manifestVersion: number; schemaVersion: string; coverage: string; verified: boolean }> {
  mkdirSync(backupParent, { recursive: true, mode: 0o700 });
  const { pressButton, waitText, openSettingsSection } = createAxDriver(running);

  await openSettingsSection("Advanced");
  await waitText("Backup & Recovery");
  await Bun.sleep(400);
  await pressButton("Choose folder…");
  await Bun.sleep(800);

  const scriptFile = path.join(root, "pick-backup-folder.applescript");
  writeFileSync(
    scriptFile,
    `tell application "System Events"
  tell (first process whose unix id is ${running.corePid})
    set frontmost to true
    delay 0.5
    key code 5 using {command down, shift down}
    delay 0.7
    repeat with w in (every window)
      if exists (sheet 1 of w) then
        tell sheet 1 of w
          if exists text field 1 then
            set value of text field 1 to ${JSON.stringify(backupParent)}
            set focused of text field 1 to true
          else if exists combo box 1 then
            set value of combo box 1 to ${JSON.stringify(backupParent)}
            set focused of combo box 1 to true
          end if
        end tell
        exit repeat
      end if
    end repeat
    delay 0.3
    keystroke return
    delay 0.8
    keystroke return
  end tell
end tell
`,
  );
  runCmd(["/usr/bin/osascript", scriptFile]);
  await waitText("Destination:");
  await pressButton("Create backup…");
  await waitText("Create this backup now?");
  await pressButton("Create backup…", 20_000, true);
  const entry = await poll("Backup operation completed", async () => {
    const history = await api<{ entries: any[] }>(running, "GET", "/backup/history");
    return history.body?.entries?.length > 0 ? history.body.entries[0] : null;
  }, 120_000);
  await waitText("Completed", 30_000);
  const snapshotPath = (entry.path ?? entry.snapshotPath) as string;
  assert.equal(existsSync(snapshotPath), true);
  const verifyStart = await api<{ operation: { id: string } }>(running, "POST", "/backup/verify", { snapshotPath });
  assert.equal(verifyStart.status, 200);
  const verifiedOp = await poll("Verify operation settled", async () => {
    const op = await api<{ operation: any }>(running, "GET", `/backup/operations/${verifyStart.body.operation.id}`);
    return op.body?.operation?.state === "completed" ? op.body.operation : null;
  }, 60_000);
  assert.equal(verifiedOp.verify?.ok, true, "Snapshot verification failed");
  assert.equal(verifiedOp.verify?.issues?.length ?? -1, 0);
  const manifest = JSON.parse(readFileSync(path.join(snapshotPath, "manifest.json"), "utf8"));
  return {
    snapshotPath,
    manifestVersion: manifest.manifestVersion,
    schemaVersion: manifest.schemaVersion,
    coverage: manifest.coverage,
    verified: true,
  };
}

async function inspectDiagnosticsInWindow(
  running: RunningApp,
  expected: { version: string; buildNumber: number; macBundleVersion: string; sourceRevision: string; migrationCeiling: string; channelLabel: string },
) {
  const { collectStrings, openSettingsSection } = createAxDriver(running);

  await openSettingsSection("Advanced");
  await poll("Settings Advanced Diagnostics loaded", () => (collectStrings().some((s) => s.includes("Diagnostics")) ? true : null), 20_000);

  const axStrings = await poll("Diagnostics rows rendered", () => {
    const all = collectStrings();
    return all.some((s) => s.includes(expected.sourceRevision)) ? all : null;
  }, 20_000);

  const expectedBuildText = `${expected.buildNumber} (${expected.macBundleVersion})`;
  for (const needle of [
    expected.version,
    expectedBuildText,
    expected.sourceRevision,
    expected.migrationCeiling,
    expected.channelLabel,
    "Disabled",
  ]) {
    assert.equal(axStrings.some((s) => s.includes(needle)), true, `Diagnostics UI missing "${needle}"`);
  }

  return {
    matchedVersion: expected.version,
    matchedBuild: expectedBuildText,
    matchedSourceRevision: expected.sourceRevision,
    matchedMigrationCeiling: expected.migrationCeiling,
    matchedChannel: expected.channelLabel,
    matchedUpdatesDisabled: true,
    axDiagnosticsExcerpt: axStrings.filter((s) =>
      [expected.version, expectedBuildText, expected.sourceRevision, expected.migrationCeiling, expected.channelLabel, "Disabled", "ForgeOrbit version", "Build number", "Source revision", "Migration ceiling", "Release channel", "Automatic updates"].some((k) => s.includes(k)),
    ),
  };
}

async function rehearseUpgradeAndRollback(oldBuildDirRaw: string, newBuildDirRaw: string, signedReceiptDirRaw?: string) {
  const ownerBefore = Object.fromEntries(OWNER_PATHS.map((p) => [p, stamp(p)]));
  const oldBuildDir = path.resolve(oldBuildDirRaw);
  const newBuildDir = path.resolve(newBuildDirRaw);
  const candidateCheck = verifyCandidate(path.join(newBuildDir, "ForgeOrbit.app"), newBuildDir, signedReceiptDirRaw);
  verifyProvenance(path.join(oldBuildDir, "ForgeOrbit.app"), oldBuildDir);

  const root = realpathSync(mkdtempSync("/private/tmp/fo-d30-"));
  try {
  for (const sub of ["apps", "profiles", "home", "tmp", "projects", "snapshots", "restores", "logs", "stubs"]) {
    mkdirSync(path.join(root, sub), { recursive: true, mode: 0o700 });
  }
  for (const [label, src] of [["old", oldBuildDir], ["live", oldBuildDir], ["new", newBuildDir]] as const) {
    const dest = path.join(root, "apps", label);
    mkdirSync(dest, { recursive: true });
    runCmd(["ditto", path.join(src, "ForgeOrbit.app"), path.join(dest, "ForgeOrbit.app")]);
    for (const file of ["forgeorbit-artifact-manifest.json", "forgeorbit-provenance.json", "local-build.json"]) {
      if (existsSync(path.join(src, file))) runCmd(["cp", path.join(src, file), path.join(dest, file)]);
    }
  }
  verifyProvenance(path.join(root, "apps/old/ForgeOrbit.app"), path.join(root, "apps/old"));
  assert.equal(evaluateLocalSignature(path.join(root, "apps/new/ForgeOrbit.app"), { requireOwnerCn: true }).ok, true);

  // Disposable Git project.
  const projectDir = path.join(root, "projects/d30-fixture");
  mkdirSync(projectDir, { recursive: true });
  runCmd(["git", "-C", projectDir, "init", "-q", "-b", "main"]);
  runCmd(["git", "-C", projectDir, "config", "user.email", "d30@example.invalid"]);
  runCmd(["git", "-C", projectDir, "config", "user.name", "D30 Fixture"]);
  writeFileSync(path.join(projectDir, "README.md"), "# D30 disposable fixture\n");
  runCmd(["git", "-C", projectDir, "add", "README.md"]);
  runCmd(["git", "-C", projectDir, "commit", "-q", "-m", "init"]);

  // 1. Seed baseline on older schema-142 bundle (526ed68d), then reopen with window in English locale.
  const mainProfile = path.join(root, "profiles/main");
  const mainPort = freePort();
  const oldSeed = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), mainProfile, mainPort, "01a-old-seed");
  await api(oldSeed, "PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api(oldSeed, "PUT", "/preferences/locale", { value: "en" });
  await api(oldSeed, "PUT", "/preferences/theme", { value: "light" });
  await api(oldSeed, "POST", "/projects", { path: projectDir, name: "D30 Fixture Project" });
  const spaceRes = await api(oldSeed, "POST", "/clusters", { name: "D30 Space" });
  const spaceId = spaceRes.body?.id ?? spaceRes.body?.cluster?.id;
  await api(oldSeed, "POST", `/clusters/${spaceId}/projects`, { projectPath: projectDir });

  const tA = await api(oldSeed, "POST", "/tasks", {
    title: "D30 Task A — completed history",
    prompt: "Say hello.",
    agent: "claude-code",
    workdir: projectDir,
    isolation: "none",
  });
  await api(oldSeed, "POST", `/tasks/${tA.body.id}/admit-inbox`);
  await api(oldSeed, "PATCH", `/tasks/${tA.body.id}`, { column: "ready" });
  await api(oldSeed, "POST", `/tasks/${tA.body.id}/start`, {});
  await poll("Task A finished", async () => {
    const cur = await api(oldSeed, "GET", `/tasks/${tA.body.id}`);
    return cur.body?.column === "review" ? cur.body : null;
  }, 45_000);

  const tB = await api(oldSeed, "POST", "/tasks", {
    title: "D30 Task B — assigned backlog",
    prompt: "Pending work.",
    agent: "claude-code",
    workdir: projectDir,
    isolation: "none",
  });
  assert.equal(tB.status >= 200 && tB.status < 300, true);
  const emp = await api(oldSeed, "POST", "/employees", {
    name: "D30 Ada",
    jobTitle: "Developer",
    projectPath: projectDir,
  });
  assert.equal(emp.status >= 200 && emp.status < 300, true);
  const assigned = await api(oldSeed, "POST", "/task-assignments", { taskId: tB.body.id, employeeId: emp.body.id });
  assert.equal(assigned.status >= 200 && assigned.status < 300, true);
  const mem = await api(oldSeed, "POST", "/brain/memories", {
    scopeKind: "project",
    projectPath: projectDir,
    title: "D30 brain marker",
    kind: "decision",
    content: "Keep IDs across bundle upgrades. D30-BRAIN-MARKER.",
    requestId: "d30-brain-1",
  });
  assert.equal(mem.status, 201);
  const oldSeedQuit = await stopApp(root, mainProfile, oldSeed);
  assert.equal(oldSeedQuit.stopped, true);

  // Reopen old bundle with its window now mounted in English locale and create + verify pre-upgrade snapshot.
  const oldRunning = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), mainProfile, mainPort, "01b-old-snapshot", { withWindow: true });

  // Create and verify pre-upgrade snapshot in the older packaged window while open & healthy.
  const snapshotDir = path.join(root, "snapshots");
  const snapshotResult = await createAndVerifySnapshotViaWindow(root, oldRunning, snapshotDir);
  assert.equal(snapshotResult.schemaVersion, "142_run_terminations");

  // Quit old app cleanly so we can capture a clean pre-Task-C snapshot-state copy for failcopy.
  const oldQuit1 = await stopApp(root, mainProfile, oldRunning);
  assert.equal(oldQuit1.stopped, true);
  assert.equal(oldQuit1.credsGone, true);
  assert.equal(oldQuit1.listeners.length, 0);

  const failCopy = path.join(root, "profiles/failcopy");
  runCmd(["ditto", mainProfile, failCopy]);

  // Reopen old bundle briefly to start Task C in-flight, then hard-stop/quit so forward upgrade tests orphan without resume.
  const oldInflight = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), mainProfile, mainPort, "02-old-inflight");
  const tC = await api(oldInflight, "POST", "/tasks", {
    title: "D30 Task C — held run on upgrade",
    prompt: "__agetor_fake_claude_handoff__ __agetor_fake_claude_subagent__:60000[D30Hold]",
    agent: "claude-code",
    workdir: projectDir,
    isolation: "none",
  });
  await api(oldInflight, "POST", `/tasks/${tC.body.id}/admit-inbox`);
  await api(oldInflight, "PATCH", `/tasks/${tC.body.id}`, { column: "ready" });
  await api(oldInflight, "POST", `/tasks/${tC.body.id}/start`, {});
  await poll("Task C running", async () => {
    const cur = await api(oldInflight, "GET", `/tasks/${tC.body.id}`);
    return cur.body?.column === "running" && cur.body?.runId ? cur.body : null;
  }, 20_000);
  const oldKill = await stopApp(root, mainProfile, oldInflight, true);
  assert.equal(oldKill.stopped, true);

  // Take closed-profile byte copy before replacement.
  const preUpgradeBytes = path.join(root, "profiles/main-pre-upgrade-142-bytes");
  runCmd(["ditto", mainProfile, preUpgradeBytes]);
  const beforeUpgradeDb = dbSummary(mainProfile);
  assert.equal(beforeUpgradeDb.lastMigration, "142_run_terminations");
  assert.equal(beforeUpgradeDb.runningRuns, 1);

  // 2. Retain old bundle and replace live bundle with verified Owner-signed candidate.
  const retainedOldDir = path.join(root, "apps/live.retained-142");
  runCmd(["mv", path.join(root, "apps/live"), retainedOldDir]);
  mkdirSync(path.join(root, "apps/live"), { recursive: true });
  runCmd(["ditto", path.join(root, "apps/new/ForgeOrbit.app"), path.join(root, "apps/live/ForgeOrbit.app")]);
  assert.equal(evaluateLocalSignature(path.join(root, "apps/live/ForgeOrbit.app"), { requireOwnerCn: true }).ok, true);

  // 3. Launch candidate on mainProfile -> verify forward migration (142 -> 145), window Diagnostics, and disabled updater!
  const upgradedRunning = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), mainProfile, mainPort, "03-candidate-upgraded", { withWindow: true });
  const infoRes = await api(upgradedRunning, "GET", "/info");
  assert.equal(infoRes.status, 200);
  assert.equal(infoRes.body.version, candidateCheck.metadata.productVersion);
  assert.equal(infoRes.body.buildNumber, candidateCheck.metadata.buildNumber);
  assert.equal(infoRes.body.sourceRevision, candidateCheck.metadata.sourceRevision);
  assert.equal(infoRes.body.migrationCeiling, candidateCheck.migrationCeiling.lastExpected);
  assert.equal(infoRes.body.channel, "dev");
  assert.equal(infoRes.body.localBuild, true);
  assert.equal(infoRes.body.updatesEnabled, false);

  const windowDiag = await inspectDiagnosticsInWindow(upgradedRunning, {
    version: candidateCheck.metadata.productVersion,
    buildNumber: candidateCheck.metadata.buildNumber,
    macBundleVersion: candidateCheck.metadata.macBundleVersion,
    sourceRevision: candidateCheck.metadata.sourceRevision,
    migrationCeiling: candidateCheck.migrationCeiling.lastExpected,
    channelLabel: "dev (local)",
  });

  const updStatus = await api(upgradedRunning, "GET", "/updates/status");
  assert.equal(updStatus.status, 200);
  assert.equal(updStatus.body.status, "idle");
  const updCheck = await api(upgradedRunning, "POST", "/updates/check", {});
  assert.equal(updCheck.status, 200);
  assert.equal(updCheck.body.status, "idle");
  assert.equal(updCheck.body.error, null);
  const updApply = await api(upgradedRunning, "POST", "/updates/apply", {});
  assert.equal(updApply.status, 409);

  const upgradeQuit1 = await stopApp(root, mainProfile, upgradedRunning);
  assert.equal(upgradeQuit1.stopped, true);
  assert.equal(upgradeQuit1.credsGone, true);

  const afterUpgradeDb = dbSummary(mainProfile);
  assert.equal(afterUpgradeDb.lastMigration, candidateCheck.migrationCeiling.lastExpected);
  assert.equal(afterUpgradeDb.migrationCount, migrations.length);
  assert.equal(afterUpgradeDb.integrity, "ok");
  assert.equal(afterUpgradeDb.runningRuns, 0);
  assert.equal(afterUpgradeDb.runs.length, beforeUpgradeDb.runs.length);
  assert.equal((afterUpgradeDb.runs.find((r: any) => r.task_id === tC.body.id) as any)?.status, "orphaned");
  assert.equal((afterUpgradeDb.tasks.find((t: any) => t.id === tC.body.id) as any)?.column, "ready");
  assert.equal(afterUpgradeDb.theme, "light");
  assert.deepEqual(afterUpgradeDb.brainMemories, beforeUpgradeDb.brainMemories);
  assert.deepEqual(afterUpgradeDb.assignments, beforeUpgradeDb.assignments);
  assert.deepEqual(afterUpgradeDb.employees, beforeUpgradeDb.employees);
  const upgradeLog1 = readFileSync(upgradedRunning.logPath, "utf8");
  assert.equal(upgradeLog1.includes("143_router_issued_plans"), true);
  assert.equal(upgradeLog1.includes(candidateCheck.migrationCeiling.lastExpected), true);

  // Reopen once to verify no repeat migrations.
  const upgradedReopen = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), mainProfile, mainPort, "04-candidate-reopen");
  const upgradeQuit2 = await stopApp(root, mainProfile, upgradedReopen);
  assert.equal(upgradeQuit2.stopped, true);
  const upgradeLog2 = readFileSync(upgradedReopen.logPath, "utf8");
  assert.equal(upgradeLog2.includes("applied migrations"), false);

  // 4. Schema-ahead refusal test on candidate (copy of 145 profile with synthetic 146 row).
  const aheadProfile = path.join(root, "profiles/ahead-146");
  runCmd(["ditto", mainProfile, aheadProfile]);
  const aheadDbPath = path.join(aheadProfile, "agetor.sqlite");
  const aheadDb = new Database(aheadDbPath);
  aheadDb.run("INSERT INTO _migrations (id, applied_at) VALUES ('146_not_in_this_build', 1)");
  aheadDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  aheadDb.close();
  const aheadBeforeBytes = sha256(readFileSync(aheadDbPath));
  const aheadLogPath = path.join(root, "logs/05-schema-ahead.log");
  const aheadRes = spawnSync(path.join(root, "apps/live/ForgeOrbit.app/Contents/MacOS/launcher"), [], {
    cwd: path.join(root, "apps/live/ForgeOrbit.app/Contents/MacOS"),
    env: buildIsolatedEnv(root, aheadProfile, freePort()),
    encoding: "utf8",
    timeout: 15_000,
  });
  const aheadLog = `${aheadRes.stdout ?? ""}\n${aheadRes.stderr ?? ""}`;
  writeFileSync(aheadLogPath, aheadLog);
  assert.notEqual(aheadRes.status, 0);
  assert.equal(aheadLog.includes("146_not_in_this_build"), true);
  assert.equal(sha256(readFileSync(aheadDbPath)), aheadBeforeBytes, "Schema-ahead database bytes must remain untouched");

  // 5. Rollback rehearsal: failcopy upgrades 142 -> 145, writes a post-upgrade task, crashes mid-session, is preserved read-only,
  //    and the matching retained older 142 bundle restores the pre-upgrade 142 snapshot into a fresh folder.
  const failPort = freePort();
  const failRunning = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), failCopy, failPort, "06-failcopy-upgrade");
  const postTask = await api(failRunning, "POST", "/tasks", {
    title: "D30 Post-upgrade task (must not exist after rollback)",
    prompt: "Written by new 145 build.",
    agent: "claude-code",
    workdir: projectDir,
    isolation: "none",
  });
  assert.equal(postTask.status, 200);
  await stopApp(root, failCopy, failRunning, true);

  const failedPreserved = path.join(root, "profiles/failcopy-FAILED-UPGRADE");
  runCmd(["mv", failCopy, failedPreserved]);
  const failedDigestsBefore = treeHashes(failedPreserved);
  chmodSync(failedPreserved, 0o555);
  for (const file of walkFiles(failedPreserved)) chmodSync(file, 0o444);

  // Swap bundle back to matching older 142 bundle (never opening failedPreserved!).
  runCmd(["mv", path.join(root, "apps/live"), path.join(root, "apps/live.failed-145")]);
  runCmd(["mv", retainedOldDir, path.join(root, "apps/live")]);

  const recoveryBase = path.join(root, "profiles/recovery-base");
  const recoveryPort = freePort();
  const oldRecovery = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), recoveryBase, recoveryPort, "07-old-recovery-base");
  const sel = await api(oldRecovery, "POST", "/backup/snapshots/select", { path: snapshotResult.snapshotPath });
  assert.equal(sel.status, 200);
  const ver = await api(oldRecovery, "POST", "/backup/verify", { snapshotPath: sel.body.path });
  assert.equal(ver.status, 200);
  const verDone = await poll("Old bundle verified 142 snapshot", async () => {
    const op = await api(oldRecovery, "GET", `/backup/operations/${ver.body.operation.id}`);
    return op.body?.operation?.state === "completed" ? op.body.operation : null;
  }, 60_000);
  assert.equal(verDone.verify?.ok, true);
  const restoreOp = await api(oldRecovery, "POST", "/backup/restore", {
    snapshotPath: sel.body.path,
    verificationId: verDone.id,
    destinationName: "d30-restored-142",
    managed: true,
  });
  assert.equal(restoreOp.status, 200);
  const restoreDone = await poll("Old bundle restored 142 snapshot", async () => {
    const op = await api(oldRecovery, "GET", `/backup/operations/${restoreOp.body.operation.id}`);
    return op.body?.operation?.state === "completed" ? op.body.operation : null;
  }, 60_000);
  const restoredDir = restoreDone.restore?.destinationPath as string;
  assert.equal(existsSync(restoredDir), true);
  await stopApp(root, recoveryBase, oldRecovery);

  // Launch matching older 142 bundle against the restored 142 profile.
  const restoredPort = freePort();
  const oldRestored = await launchPackaged(root, path.join(root, "apps/live/ForgeOrbit.app"), restoredDir, restoredPort, "08-old-restored-open");
  const restoredTasks = await api<any[]>(oldRestored, "GET", "/tasks");
  assert.equal(restoredTasks.status, 200);
  assert.equal(restoredTasks.body.some((t) => t.title.includes("Post-upgrade task")), false);
  assert.equal(restoredTasks.body.some((t) => t.id === tA.body.id), true);
  assert.equal(restoredTasks.body.some((t) => t.id === tB.body.id), true);
  await stopApp(root, restoredDir, oldRestored);

  const restoredDb = dbSummary(restoredDir);
  assert.equal(restoredDb.lastMigration, "142_run_terminations");
  assert.equal(restoredDb.integrity, "ok");
  assert.equal(restoredDb.runningRuns, 0);
  assert.equal(restoredDb.theme, "light");
  assert.deepEqual(restoredDb.brainMemories, beforeUpgradeDb.brainMemories);
  assert.deepEqual(restoredDb.assignments, beforeUpgradeDb.assignments);
  assert.deepEqual(restoredDb.employees, beforeUpgradeDb.employees);
  const restoredLog = readFileSync(oldRestored.logPath, "utf8");
  assert.equal(restoredLog.includes("applied migrations"), false);
  assert.equal(restoredLog.includes("orphaned"), false);

  // Make failedPreserved writable again for cleanup check? Keep read-only and verify hashes match.
  const failedDigestsAfter = treeHashes(failedPreserved);
  assert.deepStrictEqual(failedDigestsAfter, failedDigestsBefore, "Preserved failed-upgrade profile changed during rollback");

  const ownerAfter = Object.fromEntries(OWNER_PATHS.map((p) => [p, stamp(p)]));
  assert.deepStrictEqual(ownerAfter, ownerBefore, "Owner real paths must stay completely unchanged");

  return {
    root,
    candidate: candidateCheck,
    oldBundle: {
      revision: "526ed68d1b5d89f8dbfa0cc0eaa0c951a1885a19",
      ceiling: "142_run_terminations",
    },
    snapshot: snapshotResult,
    forwardMigration: {
      before: { migrationCount: beforeUpgradeDb.migrationCount, lastMigration: beforeUpgradeDb.lastMigration, runningRuns: beforeUpgradeDb.runningRuns },
      after: { migrationCount: afterUpgradeDb.migrationCount, lastMigration: afterUpgradeDb.lastMigration, runningRuns: afterUpgradeDb.runningRuns, integrity: afterUpgradeDb.integrity },
      windowDiagnostics: windowDiag,
      updater: { status: updStatus.body, check: updCheck.body, applyStatus: updApply.status },
      reopenCleanNoRepeatMigrations: true,
    },
    schemaAheadRefusal: {
      exitStatus: aheadRes.status,
      dbBytesUnchanged: true,
    },
    rollback: {
      failedPreservedUnchanged: true,
      restoredSchema: restoredDb.lastMigration,
      restoredIntegrity: restoredDb.integrity,
      restoredRunningRuns: restoredDb.runningRuns,
      postUpgradeTaskAbsent: true,
      preUpgradeRecordsRestored: true,
    },
    ownerPathsUnchanged: true,
  };
  } finally {
    spawnSync("pkill", ["-9", "-f", `${root}/apps/`]);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "verify-candidate") {
  console.log(JSON.stringify(verifyCandidate(rest[0]!, rest[1]!, rest[2]), null, 2));
} else if (cmd === "rehearse") {
  console.log(JSON.stringify(await rehearseUpgradeAndRollback(rest[0]!, rest[1]!, rest[2]), null, 2));
} else {
  console.error("Usage: bun --no-env-file scripts/qa-direction30-rehearsal.ts verify-candidate <app> <preSignDir> [signedReceiptDir] | rehearse <oldBuildDir> <newBuildDir> [signedReceiptDir]");
  process.exit(2);
}
