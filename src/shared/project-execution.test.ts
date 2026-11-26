import { describe, expect, test } from "bun:test";
import {
  EXECUTION_LIMITS,
  appendEvent,
  catalogBlock,
  columnBlockReason,
  executionPhase,
  isExecutableColumn,
  modeAccessLevel,
  parseExecutionSuggestion,
  sanitizeStoredExecution,
  taskFingerprint,
  usageNoticeFor,
  type ExecutionLive,
} from "./project-execution.ts";
import { buildManagerPrompt, parseManagerReply, type ManagerPromptContext } from "./project-manager.ts";

function live(over: Partial<ExecutionLive> = {}): ExecutionLive {
  return {
    taskExists: true,
    title: "T",
    column: "running",
    archived: false,
    run: null,
    runCount: 1,
    live: false,
    pendingQuestions: 0,
    pipeline: null,
    otherRun: null,
    model: "m",
    harness: "codex",
    ...over,
  };
}

const run = (status: "running" | "succeeded" | "failed" | "cancelled" | "orphaned") =>
  ({ id: "r", status, agent: "codex", startedAt: 1, endedAt: null, exitCode: null });

describe("executionPhase", () => {
  test("proposal states map directly", () => {
    expect(executionPhase({ status: "proposed" }, live())).toBe("proposed");
    expect(executionPhase({ status: "proposed" }, live({ taskExists: false }))).toBe("missing");
    expect(executionPhase({ status: "starting" }, live())).toBe("starting");
    expect(executionPhase({ status: "start-failed" }, live())).toBe("start-failed");
    expect(executionPhase({ status: "dismissed" }, live())).toBe("dismissed");
  });

  test("a started run follows the board and the run row", () => {
    const started = { status: "started" as const };
    expect(executionPhase(started, live({ live: true }))).toBe("running");
    expect(executionPhase(started, live({ live: true, pendingQuestions: 1 }))).toBe("waiting");
    expect(executionPhase(started, live({ column: "blocked", run: run("failed") }))).toBe("waiting");
    expect(executionPhase(started, live({ column: "review", run: run("succeeded") }))).toBe("review");
    expect(executionPhase(started, live({ column: "ready", run: run("failed") }))).toBe("failed");
    expect(executionPhase(started, live({ column: "ready", run: run("orphaned") }))).toBe("failed");
    expect(executionPhase(started, live({ column: "ready", run: run("cancelled") }))).toBe("stopped");
    expect(executionPhase(started, live({ column: "done", run: run("succeeded") }))).toBe("accepted");
    expect(executionPhase(started, live({ column: "backlog", run: run("succeeded") }))).toBe("returned");
    expect(executionPhase(started, live({ taskExists: false }))).toBe("missing");
  });

  test("a pipeline task follows its pipeline run", () => {
    const started = { status: "started" as const };
    const pipeline = (status: string) => ({ status, activeSteps: [], completed: 0, total: 2 });
    expect(executionPhase(started, live({ column: "running", pipeline: pipeline("running") }))).toBe("running");
    expect(executionPhase(started, live({ column: "review", pipeline: pipeline("done") }))).toBe("review");
    expect(executionPhase(started, live({ column: "ready", pipeline: pipeline("cancelled") }))).toBe("stopped");
    expect(executionPhase(started, live({ column: "done", pipeline: pipeline("done") }))).toBe("accepted");
  });

  test("never reports done just because a process ended", () => {
    const phase = executionPhase({ status: "started" }, live({ column: "review", run: run("succeeded") }));
    expect(phase).not.toBe("accepted");
  });
});

describe("columns", () => {
  test("only ready can be executed; backlog and inbox are intake stages", () => {
    expect(isExecutableColumn("ready")).toBe(true);
    expect(isExecutableColumn("backlog")).toBe(false);
    expect(isExecutableColumn("inbox")).toBe(false);
    for (const column of ["running", "blocked", "review", "done"] as const) {
      expect(isExecutableColumn(column)).toBe(false);
      expect(columnBlockReason(column)).toBeTruthy();
    }
    expect(columnBlockReason("backlog")).toBeTruthy();
    expect(columnBlockReason("inbox")).toBeTruthy();
  });
});

describe("modeAccessLevel", () => {
  test("orders modes by how much they allow", () => {
    expect(modeAccessLevel("claude-code", "plan")).toBeLessThan(modeAccessLevel("claude-code", "ask"));
    expect(modeAccessLevel("claude-code", "auto")).toBeLessThan(modeAccessLevel("claude-code", "bypass"));
    expect(modeAccessLevel("codex", "ask")).toBe(0);
    expect(modeAccessLevel("fx", "yolo")).toBe(4);
    // Unknown ids are never shown as safe.
    expect(modeAccessLevel("codex", "brand-new")).toBe(3);
  });
});

describe("taskFingerprint", () => {
  const task = {
    title: "T", prompt: "P", agent: "codex", model: "m", effort: null, mode: null, fast: false, maxMode: false,
    agentProfileId: null, pipelineId: null, column: "backlog" as const, runId: null, workdir: "/p", isolation: "worktree" as const, archivedAt: null,
  };
  test("is stable and changes with what a launch depends on", () => {
    expect(taskFingerprint(task)).toBe(taskFingerprint({ ...task }));
    for (const change of [{ prompt: "Q" }, { agent: "claude-code" }, { column: "running" as const }, { runId: "r" }, { mode: "ask" }]) {
      expect(taskFingerprint({ ...task, ...change })).not.toBe(taskFingerprint(task));
    }
  });
});

describe("usageNoticeFor", () => {
  test("fx always bills per token; others only with an API key variable", () => {
    expect(usageNoticeFor("fx", "fx", [])).toContain("bills per token");
    expect(usageNoticeFor("codex", "Codex", [])).toBeNull();
    expect(usageNoticeFor("codex", "Codex", ["OPENAI_API_KEY"])).toContain("OPENAI_API_KEY");
    expect(usageNoticeFor("claude-code", "Claude", ["OPENAI_API_KEY"])).toBeNull();
    expect(usageNoticeFor("claude-code", "Claude", ["ANTHROPIC_API_KEY"])).toContain("may bill");
  });

  test("never claims a price or a remaining limit", () => {
    const text = usageNoticeFor("fx", "fx", [])!;
    expect(text).toContain("doesn't know the price");
    expect(text).not.toMatch(/\$\d/);
  });
});

describe("parseExecutionSuggestion", () => {
  test("no tag is not an error", () => {
    expect(parseExecutionSuggestion("<reply>hi</reply>")).toEqual({ ok: true, suggestion: null });
  });

  test("reads names only, never a mode", () => {
    const text = `<reply>x</reply>\n<execution_proposal>\n{"task": "#1A2B3C4D", "harness": "codex", "model": "gpt", "mode": "bypass", "reason": "first"}\n</execution_proposal>`;
    const parsed = parseExecutionSuggestion(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.suggestion).toEqual({ taskRef: "1a2b3c4d", profile: null, pipeline: null, harness: "codex", model: "gpt", effort: null, reason: "first" });
    expect(parsed.suggestion).not.toHaveProperty("mode");
  });

  test("accepts a fenced body", () => {
    const parsed = parseExecutionSuggestion("<execution_proposal>\n```json\n{\"task\": \"1a2b3c4d\"}\n```\n</execution_proposal>");
    expect(parsed.ok && parsed.suggestion?.taskRef).toBe("1a2b3c4d");
  });

  test("refuses a missing task, bad JSON, a cut-off block and an oversized one", () => {
    expect(parseExecutionSuggestion("<execution_proposal>{\"harness\": \"codex\"}</execution_proposal>").ok).toBe(false);
    expect(parseExecutionSuggestion("<execution_proposal>{nope</execution_proposal>").ok).toBe(false);
    expect(parseExecutionSuggestion("<execution_proposal>{\"task\": \"#1a2b3c4d\"").ok).toBe(false);
    const big = `<execution_proposal>{"task": "#1a2b3c4d", "reason": "${"x".repeat(EXECUTION_LIMITS.jsonChars)}"}</execution_proposal>`;
    expect(parseExecutionSuggestion(big).ok).toBe(false);
  });
});

describe("manager reply and prompt", () => {
  test("a reply with only a run suggestion still has an answer", () => {
    const parsed = parseManagerReply(`<execution_proposal>{"task": "#1a2b3c4d", "reason": "It's next."}</execution_proposal>`, new Map());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.execution?.taskRef).toBe("1a2b3c4d");
    expect(parsed.parsed.reply).toBe("It's next.");
  });

  test("a broken suggestion is reported and the answer kept", () => {
    const parsed = parseManagerReply(`<reply>Sure.</reply><execution_proposal>{bad</execution_proposal>`, new Map());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.execution).toBeNull();
    expect(parsed.parsed.executionError).toContain("No run was proposed");
    expect(parsed.parsed.reply).toBe("Sure.");
  });

  test("the prompt lists what can run tasks and the runs so far, and explains approval", () => {
    const context: ManagerPromptContext = {
      name: "P", path: "/p", description: "", stack: "Bun", signals: [], gitBranch: null, documents: [], missingDocuments: [],
      backlog: [], backlogOmitted: 0, counts: { backlog: 0, inbox: 0, ready: 0, running: 0, blocked: 0, review: 0, done: 0 }, archivedCount: 0,
      blocked: [], running: [], environment: null,
      executions: [{ taskRef: "1a2b3c4d", title: "Login", phase: "running", startedAt: 0 }],
    };
    const prompt = buildManagerPrompt({
      context,
      config: { language: "auto", instructions: "" },
      decisions: [],
      history: [],
      message: "go",
      nonce: "abcd1234",
      catalog: { harnesses: [{ id: "codex", label: "Codex", kind: "codex", defaultModel: "gpt-6.1-sol" }], profiles: [], pipelines: [{ name: "Review", steps: 2 }] },
    });
    expect(prompt).toContain(`harness "codex" (Codex, codex)`);
    expect(prompt).toContain(`pipeline "Review" (2 steps)`);
    expect(prompt).toContain("#1a2b3c4d Login: Running");
    expect(prompt).toContain("<execution_proposal>");
    expect(prompt).toContain("You cannot start it");
    expect(prompt).toContain("You cannot change the permission mode");
    // The runs list is board data, inside the untrusted-data fence.
    const end = prompt.indexOf("--- END project data abcd1234 ---");
    expect(prompt.indexOf("### Supervised runs")).toBeLessThan(end);
  });

  test("catalogBlock says when nothing is enabled", () => {
    expect(catalogBlock({ harnesses: [], profiles: [], pipelines: [] })).toContain("No harness is enabled");
  });
});

describe("stored rows", () => {
  test("sanitize drops garbage and keeps a valid proposal", () => {
    expect(sanitizeStoredExecution(null)).toBeNull();
    expect(sanitizeStoredExecution({ id: "x" })).toBeNull();
    const row = sanitizeStoredExecution({
      id: "e", projectPath: "/p", taskId: "t", config: { harness: "codex", model: "m", mode: "ask" }, status: "weird", revision: 3,
      checks: [{ level: "error", code: "x", message: "m" }, { bad: true }],
    });
    expect(row?.status).toBe("proposed");
    expect(row?.revision).toBe(3);
    expect(row?.checks).toHaveLength(1);
    expect(row?.config.mode).toBe("ask");
  });

  test("history is capped", () => {
    let history: ReturnType<typeof appendEvent> = [];
    for (let i = 0; i < EXECUTION_LIMITS.historyEntries + 10; i++) history = appendEvent(history, "edited", `e${i}`, i);
    expect(history).toHaveLength(EXECUTION_LIMITS.historyEntries);
    expect(history.at(-1)?.text).toBe(`e${EXECUTION_LIMITS.historyEntries + 9}`);
  });
});
