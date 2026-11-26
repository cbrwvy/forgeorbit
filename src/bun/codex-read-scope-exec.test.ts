import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// End-to-end through the REAL `codex exec` binary and the REAL ForgeOrbit launch
// argv, with a local mock instead of a model: the "model" issues one shell tool
// call and the test reads what that command could and could not do. No provider
// is contacted and no credential is read. Directories sit under the home folder
// (not /tmp, which the profile denies).
const BASE = mkdtempSync(path.join(homedir(), ".forgeorbit-read-scope-exec-"));
const DATA_DIR = path.join(BASE, "data");
mkdirSync(DATA_DIR);
process.env.AGETOR_DATA_DIR = DATA_DIR;

const codexOk = (() => {
  const bin = Bun.which("codex");
  if (!bin) return false;
  return Bun.spawnSync([bin, "sandbox", "--help"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
})();
const live = codexOk ? test : test.skip;

const HOME_CANARY = path.join(homedir(), `.forgeorbit-exec-home-canary-${process.pid}`);
const TMP_CANARY = `/private/tmp/forgeorbit-exec-tmp-canary-${process.pid}`;

let pingHits = 0;
let probe = "";
let toolOutput = "";
let toolNames: string[] = [];
let server: ReturnType<typeof Bun.serve>;

const sse = (events: Array<{ type: string } & Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/ping") { pingHits += 1; return new Response("pong"); }
      if (req.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("{}", { status: 404 });
      const body = await req.json() as { input?: Array<Record<string, unknown>>; tools?: Array<{ name?: string; type?: string }> };
      const outputs = (body.input ?? []).filter((item) => item.type === "function_call_output");
      if (outputs.length === 0) toolNames = (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? "?");
      const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
      if (outputs.length > 0) {
        const last = outputs.at(-1)!.output;
        toolOutput = typeof last === "string" ? last : JSON.stringify(last);
        return new Response(sse([
          { type: "response.created", response: { id: "r2" } },
          { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "probe finished" }] } },
          { type: "response.completed", response: { id: "r2", usage } },
        ]), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: probe, yield_time_ms: 20000 }) } },
        { type: "response.completed", response: { id: "r1", usage } },
      ]), { headers: { "content-type": "text/event-stream" } });
    },
  });
  writeFileSync(HOME_CANARY, "SECRET-HOME-CANARY");
  writeFileSync(TMP_CANARY, "SECRET-TMP-CANARY");
});

afterAll(() => {
  server?.stop(true);
  rmSync(BASE, { recursive: true, force: true });
  rmSync(HOME_CANARY, { force: true });
  rmSync(TMP_CANARY, { force: true });
});

function write(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const probeScript = (cwd: string, paths: Record<string, string>) => [
  `cd ${JSON.stringify(cwd)}`,
  `echo "CWD_READ=$(cat ./probe-file.txt 2>/dev/null || echo denied)"`,
  `if (echo w > ./written-by-tool.txt) 2>/dev/null; then echo CWD_WRITE=ok; else echo CWD_WRITE=denied; fi`,
  ...Object.entries(paths).map(([name, file]) => `echo "${name}=$(cat ${JSON.stringify(file)} 2>/dev/null || echo denied)"`),
  `if (echo w > ${JSON.stringify(path.join(DATA_DIR, "written-outside.txt"))}) 2>/dev/null; then echo WRITE_DATA_DIR=ok; else echo WRITE_DATA_DIR=denied; fi`,
  `if (echo w > ${JSON.stringify(`/private/tmp/forgeorbit-exec-tmp-write-${process.pid}`)}) 2>/dev/null; then echo WRITE_TMP=ok; else echo WRITE_TMP=denied; fi`,
  `curl -s --max-time 3 http://127.0.0.1:${server.port}/ping >/dev/null 2>&1; echo "NET_EXIT=$?"`,
  `echo "BUN=$(bun --version 2>/dev/null || echo denied)"`,
].join("\n");

async function runRole(role: "developer" | "reviewer" | "head") {
  const mode = role === "developer" ? "auto" : "ask";
  const home = path.join(BASE, `codex-home-${role}`);
  write(path.join(home, "config.toml"), [
    "model_provider = \"mock\"",
    "[model_providers.mock]",
    "name = \"mock\"",
    `base_url = "http://127.0.0.1:${server.port}/v1"`,
    "env_key = \"MOCK_KEY\"",
    "wire_api = \"responses\"",
    "",
  ].join("\n"));
  write(path.join(home, "auth.json"), "{\"SECRET\":\"FAKE-LAUNCHER-AUTH\"}");
  const cwd = role === "developer"
    ? path.join(DATA_DIR, "task-workspaces", "t1", "w1", "root")
    : role === "reviewer" ? path.join(DATA_DIR, "worktrees", "t1") : path.join(DATA_DIR, "interview-scratch", "iv1");
  write(path.join(cwd, "probe-file.txt"), "cwd-content");
  const canaries = {
    DATA_TOKEN: write(path.join(DATA_DIR, "agetor-core.json"), "SECRET-API-TOKEN"),
    DATA_DB: write(path.join(DATA_DIR, "agetor-db-canary.bin"), "SECRET-DB"),
    LAUNCHER_AUTH: path.join(home, "auth.json"),
    OTHER_PROJECT: write(path.join(BASE, "other-project", "secret.txt"), "SECRET-OTHER-PROJECT"),
    HOME_CANARY,
    TMP_CANARY,
  };
  probe = probeScript(cwd, canaries);
  toolOutput = "";
  pingHits = 0;

  const { buildCodexCommand } = await import("./agents.ts");
  const harness = { id: "codex-exec-probe", kind: "codex" as const, label: "probe", isBuiltin: false, home: null, bin: null, env: { CODEX_HOME: home }, enabled: true, createdAt: 0, updatedAt: 0 };
  let lockdownArgs: string[] | undefined;
  if (role === "head") {
    const { resolveInterviewIsolation } = await import("./interview-isolation.ts");
    const isolation = await resolveInterviewIsolation(harness as never, { noCache: true });
    if (!isolation.ok) throw new Error(isolation.error);
    lockdownArgs = isolation.isolation.args;
  }
  process.env.FORGEORBIT_CODEX_READ_SCOPE = "restricted";
  let built;
  try {
    built = await buildCodexCommand(harness as never, "probe", { model: "mock-model", effort: "low", mode, lockdownArgs }, cwd);
  } finally { delete process.env.FORGEORBIT_CODEX_READ_SCOPE; }

  const proc = Bun.spawn(built.cmd, {
    cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...(built.env ?? {}), CODEX_HOME: home, MOCK_KEY: "mock-key" },
  });
  proc.stdin.write("run the probe");
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 90_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const values = Object.fromEntries(toolOutput.split("\n").map((line) => /^([A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map((m) => [m![1]!, m![2]!]));
  return { cmd: built.cmd, exitCode, stdout, stderr, toolOutput, values, toolNames: [...toolNames] };
}

const ALL_DENIED = ["DATA_TOKEN", "DATA_DB", "LAUNCHER_AUTH", "OTHER_PROJECT", "HOME_CANARY", "TMP_CANARY"];
function expectBoundary(result: Awaited<ReturnType<typeof runRole>>) {
  expect(result.exitCode, `${result.stderr.slice(0, 600)}\n${result.stdout.slice(0, 600)}`).toBe(0);
  expect(result.toolOutput).not.toBe("");
  for (const name of ALL_DENIED) expect(result.values[name], `${name} :: ${result.toolOutput.slice(0, 500)}`).toBe("denied");
  expect(result.values.WRITE_DATA_DIR).toBe("denied");
  expect(result.values.WRITE_TMP).toBe("denied");
  expect(result.values.CWD_READ).toBe("cwd-content");
  expect(result.values.NET_EXIT).not.toBe("0");
  expect(pingHits).toBe(0);
  for (const secret of ["SECRET-API-TOKEN", "SECRET-DB", "FAKE-LAUNCHER-AUTH", "SECRET-OTHER-PROJECT", "SECRET-HOME-CANARY", "SECRET-TMP-CANARY"]) {
    expect(result.toolOutput).not.toContain(secret);
  }
  expect(result.cmd).not.toContain("--sandbox");
  expect(result.cmd.join(" ")).toContain("default_permissions=");
}

live("Developer: writes only its staging directory; nothing else is readable or writable", async () => {
  const result = await runRole("developer");
  expectBoundary(result);
  expect(result.values.CWD_WRITE).toBe("ok");
  expect(result.values.BUN).not.toBe("denied");
}, 150_000);

live("Reviewer: reads only its worktree and writes nothing", async () => {
  const result = await runRole("reviewer");
  expectBoundary(result);
  expect(result.values.CWD_WRITE).toBe("denied");
}, 150_000);

live("Head: the real isolated-turn flags plus the profile; reads only its scratch directory", async () => {
  const result = await runRole("head");
  // The Head is offered no command tool at all with the isolated-turn flags.
  expect(result.exitCode).toBe(0);
  expect(result.toolNames).not.toContain("exec_command");
  expect(result.toolNames).not.toContain("shell");
  expect(result.toolNames).not.toContain("shell_command");
  expect(result.toolOutput).toContain("unsupported call");
  expect(result.toolOutput).not.toContain("SECRET");
  expect(result.cmd).toContain("--ephemeral");
  expect(result.cmd).not.toContain("--sandbox");
  expect(result.cmd.join(" ")).toContain("default_permissions=");
}, 150_000);
