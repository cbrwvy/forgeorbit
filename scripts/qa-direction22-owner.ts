/**
 * Direction 22 genuine macOS Owner check on a separate local-owner bundle and
 * a disposable profile. Never touches ~/Applications/ForgeOrbit.app, the
 * working profile, ~/Library/WebKit/app.forgeorbit, or provider homes.
 *
 * Subcommands:
 *   preflight                          Verify build/local/ForgeOrbit.app provenance, helper, entitlements, and Keychain anchor before signing.
 *   prepare   <root>                   Verify Owner signature, boot build/local/ForgeOrbit.app on a disposable profile, seed one harmless operation, open Owner Authorization.
 *   verify    <root>                   After Owner authentication, verify enrollment, SE blob (0600), consumed grant, 0 runs/providers, restart persistence, and revocation.
 *   cleanup   <root>                   Stop any running disposable app from <root>.
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../e2e/codex-profile-fixture.ts";
import { NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import { evaluateLocalSignature } from "../src/bun/owner-trust/local-signature.ts";
import { verifyPackage, verifyProvenance } from "./release-metadata.ts";

const repo = path.resolve(import.meta.dir, "..");
const localDir = path.join(repo, "build/local");
const app = path.join(localDir, "ForgeOrbit.app");
const helperBinPath = path.join(app, "Contents/Resources/app/bin/forgeorbit-owner-trust");
const bunIndexPath = path.join(app, "Contents/Resources/app/bun/index.js");

const ownerPaths = [
  path.join(homedir(), "Applications/ForgeOrbit.app"),
  path.join(homedir(), "Library/Application Support/ForgeOrbit"),
  path.join(homedir(), "Library/WebKit/app.forgeorbit"),
  path.join(homedir(), ".agetor"),
  path.join(homedir(), ".forgeorbit"),
  path.join(homedir(), ".codex"),
  path.join(homedir(), ".claude"),
];

const stamp = (p: string): string => {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
};

const consoleLocked = (): boolean =>
  /"IOConsoleLocked" = Yes/.test(spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }).stdout ?? "");

const providerPids = (): string[] =>
  ["codex", "claude", "claude-code"]
    .flatMap((name) =>
      (spawnSync("/usr/bin/pgrep", ["-x", name], { encoding: "utf8" }).stdout ?? "")
        .split("\n")
        .filter(Boolean)
        .map((pid) => `${name}:${pid}`),
    )
    .sort();

function entitlementsOf(target: string): string {
  const res = spawnSync("codesign", ["-d", "--entitlements", "-", target], { encoding: "utf8" });
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

function preflight(): Record<string, unknown> {
  assert.equal(existsSync(app), true, "build/local/ForgeOrbit.app does not exist; run bun run build:local first.");
  const sig = evaluateLocalSignature(app, { requireOwnerCn: true });
  const receipt = sig.adhoc
    ? verifyProvenance(app, localDir)
    : (() => {
        const expected = JSON.parse(readFileSync(path.join(localDir, "forgeorbit-provenance.json"), "utf8"));
        const actual = verifyPackage(app, expected.metadata);
        assert.deepStrictEqual(actual.sdk, expected.sdk, "SDK provenance mismatch after local-owner signing");
        return expected;
      })();
  assert.equal(receipt.sdk.identifier, "app.forgeorbit");
  assert.equal(receipt.metadata.localBuild, true);
  assert.equal(existsSync(helperBinPath), true, "Embedded forgeorbit-owner-trust helper is missing.");
  assert.equal(existsSync(bunIndexPath), true, "Packaged bun/index.js is missing.");
  const bunIndex = readFileSync(bunIndexPath, "utf8");
  assert.equal(bunIndex.includes("--data-dir"), true, "Packaged bun/index.js is stale (missing --data-dir).");
  const helperCodesign = spawnSync("codesign", ["-dv", "--verbose=4", helperBinPath], { encoding: "utf8" });
  const helperText = `${helperCodesign.stdout ?? ""}\n${helperCodesign.stderr ?? ""}`;
  assert.equal(helperText.includes("Identifier=app.forgeorbit.owner-trust"), true, "Helper identifier is not app.forgeorbit.owner-trust");
  assert.equal(spawnSync("codesign", ["--verify", "--strict", app], { encoding: "utf8" }).status, 0, "Bundle strict verification failed.");
  assert.equal(spawnSync("codesign", ["--verify", "--strict", helperBinPath], { encoding: "utf8" }).status, 0, "Helper strict verification failed.");
  const bunBin = path.join(app, "Contents/MacOS/bun");
  const launcherBin = path.join(app, "Contents/MacOS/launcher");
  const entitlements = {
    app: entitlementsOf(app).trim(),
    launcher: entitlementsOf(launcherBin).trim(),
    bun: entitlementsOf(bunBin).trim(),
    helper: entitlementsOf(helperBinPath).trim(),
  };
  for (const [name, text] of Object.entries(entitlements)) {
    assert.equal(text.includes("application-identifier"), false, `${name} unexpectedly carries application-identifier entitlement`);
    assert.equal(text.includes("keychain-access-groups"), false, `${name} unexpectedly carries keychain-access-groups entitlement`);
  }
  const keychains = (spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .map((line) => line.trim().replaceAll('"', ""))
    .filter(Boolean);
  return {
    app,
    provenance: receipt.metadata,
    artifactManifestSHA256: receipt.artifactManifestSHA256,
    helperPresent: true,
    helperIdentifier: "app.forgeorbit.owner-trust",
    bunIndexHasDataDir: true,
    entitlements,
    userKeychains: keychains,
    signature: sig,
  };
}

interface StateFile {
  root: string;
  runtime: string;
  data: string;
  home: string;
  tmp: string;
  project: string;
  apiPort: number;
  launcherPid?: number;
  taskId?: string;
  accountId?: string;
  harnessId?: string;
  ownerBefore: Record<string, string>;
  providersBefore: string[];
  env: Record<string, string>;
}

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 25_000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    if (consoleLocked()) throw new Error("STOP: macOS console is locked.");
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = (error as Error).message;
    }
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw new Error(`${label}${last ? `: ${last}` : ""}`);
};

async function api(port: number, token: string, route: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${route} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function stopPid(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  await poll("app exit", () => {
    try { process.kill(pid, 0); return null; } catch { return true; }
  }, 8000).catch(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  });
  await Bun.sleep(1000);
}

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXValue?: string | number; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => (node ? [node, ...(node.children ?? []).flatMap(entries)] : []);
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue].filter((v): v is string => typeof v === "string");

async function launchAndBind(state: StateFile): Promise<{ pid: number; token: string; axHelper: string; bindingFile: string }> {
  const logPath = path.join(state.root, "native.log");
  const credFile = path.join(state.data, "agetor-core.json");
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(path.join(app, "Contents/MacOS/launcher"), [], {
    cwd: path.join(app, "Contents/MacOS"),
    env: state.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  state.launcherPid = child.pid;
  await poll("Local-owner bundle did not boot", async () => {
    if (!existsSync(credFile)) return null;
    try {
      return (await fetch(`http://127.0.0.1:${state.apiPort}/health`, { signal: AbortSignal.timeout(750) })).ok || null;
    } catch {
      return null;
    }
  }, 45_000);
  const creds = JSON.parse(readFileSync(credFile, "utf8")) as { pid: number; port: number; token: string };
  assert.equal(creds.port, state.apiPort);
  const axHelper = path.join(state.root, "qa-native-pid");
  if (!existsSync(axHelper)) {
    const compiled = spawnSync("/usr/bin/clang", [
      "-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices",
      path.join(repo, "scripts/qa-native-pid.m"), "-o", axHelper,
    ], { encoding: "utf8" });
    if (compiled.status !== 0) throw new Error(compiled.stderr || "Failed to compile qa-native-pid");
  }
  const candidate = path.join(state.root, "candidate.json");
  const bindingFile = path.join(state.root, "binding.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child.pid, corePid: creds.pid, artifact: app, bundleIdentifier: "app.forgeorbit" }), { mode: 0o600 });
  const binding = await poll("Window did not bind", () => {
    try {
      return JSON.parse(spawnSync(axHelper, [candidate, "identify"], { encoding: "utf8" }).stdout || "null");
    } catch {
      return null;
    }
  }, 30_000);
  assert.ok(binding.axTrusted);
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  spawnSync(axHelper, [bindingFile, "focus"], { encoding: "utf8" });
  spawnSync(axHelper, [bindingFile, "resize", "1400", "1000"], { encoding: "utf8" });
  return { pid: child.pid!, token: creds.token, axHelper, bindingFile };
}

async function navigateToOwnerTrust(axHelper: string, bindingFile: string): Promise<void> {
  const ax = (...args: string[]) => {
    const res = spawnSync(axHelper, [bindingFile, ...args], { encoding: "utf8", timeout: 20_000 });
    if (res.status !== 0) throw new Error(res.stderr?.trim() || res.stdout?.trim() || "AX failed");
    return res.stdout.trim();
  };
  const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
  const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
  const pressLabel = async (options: string[]) => {
    const matches = await poll(`Missing control ${options.join(" | ")}`, () => {
      const found = find((node) => options.some((name) => labels(node).includes(name)) && Boolean(node.AXRole));
      return found.length ? found : null;
    }, 20_000);
    const name = options.find((option) => labels(matches[0]!).includes(option))!;
    const frame = matches[0]!.frame;
    ax("focus");
    try {
      ax("press", matches[0]!.AXRole!, name);
    } catch (error) {
      if (!frame || !(error as Error).message.includes("ambiguous")) throw error;
      ax("click", String(Math.round(frame.x + frame.width / 2)), String(Math.round(frame.y + frame.height / 2)));
    }
    await Bun.sleep(400);
  };
  try {
    await pressLabel(["Skip", "Пропустить — я уже знаком с приложением", "Пропустить", "Скрыть — я уже знаком с приложением"]);
  } catch {
    /* welcome already closed */
  }
  await pressLabel(["Missions", "Миссии"]);
  await pressLabel(["Owner confirmation", "Подтверждение владельца"]);
  await poll("Owner authorization panel did not appear", () =>
    find((node) => labels(node).some((l) => l.includes("Owner authorization") || l.includes("Авторизация владельца"))).at(-1) ?? null, 20_000);
  await poll("Review with macOS button did not appear", () =>
    find((node) => labels(node).some((l) => l === "Review with macOS" || l === "Проверить через macOS")).at(-1) ?? null, 20_000);
}

async function prepare(rawRoot: string): Promise<void> {
  if (consoleLocked()) throw new Error("STOP: macOS console is locked.");
  const check = preflight();
  const sig = check.signature as { ok: boolean; authoritative: boolean; reason: string };
  assert.equal(sig.ok && sig.authoritative, true, `Bundle must be signed with ForgeOrbit Local Owner before prepare: ${sig.reason}`);
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(rawRoot);
  assert.match(root, /^\/private\/tmp\/fo-direction22-owner-[A-Za-z0-9]+$/);
  const runtime = path.join(root, "runtime");
  const data = path.join(runtime, "data");
  const home = path.join(runtime, "home");
  const tmp = path.join(runtime, "tmp");
  const project = path.join(runtime, "project");
  const codexDir = path.join(home, "codex-a");
  assert.equal(existsSync(data), false, "Refusing to reuse an existing disposable profile");
  for (const dir of [runtime, data, home, tmp, project]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeSyntheticCodexProfile(codexDir, "d22-synthetic-codex");
  const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const apiPort = portProbe.port;
  portProbe.stop(true);
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    HOME: home,
    TMPDIR: tmp,
    CODEX_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CURSOR_CONFIG_DIR: home,
    GEMINI_CLI_HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_STATE_HOME: home,
    XDG_CACHE_HOME: home,
    FORGEORBIT_DATA_DIR: data,
    AGETOR_DATA_DIR: data,
    FORGEORBIT_API_PORT: String(apiPort),
    AGETOR_API_PORT: String(apiPort),
    FORGEORBIT_EMBEDDING_MODEL_ROOT: path.join(runtime, "no-models"),
    FORGEORBIT_USAGE_OFFLINE: "1",
    AGETOR_USAGE_OFFLINE: "1",
    FORGEORBIT_DISABLE_UPDATES: "1",
    AGETOR_DISABLE_UPDATES: "1",
  };
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) env[`AGETOR_${kind}_DRIVER`] = "fake";
  for (const kind of ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY", "TMUX", "NOTIFIER", "DISCLAIM"]) {
    const stub = path.join(runtime, kind.toLowerCase());
    writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
    env[`AGETOR_${kind}_BIN`] = stub;
  }
  const state: StateFile = {
    root,
    runtime,
    data,
    home,
    tmp,
    project,
    apiPort,
    ownerBefore: Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)])),
    providersBefore: providerPids(),
    env,
  };
  const { token, axHelper, bindingFile } = await launchAndBind(state);
  const codexProfile = await api(apiPort, token, "/account-core/codex-profiles", {
    method: "POST",
    body: JSON.stringify({ displayName: "D22 Harmless Codex", directory: realpathSync(codexDir) }),
  });
  await api(apiPort, token, "/projects", {
    method: "POST",
    body: JSON.stringify({ path: project, name: "D22 Disposable Project" }),
  });
  const created = await api(apiPort, token, "/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "Direction 22 harmless authorization check",
      prompt: "Harmless operation check. Do not start any provider process.",
      agent: codexProfile.harnessId,
      model: "gpt-6.1-sol",
      mode: "auto",
      workdir: project,
      isolation: "none",
      accessMode: "workspace",
    }),
  });
  state.taskId = created.id;
  state.accountId = codexProfile.accountId;
  state.harnessId = codexProfile.harnessId;
  const status = await api(apiPort, token, "/api/owner-trust/status");
  assert.equal(status.application.bundleId, "app.forgeorbit");
  assert.equal(status.application.trustClass, "production");
  assert.equal(status.application.adhoc, false);
  assert.equal(status.helper.ok, true);
  assert.equal(status.helper.identifier, "app.forgeorbit.owner-trust");
  assert.equal(status.enrollmentState, "none");
  assert.equal(status.operation?.taskId, created.id);
  assert.equal(status.operation?.accountId, codexProfile.accountId);
  assert.equal(status.operation?.externalProcess, false);
  assert.equal(status.executionReady, false);
  await navigateToOwnerTrust(axHelper, bindingFile);
  writeFileSync(path.join(root, "d22-state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, root, apiPort, launcherPid: state.launcherPid, taskId: state.taskId, accountId: state.accountId, status }, null, 2));
}

async function verify(rawRoot: string): Promise<void> {
  const root = realpathSync(rawRoot);
  const statePath = path.join(root, "d22-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as StateFile;
  const creds = JSON.parse(readFileSync(path.join(state.data, "agetor-core.json"), "utf8")) as { token: string };
  const statusAfter = await api(state.apiPort, creds.token, "/api/owner-trust/status");
  assert.equal(statusAfter.enrollmentState, "active", `Expected active enrollment after Owner auth, got ${statusAfter.enrollmentState}`);
  assert.equal(statusAfter.secureEnclaveEnrolled, true);
  assert.equal(statusAfter.executionReady, false);
  const keyFile = path.join(state.data, "owner-trust/owner-se-key.bin");
  assert.equal(existsSync(keyFile), true, "Missing SE-encrypted key blob");
  const keyStat = statSync(keyFile);
  assert.equal(keyStat.mode & 0o777, 0o600, "owner-se-key.bin permissions must be 0600");
  assert.ok(keyStat.size > 0, "owner-se-key.bin must be non-empty");
  const dbRead = new Database(path.join(state.data, "agetor.sqlite"), { readonly: true });
  const enrollments = dbRead.query<{ id: string; trust_class: string; application_identity: string; key_protection: string; authority_state: string; signing_cert_sha256: string | null }, []>(
    "SELECT id, trust_class, application_identity, key_protection, authority_state, signing_cert_sha256 FROM owner_trust_enrollments",
  ).all();
  const grants = dbRead.query<{ id: string; status: string; task_id: string; operation_digest: string }, []>(
    "SELECT id, status, task_id, operation_digest FROM owner_trust_grants",
  ).all();
  const decisions = dbRead.query<{ code: string; decision: string; operation_digest: string }, []>(
    "SELECT code, decision, operation_digest FROM owner_trust_decisions ORDER BY created_at",
  ).all();
  const runsCount = dbRead.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs").get()?.count ?? 0;
  dbRead.close();
  assert.equal(enrollments.length, 1);
  assert.equal(enrollments[0]!.authority_state, "active");
  assert.equal(enrollments[0]!.trust_class, "production");
  assert.equal(enrollments[0]!.key_protection, "secure-enclave-user-presence");
  assert.equal(enrollments[0]!.signing_cert_sha256, statusAfter.application.certSha256);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.status, "consumed");
  assert.equal(grants[0]!.task_id, state.taskId);
  assert.equal(runsCount, 0);
  assert.deepEqual(providerPids(), state.providersBefore);

  // Restart persistence on the same signed bundle and disposable profile.
  await stopPid(state.launcherPid);
  const restarted = await launchAndBind(state);
  const statusRestarted = await api(state.apiPort, restarted.token, "/api/owner-trust/status");
  assert.equal(statusRestarted.enrollmentState, "active");
  assert.equal(statusRestarted.secureEnclaveEnrolled, true);
  assert.equal(statusRestarted.executionReady, false);

  // Revocation check and non-revival.
  const revoked = await api(state.apiPort, restarted.token, "/api/owner-trust/revoke", {
    method: "POST",
    body: JSON.stringify({ enrollmentId: enrollments[0]!.id }),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.code, "owner-revoked");
  const statusRevoked = await api(state.apiPort, restarted.token, "/api/owner-trust/status");
  assert.equal(statusRevoked.enrollmentState, "revoked");
  assert.equal(statusRevoked.secureEnclaveEnrolled, false);
  assert.equal(statusRevoked.state, "authorization-refused");
  await stopPid(restarted.pid);
  assert.deepEqual(providerPids(), state.providersBefore);
  const ownerUnchanged = ownerPaths.every((p) => stamp(p) === state.ownerBefore[p]);
  assert.equal(ownerUnchanged, true, "Owner real application/provider paths changed!");
  const evidence = {
    verdict: "PASS",
    bundleId: "app.forgeorbit",
    certSha256: statusAfter.application.certSha256,
    enrollmentId: enrollments[0]!.id,
    seBlobBytes: keyStat.size,
    seBlobMode: "0600",
    grantId: grants[0]!.id,
    grantStatus: grants[0]!.status,
    decisions,
    runsCount,
    restartedActive: true,
    revokedCode: revoked.code,
    ownerUnchanged,
    providersUnchanged: true,
  };
  writeFileSync(path.join(root, "fo-direction22-owner.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}

async function cleanup(rawRoot: string): Promise<void> {
  const statePath = path.join(realpathSync(rawRoot), "d22-state.json");
  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as StateFile;
  await stopPid(state.launcherPid);
}

const cmd = process.argv[2] ?? "";
if (cmd === "preflight") {
  console.log(JSON.stringify(preflight(), null, 2));
} else if (cmd === "prepare") {
  await prepare(process.argv[3] ?? "");
} else if (cmd === "verify") {
  await verify(process.argv[3] ?? "");
} else if (cmd === "cleanup") {
  await cleanup(process.argv[3] ?? "");
} else {
  console.error("Usage: bun --no-env-file scripts/qa-direction22-owner.ts preflight | prepare <root> | verify <root> | cleanup <root>");
  process.exit(2);
}
