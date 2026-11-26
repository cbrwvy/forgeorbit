import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";
import { OWNER_TRUST_SCHEMA, parseOwnerOperation } from "../shared/owner-trust/protocol.ts";

const root = realpathSync(mkdtempSync("/private/tmp/fo-d21-integ-"));
const dataDir = path.join(root, "data");
const homeDir = path.join(root, "home");
const repoDir = path.join(root, "project");
const outsideDir = path.join(root, "outside");
const scratchDir = path.join(root, "scratch");

for (const dir of [dataDir, homeDir, path.join(repoDir, "src"), outsideDir, scratchDir]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const probePort = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const apiPort = probePort.port;
probePort.stop(true);

process.env.AGETOR_DATA_DIR = dataDir;
process.env.HOME = homeDir;
process.env.AGETOR_API_PORT = String(apiPort);
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CURSOR_DRIVER = "fake";
process.env.AGETOR_GEMINI_DRIVER = "fake";
process.env.AGETOR_FX_DRIVER = "fake";
process.env.AGETOR_ANTIGRAVITY_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const OUTSIDE_CANARY = path.join(outsideDir, "secret-canary.txt");
const OUTSIDE_WRITE = path.join(outsideDir, "should-not-write.txt");
writeFileSync(OUTSIDE_CANARY, "OUTSIDE-SECRET-CANARY-D21", { mode: 0o600 });

const CALC_SOURCE = "export function add(a: number, b: number): number { return a + b; }\n";
const CALC_TARGET = "export function mul(a: number, b: number): number { return a * b; }\n";

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

let server: { stop: () => void };
let apiToken = "";
let loopServer: ReturnType<typeof Bun.serve>;
let loopHits = 0;

beforeAll(async () => {
  writeFileSync(path.join(repoDir, "README.md"), "# D21 fixture\n");
  writeFileSync(path.join(repoDir, "src/calc.ts"), CALC_SOURCE);
  writeFileSync(path.join(repoDir, ".env"), "SECRET_ENV=do-not-copy\n");
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["add", "README.md", "src/calc.ts"]);
  await git(repoDir, ["-c", "user.email=d21@example.com", "-c", "user.name=D21", "commit", "-m", "seed"]);

  loopServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/ping") loopHits += 1;
      return new Response("pong");
    },
  });

  const store = await import("./db.ts");
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("claude-code", true);
  store.projects.upsert(repoDir, "D21 Fixture");

  const srv = await import("./server.ts");
  server = srv.startApiServer() as unknown as { stop: () => void };
  apiToken = srv.API_TOKEN;
});

afterAll(async () => {
  const { useSeatbeltProbeForTests } = await import("./launch-diagnostics.ts");
  useSeatbeltProbeForTests(null);
  server?.stop?.();
  loopServer?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("API enforces accessMode validation, immutability, and pre-launch diagnostics", async () => {
  const bad = await api("POST", "/tasks", {
    title: "bad mode",
    prompt: "p",
    workdir: repoDir,
    accessMode: "sudo-root",
    isolation: "none",
  });
  expect(bad.status).toBe(400);

  const conflictWorktree = await api("POST", "/tasks", {
    title: "isolated worktree",
    prompt: "p",
    workdir: repoDir,
    accessMode: "isolated",
    isolation: "worktree",
  });
  expect(conflictWorktree.status).toBe(400);

  const isoTask = await api("POST", "/tasks", {
    title: "isolated codex draft",
    prompt: "p",
    workdir: repoDir,
    agent: "codex",
    mode: "auto",
    accessMode: "isolated",
    isolation: "none",
    column: "ready",
  });
  expect(isoTask.status).toBe(200);
  expect(isoTask.json.accessMode).toBe("isolated");

  const mutateMode = await api("PATCH", `/tasks/${isoTask.json.id}`, { accessMode: "workspace" });
  expect(mutateMode.status).toBe(409);
  expect(mutateMode.json.code).toBe("access-mode-immutable");

  const diag = await api("GET", `/tasks/${isoTask.json.id}/launch-diagnostics`);
  expect(diag.status).toBe(200);
  expect(diag.json.accessMode).toBe("isolated");
  expect(diag.json.launchAllowed).toBe(false);
  expect(diag.json.blockCodes).toContain("block-isolated-requires-staging");

  const previewClaudeIso = await api("POST", "/launch-diagnostics", {
    accessMode: "isolated",
    harnessId: "claude-code",
    mode: "auto",
    isolation: "none",
    workdir: repoDir,
  });
  expect(previewClaudeIso.status).toBe(200);
  expect(previewClaudeIso.json.launchAllowed).toBe(false);
  expect(previewClaudeIso.json.blockCodes).toContain("block-isolated-unsupported-harness");
  expect(previewClaudeIso.json.osEnforcement.mechanism).toBe("none");

  const previewFullComp = await api("POST", "/launch-diagnostics", {
    accessMode: "full-computer",
    harnessId: "codex",
    mode: "full-access",
    isolation: "none",
    workdir: repoDir,
  });
  expect(previewFullComp.status).toBe(200);
  expect(previewFullComp.json.launchAllowed).toBe(false);
  expect(previewFullComp.json.blockCodes).toContain("block-full-computer-no-process-grant");
  expect(previewFullComp.json.computerUse.grantedByMode).toBe(false);
});

test("startTask & sendInput refuse unsupported access modes, missing staging, and Seatbelt blocks with no fallback", async () => {
  const { createTask, startTask, sendInput } = await import("./orchestrator.ts");
  const { runs, tasks } = await import("./db.ts");
  const { prepareTaskWorkspace } = await import("./task-workspace.ts");
  const { useSeatbeltProbeForTests } = await import("./launch-diagnostics.ts");

  // 1. Full Computer task cannot launch process execution
  const fcRes = await createTask({
    title: "fc refused",
    prompt: "open something",
    workdir: repoDir,
    agent: "codex",
    mode: "auto",
    accessMode: "full-computer",
    isolation: "none",
    column: "ready",
  });
  if ("error" in fcRes) throw new Error(fcRes.error);
  const fcStart = await startTask(fcRes.task.id);
  expect("error" in fcStart).toBe(true);
  expect(runs.listForTask(fcRes.task.id)).toHaveLength(0);
  expect(tasks.get(fcRes.task.id)?.column).toBe("ready");

  // 2. Isolated + Claude refuses (no OS sandbox for Claude)
  const claudeIso = await createTask({
    title: "claude isolated refused",
    prompt: "do work",
    workdir: repoDir,
    agent: "claude-code",
    mode: "auto",
    accessMode: "isolated",
    isolation: "none",
    column: "ready",
  });
  if ("error" in claudeIso) throw new Error(claudeIso.error);
  const claudeStart = await startTask(claudeIso.task.id);
  expect("error" in claudeStart).toBe(true);
  expect(runs.listForTask(claudeIso.task.id)).toHaveLength(0);

  // 3. Isolated + Codex without staging refuses cleanly
  const unstagedIso = await createTask({
    title: "unstaged codex iso",
    prompt: "do work",
    workdir: repoDir,
    agent: "codex",
    mode: "auto",
    accessMode: "isolated",
    isolation: "none",
    column: "ready",
  });
  if ("error" in unstagedIso) throw new Error(unstagedIso.error);
  const unstagedStart = await startTask(unstagedIso.task.id);
  expect("error" in unstagedStart).toBe(true);
  expect(runs.listForTask(unstagedIso.task.id)).toHaveLength(0);

  // 4. Isolated + Codex WITH staging: nested Seatbelt refuses with zero fallback
  const stagedTask = await createTask({
    title: "staged codex iso",
    prompt: `Write src/mul.ts\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({ writes: [{ path: "src/mul.ts", contents: CALC_TARGET }] })}`,
    workdir: repoDir,
    agent: "codex",
    mode: "auto",
    model: "gpt-6.1-sol",
    effort: "low",
    accessMode: "isolated",
    isolation: "none",
    column: "ready",
  });
  if ("error" in stagedTask) throw new Error(stagedTask.error);
  const prepared = await prepareTaskWorkspace(stagedTask.task.id, { outputPaths: ["src/mul.ts"] });
  expect(existsSync(path.join(prepared.stagingPath, ".env"))).toBe(false);

  useSeatbeltProbeForTests(() => "nested-blocked");
  const nestedStart = await startTask(stagedTask.task.id);
  expect("error" in nestedStart).toBe(true);
  if ("error" in nestedStart) expect(nestedStart.error).toContain("nested sandbox-exec");
  expect(runs.listForTask(stagedTask.task.id)).toHaveLength(0);

  // 5. Seatbelt available: staged Isolated launch succeeds inside staging without touching project
  useSeatbeltProbeForTests(() => "available");
  const calcBefore = sha(path.join(repoDir, "src/calc.ts"));
  const allowedStart = await startTask(stagedTask.task.id);
  expect("error" in allowedStart).toBe(false);
  await Bun.sleep(150);
  expect(runs.listForTask(stagedTask.task.id)).toHaveLength(1);
  expect(sha(path.join(repoDir, "src/calc.ts"))).toBe(calcBefore);
  expect(existsSync(path.join(repoDir, "src/mul.ts"))).toBe(false);

  // 6. Settled Isolated staging refuses follow-up sendInput instead of falling back to repoDir
  const runId = runs.listForTask(stagedTask.task.id)[0]!.id;
  const followUp = await sendInput(runId, "touch live project");
  expect(followUp.delivered).toBe(false);

  // 7. Workspace Codex Auto + worktree refuses pre-start (does not leave a failed run row)
  const codexWt = await createTask({
    title: "codex wt auto",
    prompt: "p",
    workdir: repoDir,
    agent: "codex",
    mode: "auto",
    accessMode: "workspace",
    isolation: "worktree",
    column: "ready",
  });
  if ("error" in codexWt) throw new Error(codexWt.error);
  const codexWtStart = await startTask(codexWt.task.id);
  expect("error" in codexWtStart).toBe(true);
  expect(runs.listForTask(codexWt.task.id)).toHaveLength(0);
});

test("buildCodexCommand in Isolated mode automatically enforces restricted readScope", async () => {
  const { buildCodexCommand } = await import("./agents.ts");
  const { harnesses } = await import("./db.ts");
  const harness = harnesses.getByIdOrKind("codex")!;
  const isoWork = path.join(root, "iso-cmd-work");
  mkdirSync(isoWork, { recursive: true, mode: 0o700 });

  await expect(
    buildCodexCommand(harness, "hi", { mode: "full-access", model: "gpt-6.1-sol", effort: "low", accessMode: "isolated" }, isoWork),
  ).rejects.toThrow(/Full access/);

  await expect(
    buildCodexCommand(harness, "hi", { mode: "auto", model: "gpt-6.1-sol", effort: "low", accessMode: "full-computer" }, isoWork),
  ).rejects.toThrow(/Full Computer/);

  const realCodex = Bun.which("codex");
  if (realCodex) {
    const canSandbox = Bun.spawnSync([realCodex, "sandbox", "--help"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    if (canSandbox) {
      const tempCodexHome = path.join(root, "disposable-codex-home");
      mkdirSync(tempCodexHome, { recursive: true, mode: 0o700 });
      const isolatedHarness = { ...harness, bin: realCodex, env: { CODEX_HOME: tempCodexHome } };
      delete process.env.FORGEORBIT_CODEX_READ_SCOPE;
      // Under /private/tmp (which Codex :minimal allows reading), buildCodexCommand in Isolated mode
      // detects the leaked read in its pre-launch self-test and fails closed instead of weakening.
      await expect(
        buildCodexCommand(
          isolatedHarness,
          "hi",
          { mode: "auto", model: "gpt-6.1-sol", effort: "low", accessMode: "isolated" },
          isoWork,
        ),
      ).rejects.toThrow(/did not hold in the pre-launch self-test|cannot fall back/);
    }
  }
});

test("Real child process under macOS Seatbelt enforces inside/outside canaries and loopback network denial", async () => {
  const { probeSeatbeltCapability } = await import("./launch-diagnostics.ts");
  const seatbelt = probeSeatbeltCapability();
  if (seatbelt !== "available") {
    // Nested sandbox or missing sandbox-exec: verify we report blocked honestly rather than pretending OS isolation passed.
    expect(["nested-blocked", "unavailable"]).toContain(seatbelt);
    return;
  }

  const boundary = await import("./macos-offline-boundary.ts");
  const { createBunProcessHost } = await import("./environment/process-host.ts");
  const fixtureWork = path.join(root, "real-child-staging");
  mkdirSync(fixtureWork, { recursive: true, mode: 0o700 });
  chmodSync(scratchDir, 0o700);
  writeFileSync(path.join(fixtureWork, "inside-canary.txt"), "INSIDE-CANARY-OK\n");
  writeFileSync(
    path.join(fixtureWork, "probe.ts"),
    `
import { readFileSync, writeFileSync } from "node:fs";
const out: Record<string, string> = {};
try { out.insideRead = readFileSync("./inside-canary.txt", "utf8").trim(); } catch (e) { out.insideRead = "err:" + (e as NodeJS.ErrnoException).code; }
try { writeFileSync("./inside-wrote.txt", "ok"); out.insideWrite = "ok"; } catch (e) { out.insideWrite = "err:" + (e as NodeJS.ErrnoException).code; }
try { out.outsideRead = readFileSync(${JSON.stringify(OUTSIDE_CANARY)}, "utf8").trim(); } catch (e) { out.outsideRead = "err:" + (e as NodeJS.ErrnoException).code; }
try { writeFileSync(${JSON.stringify(OUTSIDE_WRITE)}, "bad"); out.outsideWrite = "ok"; } catch (e) { out.outsideWrite = "err:" + (e as NodeJS.ErrnoException).code; }
try {
  const r = await fetch(${JSON.stringify(`http://127.0.0.1:${loopServer.port}/ping`)}, { signal: AbortSignal.timeout(1500) });
  out.net = "ok:" + r.status;
} catch {
  out.net = "err:blocked";
}
console.log("D21_CHILD=" + JSON.stringify(out));
`,
  );

  const runProbe = async (sandboxed: boolean) => {
    const chunks: string[] = [];
    const host = createBunProcessHost({ perlAvailable: false });
    const req = sandboxed
      ? boundary.offlineBoundaryRequest(
          boundary.createOfflineMacosBoundary({
            project: realpathSync(fixtureWork),
            scratch: realpathSync(scratchDir),
            role: "developer",
            executable: process.execPath,
          }),
          ["run", "./probe.ts"],
          "a".repeat(32),
          (_s, text) => chunks.push(text),
        )
      : {
          executable: process.execPath,
          args: ["run", "./probe.ts"],
          cwd: realpathSync(fixtureWork),
          processGroup: true,
          token: "b".repeat(32),
          onOutput: (_s: "stdout" | "stderr", text: string) => chunks.push(text),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homeDir },
        };
    const started = await host.start(req);
    if (!started.ok) throw new Error(started.detail);
    await started.process.exited;
    const match = chunks.join("").split("\n").find((l) => l.startsWith("D21_CHILD="));
    if (!match) throw new Error(`probe failed: ${chunks.join("")}`);
    return JSON.parse(match.slice("D21_CHILD=".length)) as Record<string, string>;
  };

  loopHits = 0;
  const confined = await runProbe(true);
  expect(confined.insideRead).toBe("INSIDE-CANARY-OK");
  expect(confined.insideWrite).toBe("ok");
  expect(confined.outsideRead).toMatch(/^err:(EPERM|EACCES)/);
  expect(confined.outsideWrite).toMatch(/^err:(EPERM|EACCES)/);
  expect(confined.net).toBe("err:blocked");
  expect(loopHits).toBe(0);
  expect(existsSync(OUTSIDE_WRITE)).toBe(false);

  // Contrasting baseline: unsandboxed child process (same UID as Workspace non-Codex harnesses)
  const unconfined = await runProbe(false);
  expect(unconfined.outsideRead).toBe("OUTSIDE-SECRET-CANARY-D21");
  expect(unconfined.net).toBe("ok:200");
  expect(loopHits).toBe(1);
});

test("Full Computer grants stay strictly separate from process trust and require per-action grants", async () => {
  const { NativeAgentGrantService, settleNativeAgentAction } = await import("./native-computer-agent.ts");
  const { Database } = await import("bun:sqlite");

  // OwnerTrust refuses privileged computer-use/browser/terminal process escalation
  const baseOp = {
    schema: OWNER_TRUST_SCHEMA,
    requestId: "req-1",
    kind: "single-operation",
    projectPath: repoDir,
    taskId: "t1",
    missionId: "m1",
    missionRevision: "rev-m1",
    harnessId: "codex",
    mode: "auto",
    workspace: repoDir,
    envelopeId: "env-1",
    policyRevision: "rev-1",
    envelopeDigest: "0".repeat(64),
    role: "developer",
    providerId: "codex",
    accountId: "acc-1",
    modelId: "gpt-6.1-sol",
    scope: "single:developer:codex:acc-1:gpt-6.1-sol",
    filesystem: "workspace-write",
    costCoverage: "unknown-subscription",
    knownCost: "unknown",
    taskStateDigest: "1".repeat(64),
    missionStateDigest: "2".repeat(64),
    runId: "run-1",
    attemptId: "att-1",
    terminalAllowed: false,
    browserAllowed: false,
    computerUseAllowed: true,
    gitRead: true,
    gitPublish: false,
    deploymentAllowed: false,
    externalProcess: false,
    cancellationAvailable: true,
    expiresAt: Date.now() + 60_000,
  };
  const rejected = parseOwnerOperation(baseOp);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.code).toBe("owner-privileged-excluded");

  // Native CU disposable fixture: no action runs without its own per-action grant
  const nativeDb = new Database(":memory:");
  nativeDb.exec(readFileSync(path.join(import.meta.dir, "migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(nativeDb, () => Date.now());
  const fakeApp = { pid: 99999, startSec: 1, startUsec: 1, bundleId: "com.forgeorbit.qa.disposable", appName: "DisposableFixture", executableName: "DisposableFixture" };
  let invoked = 0;
  const fakeManager = {
    async inspect() {
      return { id: "s1", status: "active" as const, application: fakeApp, window: { windowId: 7, title: "Disposable Window", role: "AXWindow", ownerPid: 99999, bounds: { x: 0, y: 0, width: 400, height: 300 } }, observationId: "obs-1", actionCount: 0, maxActions: 10, createdAt: Date.now(), lastActionAt: null, lastError: null, history: [] };
    },
    async press() {
      invoked += 1;
      throw new Error("should not run without grant");
    },
  } as unknown as Parameters<typeof settleNativeAgentAction>[1];

  const denied = await settleNativeAgentAction(grants, fakeManager, {
    target: { managerKind: "head-of-pm", projectPath: null },
    grantId: null,
    messageId: "m1",
    turnId: "t1",
    replyText: 'Click button.\n<native_action>{"kind":"press_accessible_button","elementId":"el_1"}</native_action>',
  });
  expect(denied.record?.status).toBe("ignored");
  expect(denied.record?.reasonCode).toBe("not_authorized");
  expect(invoked).toBe(0);
  nativeDb.close();
});
