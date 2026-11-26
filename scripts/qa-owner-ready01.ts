/**
 * FO-OWNER-READY01 packaged walkthrough.
 * Isolated ForgeOrbitQA only. Fake Head and Developer drivers. Two disposable projects.
 *
 * FORGEORBIT_QA_OUTPUT_ROOT=<root> bun --no-env-file scripts/build-qa-native.ts
 * bun --no-env-file scripts/qa-owner-ready01.ts <root>
 */
import { assertNativeQaEnvironment, NATIVE_QA_STUB } from "../src/bun/native-qa-environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const root = realpathSync(process.argv[2] ?? "");
assert.match(root, /^\/private\/tmp\/fo-owner-ready01-[A-Za-z0-9]+$/);
const evidencePath = join(root, "fo-owner-ready01-evidence.json");
const repo = join(import.meta.dir, "..");
const runtime = join(root, "runtime");
const data = join(runtime, "data");
const home = join(runtime, "home");
const tmp = join(runtime, "tmp");
const alpha = join(runtime, "Alpha");
const other = join(runtime, "Other");
const app = join(root, "ForgeOrbitQA-dev.app");
const appBin = join(app, "Contents/MacOS");
assert.equal(realpathSync(app), app);
const helper = join(root, "qa-native-pid");
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = portProbe.port;
portProbe.stop(true);
const logPath = join(root, "native.log");
const credFile = join(data, "agetor-core.json");
assert(!existsSync(data), "Refusing to reuse a QA profile");
for (const p of [data, home, tmp, join(alpha, "src"), other]) mkdirSync(p, { recursive: true, mode: 0o700 });
writeFileSync(join(alpha, "src", "add.ts"), "export const add = (a: number, b: number) => a + b;\n");
writeFileSync(join(alpha, "README.md"), "fixture\n");
writeFileSync(join(other, "README.md"), "other fixture\n");
const git = (args: string[]) => {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: alpha, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(result.stderr || "git fixture failed");
};
git(["init", "-q"]);
git(["add", "."]);
git(["-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-q", "-m", "fixture"]);

const ownerPaths = [
  join(homedir(), "Library/Application Support/ForgeOrbit"),
  join(homedir(), "Library/WebKit/app.forgeorbit"),
  join(homedir(), ".agetor"),
  join(homedir(), ".forgeorbit"),
  join(homedir(), ".codex"),
  join(homedir(), ".claude"),
];
const stamp = (p: string) => {
  try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; }
};
const ownerBefore = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));

const sh = (argv: string[], timeout = 15000) => {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw Error(result.stderr?.trim() || String(result.error ?? "helper unavailable"));
  return result.stdout.trim();
};
sh(["/usr/bin/clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "ApplicationServices", join(repo, "scripts/qa-native-pid.m"), "-o", helper]);

const env: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh", LANG: "en_US.UTF-8", HOME: home, TMPDIR: tmp,
  CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, CURSOR_CONFIG_DIR: home, GEMINI_CLI_HOME: home,
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home, LD_LIBRARY_PATH: ".",
  FORGEORBIT_DATA_DIR: data, AGETOR_DATA_DIR: data, FORGEORBIT_API_PORT: String(apiPort), AGETOR_API_PORT: String(apiPort),
  FORGEORBIT_EMBEDDING_MODEL_ROOT: join(runtime, "no-models"),
  FORGEORBIT_USAGE_OFFLINE: "1", AGETOR_USAGE_OFFLINE: "1", FORGEORBIT_DISABLE_UPDATES: "1", AGETOR_DISABLE_UPDATES: "1",
};
const kinds = ["CLAUDE", "CODEX", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"];
for (const kind of kinds) env[`AGETOR_${kind}_DRIVER`] = "fake";
for (const kind of [...kinds, "TMUX", "NOTIFIER", "DISCLAIM"]) {
  const stub = join(runtime, kind.toLowerCase());
  writeFileSync(stub, NATIVE_QA_STUB, { mode: 0o755 });
  env[`AGETOR_${kind}_BIN`] = stub;
}
assert.equal("AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE" in env, false);
assertNativeQaEnvironment(runtime, env);
const receipt = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
assert.equal(receipt.bundleIdentifier, "app.forgeorbit.qa");
assert.equal(receipt.qaRuntimeRoot, runtime);

const launch = () => {
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(join(appBin, "launcher"), [], { cwd: appBin, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  return child;
};

const steps: string[] = [];
const controls: string[] = [];
const verdicts: Record<string, string> = {};
const evidence: Record<string, unknown> = {
  apiPort, bundle: "app.forgeorbit.qa", manifest: receipt.artifactManifestSHA256,
  fakeDrivers: kinds, syntheticHead: true, steps, controls, verdicts,
};
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
const mark = (step: string) => { steps.push(step); save(); console.log(step); };

const poll = async <T>(label: string, fn: () => T | null | Promise<T | null>, timeout = 20000): Promise<T> => {
  const end = Date.now() + timeout;
  let last = "";
  do {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { last = (error as Error).message; }
    await Bun.sleep(250);
  } while (Date.now() < end);
  throw Error(`${label}${last ? `: ${last}` : ""}`);
};

let child: ReturnType<typeof launch> | undefined;
let creds: { pid: number; port: number; token: string };
const boot = async () => {
  child = launch();
  await poll("Packaged backend did not boot", async () => {
    if (!existsSync(credFile)) return null;
    try {
      const result = await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(750) });
      return result.ok || null;
    } catch { return null; }
  }, 25_000);
  creds = JSON.parse(readFileSync(credFile, "utf8"));
  assert.equal(creds.port, apiPort);
  assert.match(readFileSync(logPath, "utf8"), /FO-NATIVE005-QA-EPHEMERAL-V1/);
};
const stop = async () => {
  if (!child?.pid) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => {
    if (child?.exitCode != null || child?.signalCode != null) resolve();
    else child?.once("exit", () => resolve());
  });
  try { process.kill(-pid, "SIGTERM"); } catch { /* already stopped */ }
  await Promise.race([exited, Bun.sleep(4000)]);
  try { process.kill(-pid, 0); } catch { child = undefined; return; }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
  await Bun.sleep(500);
  child = undefined;
};

async function api(method: string, route: string, body?: unknown, expected = 200): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  assert.equal(res.status, expected, `${method} ${route}: HTTP ${res.status}${raw ? ` ${raw.slice(0, 500)}` : ""}`);
  if (!raw && expected === 204) return null;
  return raw ? JSON.parse(raw) : null;
}
const get = (route: string) => api("GET", route);

type AxNode = { AXRole?: string; AXTitle?: string; AXDescription?: string; AXHelp?: string; AXValue?: string | number; AXEnabled?: boolean;
  AXFocused?: boolean; frame?: { x: number; y: number; width: number; height: number }; children?: AxNode[] };
const entries = (node: AxNode | undefined): AxNode[] => node ? [node, ...(node.children ?? []).flatMap(entries)] : [];
const labels = (node: AxNode) => [node.AXTitle, node.AXDescription, node.AXValue, node.AXHelp].filter((x): x is string => typeof x === "string");
const names = (node: AxNode) => [node.AXTitle, node.AXDescription].filter((x): x is string => typeof x === "string");
const bindingFile = join(root, "binding.json");
let binding: { axTrusted: boolean; windowId: number; corePid: number } | undefined;
const ax = (...args: string[]) => sh([helper, bindingFile, ...args]);
const inspect = () => JSON.parse(ax("inspect")) as { web?: AxNode };
const bind = async () => {
  const candidate = join(root, "candidate.json");
  writeFileSync(candidate, JSON.stringify({ launcherPid: child?.pid, corePid: creds.pid, artifact: app }), { mode: 0o600 });
  binding = await poll("Packaged window could not be bound", () => {
    try { return JSON.parse(sh([helper, candidate, "identify"])); } catch { return null; }
  }, 30_000);
  assert(binding.axTrusted, "macOS Accessibility is unavailable to the QA runner");
  writeFileSync(bindingFile, JSON.stringify(binding), { mode: 0o600 });
  await poll("Packaged window frame was not stable", () => {
    ax("focus");
    return true;
  }, 25_000);
};
const find = (predicate: (node: AxNode) => boolean) => entries(inspect().web).filter(predicate);
const seek = (label: string, predicate: (node: AxNode) => boolean, timeout = 12_000) =>
  poll(label, () => find(predicate).at(-1) ?? null, timeout);
const show = (part: string, timeout = 12_000) => seek(`WKWebView did not render "${part}"`,
  (node) => labels(node).some((label) => label.includes(part)), timeout);
const matching = (role: string, name: string) => (n: AxNode) => n.AXRole === role && names(n).some((value) => value === name || value.includes(name));
const click = (node: AxNode) => {
  assert(node.frame, "Control has no clickable bounds");
  const { x, y, width, height } = node.frame;
  ax("focus");
  ax("click", String(Math.round(x + width / 2)), String(Math.round(y + height / 2)));
};
const activate = (node: AxNode, preferred?: string) => {
  const labeled = names(node).filter((value) => value.length > 0);
  const name = preferred && labeled.some((value) => value.includes(preferred))
    ? preferred
    : labeled.sort((a, b) => b.length - a.length)[0];
  assert(node.AXRole && name, `AX control is not labeled: ${JSON.stringify(labels(node))}`);
  const point = node.frame
    ? [String(Math.round(node.frame.x + node.frame.width / 2)), String(Math.round(node.frame.y + node.frame.height / 2))]
    : [];
  try { ax("press", node.AXRole, name, ...point); }
  catch (error) {
    const message = (error as Error).message;
    if (!node.frame || message.includes("outside")) {
      throw Error(`${message}; role=${node.AXRole} name=${name} labels=${JSON.stringify(labels(node))} frame=${JSON.stringify(node.frame)}`);
    }
    click(node);
  }
};
const button = async (name: string) => {
  let node: AxNode | null = null;
  try {
    node = await seek(`Missing enabled button "${name}"`, (n) => matching("AXButton", name)(n) && n.AXEnabled !== false);
  } catch (error) {
    const titles = find((n) => n.AXRole === "AXButton").map((item) => names(item)[0]).filter(Boolean).slice(-25);
    throw Error(`${(error as Error).message}; buttons: ${titles.join(" | ")}`);
  }
  activate(node!, name);
  controls.push(name);
  await Bun.sleep(250);
};
const key = (code: number, flags = 0) => ax("key", String(code), String(flags));
const choose = async (label: string, option: string) => {
  const match = matching("AXPopUpButton", label);
  await seek(`Missing select "${label}"`, match);
  for (let i = 0; i < 6; i++) {
    const node = find(match).at(-1);
    if (String(node?.AXValue).includes(option)) { controls.push(`${label}=${option}`); return; }
    try { ax("press", "AXPopUpButton", label); } catch { try { ax("focus-name", "AXPopUpButton", label); } catch { /* popup not exposed this pass */ } }
    await Bun.sleep(500);
    try { ax("press", "AXMenuItem", option); } catch { /* option not exposed in this menu */ }
    await Bun.sleep(250);
  }
  const last = find(match).at(-1);
  throw Error(`${label} stayed on "${last?.AXValue ?? ""}"`);
};
const checkbox = (label: string) => seek(`Missing checkbox "${label}"`, matching("AXCheckBox", label));
const checked = (node: AxNode) => String(node.AXValue) === "1";
const setCheck = async (label: string, want: boolean) => {
  const node = await checkbox(label);
  if (checked(node) === want) return;
  ax("focus-name", "AXCheckBox", label);
  await seek(`Checkbox "${label}" could not take keyboard focus`, (item) => matching("AXCheckBox", label)(item) && item.AXFocused === true);
  key(49);
  await seek(`Checkbox "${label}" did not change to ${want}`, (item) => matching("AXCheckBox", label)(item) && checked(item) === want);
  controls.push(`check:${label}=${want} (Space)`);
};
const fill = async (name: string, value: string) => {
  const node = await seek(`Missing field "${name}"`, (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "") && names(n).some((label) => label.includes(name)));
  const role = node.AXRole!;
  const accessible = names(node).find((label) => label.includes(name)) ?? name;
  ax("focus-name", role, accessible);
  await Bun.sleep(120);
  key(0, 1048576);
  key(51);
  ax("text", value);
  await Bun.sleep(150);
  const written = find((n) => n.AXRole === role && names(n).some((label) => label.includes(name))).at(-1);
  assert(String(written?.AXValue ?? "").includes(value.slice(0, 24)), `${name} did not receive the typed value`);
  controls.push(`fill:${name}`);
};

const MEMORY = "Ready timeout note";
const OTHER = "Other project secret";
const boardTitle = "Ready board note";

try {
  await boot();
  const config = { harness: "codex", model: "gpt-5.6-sol", effort: "low" };
  mark("Packaged ForgeOrbitQA started on a disposable profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" }, 204);
  await api("PUT", "/preferences/locale", { value: "en" }, 204);
  const project = await api("POST", "/projects", { path: alpha, name: "Ready Alpha" });
  await api("POST", "/projects", { path: other, name: "Ready Other" });
  const worker = await api("POST", "/employees", { projectPath: alpha, name: "Ada", jobTitle: "Developer" }, 201);
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const preflight = await api("POST", "/project-interviews/preflight", config);
  await api("PUT", "/portfolio-manager/config", { config: { ...config, consentKey: preflight.isolation.consentKey } });
  const memory = await api("POST", "/brain/memories", {
    scopeKind: "project", projectPath: project.path, title: MEMORY, kind: "fact",
    content: "Ready Alpha keeps the disposable fixture timeout at 2000ms.",
  }, 201);
  await api("POST", "/brain/memories", {
    scopeKind: "project", projectPath: other, title: OTHER, kind: "fact",
    content: "This memory belongs to a different registered project.",
  }, 201);
  evidence.memory = { id: memory.id, revision: memory.revision, title: MEMORY };
  await bind();
  const skip = find((n) => ["Skip", "Пропустить"].some((s) => matching("AXButton", s)(n))).at(-1);
  if (skip) activate(skip);
  await button("Open Head of PM");
  await choose("Context", "Ready Alpha");
  try {
    await Bun.sleep(1500);
    await button("Brain for the next message");
    await checkbox(MEMORY);
    assert.equal(find((n) => labels(n).some((value) => value.includes(OTHER))).length, 0);
    await setCheck(MEMORY, true);
    await show("1 selected, not sent");
    await setCheck(MEMORY, false);
    assert.equal(find((n) => labels(n).some((value) => value.includes("1 selected, not sent"))).length, 0);
    await show("Off for this message");
    await setCheck(MEMORY, true);
    await show("1 selected, not sent");
    await button("Preview context");
    await show("Context that will be sent");
    await show(MEMORY);
    await button("Use these memories on the next message");
    await show("approved for the next message");
    const before = (await get("/portfolio-manager")).messages.length;
    const composer = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
      && labels(n).some((value) => value.includes("Message to Head of PM")));
    ax("focus-name", composer.AXRole!, names(composer).find((value) => value.includes("Message to Head of PM"))!);
    ax("text", "__fake_head_scope__ Confirm the attached project memory");
    key(36, 1048576);
    controls.push("Head send");
    const reply = await poll("Head did not answer with the memory source", async () => {
      const state = await get("/portfolio-manager");
      if (state.messages.length < before + 2 || state.activeTurn) return null;
      const message = state.messages.at(-1);
      const source = message?.sources?.find((item: { id: string }) => item.id === "brain");
      return source ? { message, source } : null;
    }, 40_000);
    const detail = String(reply.source.detail ?? "");
    assert(detail.includes(MEMORY), detail);
    assert(detail.includes(`r${memory.revision}`), detail);
    assert(detail.includes("project"), detail);
    assert(!detail.includes(OTHER), detail);
    assert(!String(reply.message.text).includes("2000ms"), "The memory body was injected into the reply");
    const audit = await get("/brain/context/transmissions?managerKind=portfolio");
    const transmission = audit.transmissions.find((item: { turnId: string; used: boolean; status: string }) =>
      item.turnId && item.used && item.status === "consumed");
    assert(transmission, "No used Brain transmission was recorded");
    assert.deepEqual(transmission.access, { mode: "projects", projectPaths: [project.path], inheritCompany: false });
    assert.deepEqual(transmission.items.map((item: { id: string; revision: number; sha256: string; scope: unknown }) =>
      ({ id: item.id, revision: item.revision, sha256: item.sha256, scope: item.scope })), [{
      id: memory.id, revision: memory.revision, sha256: memory.contentSha256, scope: { kind: "project", id: project.path },
    }]);
    evidence.brainTransmission = { ref: transmission.ref, digest: transmission.digest, items: transmission.items };
    evidence.brainSource = detail;
    verdicts.brainInHead = "PASS";
    mark("Head received the selected project memory as data, with its revision");
  } catch (error) {
    verdicts.brainInHead = "PARTIAL";
    evidence.brainBlocker = (error as Error).message;
    writeFileSync(join(root, "ax-brain-at-stop.json"), JSON.stringify(inspect(), null, 2));
    console.error("Brain walkthrough stopped:", evidence.brainBlocker);
    if (find(matching("AXButton", "Preview context")).length > 0) await button("Brain for the next message");
    process.exitCode = 1;
  }

  const propose = async (action: Record<string, unknown>) => {
    const count = (await get("/portfolio-manager")).messages.length;
    const field = await seek("Missing Head composer", (n) => ["AXTextArea", "AXTextField"].includes(n.AXRole ?? "")
      && labels(n).some((value) => value.includes("Message to Head of PM")));
    ax("focus-name", field.AXRole!, names(field).find((value) => value.includes("Message to Head of PM"))!);
    ax("text", `__fake_head_board__ ${JSON.stringify({ projectPath: alpha, ...action })}`);
    key(36, 1048576);
    controls.push(`Head proposal ${String(action.kind)}`);
    await poll("Head did not prepare a proposal", async () => {
      const state = await get("/portfolio-manager");
      return state.messages.length >= count + 2 && !state.activeTurn ? state : null;
    }, 40_000);
    await show("Review the board proposal");
    const proposal = (await get("/portfolio-manager")).boardProposals?.at(-1);
    if (!proposal || proposal.status !== "pending") throw Error(`No pending proposal: ${JSON.stringify(proposal)}`);
    return proposal;
  };
  const approve = async (expectStatus: "applied" | "pending") => {
    const before = (await get("/portfolio-manager")).boardProposals?.at(-1);
    await button("Approve");
    let last = "";
    const settled = await poll("Head proposal did not reach the expected state", async () => {
      const current = (await get("/portfolio-manager")).boardProposals?.at(-1);
      last = `${current?.status ?? "missing"}${current?.error ? `: ${current.error}` : ""}`;
      if (expectStatus === "applied" && current?.status === "applied") return current;
      if (expectStatus === "pending" && current?.status === "pending" && current.error && current.error !== before?.error) return current;
      if (current && !["pending", "applying"].includes(current.status)) return current;
      return null;
    }, 90_000).catch((error) => { throw Error(`${(error as Error).message} (${last})`); });
    assert.equal(settled.status, expectStatus, last);
    return settled;
  };

  await propose({ kind: "create", title: boardTitle, description: "Organize the disposable board. This note is not an execution prompt." });
  await approve("applied");
  let board = (await get("/tasks")).find((row: { title: string }) => row.title === boardTitle);
  assert.equal(board.isolation, "worktree");
  await api("PATCH", `/tasks/${board.id}`, { agent: "codex", model: config.model, mode: "auto" });
  await propose({ kind: "admit", taskId: board.id });
  await approve("applied");
  await propose({ kind: "assign", taskId: board.id, employeeId: worker.id });
  await approve("applied");
  await propose({ kind: "stage_ready", taskId: board.id });
  await approve("applied");
  await propose({ kind: "plan_execution", taskId: board.id, employeeId: worker.id, harnessId: "codex", model: config.model, effort: config.effort, mode: "auto" });
  await show("Reading this repository does not need extra access");
  await show("developer-execution");
  await show("task-staging");
  await show(project.path);
  const refused = await approve("pending");
  assert.match(String(refused.error ?? ""), /developer-execution/);
  assert.match(String(refused.error ?? ""), /task-staging/);
  assert.equal((await get(`/employee-execution/attempts?taskId=${board.id}`)).attempts.length, 0);
  await show("Execution planning is blocked");
  verdicts.executionRefused = "PASS";
  mark("Approving without the task-owned write left execution blocked");

  await setCheck("Approve task-owned workspace write for this project", true);
  await fill("Output paths in the task workspace", "README.md");
  const allowed = await approve("applied");
  const attempts = await get(`/employee-execution/attempts?taskId=${board.id}`);
  assert.equal(attempts.attempts.length, 1);
  const attempt = attempts.attempts[0];
  assert.equal(attempt.phase, "awaiting-approval");
  assert.equal(attempt.runId, null);
  assert.equal(attempt.review.permission.layout, "non-git");
  assert.equal(attempt.review.permission.sandbox, "workspace-write");
  assert.equal(attempt.review.permission.escalated, false);
  assert.equal(attempt.review.permission.launchAllowed, true);
  assert.equal(String(attempt.review.workspace).includes(`${"/"}task-workspaces${"/"}`), true);
  board = await get(`/tasks/${board.id}`);
  assert.equal(board.worktreePath ?? null, null);
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: alpha, encoding: "utf8" });
  const worktrees = listed.stdout.split("\n").filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: alpha, encoding: "utf8" });
  assert.equal(status.stdout, "");
  evidence.executionPlan = {
    proposal: allowed.status,
    attemptId: attempt.id,
    permission: attempt.review.permission,
    workspace: attempt.review.workspace,
  };
  verdicts.executionPlan = "PASS";
  mark("Scoped task-owned planning succeeded without Full access or a Git worktree");
  verdicts.ownerProfile = "PASS";
} catch (error) {
  evidence.blocker = (error as Error).stack ?? (error as Error).message;
  console.error(error);
  if (binding) {
    try { writeFileSync(join(root, "ax-at-stop.json"), JSON.stringify(inspect(), null, 2)); } catch { /* no AX tree */ }
  }
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { evidence.cleanup = (error as Error).message; process.exitCode = 1; }
  const ownerAfter = Object.fromEntries(ownerPaths.map((p) => [p, stamp(p)]));
  evidence.ownerUnchanged = JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter);
  if (!evidence.ownerUnchanged) {
    verdicts.ownerProfile = "FAIL";
    process.exitCode = 1;
  }
  save();
}
