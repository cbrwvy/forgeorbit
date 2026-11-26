import { test, expect, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures AGETOR_DATA_DIR at first import. Set it before any dynamic
// import, and never point this file at the user's data dir.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-quit-release-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;

const LOG = path.join(DATA_DIR, "tmux-argv.log");
const TMUX_STUB = path.join(DATA_DIR, "tmux-stub.sh");
writeFileSync(
  TMUX_STUB,
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(LOG)}\nexit 0\n`,
);
chmodSync(TMUX_STUB, 0o755);

const HAVE_TMUX = (() => {
  try {
    return Bun.spawnSync(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
})();

const FOREIGN_SOCKET = "fo-lc01-foreign";

afterAll(() => {
  // Only the sessions this file created, by exact name, on the two sockets
  // it used. Never kill-server, and never the default socket.
  if (!HAVE_TMUX) return;
  for (const [socket, name] of ownedNames) {
    Bun.spawnSync(["tmux", "-L", socket, "kill-session", "-t", `=${name}`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  }
});

const ownedNames: Array<[socket: string, name: string]> = [];

function remember(socket: string, name: string) {
  ownedNames.push([socket, name]);
}

async function seedTask(opts: {
  agent: "claude-code" | "codex" | "fx";
  column: "ready" | "running" | "review";
  status: "succeeded" | "failed" | "cancelled" | "running";
  exitCode: number | null;
  claudeSessionId: string | null;
  title: string;
}) {
  const { tasks, runs } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  const id = randomUUID();
  const runId = randomUUID();
  const now = Date.now();
  const workdir = mkdtempSync(path.join(tmpdir(), "agetor-quit-wd-"));
  const sessionName = sessionNameFor(id);
  tasks.insert({
    id,
    title: opts.title,
    prompt: "p",
    column: opts.column,
    agent: opts.agent,
    workdir,
    isolation: "none",
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    mode: null,
    model: opts.agent === "claude-code" ? "claude-haiku-4-5" : null,
    effort: null,
    fast: false,
    maxMode: false,
    references: [],
    backlog: [],
    plans: [],
    draft: null,
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  runs.insert({
    id: runId,
    taskId: id,
    agent: opts.agent,
    status: opts.status,
    startedAt: now,
    endedAt: opts.status === "running" ? null : now,
    exitCode: opts.exitCode,
    tmuxSession: sessionName,
    claudeSessionId: opts.claudeSessionId,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: opts.agent === "fx" ? "fx-session" : null,
  });
  runs.appendEvent(runId, "user", `keep-turn ${opts.title}`);
  const { db } = await import("./db.ts");
  db.run(
    `INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, task_id, run_id, idempotency_key, created_at)
     VALUES (?, 'run.completed', 'system', 'task', ?, ?, ?, ?, ?)`,
    [randomUUID(), id, id, runId, `quit-release:${runId}`, now],
  );
  return { id, runId, sessionName };
}

function killLines(): string[] {
  let text = "";
  try {
    text = readFileSync(LOG, "utf8");
  } catch {
    text = "";
  }
  return text.split("\n").filter((line) => line.includes("kill-session"));
}

test("quit releases settled owned sessions and keeps live ones", async () => {
  writeFileSync(LOG, "");
  const savedBin = process.env.AGETOR_TMUX_BIN;
  process.env.AGETOR_TMUX_BIN = TMUX_STUB;
  const { releaseSettledSessionsSync } = await import("./orchestrator.ts");
  const { runs, db } = await import("./db.ts");
  const { registerTmuxPrompt, cancelPendingForTask } = await import("./interactions.ts");
  const { subagents } = await import("./db.ts");

  const succeeded = await seedTask({
    agent: "claude-code",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: "claude-session-succeeded",
    title: "succeeded",
  });
  const failed = await seedTask({
    agent: "claude-code",
    column: "ready",
    status: "failed",
    exitCode: 1,
    claudeSessionId: "claude-session-failed",
    title: "failed",
  });
  const cancelled = await seedTask({
    agent: "claude-code",
    column: "ready",
    status: "cancelled",
    exitCode: null,
    claudeSessionId: "claude-session-cancelled",
    title: "cancelled",
  });
  const running = await seedTask({
    agent: "claude-code",
    column: "running",
    status: "running",
    exitCode: null,
    claudeSessionId: "claude-session-running",
    title: "running",
  });
  const pending = await seedTask({
    agent: "claude-code",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: "claude-session-pending",
    title: "pending",
  });
  const held = await seedTask({
    agent: "claude-code",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: "claude-session-held",
    title: "held",
  });
  const codex = await seedTask({
    agent: "codex",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: null,
    title: "codex",
  });
  const fx = await seedTask({
    agent: "fx",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: null,
    title: "fx",
  });

  registerTmuxPrompt({
    taskId: pending.id,
    runId: pending.runId,
    paneText: "Allow?",
    choices: [{ key: "1", label: "Yes" }],
    fingerprint: "quit-release-pending",
  });
  subagents.insertIfAbsent({
    id: `sub-${held.id}`,
    taskId: held.id,
    runId: held.runId,
    parentKind: "subagent",
    agentType: "Explore",
    description: "still going",
    spawnDepth: 1,
    sourcePath: path.join(DATA_DIR, "sub.jsonl"),
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
  });

  const runsBefore = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n;
  const journalBefore = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events`).get()!.n;

  try {
    const first = releaseSettledSessionsSync();
    const lines = killLines();
    const killedNames = lines.map((line) => line.match(/-t =(\S+)/)?.[1]).filter(Boolean);

    expect(lines.every((line) => line.startsWith("-L agetor-test "))).toBe(true);
    expect(lines.some((line) => line.includes("kill-server"))).toBe(false);
    expect(killedNames).toContain(succeeded.sessionName);
    expect(killedNames).toContain(failed.sessionName);
    expect(killedNames).toContain(cancelled.sessionName);
    expect(killedNames).toContain(codex.sessionName);
    expect(killedNames).not.toContain(running.sessionName);
    expect(killedNames).not.toContain(pending.sessionName);
    expect(killedNames).not.toContain(held.sessionName);
    expect(killedNames).not.toContain(fx.sessionName);
    expect(first.released).toContain(succeeded.id);
    expect(first.released).not.toContain(running.id);

    for (const row of [succeeded, failed, cancelled]) {
      const events = runs.events(row.runId);
      expect(events.some((e) => e.stream === "user" && e.data.startsWith("keep-turn"))).toBe(true);
      expect(events.filter((e) => e.data.startsWith("session released on quit"))).toHaveLength(1);
      expect(events.some((e) => e.data === "session released on quit — next message will resume it")).toBe(true);
    }
    expect(runs.events(codex.runId).some((e) => e.data.includes("session released on quit"))).toBe(false);
    expect(runs.events(running.runId).some((e) => e.data.includes("session released on quit"))).toBe(false);

    const succeededRun = runs.get(succeeded.runId);
    expect(succeededRun?.status).toBe("succeeded");
    expect(succeededRun?.exitCode).toBe(0);
    expect(runs.get(failed.runId)?.status).toBe("failed");
    expect(runs.get(cancelled.runId)?.status).toBe("cancelled");
    expect(runs.get(running.runId)?.status).toBe("running");

    releaseSettledSessionsSync();
    for (const row of [succeeded, failed, cancelled]) {
      expect(runs.events(row.runId).filter((e) => e.data.startsWith("session released on quit"))).toHaveLength(1);
    }

    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n).toBe(runsBefore);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events`).get()!.n).toBe(journalBefore);
    expect(killLines().every((line) => line.includes("-L agetor-test") && !line.includes("kill-server"))).toBe(true);
    expect(killLines().some((line) => line.includes("new-session"))).toBe(false);
  } finally {
    cancelPendingForTask(pending.id, "test cleanup");
    if (savedBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = savedBin;
  }
});

test.skipIf(!HAVE_TMUX)("real tmux: settled sessions die, a foreign socket and an unrelated name stay", async () => {
  const savedBin = process.env.AGETOR_TMUX_BIN;
  const savedSocket = process.env.AGETOR_TMUX_SOCKET;
  delete process.env.AGETOR_TMUX_BIN;
  delete process.env.AGETOR_TMUX_SOCKET;
  const { releaseSettledSessionsSync, reconcileOrphans } = await import("./orchestrator.ts");
  const { tmuxSocketArgs } = await import("./tmux-resolution.ts");
  const { runs, db } = await import("./db.ts");

  const succeeded = await seedTask({
    agent: "claude-code",
    column: "review",
    status: "succeeded",
    exitCode: 0,
    claudeSessionId: "real-claude-session",
    title: "real-succeeded",
  });
  const failed = await seedTask({
    agent: "claude-code",
    column: "ready",
    status: "failed",
    exitCode: 1,
    claudeSessionId: "real-claude-failed",
    title: "real-failed",
  });
  const cancelled = await seedTask({
    agent: "claude-code",
    column: "ready",
    status: "cancelled",
    exitCode: null,
    claudeSessionId: "real-claude-cancelled",
    title: "real-cancelled",
  });
  const running = await seedTask({
    agent: "claude-code",
    column: "running",
    status: "running",
    exitCode: null,
    claudeSessionId: "real-claude-running",
    title: "real-running",
  });
  const stranger = `agetor-stranger01`;
  const socket = tmuxSocketArgs();
  expect(socket).toEqual(["-L", "agetor-test"]);

  function start(sock: string, name: string) {
    remember(sock, name);
    const created = Bun.spawnSync(
      ["tmux", "-L", sock, "new-session", "-d", "-s", name, "--", "sleep", "120"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    expect(created.exitCode).toBe(0);
  }
  function alive(sock: string, name: string): boolean {
    return Bun.spawnSync(
      ["tmux", "-L", sock, "has-session", "-t", `=${name}`],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    ).exitCode === 0;
  }

  start("agetor-test", succeeded.sessionName);
  start("agetor-test", failed.sessionName);
  start("agetor-test", cancelled.sessionName);
  start("agetor-test", running.sessionName);
  start("agetor-test", stranger);
  start(FOREIGN_SOCKET, succeeded.sessionName);

  const runsBefore = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n;
  const journalBefore = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events WHERE event_type = 'run.completed'`).get()!.n;

  try {
    releaseSettledSessionsSync();
    expect(alive("agetor-test", succeeded.sessionName)).toBe(false);
    expect(alive("agetor-test", failed.sessionName)).toBe(false);
    expect(alive("agetor-test", cancelled.sessionName)).toBe(false);
    expect(alive("agetor-test", running.sessionName)).toBe(true);
    expect(alive("agetor-test", stranger)).toBe(true);
    expect(alive(FOREIGN_SOCKET, succeeded.sessionName)).toBe(true);

    expect(runs.get(succeeded.runId)?.status).toBe("succeeded");
    expect(runs.get(succeeded.runId)?.exitCode).toBe(0);
    expect(runs.get(failed.runId)?.status).toBe("failed");
    expect(runs.get(cancelled.runId)?.status).toBe("cancelled");
    expect(runs.get(running.runId)?.status).toBe("running");
    expect(runs.events(succeeded.runId).some((e) => e.data.startsWith("keep-turn"))).toBe(true);
    expect(runs.events(succeeded.runId).filter((e) => e.data.startsWith("session released on quit"))).toHaveLength(1);

    releaseSettledSessionsSync();
    expect(runs.events(succeeded.runId).filter((e) => e.data.startsWith("session released on quit"))).toHaveLength(1);
    expect(alive("agetor-test", running.sessionName)).toBe(true);
    expect(alive(FOREIGN_SOCKET, succeeded.sessionName)).toBe(true);

    // Quit already decided this in-flight session stays. Boot reconciliation
    // reattaches a `running` row, and with no JSONL it would kill that pane
    // (existing missing-transcript path). Mark the row settled first so this
    // restart check is the completed-run case: no new run, no second pass
    // over a foreign socket, and the pane quit chose to keep is still there
    // because boot does not sweep non-running sessions.
    runs.update(running.runId, { status: "succeeded", endedAt: Date.now(), exitCode: 0 });
    const completedBefore = [succeeded, failed, cancelled, running].map((row) => runs.get(row.runId)?.status);
    await reconcileOrphans();
    expect([succeeded, failed, cancelled, running].map((row) => runs.get(row.runId)?.status)).toEqual(completedBefore);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM runs`).get()!.n).toBe(runsBefore);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM activity_events WHERE event_type = 'run.completed'`).get()!.n).toBe(journalBefore);
    expect(alive("agetor-test", stranger)).toBe(true);
    expect(alive(FOREIGN_SOCKET, succeeded.sessionName)).toBe(true);
    expect(alive("agetor-test", running.sessionName)).toBe(true);
  } finally {
    if (savedBin === undefined) delete process.env.AGETOR_TMUX_BIN;
    else process.env.AGETOR_TMUX_BIN = savedBin;
    if (savedSocket === undefined) delete process.env.AGETOR_TMUX_SOCKET;
    else process.env.AGETOR_TMUX_SOCKET = savedSocket;
  }
});
