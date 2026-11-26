import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * FO-003 interview runner and routes. Every agent here is the fake codex
 * driver (`AGETOR_CODEX_DRIVER=fake`) — no real CLI runs and no AI quota is
 * spent. Cursor points at a missing binary to exercise "not available".
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo003-interview-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4653";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let runner: typeof import("./project-interview.ts");
let fake: typeof import("./project-interview-fake.ts");
let isolationMod: typeof import("./interview-isolation.ts");
let codexConsent = "";

beforeAll(async () => {
  db = await import("./db.ts");
  runner = await import("./project-interview.ts");
  fake = await import("./project-interview-fake.ts");
  isolationMod = await import("./interview-isolation.ts");
  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  db.harnesses.setEnabled("codex", true);
  db.harnesses.setEnabled("cursor", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  expect(preflight.status).toBe(200);
  codexConsent = preflight.json.isolation.consentKey;
});

afterAll(() => {
  server?.stop?.();
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let counter = 0;
function interviewId(): string {
  counter += 1;
  return `test-interview-${counter}-${Date.now()}`;
}

function newProject(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "fo003-proj-")));
}

function turnBody(overrides: Record<string, unknown> = {}) {
  return {
    interviewId: interviewId(),
    harness: "codex",
    model: "gpt-6.1-sol",
    effort: "low",
    request: { kind: "question" },
    project: {
      path: "/tmp/fo003-not-created-yet",
      name: "Orbit Notes",
      description: "",
      mode: "create",
      empty: true,
      stack: "No stack detected",
      signals: [],
      targets: { idea: "docs/IDEA.md", prd: "docs/PRD.md" },
    },
    messages: [],
    drafts: {},
    consent: codexConsent,
    ...overrides,
  };
}

async function settle(turnId: string): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const { json } = await call("GET", `/project-interviews/turns/${turnId}`);
    if (json?.status && json.status !== "running") return json;
    await Bun.sleep(25);
  }
  throw new Error("turn never settled");
}

async function run(body: Record<string, unknown>): Promise<any> {
  const started = await call("POST", "/project-interviews/turns", body);
  expect(started.status).toBe(202);
  return settle(started.json.id);
}

test("every interview route requires the API token", async () => {
  const routes: [string, string][] = [
    ["POST", "/project-interviews/turns"],
    ["GET", "/project-interviews/turns/x"],
    ["DELETE", "/project-interviews/turns/x"],
    ["GET", "/project-interviews/draft?path=/tmp/x"],
    ["PUT", "/project-interviews/draft"],
    ["DELETE", "/project-interviews/draft?path=/tmp/x"],
    ["POST", "/project-interviews/check-docs"],
    ["POST", "/project-interviews/write-docs"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${base}${route}`, { method, body: method === "GET" ? undefined : "{}" });
    expect(res.status).toBe(401);
  }
});

describe("preflight", () => {
  test("refuses an unsupported harness with its reason", async () => {
    const res = await call("POST", "/project-interviews/turns", turnBody({ harness: "claude-code" }));
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("Interviews don't support it yet");
  });

  test("refuses an unknown harness", async () => {
    const res = await call("POST", "/project-interviews/turns", turnBody({ harness: "no-such-harness" }));
    expect(res.status).toBe(404);
  });

  test("refuses a disabled harness", async () => {
    db.harnesses.setEnabled("cursor", false);
    const res = await call("POST", "/project-interviews/turns", turnBody({ harness: "cursor" }));
    db.harnesses.setEnabled("cursor", true);
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("disabled");
  });

  test("refuses a harness whose CLI isn't installed", async () => {
    const res = await call("POST", "/project-interviews/turns", turnBody({ harness: "cursor", model: "auto" }));
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("not available");
  });

  test("refuses a logged-out harness with its login hint", async () => {
    const result = await runner.interviewPreflight("codex", null, null, {
      checkHarness: async () => ({
        harnessId: "codex",
        agent: "codex",
        available: true,
        path: "/bin/echo",
        version: null,
        reason: null,
        installHint: null,
        loggedIn: false,
        authHelp: "Run codex login",
      }) as never,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("isn't logged in — Run codex login");
  });

  test("a turn is refused until the isolation summary was confirmed", async () => {
    for (const consent of [null, "0000000000000000"]) {
      const res = await call("POST", "/project-interviews/turns", turnBody({ consent }));
      expect(res.status).toBe(428);
      expect(res.json.isolation.consentKey).toBe(codexConsent);
      expect(res.json.isolation.warnings.length).toBeGreaterThan(0);
    }
  });

  test("forces the restricted mode for the harness", async () => {
    const result = await runner.interviewPreflight("codex", null);
    expect(result.ok && result.mode).toBe("ask");
    expect(result.ok && result.effort).not.toBeNull();
  });

  test("rejects bodies without anything to draft or with unsafe targets", async () => {
    const both = turnBody();
    (both.project as any).targets = { idea: null, prd: "../PRD.md" };
    const res = await call("POST", "/project-interviews/turns", both);
    expect(res.status).toBe(400);
  });
});

describe("turns", () => {
  test("asks questions in sequence, then reports ready", async () => {
    const tasksBefore = db.tasks.list().length;
    const id = interviewId();
    const messages: any[] = [];
    const first = await run(turnBody({ interviewId: id }));
    expect(first.status).toBe("succeeded");
    expect(first.result.kind).toBe("question");
    expect(first.result.reply.text).toBe("What do you want to build, in one or two sentences?");
    expect(first.result.reply.notes.openQuestions).toEqual(["Pricing is not decided"]);
    messages.push({ id: "q1", role: "assistant", kind: "question", text: first.result.reply.text, at: 1 });
    messages.push({ id: "a1", role: "user", kind: "answer", text: "A shared notes app", at: 2 });

    const second = await run(turnBody({ interviewId: id, messages }));
    expect(second.result.reply.text).toContain("main users");
    messages.push({ id: "q2", role: "assistant", kind: "question", text: second.result.reply.text, at: 3 });
    messages.push({ id: "a2", role: "user", kind: "skip", text: "", at: 4 });

    const third = await run(turnBody({ interviewId: id, messages }));
    expect(third.result.reply.text).toContain("MVP");
    messages.push({ id: "q3", role: "assistant", kind: "question", text: third.result.reply.text, at: 5 });
    messages.push({ id: "a3", role: "user", kind: "answer", text: "Offline sync", at: 6 });

    const done = await run(turnBody({ interviewId: id, messages }));
    expect(done.result.reply.kind).toBe("ready");

    // No task, run or board entity was created for any of these turns.
    expect(db.tasks.list().length).toBe(tasksBefore);
    // The scratch folders are cleaned up after each turn.
    const scratch = path.join(db.dataDir, "interview-scratch");
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
  });

  test("drafts IDEA.md and PRD.md from the answers", async () => {
    const messages = [
      { id: "q1", role: "assistant", kind: "question", text: "What?", at: 1 },
      { id: "a1", role: "user", kind: "answer", text: "A shared notes app", at: 2 },
    ];
    const result = await run(turnBody({ request: { kind: "drafts" }, messages }));
    expect(result.status).toBe("succeeded");
    expect(result.result.reply.drafts.idea).toContain("# Orbit Notes");
    expect(result.result.reply.drafts.idea).toContain("A shared notes app");
    expect(result.result.reply.drafts.prd).toContain("FR-1");
  });

  test("drafts only the missing document", async () => {
    const body = turnBody({ request: { kind: "drafts" } });
    (body.project as any).targets = { idea: null, prd: "docs/PRD.md" };
    (body.project as any).ideaPath = "docs/IDEA.md";
    const result = await run(body);
    expect(result.result.reply.drafts.idea).toBeNull();
    expect(result.result.reply.drafts.prd).toContain("PRD");
  });

  test("revises one section", async () => {
    const result = await run(turnBody({
      request: { kind: "section", doc: "prd", heading: "Goals", instruction: "Be specific" },
      drafts: { prd: "# PRD\n\n## Goals\nShip\n" },
    }));
    expect(result.result.reply.markdown).toContain("## Goals");
    expect(result.result.reply.markdown).toContain("Be specific");
  });

  test("reports a CLI error", async () => {
    const result = await run(turnBody({
      messages: [{ id: "a", role: "user", kind: "answer", text: fake.FAKE_INTERVIEW_FAIL_MARKER, at: 1 }],
    }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("CLI exited with an error");
  });

  test("redacts credentials in CLI errors", async () => {
    const result = await run(turnBody({
      messages: [{ id: "a", role: "user", kind: "answer", text: fake.FAKE_INTERVIEW_SECRET_ERROR_MARKER, at: 1 }],
    }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain("fakeSECRET");
  });

  test("reports a reply without the protocol", async () => {
    const result = await run(turnBody({
      messages: [{ id: "a", role: "user", kind: "answer", text: fake.FAKE_INTERVIEW_GARBAGE_MARKER, at: 1 }],
    }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not contain a question");
  });

  test("one turn at a time, and cancel stops it", async () => {
    const id = interviewId();
    const slow = turnBody({
      interviewId: id,
      messages: [{ id: "a", role: "user", kind: "answer", text: fake.FAKE_INTERVIEW_SLOW_MARKER, at: 1 }],
    });
    const started = await call("POST", "/project-interviews/turns", slow);
    expect(started.status).toBe(202);
    const second = await call("POST", "/project-interviews/turns", turnBody({ interviewId: id }));
    expect(second.status).toBe(409);
    const cancelled = await call("DELETE", `/project-interviews/turns/${started.json.id}`);
    expect(cancelled.status).toBe(200);
    const result = await settle(started.json.id);
    expect(result.status).toBe("cancelled");
    // The interview can continue after a cancel.
    const next = await run(turnBody({ interviewId: id }));
    expect(next.status).toBe("succeeded");
  });

  test("unknown turns are 404", async () => {
    expect((await call("GET", "/project-interviews/turns/nope")).status).toBe(404);
    expect((await call("DELETE", "/project-interviews/turns/nope")).status).toBe(404);
  });

  test("a turn reads nothing into and writes nothing to an existing project", async () => {
    const dir = newProject();
    writeFileSync(path.join(dir, "README.md"), "# Readme\n");
    const before = readdirSync(dir).sort();
    const body = turnBody();
    (body.project as any).path = dir;
    (body.project as any).mode = "import";
    (body.project as any).empty = false;
    (body.project as any).readmePath = "README.md";
    const result = await run(body);
    expect(result.status).toBe("succeeded");
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe("excerpts", () => {
  test("reads selected markdown, redacts secrets, and skips secrets and escapes", () => {
    const dir = newProject();
    const outside = newProject();
    writeFileSync(path.join(dir, "README.md"), "# App\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    writeFileSync(path.join(outside, "secret.md"), "# Outside\n");
    mkdirSync(path.join(dir, "docs"));
    symlinkSync(path.join(outside, "secret.md"), path.join(dir, "docs", "IDEA.md"));
    const excerpts = runner.readInterviewExcerpts(dir, { readmePath: "README.md", ideaPath: "docs/IDEA.md", prdPath: ".env" });
    expect(excerpts.map((item) => item.path)).toEqual(["README.md"]);
    expect(excerpts[0]!.text).toContain("API_KEY=[redacted]");
    expect(runner.readInterviewExcerpts("/nonexistent/fo003", { readmePath: "README.md", ideaPath: null, prdPath: null })).toEqual([]);
  });

  test("a README path outside the known names is not read", () => {
    const dir = newProject();
    writeFileSync(path.join(dir, "NOTES.md"), "# Notes\n");
    expect(runner.readInterviewExcerpts(dir, { readmePath: "NOTES.md", ideaPath: null, prdPath: null })).toEqual([]);
  });
});

describe("draft persistence", () => {
  test("save, load, and delete a draft outside the project", async () => {
    const projectPath = "/tmp/fo003-draft-project";
    const state = {
      version: 1,
      projectPath,
      targets: { idea: "docs/IDEA.md", prd: null },
      agent: { harness: "codex", model: "gpt-6.1-sol", effort: "low", profileId: null },
      messages: [{ id: "q1", role: "assistant", kind: "question", text: "What?", at: 1 }],
      notes: { assumptions: [], openQuestions: [] },
      drafts: { idea: "# Idea", prd: null },
      accepted: false,
      updatedAt: 1,
    };
    expect((await call("PUT", "/project-interviews/draft", { state })).status).toBe(200);
    const loaded = await call("GET", `/project-interviews/draft?path=${encodeURIComponent(projectPath)}`);
    expect(loaded.json.state).toEqual(state);
    expect(existsSync(projectPath)).toBe(false);
    expect((await call("DELETE", `/project-interviews/draft?path=${encodeURIComponent(projectPath)}`)).json.deleted).toBe(true);
    expect((await call("GET", `/project-interviews/draft?path=${encodeURIComponent(projectPath)}`)).json.state).toBeNull();
    expect((await call("PUT", "/project-interviews/draft", { state: { version: 9 } })).status).toBe(400);
  });
});

describe("isolation probes (scripted CLI, no model)", () => {
  type Script = Record<string, { code?: number; stdout: string }>;
  function runner(script: Script, seen: string[][] = []) {
    return async (argv: string[]) => {
      seen.push(argv);
      const key = argv.slice(1).filter((arg) => !arg.startsWith("-") && !arg.includes("=")).join(" ");
      const hit = script[key];
      return hit ? { code: hit.code ?? 0, stdout: hit.stdout } : { code: 1, stdout: "" };
    };
  }
  const harness = (kind: string) => ({ id: kind, kind, label: kind, home: null, enabled: true } as never);
  const features = (on: Record<string, boolean>) =>
    Object.entries(on).map(([name, value]) => `${name.padEnd(30)} stable  ${value}`).join("\n");

  test("codex: disables known tools and every MCP server, and verifies it", async () => {
    const seen: string[][] = [];
    const before = features({ shell_tool: true, unified_exec: true, apps: true, plugins: true, browser_use: true, computer_use: true, hooks: true });
    let call = 0;
    const run = async (argv: string[]) => {
      seen.push(argv);
      call += 1;
      if (argv.includes("features")) {
        // First listing: everything on. Verification: on except unified_exec.
        return { code: 0, stdout: call === 1 ? before : features({ shell_tool: false, unified_exec: true, apps: false, plugins: false, browser_use: false, computer_use: false, hooks: false }) };
      }
      const disabled = argv.some((arg) => arg === "mcp_servers.node_repl.enabled=false");
      return { code: 0, stdout: JSON.stringify([{ name: "node_repl", enabled: !disabled }, { name: "off", enabled: false }]) };
    };
    const prev = process.env.AGETOR_CODEX_DRIVER;
    delete process.env.AGETOR_CODEX_DRIVER;
    try {
      const result = await isolationMod.resolveInterviewIsolation(harness("codex"), { run, noCache: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const args = result.isolation.args;
      expect(args[0]).toBe("--ephemeral");
      expect(args).toContain('web_search="disabled"');
      for (const name of ["shell_tool", "apps", "plugins", "browser_use", "computer_use", "hooks"]) {
        expect(args.join(" ")).toContain(`--disable ${name}`);
      }
      expect(args).toContain("mcp_servers.node_repl.enabled=false");
      expect(args).not.toContain("mcp_servers.off.enabled=false");
      expect(result.isolation.writes).toContain("read-only");
      expect(result.isolation.warnings.join(" ")).toContain("unified_exec on");
    } finally {
      process.env.AGETOR_CODEX_DRIVER = prev;
    }
  });

  test("codex: refuses when the shell stays on or an MCP server stays enabled", async () => {
    const prev = process.env.AGETOR_CODEX_DRIVER;
    delete process.env.AGETOR_CODEX_DRIVER;
    try {
      const shellOn = async (argv: string[]) => argv.includes("features")
        ? { code: 0, stdout: features({ shell_tool: true }) }
        : { code: 0, stdout: "[]" };
      const a = await isolationMod.resolveInterviewIsolation(harness("codex"), { run: shellOn, noCache: true });
      expect(!a.ok && a.error).toContain("shell_tool stayed on");

      const mcpOn = async (argv: string[]) => argv.includes("features")
        ? { code: 0, stdout: features({ shell_tool: false }) }
        : { code: 0, stdout: JSON.stringify([{ name: "stubborn", enabled: true }]) };
      const b = await isolationMod.resolveInterviewIsolation(harness("codex"), { run: mcpOn, noCache: true });
      expect(!b.ok && b.error).toContain("MCP servers stayed enabled: stubborn");

      const weird = async (argv: string[]) => argv.includes("features")
        ? { code: 0, stdout: features({ shell_tool: false }) }
        : { code: 0, stdout: JSON.stringify([{ name: "a.b", enabled: true }]) };
      const c = await isolationMod.resolveInterviewIsolation(harness("codex"), { run: weird, noCache: true });
      expect(!c.ok && c.error).toContain("can't be disabled");

      const silent = await isolationMod.resolveInterviewIsolation(harness("codex"), { run: runner({}), noCache: true });
      expect(silent.ok).toBe(false);
    } finally {
      process.env.AGETOR_CODEX_DRIVER = prev;
    }
  });

  test("cursor: ask mode and sandbox, never --force; refused without ask mode", async () => {
    const ok = await isolationMod.resolveInterviewIsolation(harness("cursor"), {
      run: runner({ "": { stdout: "--mode <mode> plan ask --sandbox <mode> --trust --force" } }),
      noCache: true,
    });
    expect(ok.ok && ok.isolation.args).toEqual(["--mode", "ask", "--sandbox", "enabled", "--trust"]);
    expect(ok.ok && ok.isolation.args).not.toContain("--force");
    expect(ok.ok && ok.isolation.writes).toContain("macOS kernel sandbox");
    const old = await isolationMod.resolveInterviewIsolation(harness("cursor"), {
      run: runner({ "": { stdout: "--force only" } }),
      noCache: true,
    });
    expect(old.ok).toBe(false);
  });

  test("antigravity: lists the MCP servers it can't turn off, and the consent key follows them", async () => {
    const help = { stdout: "--sandbox --mode --disable-slash-commands" };
    const one = await isolationMod.resolveInterviewIsolation(harness("antigravity"), {
      run: runner({ "": help, "mcp list": { stdout: "NAME TYPE STATUS COMMAND\npencil stdio enabled /x\nold stdio disabled /y" } }),
      noCache: true,
    });
    expect(one.ok && one.isolation.args).toEqual(["--sandbox", "--disable-slash-commands"]);
    expect(one.ok && one.isolation.warnings[0]).toContain("enabled and available");
    expect(one.ok && one.isolation.warnings[0]).toContain("pencil");
    expect(one.ok && one.isolation.warnings[0]).not.toMatch(/\bdisabled\b|\bisolated\b/i);
    const liveHeader = await isolationMod.resolveInterviewIsolation(harness("antigravity"), {
      run: runner({
        "": help,
        "mcp list": {
          stdout: "NAME    TYPE   STATUS   COMMAND/URL\npencil  stdio  enabled  /Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64 --app desktop\nold stdio disabled /y\n",
        },
      }),
      noCache: true,
    });
    expect(liveHeader.ok && liveHeader.isolation.warnings[0]).toContain("pencil");
    expect(liveHeader.ok && liveHeader.isolation.warnings[0]).toContain("enabled and available");
    expect(liveHeader.ok && liveHeader.isolation.warnings[0]).not.toMatch(/\bdisabled\b|\bisolated\b/);
    const two = await isolationMod.resolveInterviewIsolation(harness("antigravity"), {
      run: runner({ "": help, "mcp list": { stdout: "NAME TYPE STATUS COMMAND\npencil stdio enabled /x\nnew stdio enabled /z" } }),
      noCache: true,
    });
    expect(one.ok && two.ok && one.isolation.consentKey).not.toBe(two.ok && two.isolation.consentKey);
  });
});

describe("process lifecycle", () => {
  test("the boot sweep kills a leftover turn's session by exact name and clears its files", async () => {
    const compact = "0123456789abcdef0123456789abcdef";
    const scratch = path.join(db.dataDir, "interview-scratch", compact);
    mkdirSync(scratch, { recursive: true });
    mkdirSync(path.join(db.dataDir, "codex-logs"), { recursive: true });
    writeFileSync(path.join(db.dataDir, "codex-logs", `interview-${compact}.prompt.txt`), "prompt");
    mkdirSync(path.join(db.dataDir, "interview-scratch", "not-ours"), { recursive: true });
    mkdirSync(path.join(db.dataDir, "cursor-logs"), { recursive: true });
    const lateExit = path.join(db.dataDir, "cursor-logs", "interview-fedcba9876543210fedcba9876543210.exit");
    const taskLog = path.join(db.dataDir, "cursor-logs", "11111111-2222-3333-4444-555555555555.exit");
    writeFileSync(lateExit, "0\n");
    writeFileSync(taskLog, "0\n");
    const killed: string[] = [];
    const swept = await runner.sweepInterviewLeftovers({ kill: async (name) => { killed.push(name); } });
    expect(swept).toBe(1);
    expect(killed).toEqual(["agetor-iv-012345678"]);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(path.join(db.dataDir, "codex-logs", `interview-${compact}.prompt.txt`))).toBe(false);
    expect(existsSync(path.join(db.dataDir, "interview-scratch", "not-ours"))).toBe(true);
    expect(existsSync(lateExit)).toBe(false);
    // A task's run file is never touched.
    expect(existsSync(taskLog)).toBe(true);
  });

  test("shutdown stops every running turn", async () => {
    const started = await call("POST", "/project-interviews/turns", turnBody({
      messages: [{ id: "a", role: "user", kind: "answer", text: fake.FAKE_INTERVIEW_SLOW_MARKER, at: 1 }],
    }));
    expect(started.status).toBe(202);
    expect(runner.stopInterviewTurnsSync()).toBeGreaterThanOrEqual(1);
    runner.cancelInterviewTurn(started.json.id);
    expect((await settle(started.json.id)).status).toBe("cancelled");
  });
});
