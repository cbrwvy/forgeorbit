import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PortfolioManagerState } from "../shared/portfolio-manager.ts";
import type { HeadBoardProposal } from "../shared/head-pm-scope.ts";
import type { Task, Run } from "../shared/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-head-unified01-")));
const profile = join(root, "profile");
const projectA = join(root, "project-alpha");
const projectB = join(root, "project-beta");
mkdirSync(profile, { recursive: true });
mkdirSync(projectA, { recursive: true });
mkdirSync(projectB, { recursive: true });

// Seed simple Git repo or files for worktree/task capability
writeFileSync(join(projectA, "README.md"), "# Project Alpha\n");
writeFileSync(join(projectB, "README.md"), "# Project Beta\n");

const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = socket.port;
socket.stop(true);

const env = {
  AGETOR_API_PORT: String(port),
  AGETOR_DATA_DIR: profile,
  FORGEORBIT_DATA_DIR: profile,
  AGETOR_USAGE_OFFLINE: "1",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_FAKE_QC_VERDICT: "PASS",
  AGETOR_TMUX_BIN: "/bin/echo",
};
Object.assign(process.env, env);

let token: string;
let close: () => void;
let store: typeof import("./db.ts");

async function call<T = unknown>(method: string, route: string, body?: unknown, expected = 200, auth = true): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    result = text;
  }
  expect(response.status, `${method} ${route}: ${text}`).toBe(expected);
  return result as T;
}

async function sendHeadMessage(text: string, scope: object) {
  const sent = await call<{ turn: { id: string } }>("POST", "/portfolio-manager/messages", { text, scope }, 202);
  for (let i = 0; i < 80; i++) {
    const turn = await call<{ status: string }>("GET", `/portfolio-manager/turns/${sent.turn.id}`);
    if (turn.status !== "running") {
      expect(turn.status).toBe("succeeded");
      return call<PortfolioManagerState>("GET", "/portfolio-manager");
    }
    await Bun.sleep(25);
  }
  throw new Error("Fake Head turn did not settle");
}

beforeAll(async () => {
  store = await import("./db.ts");
  const server = await import("./server.ts");
  const api = server.startApiServer();
  close = () => api.stop(true);
  token = server.API_TOKEN;

  store.harnesses.setEnabled("codex", true);
  const preflight = await call<{ isolation: { consentKey: string } }>("POST", "/project-interviews/preflight", {
    harness: "codex",
    model: "gpt-6.1-sol",
    effort: "low",
  });
  const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: preflight.isolation.consentKey };
  await call("PUT", "/portfolio-manager/config", { config });

  store.projects.upsert(projectA, "Alpha");
  store.projects.upsert(projectB, "Beta");
});

afterAll(() => close?.());

test("FO-HEAD-UNIFIED01 Complete 15-step Unified Head of PM Management Workflow", async () => {
  // Step 1: Two disposable projects exist (projectA and projectB).
  expect(store.projects.get(projectA)?.name).toBe("Alpha");
  expect(store.projects.get(projectB)?.name).toBe("Beta");

  // Add Developer specialist to Project A
  const dev = await call<{ id: string; name: string }>("POST", "/employees", {
    name: "Alex Developer",
    jobTitle: "Senior Developer",
    projectPath: projectA,
  }, 201);
  expect(dev.id).toBeDefined();

  // Step 2: Open single Head conversation in Project A scope
  const scopeA = { kind: "project", path: projectA };
  const scopeB = { kind: "project", path: projectB };

  // Step 3: Create and edit a task in Project A
  // 3a. Propose creation
  const createBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "create",
    title: "Implement Navigation Bar",
    description: "Initial specification for responsive navbar.",
  })}`;
  const stateAfterCreateTurn = await sendHeadMessage(createBoardMsg, scopeA);
  const createProposal = stateAfterCreateTurn.boardProposals?.at(-1);
  expect(createProposal).toBeDefined();
  expect(createProposal!.status).toBe("pending");
  expect(createProposal!.action.kind).toBe("create");
  expect(createProposal!.permissions).toContain("Backlog");
  expect(createProposal!.sideEffects).toContain("Backlog");

  // Approve creation
  const approveCreate = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${createProposal!.messageId}/approve`, { confirm: true });
  expect(approveCreate.status).toBe("applied");
  expect(approveCreate.taskId).toBeDefined();
  const taskId = approveCreate.taskId!;
  const taskAfterCreate = store.tasks.get(taskId)!;
  expect(taskAfterCreate.column).toBe("backlog");
  expect(taskAfterCreate.title).toBe("Implement Navigation Bar");

  // 3b. Edit task in Project A
  const editBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "edit",
    taskId,
    title: "Implement Mobile Navigation Bar",
    description: "Updated specification: support mobile drawer navigation.",
  })}`;
  const stateAfterEditTurn = await sendHeadMessage(editBoardMsg, scopeA);
  const editProposal = stateAfterEditTurn.boardProposals?.at(-1);
  expect(editProposal).toBeDefined();
  expect(editProposal!.action.kind).toBe("edit");
  expect(editProposal!.status).toBe("pending");

  // Approve edit
  const approveEdit = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${editProposal!.messageId}/approve`, { confirm: true });
  expect(approveEdit.status).toBe("applied");
  const taskAfterEdit = store.tasks.get(taskId)!;
  expect(taskAfterEdit.title).toBe("Implement Mobile Navigation Bar");
  expect(taskAfterEdit.prompt).toBe("Updated specification: support mobile drawer navigation.");

  // Step 4: Admit it to Inbox through normal authorization
  const admitBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "admit",
    taskId,
  })}`;
  const stateAfterAdmitTurn = await sendHeadMessage(admitBoardMsg, scopeA);
  const admitProposal = stateAfterAdmitTurn.boardProposals?.at(-1);
  expect(admitProposal).toBeDefined();
  expect(admitProposal!.action.kind).toBe("admit");
  expect(admitProposal!.status).toBe("pending");

  const approveAdmit = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${admitProposal!.messageId}/approve`, { confirm: true });
  expect(approveAdmit.status).toBe("applied");
  expect(store.tasks.get(taskId)!.column).toBe("inbox");

  // Step 5: Assign a Developer
  const assignBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "assign",
    taskId,
    employeeId: dev.id,
  })}`;
  const stateAfterAssignTurn = await sendHeadMessage(assignBoardMsg, scopeA);
  const assignProposal = stateAfterAssignTurn.boardProposals?.at(-1);
  expect(assignProposal).toBeDefined();
  expect(assignProposal!.action.kind).toBe("assign");
  expect(assignProposal!.status).toBe("pending");
  expect(assignProposal!.specialistName).toBe("Alex Developer");

  const approveAssign = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${assignProposal!.messageId}/approve`, { confirm: true });
  expect(approveAssign.status).toBe("applied");
  const activeAssignment = store.db.query<{ employee_id: string }, [string]>(
    "SELECT employee_id FROM employee_task_assignments WHERE task_id=? AND status='active'",
  ).get(taskId);
  expect(activeAssignment?.employee_id).toBe(dev.id);

  // Step 6: Prepare and authorize the existing worker workflow
  // Head proposes execute (with stage_ready handled automatically)
  const executeBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "execute",
    taskId,
    employeeId: dev.id,
    harnessId: "codex",
    model: "gpt-6.1-sol",
  })}`;
  const stateAfterExecTurn = await sendHeadMessage(executeBoardMsg, scopeA);
  const execProposal = stateAfterExecTurn.boardProposals?.at(-1);
  expect(execProposal).toBeDefined();
  expect(execProposal!.action.kind).toBe("execute");
  expect(execProposal!.status).toBe("pending");
  expect(execProposal!.policy).toContain("Supervised worker execution");

  // Authorize execution
  const approveExec = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${execProposal!.messageId}/approve`, { confirm: true });
  expect(approveExec.status).toBe("applied");
  expect(approveExec.result).toBeDefined();

  // Step 7: Complete fake Developer execution
  // In fake mode, wait for run to settle and column to move to review
  for (let i = 0; i < 50; i++) {
    const t = store.tasks.get(taskId)!;
    if (t.column === "review") break;
    await Bun.sleep(50);
  }
  const taskAfterExec = store.tasks.get(taskId)!;
  expect(taskAfterExec.column).toBe("review");
  const runs = store.runs.listForTask(taskId);
  expect(runs.length).toBeGreaterThan(0);
  expect(runs[0]!.status).toBe("succeeded");

  // Step 8: Perform fake independent QC
  const qcBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "request_qc",
    taskId,
    reviewerHarness: "codex",
    reviewerModel: "gpt-6.1-sol",
  })}`;
  const stateAfterQcTurn = await sendHeadMessage(qcBoardMsg, scopeA);
  const qcProposal = stateAfterQcTurn.boardProposals?.at(-1);
  expect(qcProposal).toBeDefined();
  expect(qcProposal!.action.kind).toBe("request_qc");
  expect(qcProposal!.status).toBe("pending");
  expect(qcProposal!.policy).toContain("Independent QC policy");

  const approveQc = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${qcProposal!.messageId}/approve`, { confirm: true });
  expect(approveQc.status).toBe("applied");

  // Wait for fake QC to complete (AGETOR_FAKE_QC_VERDICT="PASS")
  for (let i = 0; i < 50; i++) {
    const t = store.tasks.get(taskId)!;
    if (t.qcState?.latestVerdict === "PASS" && t.qcState.awaitingOwnerApproval) break;
    await Bun.sleep(50);
  }
  const taskAfterQc = store.tasks.get(taskId)!;
  expect(taskAfterQc.qcState?.latestVerdict).toBe("PASS");
  expect(taskAfterQc.qcState?.awaitingOwnerApproval).toBe(true);

  // Step 9: Verify task completion through configured policy
  const completeBoardMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "complete",
    taskId,
  })}`;
  const stateAfterCompleteTurn = await sendHeadMessage(completeBoardMsg, scopeA);
  const completeProposal = stateAfterCompleteTurn.boardProposals?.at(-1);
  expect(completeProposal).toBeDefined();
  expect(completeProposal!.action.kind).toBe("complete");
  expect(completeProposal!.status).toBe("pending");

  const approveComplete = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${completeProposal!.messageId}/approve`, { confirm: true });
  expect(approveComplete.status).toBe("applied");
  const finalTask = store.tasks.get(taskId)!;
  expect(finalTask.column).toBe("done");
  expect(finalTask.qcState?.awaitingOwnerApproval).toBe(false);

  // Step 10: Read final result through Head
  const checkTurn = await sendHeadMessage("__fake_head_scope__ status check", scopeA);
  const replyText = checkTurn.messages.at(-1)?.text ?? "";
  expect(replyText).toContain("done");
  expect(replyText).toContain("QC: PASS");

  // Step 11: Switch to Project B in the same conversation
  const checkBetaTurn = await sendHeadMessage("__fake_head_scope__ switch to beta", scopeB);
  const betaReplyText = checkBetaTurn.messages.at(-1)?.text ?? "";
  expect(betaReplyText).not.toContain("Implement Mobile Navigation Bar");
  expect(betaReplyText).toContain("Beta");

  // Step 12: Prepare a separate task and verify independent state
  const createBetaMsg = `__fake_head_board__ ${JSON.stringify({
    kind: "create",
    title: "Project B Database Schema",
    description: "Initial schema for Project Beta.",
  })}`;
  const stateAfterBetaCreateTurn = await sendHeadMessage(createBetaMsg, scopeB);
  const betaCreateProposal = stateAfterBetaCreateTurn.boardProposals?.at(-1);
  expect(betaCreateProposal).toBeDefined();
  const approveBetaCreate = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${betaCreateProposal!.messageId}/approve`, { confirm: true });
  expect(approveBetaCreate.status).toBe("applied");
  const betaTaskId = approveBetaCreate.taskId!;
  const betaTask = store.tasks.get(betaTaskId)!;
  expect(betaTask.column).toBe("backlog");
  expect(betaTask.workdir).toBe(projectB);

  // Independent state verified: Project A has 1 Done task; Project B has 1 Backlog task
  const tasksA = store.tasks.list().filter((t) => t.workdir === projectA);
  const tasksB = store.tasks.list().filter((t) => t.workdir === projectB);
  expect(tasksA.length).toBe(1);
  expect(tasksA[0]!.column).toBe("done");
  expect(tasksB.length).toBe(1);
  expect(tasksB[0]!.column).toBe("backlog");

  // Step 13 & 14: Verify durable history after backend restart & confirm no duplicate worker execution
  // Seed a historical Project Manager message in Project A to verify Step 15
  store.projectManagers.appendMessage(projectA, "legacy-pm-turn", JSON.stringify({
    id: "legacy-pm-turn",
    role: "manager",
    text: "Recorded historical PM conversation from previous milestone.",
  }), Date.now());

  // Perform restart in isolated subprocess
  const restartScript = `
    const { getPortfolioManagerState } = await import("./src/bun/portfolio-manager.ts");
    const { getManagerState } = await import("./src/bun/project-manager.ts");
    const { tasks, runs } = await import("./src/bun/db.ts");
    const head = getPortfolioManagerState();
    const pmA = getManagerState(${JSON.stringify(projectA)});
    const runsCount = runs.listForTask(${JSON.stringify(taskId)}).length;
    const taskRows = tasks.list();
    console.log(JSON.stringify({
      headOk: head.ok,
      boardProposalsCount: head.value.boardProposals.length,
      taskCount: taskRows.length,
      runsCount,
      pmMessage: pmA.value?.messages?.[0]?.text ?? null,
    }));
  `;
  const actualDataDir = store.dataDir;
  const restart = Bun.spawnSync([process.execPath, "--no-env-file", "-e", restartScript], {
    env: { ...env, AGETOR_DATA_DIR: actualDataDir, FORGEORBIT_DATA_DIR: actualDataDir, NODE_ENV: "test", PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: root },
  });
  expect(restart.exitCode, restart.stderr.toString()).toBe(0);
  const restored = JSON.parse(restart.stdout.toString().trim().split("\n").at(-1)!);

  expect(restored.headOk).toBe(true);
  expect(restored.boardProposalsCount).toBeGreaterThanOrEqual(6);
  expect(restored.taskCount).toBe(store.tasks.list().length);
  expect(restored.runsCount).toBe(2); // 1 Developer run + 1 QC run

  // Confirm idempotency / no duplicate execution on re-approval
  const replayApprove = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${execProposal!.messageId}/approve`, { confirm: true });
  expect(replayApprove.status).toBe("applied");
  // Total runs for task did not increase
  expect(store.runs.listForTask(taskId).length).toBe(2);

  // Step 15: Confirm old Project Manager history remains readable
  expect(restored.pmMessage).toBe("Recorded historical PM conversation from previous milestone.");
  const pmRead = await call<{ messages: Array<{ text: string }> }>("GET", `/project-manager?path=${encodeURIComponent(projectA)}`);
  expect(pmRead.messages.some((m) => m.text.includes("Recorded historical PM"))).toBe(true);
});

test("Head execution planning requires the registered project's task-staging approval", async () => {
  const repo = realpathSync(mkdtempSync(join(root, "staging-")));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  writeFileSync(join(repo, "README.md"), "# Planning fixture\n");
  git("init", "-q");
  git("add", "README.md");
  git("-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-qm", "fixture");
  store.projects.upsert(repo, "Staging fixture");
  const { createTask } = await import("./orchestrator.ts");
  const { AssignmentCore } = await import("./assignment-core.ts");
  const worker = await call<{ id: string }>("POST", "/employees", { name: "Fixture Developer", jobTitle: "Developer", projectPath: repo }, 201);
  const created = await createTask({ title: "Plan a fixture edit", prompt: "Edit README.md", workdir: repo, column: "ready", agent: "codex", mode: "auto", isolation: "worktree" });
  if ("error" in created) throw new Error(created.error);
  const task = created.task;
  new AssignmentCore(store.db).assign(task.id, worker.id);

  const state = await sendHeadMessage(`__fake_head_board__ ${JSON.stringify({
    kind: "plan_execution", taskId: task.id, employeeId: worker.id, harnessId: "codex",
  })}`, { kind: "project", path: repo });
  const proposal = state.boardProposals!.at(-1)!;
  const route = `/head-pm/board-proposals/${proposal.messageId}/approve`;
  const refused = await call<HeadBoardProposal>("POST", route, { confirm: true });
  expect(refused.status).toBe("pending");
  expect(refused.error).toContain("developer-execution");
  expect(refused.error).toContain("task-staging");

  const executionPermission = { operation: "developer-execution", scope: "task-staging", outputPaths: ["README.md"], projectPath: projectB };
  const wrong = await call<HeadBoardProposal>("POST", route, { confirm: true, executionPermission });
  expect(wrong.status).toBe("pending");
  expect(wrong.error).toContain("different registered project");
  const { getTaskWorkspace } = await import("./task-workspace.ts");
  expect(getTaskWorkspace(task.id)).toBeNull();

  const allowed = await call<HeadBoardProposal>("POST", route, { confirm: true, executionPermission: { ...executionPermission, projectPath: repo } });
  expect(allowed).toMatchObject({ status: "applied", taskId: task.id });
  expect(getTaskWorkspace(task.id)).toMatchObject({ status: "armed", developerRunId: null, outputPaths: ["README.md"] });
  expect(store.runs.countForTask(task.id)).toBe(0);
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(git("--no-optional-locks", "status", "--porcelain")).toBe("");
});
