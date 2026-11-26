import { describe, expect, test } from "bun:test";
import {
  assessCost,
  defaultBatchPolicy,
  dependencyReadiness,
  deriveEntryState,
  findCycle,
  hasMarkdownDependencies,
  launchFingerprint,
  normalizeTaskPriority,
  orderCandidates,
  planTick,
  plannedOrder,
  priorityFromProposal,
  readBatchPolicy,
  sanitizeStoredBatch,
  spendingChecks,
  validateDependencies,
  type BatchEntry,
  type BatchEntryState,
  type BatchPolicy,
  type DependencyInfo,
  type DependencyTaskRef,
  type EntrySnapshot,
  type Readiness,
  type TaskPriority,
} from "./task-scheduling.ts";

const config = { pipelineId: null, profileId: null, harness: "codex", model: "gpt-6.1-sol", effort: null, mode: "auto", fast: false, maxMode: false };

function entry(taskId: string, order: number, extra: Partial<BatchEntry> = {}): BatchEntry {
  return {
    taskId,
    title: taskId,
    order,
    config,
    approved: { fingerprint: "f", signature: "s", dependsOn: [], accessLevel: 3, harnessIds: ["codex"] },
    appliedFingerprint: null,
    attempts: [],
    launching: null,
    hold: null,
    failureSeen: 0,
    observed: null,
    ...extra,
  };
}

const snap = (extra: Partial<EntrySnapshot> = {}): EntrySnapshot => ({
  exists: true,
  inProject: true,
  column: "backlog",
  archived: false,
  live: false,
  runId: null,
  pipelineStatus: null,
  ownRunStatus: null,
  claimed: false,
  ...extra,
});

describe("priority", () => {
  test("normalizes the four levels and maps proposal priorities", () => {
    expect(normalizeTaskPriority("Critical")).toBe("critical");
    expect(normalizeTaskPriority(" low ")).toBe("low");
    expect(normalizeTaskPriority("urgent")).toBeNull();
    expect(normalizeTaskPriority(3)).toBeNull();
    expect(priorityFromProposal("medium")).toBe("normal");
    expect(priorityFromProposal("high")).toBe("high");
  });

  test("orders by priority, then the owner's order, then id — deterministically", () => {
    const entries = [entry("t-c", 2), entry("t-a", 0), entry("t-b", 1), entry("t-d", 1)];
    const priorities = new Map<string, TaskPriority>([["t-c", "critical"], ["t-a", "low"], ["t-b", "normal"], ["t-d", "normal"]]);
    expect(orderCandidates(entries, priorities).map((e) => e.taskId)).toEqual(["t-c", "t-b", "t-d", "t-a"]);
    expect(orderCandidates([...entries].reverse(), priorities).map((e) => e.taskId)).toEqual(["t-c", "t-b", "t-d", "t-a"]);
  });
});

describe("dependency graph", () => {
  const refs: Record<string, DependencyTaskRef> = {
    a: { id: "a", projectPath: "/p", title: "A", pipelineStep: false },
    b: { id: "b", projectPath: "/p", title: "B", pipelineStep: false },
    c: { id: "c", projectPath: "/p", title: "C", pipelineStep: false },
    x: { id: "x", projectPath: "/other", title: "X", pipelineStep: false },
    s: { id: "s", projectPath: "/p", title: "Step", pipelineStep: true },
  };
  const lookup = (id: string) => refs[id] ?? null;

  test("finds cycles and reports none for a DAG", () => {
    expect(findCycle([{ taskId: "a", dependsOn: "b" }, { taskId: "b", dependsOn: "c" }])).toBeNull();
    expect(findCycle([{ taskId: "a", dependsOn: "b" }, { taskId: "b", dependsOn: "c" }, { taskId: "c", dependsOn: "a" }])).toEqual(["a", "b", "c", "a"]);
    expect(findCycle([{ taskId: "a", dependsOn: "a" }])).toEqual(["a", "a"]);
  });

  test("a long chain doesn't overflow the stack", () => {
    const edges = Array.from({ length: 20_000 }, (_, i) => ({ taskId: `t${i}`, dependsOn: `t${i + 1}` }));
    expect(findCycle(edges)).toBeNull();
    edges.push({ taskId: "t20000", dependsOn: "t0" });
    expect(findCycle(edges)?.length).toBe(20_002);
  });

  test("refuses self, missing, foreign, pipeline-step and cyclic links", () => {
    expect(validateDependencies(refs.a!, ["a"], lookup, [])).toMatchObject({ ok: false, code: "self" });
    expect(validateDependencies(refs.a!, ["ghost"], lookup, [])).toMatchObject({ ok: false, code: "missing" });
    expect(validateDependencies(refs.a!, ["x"], lookup, [])).toMatchObject({ ok: false, code: "other-project" });
    expect(validateDependencies(refs.a!, ["s"], lookup, [])).toMatchObject({ ok: false, code: "pipeline-step" });
    const cyc = validateDependencies(refs.a!, ["b"], lookup, [{ taskId: "b", dependsOn: "c" }, { taskId: "c", dependsOn: "a" }]);
    expect(cyc).toMatchObject({ ok: false, code: "cycle" });
    if (!cyc.ok) expect(cyc.error).toContain("A → B → C → A");
    const many = validateDependencies(refs.a!, Array.from({ length: 31 }, (_, i) => `d${i}`), lookup, []);
    expect(many).toMatchObject({ ok: false, code: "too-many" });
  });

  test("replacing a task's own links doesn't count its old ones as a cycle", () => {
    const edges = [{ taskId: "a", dependsOn: "b" }, { taskId: "c", dependsOn: "a" }];
    expect(validateDependencies(refs.a!, ["b", "b"], lookup, edges)).toEqual({ ok: true, dependsOn: ["b"] });
    expect(validateDependencies(refs.b!, ["c"], lookup, edges)).toMatchObject({ ok: false, code: "cycle" });
  });

  test("readiness: done is satisfied; missing, foreign, archived and stuck block; the rest waits", () => {
    const info: Record<string, DependencyInfo> = {
      done: { exists: true, inProject: true, title: "Done", column: "done", archived: false },
      open: { exists: true, inProject: true, title: "Open", column: "review", archived: false },
      gone: { exists: false, inProject: false, title: "gone", column: null, archived: false },
      moved: { exists: true, inProject: false, title: "Moved", column: "backlog", archived: false },
      shelved: { exists: true, inProject: true, title: "Shelved", column: "backlog", archived: true },
    };
    const of = (id: string) => info[id]!;
    expect(dependencyReadiness(["done"], of)).toEqual({ state: "ready" });
    expect(dependencyReadiness(["done", "open"], of)).toEqual({ state: "waiting", on: ["open"] });
    for (const id of ["gone", "moved", "shelved"]) expect(dependencyReadiness([id], of).state).toBe("blocked");
    expect(dependencyReadiness(["open"], of, () => ({ state: "failed", stuck: true })).state).toBe("blocked");
    expect(dependencyReadiness(["open"], of, () => ({ state: "running", stuck: false })).state).toBe("waiting");
  });

  test("the Markdown Depends-on section is only detected, never parsed", () => {
    expect(hasMarkdownDependencies("Do it.\n\n## Depends on\n- Other (task 1a2b3c4d)\n")).toBe(true);
    expect(hasMarkdownDependencies("It depends on nothing.")).toBe(false);
  });
});

describe("entry state", () => {
  test("derives states from the task and run rows", () => {
    const started = entry("t", 0, { attempts: [{ at: 1, executionId: "e", runId: "r1", outcome: "started", error: null }] });
    expect(deriveEntryState(entry("t", 0), snap())).toBe("pending");
    expect(deriveEntryState(entry("t", 0), snap({ exists: false }))).toBe("missing");
    expect(deriveEntryState(entry("t", 0), snap({ inProject: false }))).toBe("missing");
    expect(deriveEntryState(entry("t", 0, { launching: { at: 1, executionId: "e" } }), snap())).toBe("starting");
    expect(deriveEntryState(started, snap({ live: true, runId: "r1", column: "running" }))).toBe("running");
    expect(deriveEntryState(entry("t", 0), snap({ live: true, runId: "other", column: "running" }))).toBe("external");
    expect(deriveEntryState(started, snap({ column: "blocked", runId: "r1" }))).toBe("waiting");
    expect(deriveEntryState(started, snap({ column: "review", runId: "r1", ownRunStatus: "succeeded" }))).toBe("review");
    expect(deriveEntryState(started, snap({ column: "done" }))).toBe("done");
    expect(deriveEntryState(started, snap({ column: "ready", runId: "r1", ownRunStatus: "failed" }))).toBe("failed");
    expect(deriveEntryState(started, snap({ column: "ready", runId: "r1", ownRunStatus: "orphaned" }))).toBe("failed");
    expect(deriveEntryState(started, snap({ column: "ready", runId: "r1", ownRunStatus: "cancelled" }))).toBe("cancelled");
    expect(deriveEntryState(entry("t", 0, { hold: { code: "x", reason: "y", at: 1, seen: false } }), snap())).toBe("held");
    expect(deriveEntryState(entry("t", 0, { attempts: [{ at: 1, executionId: null, runId: null, outcome: "start-failed", error: "boom" }] }), snap())).toBe("failed");
  });
});

describe("scheduler", () => {
  function plan(
    entries: BatchEntry[],
    states: Record<string, BatchEntryState>,
    opts: { policy?: Partial<BatchPolicy>; readiness?: Record<string, Readiness>; priorities?: Record<string, TaskPriority>; deadlineAt?: number | null; now?: number } = {},
  ) {
    return planTick({
      status: "running",
      policy: { ...defaultBatchPolicy(entries.length), ...opts.policy },
      entries,
      states: new Map(Object.entries(states)),
      priorities: new Map(Object.entries(opts.priorities ?? {})),
      readiness: new Map(entries.map((e) => [e.taskId, opts.readiness?.[e.taskId] ?? { state: "ready" }])),
      now: opts.now ?? 1000,
      deadlineAt: opts.deadlineAt ?? null,
    });
  }

  test("starts nothing unless the batch is running", () => {
    const decision = planTick({
      status: "approved",
      policy: defaultBatchPolicy(1),
      entries: [entry("a", 0)],
      states: new Map(),
      priorities: new Map(),
      readiness: new Map([["a", { state: "ready" }]]),
      now: 0,
      deadlineAt: null,
    });
    expect(decision.kind).toBe("idle");
  });

  test("independent tasks start up to the parallel limit, by priority", () => {
    const entries = [entry("a", 0), entry("b", 1), entry("c", 2)];
    const states = { a: "pending", b: "pending", c: "pending" } as const;
    expect(plan(entries, states)).toMatchObject({ kind: "start", taskIds: ["a"] });
    expect(plan(entries, states, { policy: { maxParallel: 2, maxStarts: 3 }, priorities: { c: "critical" } })).toMatchObject({ kind: "start", taskIds: ["c", "a"] });
    expect(plan(entries, { ...states, a: "running" }, { policy: { maxParallel: 2, maxStarts: 3 } })).toMatchObject({ kind: "start", taskIds: ["b"] });
    expect(plan(entries, { a: "running", b: "waiting", c: "pending" }, { policy: { maxParallel: 2, maxStarts: 3 } }).kind).toBe("idle");
  });

  test("a task waiting on dependencies is skipped even at a higher priority", () => {
    const entries = [entry("a", 0), entry("b", 1)];
    const decision = plan(entries, { a: "pending", b: "pending" }, {
      priorities: { b: "critical" },
      readiness: { b: { state: "waiting", on: ["a"] } },
    });
    expect(decision).toMatchObject({ kind: "start", taskIds: ["a"] });
  });

  test("review: waits by default, continues with independent tasks when allowed", () => {
    const entries = [entry("a", 0), entry("b", 1)];
    const states = { a: "review", b: "pending" } as const;
    const waiting = plan(entries, states);
    expect(waiting.kind).toBe("idle");
    if (waiting.kind === "idle") expect(waiting.reason).toContain("review");
    expect(plan(entries, states, { policy: { reviewPolicy: "continue-independent" } })).toMatchObject({ kind: "start", taskIds: ["b"] });
    // Review never counts as done: a dependent waits either way.
    expect(plan(entries, states, { policy: { reviewPolicy: "continue-independent" }, readiness: { b: { state: "waiting", on: ["a"] } } }).kind).toBe("idle");
  });

  test("completes only when every task is Done", () => {
    const entries = [entry("a", 0), entry("b", 1)];
    expect(plan(entries, { a: "done", b: "done" })).toEqual({ kind: "complete" });
    expect(plan(entries, { a: "done", b: "review" }).kind).toBe("idle");
  });

  test("failure: pauses once by default, continues when allowed, retries within the allowance", () => {
    const failedOnce = entry("a", 0, { attempts: [{ at: 1, executionId: null, runId: "r", outcome: "started", error: null }] });
    const entries = [failedOnce, entry("b", 1)];
    expect(plan(entries, { a: "failed", b: "pending" })).toMatchObject({ kind: "pause", code: "failure" });
    expect(plan([{ ...failedOnce, failureSeen: 1 }, entry("b", 1)], { a: "failed", b: "pending" })).toMatchObject({ kind: "start", taskIds: ["b"] });
    expect(plan(entries, { a: "failed", b: "pending" }, { policy: { onFailure: "continue" } })).toMatchObject({ kind: "start", taskIds: ["b"] });
    // One retry allowed: the failed task is a candidate again.
    expect(plan(entries, { a: "failed", b: "pending" }, { policy: { maxRetriesPerTask: 1, maxStarts: 5 } })).toMatchObject({ kind: "start", taskIds: ["a"] });
    // A task the owner stopped is never retried automatically.
    expect(plan(entries, { a: "cancelled", b: "pending" }, { policy: { maxRetriesPerTask: 1, maxStarts: 5 } })).toMatchObject({ kind: "pause" });
  });

  test("a hold pauses once; a seen hold doesn't", () => {
    const hold = { code: "configuration-changed", reason: "changed", at: 5, seen: false };
    expect(plan([entry("a", 0, { hold }), entry("b", 1)], { a: "held", b: "pending" })).toMatchObject({ kind: "pause", code: "held" });
    expect(plan([entry("a", 0, { hold: { ...hold, seen: true } }), entry("b", 1)], { a: "held", b: "pending" })).toMatchObject({ kind: "start", taskIds: ["b"] });
  });

  test("limits: the start budget and the time limit stop new starts", () => {
    const used = entry("a", 0, { attempts: [{ at: 1, executionId: null, runId: "r", outcome: "started", error: null }] });
    const entries = [used, entry("b", 1)];
    expect(plan(entries, { a: "done", b: "pending" }, { policy: { maxStarts: 1 } })).toMatchObject({ kind: "stop", code: "start-limit" });
    expect(plan(entries, { a: "running", b: "pending" }, { policy: { maxStarts: 1, maxParallel: 2 } }).kind).toBe("idle");
    expect(plan([entry("a", 0)], { a: "pending" }, { deadlineAt: 500, now: 1000 })).toMatchObject({ kind: "stop", code: "deadline" });
  });

  test("planned order follows dependencies, then priority", () => {
    const entries = [entry("a", 0), entry("b", 1), entry("c", 2)];
    const deps: Record<string, string[]> = { a: ["c"], b: [], c: [] };
    const order = plannedOrder(entries, (id) => deps[id]!, new Map([["b", "low" as TaskPriority]]), () => false);
    expect(order).toEqual(["c", "a", "b"]);
  });
});

describe("cost and spending", () => {
  test("never reports an unknown or paid path as free", () => {
    expect(assessCost("fx", "fx", [])).toMatchObject({ paidApi: "yes" });
    expect(assessCost("codex", "Codex", ["OPENAI_API_KEY"])).toMatchObject({ paidApi: "yes" });
    expect(assessCost("codex", "Codex", ["OPENAI_BASE_URL"])).toMatchObject({ paidApi: "unknown" });
    expect(assessCost("claude-code", "Claude", [], ["MY_PROXY_TOKEN"])).toMatchObject({ paidApi: "unknown" });
    expect(assessCost(null, "?", [])).toMatchObject({ paidApi: "unknown" });
    expect(assessCost("codex", "Codex", ["HOME", "PATH"])).toMatchObject({ paidApi: "no", overage: "possible" });
    // Only names are ever reported.
    expect(assessCost("codex", "Codex", ["OPENAI_API_KEY"]).reasons.join(" ")).not.toContain("sk-");
  });

  const harness = (cost: ReturnType<typeof assessCost>) => ({ id: "codex", label: "Codex", cost });

  test("no-extra refuses paid, unknown and unverified overage; an owner confirmation is recorded as unverified", () => {
    const codes = (checks: { code: string; level: string }[]) => checks.map((c) => `${c.level}:${c.code}`);
    expect(codes(spendingChecks("no-extra", [], harness(assessCost("codex", "Codex", ["OPENAI_API_KEY"]))))).toEqual(["error:spend-paid-api-forbidden"]);
    expect(codes(spendingChecks("no-extra", [], harness(assessCost("codex", "Codex", ["OPENAI_BASE_URL"]))))).toEqual(["error:spend-unknown-forbidden"]);
    expect(codes(spendingChecks("no-extra", [], harness(assessCost("codex", "Codex", []))))).toEqual(["error:spend-overage-unverified"]);
    const confirmed = spendingChecks("no-extra", ["codex"], harness(assessCost("codex", "Codex", [])));
    expect(codes(confirmed)).toEqual(["info:spend-no-overage-confirmed"]);
    expect(confirmed[0]!.message).toContain("can't verify");
  });

  test("allow-overage still refuses per-request APIs; allow-paid needs acknowledgement", () => {
    expect(spendingChecks("allow-overage", [], harness(assessCost("codex", "Codex", []))).map((c) => c.level)).toEqual(["warning"]);
    expect(spendingChecks("allow-overage", [], harness(assessCost("fx", "fx", []))).map((c) => c.level)).toEqual(["error"]);
    expect(spendingChecks("allow-paid", [], harness(assessCost("fx", "fx", []))).map((c) => `${c.level}:${c.code}`)).toEqual(["warning:spend-paid-api"]);
    expect(spendingChecks("allow-paid", [], harness(assessCost("codex", "Codex", ["OPENAI_BASE_URL"]))).map((c) => c.code)).toContain("spend-unknown");
  });
});

describe("policy and storage", () => {
  test("reads a policy patch and refuses bad values", () => {
    const base = defaultBatchPolicy(3);
    expect(base).toMatchObject({ maxParallel: 1, maxStarts: 3, maxRetriesPerTask: 0, spending: "no-extra", reviewPolicy: "wait-for-review", onFailure: "pause" });
    expect(readBatchPolicy({ maxParallel: 2, spending: "allow-overage", maxDurationMinutes: 30 }, base)).toMatchObject({ maxParallel: 2, spending: "allow-overage", maxDurationMinutes: 30 });
    expect(typeof readBatchPolicy({ maxParallel: 9 }, base)).toBe("string");
    expect(typeof readBatchPolicy({ maxRetriesPerTask: -1 }, base)).toBe("string");
    expect(typeof readBatchPolicy({ spending: "free" }, base)).toBe("string");
    expect(typeof readBatchPolicy({ reviewPolicy: "skip-review" }, base)).toBe("string");
    expect(typeof readBatchPolicy([], base)).toBe("string");
  });

  test("the launch fingerprint ignores run state but not the prompt or settings", () => {
    const task = {
      title: "T", prompt: "P", agent: "codex", model: "m", effort: null, mode: null, fast: false, maxMode: false,
      agentProfileId: null, pipelineId: null, workdir: "/p", isolation: "none" as const, archivedAt: null,
    };
    const base = launchFingerprint(task);
    expect(launchFingerprint({ ...task, ...({ column: "review", runId: "r" } as object) })).toBe(base);
    expect(launchFingerprint({ ...task, prompt: "Q" })).not.toBe(base);
    expect(launchFingerprint({ ...task, mode: "ask" })).not.toBe(base);
  });

  test("a stored batch is sanitized", () => {
    expect(sanitizeStoredBatch(null)).toBeNull();
    expect(sanitizeStoredBatch({ id: "b", projectPath: "/p", entries: [], status: "exploded" })).toBeNull();
    const batch = sanitizeStoredBatch({ id: "b", projectPath: "/p", status: "paused", entries: [{ taskId: "t", config, attempts: [] }, { bogus: 1 }], policy: { maxParallel: 99 } });
    expect(batch?.entries).toHaveLength(1);
    expect(batch?.entries[0]!.hold).toBeNull();
    expect(batch?.policy.maxParallel).toBe(1);
  });
});
