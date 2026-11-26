import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveQuota } from "../shared/accounts/resolve.ts";
import { EMPTY_MODEL_EVIDENCE } from "../shared/model-router/route.ts";
import type { OwnerRoutingConstraints, RoutingSnapshot } from "../shared/model-router/types.ts";
import { describePermissions, WORKSPACE_LAYOUTS, codexSandboxFor, layoutNeedsExternalGit, type WorkspaceLayout } from "../shared/execution/permissions.ts";
import type { AgentKind, Harness } from "../shared/types.ts";

/**
 * FO-ORCH01 executor recommendations, Owner routing preferences and Codex permission disclosure.
 * The fake codex driver sits behind a /bin/echo stub: no real AI CLI runs and no provider is reached.
 */
const isolated = realpathSync(mkdtempSync(path.join(tmpdir(), "foorch01-")));
process.env.AGETOR_DATA_DIR = isolated;
process.env.FORGEORBIT_DATA_DIR = isolated;
process.env.CODEX_HOME = path.join(isolated, ".codex");
process.env.HOME = isolated;
process.env.AGETOR_API_PORT = "4730";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
for (const kind of ["CLAUDE", "CURSOR", "GEMINI", "FX", "ANTIGRAVITY"]) process.env["AGETOR_" + kind + "_BIN"] = "/nonexistent/foorch01";

let store: typeof import("./db.ts");
let backend: typeof import("./server.ts");
let server: ReturnType<(typeof import("./server.ts"))["startApiServer"]>;
let orchestrator: typeof import("./orchestrator.ts");
let run: typeof import("./employee-run.ts");
let rec: typeof import("./executor-recommendations.ts");
let layoutMod: typeof import("./execution-layout.ts");
let agents: typeof import("./agents.ts");
let EmployeeCore: typeof import("./employee-core.ts").EmployeeCore;
let AssignmentCore: typeof import("./assignment-core.ts").AssignmentCore;
const base = "http://127.0.0.1:4730";
let counter = 0;

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  run = await import("./employee-run.ts");
  rec = await import("./executor-recommendations.ts");
  layoutMod = await import("./execution-layout.ts");
  agents = await import("./agents.ts");
  backend = await import("./server.ts");
  ({ EmployeeCore } = await import("./employee-core.ts"));
  ({ AssignmentCore } = await import("./assignment-core.ts"));
  run.initEmployeeExecutionTracking();
  server = backend.startApiServer();
  store.harnesses.setEnabled("codex", true);
  store.harnesses.setEnabled("claude-code", true);
  store.harnesses.setEnabled("cursor", false);
});
afterAll(() => server?.stop(true));
beforeEach(() => {
  run.__testing.reset();
  store.preferences.set("executorRoutingPreferences", "");
});

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}
async function gitRepo(name: string): Promise<string> {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  await sh(["init", "-b", "main"], dir);
  await sh(["config", "user.email", "t@example.com"], dir);
  await sh(["config", "user.name", "t"], dir);
  writeFileSync(path.join(dir, "README.md"), "# r\n");
  await sh(["add", "."], dir);
  await sh(["commit", "-m", "init"], dir);
  store.projects.upsert(dir, name);
  return dir;
}
function plainProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(isolated, `${name}-`)));
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  store.projects.upsert(dir, name);
  return dir;
}
async function newTask(dir: string, fields: Record<string, unknown> = {}): Promise<string> {
  const created = await orchestrator.createTask({
    title: `Task ${++counter}`, prompt: "SECRET_PROMPT_MARKER do the work", workdir: dir, column: "ready",
    agent: "codex", model: "gpt-6.1-sol", isolation: "none", ...fields,
  } as never);
  if ("error" in created) throw new Error(created.error);
  return created.task.id;
}
const worker = (projectPath: string) => new EmployeeCore(store.db).createWorker({ name: `Worker ${++counter}`, jobTitle: "QA", projectPath });
async function scenario(fields: Record<string, unknown> = {}, dir = plainProject("proj")) {
  const taskId = await newTask(dir, fields);
  new AssignmentCore(store.db).assign(taskId, worker(dir).id);
  return { dir, taskId };
}
async function http(route: string, body?: unknown, method = body === undefined ? "GET" : "POST", auth: string | null = "Bearer " + backend.API_TOKEN) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const setPrefs = (prefs: Record<string, unknown>) => store.preferences.set("executorRoutingPreferences", JSON.stringify(prefs));
const present = { cli: () => ({ available: true, loggedIn: null as boolean | null }) };
const counts = () => ({
  runs: store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n,
  attempts: store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM employee_executions").get()!.n,
});

// ----- recommendations ----------------------------------------------------------------------

test("recommendations group registered harnesses, are read-only, and create no run, review or task change", async () => {
  const s = await scenario();
  const before = { ...counts(), task: JSON.stringify(store.tasks.get(s.taskId)) };
  const out = await rec.recommendExecutors({ taskId: s.taskId }, present);
  const options = Object.values(out.recommendations.groups).flat();
  expect(options.length).toBeGreaterThan(0);
  expect(out.recommendations.executionAvailable).toBe(false);
  expect(out.recommendations.automaticSelection).toBe("none");
  expect(out.recommendations.groups["verified-eligible"]).toEqual([]);
  // Disabled harness is blocked, enabled ones with no evidence are potential-Unknown.
  expect(out.recommendations.groups.blocked.find((o) => o.harnessId === "cursor")!.availability).toBe("disabled");
  const codex = out.recommendations.groups["potential-unknown"].find((o) => o.harnessId === "codex" && o.modelId === "gpt-6.1-sol")!;
  expect(codex.availability).toBe("unknown");
  expect(codex.why.map((w) => w.code)).toContain("task-configured");
  expect(codex.requiresOwnerConfirmation).toBe(true);
  expect(counts()).toEqual({ runs: before.runs, attempts: before.attempts });
  expect(JSON.stringify(store.tasks.get(s.taskId))).toBe(before.task);
  expect(JSON.stringify(out)).not.toMatch(/SECRET_PROMPT_MARKER/);
});

test("a CLI that is not on this machine is blocked, not offered", async () => {
  const s = await scenario();
  const out = await rec.recommendExecutors({ taskId: s.taskId }, { cli: (h: Harness) => ({ available: h.kind === "codex", loggedIn: null }) });
  const claude = out.recommendations.groups.blocked.find((o) => o.harnessId === "claude-code")!;
  expect(claude.availability).toBe("not-installed");
  expect(claude.selectable).toBe(false);
});

test("verified exhausted quota for a model blocks it while a neighbour stays an Owner choice; the router stays fail-closed", async () => {
  const s = await scenario();
  const now = 1_000_000;
  const fact = <T,>(value: T) => ({ value, verification: "verified" as const, source: "fake", observedAt: now - 1, expiresAt: now + 1000 });
  const def = { id: "q1", accountId: "acct", subscriptionId: null, scope: "model:gpt-6.1-sol", unit: { kind: "requests" as const }, window: "day", createdAt: 1, archivedAt: null };
  const obs = { id: "o1", quotaId: "q1", source: "fake", verification: "verified" as const, provenance: "verified" as const, observedAt: now - 1, expiresAt: now + 1000, resetAt: null, limit: 10, used: 10, remaining: 0, indicator: null, confidence: "high" as const };
  const candidate = (modelId: string) => ({
    id: modelId, accountId: "acct", harnessId: "codex", modelId, enabled: true, profileIds: [],
    authorization: fact(true), availability: fact(true), billing: fact({ paidApi: "no", overage: "none", reasons: ["fixture"] }),
    support: { accountId: "acct", harnessId: "codex", modelId, support: "supported", source: "fake", provenance: "verified", verification: "verified", observedAt: now - 1, expiresAt: now + 1000 },
    evidence: { ...EMPTY_MODEL_EVIDENCE },
  });
  const snapshot = {
    capturedAt: now, candidates: [candidate("gpt-6.1-sol"), candidate("gpt-6-luna")],
    accounts: [{ id: "acct", provider: "fake", displayName: "Fake", externalIdentity: "x@example.com", availability: "available", provenance: "user-provided", verification: "unverified", source: "manual", createdAt: 1, updatedAt: 1, archivedAt: null }],
    bindings: [{ accountId: "acct", harnessId: "codex", createdAt: 1, provenance: "user-provided", verification: "unverified", source: "manual" }],
    subscriptions: [], subscriptionLinks: [], quotas: [resolveQuota(def as never, [obs], now)],
    limits: [{ id: "global", scope: { kind: "global" }, limit: fact(4), occupied: fact(0) }, { id: "account:acct", scope: { kind: "account", id: "acct" }, limit: fact(1 as number | "unbounded"), occupied: fact(0) }],
    occupancyComplete: true,
  } as unknown as RoutingSnapshot;
  const allowPaid = (o: OwnerRoutingConstraints): OwnerRoutingConstraints => ({ ...o, spending: "allow-paid" });
  const out = await rec.recommendExecutors({ taskId: s.taskId }, { ...present, now: () => now, preflight: { now: () => now, snapshot: () => snapshot, owner: allowPaid } });
  const sol = out.recommendations.groups.blocked.find((o) => o.harnessId === "codex" && o.modelId === "gpt-6.1-sol")!;
  expect(sol.limitations.map((l) => l.code)).toContain("quota-exhausted");
  expect(sol.availability).toBe("exhausted");
  expect(sol.selectable).toBe(false);
  const luna = out.recommendations.groups["potential-unknown"].find((o) => o.modelId === "gpt-6-luna");
  expect(luna).toBeDefined();
  expect(out.recommendations.automaticRouter.status).toBe("no-verified-candidate");
  expect(out.recommendations.automaticSelection).toBe("none");
  // Choosing the blocked model by hand is still refused by the preflight, not waived; its neighbour stays a manual choice.
  const exec = await import("./employee-execution.ts");
  const deps = { now: () => now, snapshot: () => snapshot, owner: allowPaid };
  const named = exec.prepareEmployeeExecution({ taskId: s.taskId, harnessId: "codex", model: "gpt-6.1-sol" }, deps);
  expect(named.outcome).toBe("blocked");
  expect(named.blockingErrors.map((e) => e.code)).toContain("resource-excluded");
  const neighbour = exec.prepareEmployeeExecution({ taskId: s.taskId, harnessId: "codex", model: "gpt-6-luna" }, deps);
  expect(neighbour.blockingErrors.map((e) => e.code)).not.toContain("resource-excluded");
});

test("a blocked current selection gets alternatives, and nothing is started or applied", async () => {
  const s = await scenario();
  setPrefs({ forbiddenModels: ["gpt-6.1-sol"] });
  const before = counts();
  const out = await rec.recommendExecutors({ taskId: s.taskId, harnessId: "codex" }, present);
  expect(out.recommendations.selection!.classification).toBe("blocked");
  expect(out.recommendations.selection!.alternatives.length).toBeGreaterThan(0);
  expect(out.recommendations.selection!.alternatives.every((o) => o.selectable)).toBe(true);
  expect(counts()).toEqual(before);
});

// ----- Owner preferences -------------------------------------------------------------------

test("preferences are stored through the API, validated strictly, and need the bearer token", async () => {
  expect((await http("/employee-execution/executor-preferences", undefined, "GET", null)).status).toBe(401);
  expect((await http("/employee-execution/executor-preferences", {}, "PUT", null)).status).toBe(401);
  expect((await http("/employee-execution/recommendations", { taskId: "x" }, "POST", null)).status).toBe(401);
  const put = await http("/employee-execution/executor-preferences", { preferredHarnessId: "codex", forbiddenModels: ["gpt-5"], requiredMode: "ask", policy: "quality-first" }, "PUT");
  expect(put.status).toBe(200);
  const got = await http("/employee-execution/executor-preferences");
  expect(got.body.preferences).toMatchObject({ preferredHarnessId: "codex", forbiddenModels: ["gpt-5"], requiredMode: "ask", policy: "quality-first", allowedHarnessIds: null });
  for (const bad of [{ unknown: 1 }, { policy: "cheap" }, { allowedHarnessIds: [] }, [], "x"]) {
    expect((await http("/employee-execution/executor-preferences", bad, "PUT")).status).toBe(400);
  }
  expect((await http("/employee-execution/executor-preferences", { forbiddenModels: ["a"] }, "POST")).status).toBe(405);
  expect((await http("/employee-execution/executor-preferences")).body.preferences.forbiddenModels).toEqual(["gpt-5"]);
});

test("a forbidden model and a harness allow-list cannot be waived by choosing them by hand", async () => {
  const s = await scenario();
  setPrefs({ forbiddenModels: ["gpt-6.1-sol"] });
  const forbidden = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex" });
  expect(forbidden.body.preflight.outcome).toBe("blocked");
  expect(forbidden.body.preflight.blockingErrors.map((e: any) => e.code)).toContain("owner-model-forbidden");
  expect(forbidden.body.preflight.ownerRestrictions.forbiddenModels).toEqual(["gpt-6.1-sol"]);
  const other = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex", model: "gpt-6-luna" });
  expect(other.body.preflight.blockingErrors.map((e: any) => e.code)).not.toContain("owner-model-forbidden");

  setPrefs({ allowedHarnessIds: ["claude-code"] });
  const blocked = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex" });
  expect(blocked.body.preflight.outcome).toBe("blocked");
  expect(blocked.body.preflight.blockingErrors.map((e: any) => e.code)).toEqual(expect.arrayContaining(["owner-policy"]));
  expect(blocked.body.preflight.ownerRestrictions.allowedHarnesses).toEqual(["claude-code"]);
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.attempt).toBeNull();
});

test("a required permission mode is unsupported where the harness lacks it, and is applied and disclosed in the review", async () => {
  const s = await scenario();
  setPrefs({ requiredMode: "plan" });
  const unsupported = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex" });
  expect(unsupported.body.preflight.blockingErrors.map((e: any) => e.code)).toContain("required-mode-unsupported");
  expect((await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" })).attempt).toBeNull();

  setPrefs({ requiredMode: "ask" });
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.blockingErrors).toEqual([]);
  expect(out.attempt!.requested.mode).toBe("ask");
  expect(out.attempt!.review.permission).toMatchObject({ sandbox: "read-only", escalated: false });
  expect(out.attempt!.review.warnings.map((w) => w.code)).toContain("mode-set-by-preferences");
  // Nothing started: the owner has not confirmed.
  expect(store.runs.listForTask(s.taskId)).toEqual([]);
  expect(store.tasks.get(s.taskId)!.mode ?? "auto").not.toBe("ask");
});

test("changing preferences after a review voids the start instead of launching with stale rules", async () => {
  const s = await scenario();
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.attempt).not.toBeNull();
  setPrefs({ forbiddenModels: ["gpt-6.1-sol"] });
  const started = await run.startEmployeeExecution(out.attempt!.id, { revision: out.attempt!.revision, confirm: true }).then(() => null, (e) => e);
  expect(started).toBeInstanceOf(run.EmployeeRunError);
  expect(store.runs.countForTask(s.taskId)).toBe(0);
});

test("the chosen executor is saved as requested; actual stays Unknown until the runtime establishes it", async () => {
  const s = await scenario();
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex", model: "gpt-6-luna" });
  expect(out.attempt!.requested).toMatchObject({ harnessId: "codex", model: "gpt-6-luna" });
  expect(out.attempt!.actual).toEqual({ harnessId: null, model: null, accountId: null });
});

// ----- Codex permission UX ----------------------------------------------------------------

test("the review blocks implicit full access and discloses explicit full access", async () => {
  const repo = await gitRepo("gitproj");
  const root = await scenario({ isolation: "none" }, repo);
  const plain = await run.reviewEmployeeExecution({ taskId: root.taskId, harnessId: "codex" });
  expect(plain.attempt!.review.permission).toMatchObject({ layout: "repo-root", sandbox: "workspace-write", escalated: false, approval: "never-asked", network: "sandbox-disabled", predicted: false });
  expect(plain.attempt!.review.checks.map((c) => c.code)).toContain("codex-sandbox");

  const worktree = await scenario({ isolation: "worktree" }, repo);
  const linked = await run.reviewEmployeeExecution({ taskId: worktree.taskId, harnessId: "codex" });
  expect(linked.attempt).toBeNull();
  expect(linked.blockingErrors.map((c) => c.code)).toContain("task-staging-required");
  setPrefs({ requiredMode: "full-access" });
  const full = await run.reviewEmployeeExecution({ taskId: worktree.taskId, harnessId: "codex" });
  expect(full.blockingErrors).toEqual([]);
  expect(full.attempt!.review.permission).toMatchObject({ layout: "linked-worktree", sandbox: "danger-full-access", escalated: true, predicted: true });
  setPrefs({});

  const nonGit = await scenario({ isolation: "none" });
  const outside = await run.reviewEmployeeExecution({ taskId: nonGit.taskId, harnessId: "codex" });
  expect(outside.attempt!.review.permission).toMatchObject({ layout: "non-git", sandbox: "workspace-write" });
  // Persisted with the review, so a later change of layout cannot rewrite what the Owner saw.
  expect(run.getEmployeeRun(plain.attempt!.id).review.permission!.sandbox).toBe("workspace-write");
  // Other harnesses are unaffected: no Codex-specific disclosure.
  const claude = await run.reviewEmployeeExecution({ taskId: nonGit.taskId, harnessId: "claude-code" });
  expect(claude.attempt?.review.permission ?? null).toBeNull();
});

test("an Owner task-staging grant plans workspace-write without a Git worktree or Full access", async () => {
  const repo = await gitRepo("staging-grant");
  const worktree = await scenario({ isolation: "worktree" }, repo);
  const refused = await run.reviewEmployeeExecution({ taskId: worktree.taskId, harnessId: "codex" });
  expect(refused.attempt).toBeNull();
  expect(refused.blockingErrors.map((item) => item.code)).toContain("task-staging-required");
  const refusedText = refused.blockingErrors.map((item) => item.message).join("\n");
  expect(refusedText).toContain("operation developer-execution");
  expect(refusedText).toContain("scope task-staging");
  expect(refusedText).not.toContain("explicitly select Full access");

  const wrong = await run.reviewEmployeeExecution({
    taskId: worktree.taskId,
    harnessId: "codex",
    executionPermission: {
      operation: "developer-execution",
      projectPath: "/tmp/not-this-project",
      scope: "task-staging",
      outputPaths: ["README.md"],
    },
  });
  expect(wrong.attempt).toBeNull();
  expect(wrong.blockingErrors.map((item) => item.code)).toContain("permission-scope");
  expect(store.tasks.get(worktree.taskId)!.worktreePath ?? null).toBeNull();

  const request = {
    taskId: worktree.taskId,
    harnessId: "codex",
    executionPermission: {
      operation: "developer-execution",
      projectPath: repo,
      scope: "task-staging",
      outputPaths: ["README.md"],
    },
  };
  const [first, second] = await Promise.all([run.reviewEmployeeExecution(request), run.reviewEmployeeExecution(request)]);
  const allowed = first.attempt ? first : second;
  const retry = await run.reviewEmployeeExecution(request);
  expect(retry.attempt?.id).toBe(allowed.attempt?.id);
  expect(store.db.query("SELECT COUNT(*) AS total FROM task_workspaces WHERE task_id = ?").get(worktree.taskId)).toEqual({ total: 1 });
  expect(allowed.blockingErrors).toEqual([]);
  expect(allowed.preflight.outcome).toBe("prepared");
  expect(allowed.preflight.blockingErrors).toEqual([]);
  expect(allowed.attempt!.review.permission).toMatchObject({
    layout: "non-git",
    sandbox: "workspace-write",
    escalated: false,
    launchAllowed: true,
  });
  expect(allowed.attempt!.review.workspace).toContain(`${path.sep}task-workspaces${path.sep}`);
  expect(store.tasks.get(worktree.taskId)!.worktreePath ?? null).toBeNull();

  const started = await run.startEmployeeExecution(allowed.attempt!.id, { revision: allowed.attempt!.revision, confirm: true });
  expect(started.attempt.runId).not.toBeNull();
  const runId = started.attempt.runId!;
  const workspace = await import("./task-workspace.ts");
  const recorded = workspace.getTaskWorkspace(worktree.taskId);
  expect(recorded?.developerRunId).toBe(runId);
  expect(recorded?.outputPaths).toEqual(["README.md"]);
  const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const worktrees = listed.stdout.toString().split("\n").filter((line) => line.startsWith("worktree "));
  expect(worktrees).toHaveLength(1);
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe" });
  expect(status.stdout.toString()).toBe("");
  expect(store.runs.listForTask(worktree.taskId)).toHaveLength(1);
});

test("layout detection distinguishes repo root, subfolder, linked worktree and non-git", async () => {
  const repo = await gitRepo("layouts");
  const sub = path.join(repo, "pkg", "inner");
  mkdirSync(sub, { recursive: true });
  const linked = path.join(isolated, "linked-" + counter++);
  await sh(["worktree", "add", "-b", "wt-" + counter, linked], repo);
  const plain = plainProject("nogit");
  const detect = (task: Partial<import("../shared/types.ts").Task>) => layoutMod.detectWorkspaceLayout({ isolation: "none", worktreePath: null, workdir: repo, ...task } as never);
  expect((await detect({})).layout).toBe("repo-root");
  expect((await detect({ workdir: sub })).layout).toBe("repo-subfolder");
  expect((await detect({ workdir: linked })).layout).toBe("linked-worktree");
  expect((await detect({ workdir: plain })).layout).toBe("non-git");
  expect(await detect({ isolation: "worktree" })).toEqual({ layout: "linked-worktree", predicted: true });
  expect((await detect({ workdir: path.join(isolated, "missing") })).layout).toBe("unknown");
});

test("the disclosure is tied to the real codex argv for every mode and layout", async () => {
  const harness = store.harnesses.getByIdOrKind("codex")!;
  for (const layout of WORKSPACE_LAYOUTS) {
    if (layout === "unknown") continue;
    for (const mode of ["ask", "auto", "full-access"]) {
      const { cmd } = agents.buildCommand(harness, "hi", { mode, model: "gpt-6-luna", effort: "low", codexExternalGitDirs: layoutNeedsExternalGit(layout as WorkspaceLayout) ? ["/x/.git"] : [] });
      const sandbox = cmd[cmd.indexOf("--sandbox") + 1];
      expect(sandbox).toBe(codexSandboxFor(mode, layout));
      expect(cmd.includes("approval_policy=never")).toBe(true);
    }
  }
  const _kind: AgentKind = harness.kind;
  expect(_kind).toBe("codex");
});

// ----- HTTP and compatibility ------------------------------------------------------------------

test("HTTP recommendations: strict schema, read-only POST, no client paths, no secrets", async () => {
  const s = await scenario();
  const ok = await http("/employee-execution/recommendations", { taskId: s.taskId });
  expect(ok.status).toBe(200);
  expect(ok.body.recommendations.readOnly).toBe(true);
  expect(ok.body.preflight.executionAvailable).toBe(false);
  expect((await http("/employee-execution/recommendations", { taskId: s.taskId, path: "/etc" })).status).toBe(400);
  expect((await http("/employee-execution/recommendations", undefined, "GET")).status).toBe(405);
  expect((await http("/employee-execution/recommendations", { taskId: "nope" })).status).toBe(404);
  expect((await http("/employee-execution/recommendations?x=1", { taskId: s.taskId })).status).toBe(400);
  expect(JSON.stringify(ok.body)).not.toMatch(/(token|password|apiKey|externalIdentity)/i);
});

test("the existing PM workflow is unchanged: assignment, preflight and review still work with no preferences", async () => {
  const s = await scenario();
  const pre = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex" });
  expect(pre.body.preflight.outcome).toBe("prepared");
  expect(pre.body.preflight.ownerRestrictions.forbiddenModels).toEqual([]);
  expect(pre.body.preflight.ownerRestrictions.requiredMode).toBeNull();
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.attempt!.phase).toBe("awaiting-approval");
  expect(store.runs.listForTask(s.taskId)).toEqual([]);
});


// FO-ORCH02 permission and PM confirmation regression tests.
test("Auto is blocked for a Git subdirectory; missing and corrupt workspaces fail closed even for full access", async () => {
  const repo = await gitRepo("subfolder");
  const sub = path.join(repo, "pkg"); mkdirSync(sub);
  const s = await scenario({ workdir: sub }, repo);
  const pre = await http("/employee-execution/preflight", { taskId: s.taskId, harnessId: "codex" });
  expect(pre.body.preflight.permission).toMatchObject({ layout: "repo-subfolder", sandbox: "workspace-write", launchAllowed: false });
  expect(pre.body.preflight.outcome).toBe("blocked");
  const h = store.harnesses.getByIdOrKind("codex")!;
  const opts = { mode: "auto", model: "gpt-6-luna", effort: "low" };
  await expect(agents.buildCodexCommand(h, "hi", opts, sub)).rejects.toThrow("Owner");
  expect((await agents.buildCodexCommand(h, "hi", { ...opts, mode: "full-access" }, sub)).cmd).toContain("danger-full-access");
  await expect(agents.buildCodexCommand(h, "hi", { ...opts, mode: "full-access" }, path.join(isolated, "absent"))).rejects.toThrow("Unknown");
  const corrupt = plainProject("corrupt"); mkdirSync(path.join(corrupt, ".git"));
  await expect(agents.buildCodexCommand(h, "hi", opts, corrupt)).rejects.toThrow("Unknown");
});

test("layout changes after Review reject confirmation before any Run", async () => {
  const s = await scenario();
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.attempt).not.toBeNull();
  await sh(["init", "-b", "main"], s.dir);
  await expect(run.startEmployeeExecution(out.attempt!.id, { revision: out.attempt!.revision, confirm: true })).rejects.toThrow("permissions changed");
  expect(store.runs.listForTask(s.taskId)).toEqual([]);
});

test("full access requires a separate acknowledgement; a confirmed fake run never retries", async () => {
  const s = await scenario({ mode: "full-access" });
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  expect(out.attempt!.review.permission).toMatchObject({ sandbox: "danger-full-access", network: "unrestricted" });
  const body = { revision: out.attempt!.revision, confirm: true };
  await expect(run.startEmployeeExecution(out.attempt!.id, body)).rejects.toThrow("full-access acknowledgement");
  expect(store.runs.listForTask(s.taskId)).toEqual([]);
  const started = await run.startEmployeeExecution(out.attempt!.id, { ...body, acknowledgeFullAccess: true });
  expect(started.attempt.runId).not.toBeNull();
  expect((await run.startEmployeeExecution(out.attempt!.id, { ...body, acknowledgeFullAccess: true })).replayed).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(store.runs.listForTask(s.taskId)).toHaveLength(1);
});

test("permission changes after the claim and Codex config changes after Review are refused", async () => {
  const s = await scenario();
  const out = await run.reviewEmployeeExecution({ taskId: s.taskId, harnessId: "codex" });
  const started = await run.startEmployeeExecution(out.attempt!.id, { revision: out.attempt!.revision, confirm: true }, {
    afterClaim: () => sh(["init", "-b", "main"], s.dir),
  });
  expect(started.attempt.status).toBe("rejected");
  expect(store.runs.listForTask(s.taskId)).toEqual([]);
  const another = await scenario();
  const review = await run.reviewEmployeeExecution({ taskId: another.taskId, harnessId: "codex" });
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  writeFileSync(path.join(process.env.CODEX_HOME!, "config.toml"), "[sandbox_workspace_write]\nnetwork_access = true\n");
  await expect(run.startEmployeeExecution(review.attempt!.id, { revision: review.attempt!.revision, confirm: true })).rejects.toThrow("permissions changed");
  expect(store.runs.listForTask(another.taskId)).toEqual([]);
});

test("PM recommendations do not assign or run; missing, tampered and stale confirmations cannot assign", async () => {
  const dir = plainProject("pm");
  const taskId = await newTask(dir);
  const employee = worker(dir);
  const { AssignmentProposalCore } = await import("./assignment-proposals.ts");
  const core = new AssignmentProposalCore(store.db, new AssignmentCore(store.db));
  const proposal = core.createFromManager(dir, [{ taskRef: taskId.slice(0, 8), workerRef: employee.id.slice(0, 8), rationale: "Fits the task" }], { messageId: null, delegationId: null }).created[0]!;
  expect(proposal.proposedBy.kind).toBe("project-manager");
  const before = { ...counts(), task: JSON.stringify(store.tasks.get(taskId)) };
  const review = await http(`/assignment-proposals/${proposal.id}/recommendations`);
  expect(review.status).toBe(200);
  expect(review.body.review).toMatchObject({ readOnly: true, executionAvailable: false, automaticSelection: "none" });
  expect(review.body.review.proposed.classification).toBe("potential-unknown");
  expect(review.body.review.proposed.availability).toBe("unknown");
  expect(review.body.review.alternatives.length).toBeLessThanOrEqual(3);
  expect(new AssignmentCore(store.db).forTask(taskId)).toBeNull();
  expect(counts()).toEqual({ runs: before.runs, attempts: before.attempts });
  const body = { expectedRevision: proposal.revision, expectedAssignmentRevision: null, allowReassign: false };
  expect((await http(`/assignment-proposals/${proposal.id}/approve`, body)).status).toBe(409);
  expect((await http(`/assignment-proposals/${proposal.id}/approve`, { ...body, routingReviewToken: review.body.review.reviewToken + "x" })).status).toBe(409);
  setPrefs({ forbiddenModels: [review.body.review.proposed.modelId] });
  expect((await http(`/assignment-proposals/${proposal.id}/approve`, { ...body, routingReviewToken: review.body.review.reviewToken })).status).toBe(409);
  expect(new AssignmentCore(store.db).forTask(taskId)).toBeNull();
  const fresh = await http(`/assignment-proposals/${proposal.id}/recommendations`);
  const approved = await http(`/assignment-proposals/${proposal.id}/approve`, { ...body, routingReviewToken: fresh.body.review.reviewToken });
  expect(approved.status).toBe(200);
  expect(new AssignmentCore(store.db).forTask(taskId)!.employeeId).toBe(employee.id);
  expect(JSON.stringify(store.tasks.get(taskId))).toBe(before.task);
  expect(counts()).toEqual({ runs: before.runs, attempts: before.attempts });
});

test("PM review tokens expire, bind to a single proposal, and retain Unknown when no executor is eligible", async () => {
  const { AssignmentProposalCore } = await import("./assignment-proposals.ts");
  const { assignmentExecutorReview, verifyAssignmentExecutorReview } = await import("./assignment-executor-review.ts");
  const core = new AssignmentProposalCore(store.db, new AssignmentCore(store.db));
  const dir = plainProject("pm-token");
  const employee = worker(dir);
  const taskId = await newTask(dir);
  const proposal = core.createFromManager(dir, [{ taskRef: taskId.slice(0, 8), workerRef: employee.id.slice(0, 8), rationale: "QA" }], { messageId: null, delegationId: null }).created[0]!;
  const now = Date.now();
  const deps = { ...present, now: () => now };
  const first = await assignmentExecutorReview(proposal, deps);
  const fresh = await assignmentExecutorReview(proposal, deps);
  expect(verifyAssignmentExecutorReview(proposal, first.reviewToken, fresh, now)).toBe(true);
  expect(verifyAssignmentExecutorReview(proposal, first.reviewToken, fresh, now + 300_001)).toBe(false);
  expect(verifyAssignmentExecutorReview({ ...proposal, id: crypto.randomUUID() }, first.reviewToken, fresh, now)).toBe(false);
  const unavailable = await assignmentExecutorReview(proposal, { cli: () => ({ available: false, loggedIn: null }) });
  expect(unavailable.proposed).toBeNull();
  expect(unavailable.alternatives).toEqual([]);
  expect(unavailable.automaticSelection).toBe("none");
  expect(new AssignmentCore(store.db).forTask(taskId)).toBeNull();
  expect(store.runs.listForTask(taskId)).toEqual([]);
});

test("actual Codex layout must match the reviewed prediction and known workspace identity", async () => {
  const repo = await gitRepo("actual-review");
  const h = store.harnesses.getByIdOrKind("codex")!;
  const opts = { mode: "full-access", model: "gpt-6-luna", effort: "low" };
  const expected = describePermissions({ kind: "codex", mode: "full-access", layout: "linked-worktree", predicted: true })!;
  await expect(agents.buildCodexCommand(h, "hi", { ...opts, codexPermissionReview: expected }, repo)).rejects.toThrow("differ from Owner Review");
  const linked = path.join(isolated, "actual-linked-" + counter++);
  await sh(["worktree", "add", "-b", "actual-" + counter, linked], repo);
  expect((await agents.buildCodexCommand(h, "hi", { ...opts, codexPermissionReview: expected }, linked)).cmd).toContain("danger-full-access");
  const known = describePermissions({ kind: "codex", mode: "full-access", layout: "linked-worktree" })!;
  await expect(agents.buildCodexCommand(h, "hi", { ...opts, codexPermissionReview: known, codexPermissionIdentity: "stale" }, linked)).rejects.toThrow("differ from Owner Review");
  expect((await agents.buildCodexCommand(h, "hi", { ...opts, codexPermissionReview: known, codexPermissionIdentity: layoutMod.workspacePermissionIdentity({ workdir: linked, isolation: "none", worktreePath: null }, h) }, linked)).cmd).toContain("danger-full-access");
});
