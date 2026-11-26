import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PortfolioManagerState } from "../shared/portfolio-manager.ts";
import type { HeadBoardProposal } from "../shared/head-pm-scope.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "fo-head-edit-")));
const profile = join(root, "profile");
const project = join(root, "fo-head-edit-proj");
mkdirSync(project);

const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = socket.port;
socket.stop(true);

Object.assign(process.env, {
  AGETOR_API_PORT: String(port),
  AGETOR_DATA_DIR: profile,
  FORGEORBIT_DATA_DIR: profile,
  AGETOR_USAGE_OFFLINE: "1",
  AGETOR_CODEX_DRIVER: "fake",
  AGETOR_CODEX_BIN: "/bin/echo",
  AGETOR_TMUX_BIN: "/bin/echo",
  FORGEORBIT_EMBEDDING_MODEL_ROOT: "/nonexistent/no-model-fixture",
});

let token: string;
let close: () => void;
let store: typeof import("./db.ts");
let orchestrator: typeof import("./orchestrator.ts");
let fake: typeof import("./portfolio-manager-fake.ts").fakeTurnLog;
let headBoard: typeof import("./head-board-proposals.ts");
let headScope: typeof import("./head-pm-scope.ts");

const scope = { kind: "project", path: project } as const;
const ORIGINAL_PROMPT = "Add `export function subtract(a: number, b: number): number { return a - b; }` to src/index.ts.";

async function call<T = any>(method: string, route: string, body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.status, `${method} ${route}: ${JSON.stringify(result)}`).toBe(expected);
  return result as T;
}

async function sendBoard(action: Record<string, unknown>): Promise<PortfolioManagerState> {
  const sent = await call<{ turn: { id: string } }>(
    "POST",
    "/portfolio-manager/messages",
    { text: `__fake_head_board__ ${JSON.stringify(action)}`, scope },
    202,
  );
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

async function addTask(title: string, prompt = ORIGINAL_PROMPT) {
  const made = await orchestrator.createTask({
    title,
    prompt,
    workdir: project,
    column: "backlog",
    agent: "codex",
    model: "gpt-6-luna",
    isolation: "none",
  } as never);
  if ("error" in made) throw new Error(made.error);
  return made.task;
}

function runCount(): number {
  return store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n;
}

function rawProposalRow(messageId: string): { status: string; action_json: string; error: string | null } | null {
  return store.db.query<{ status: string; action_json: string; error: string | null }, [string]>(
    "SELECT status, action_json, error FROM head_board_proposals WHERE message_id = ?",
  ).get(messageId);
}

function insertManagerMessage(text: string, snapshot: unknown): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const maxSeq = store.db.query<{ s: number | null }, []>("SELECT MAX(seq) AS s FROM portfolio_manager_messages").get()?.s ?? 0;
  const data = {
    id,
    role: "manager",
    text,
    createdAt: now,
    status: null,
    error: null,
    planId: null,
    delegationIds: [],
    initiativeProposalId: null,
    protocolErrors: [],
    suggestedDecisions: [],
    sources: [],
    delegationId: null,
    headScope: snapshot,
  };
  store.db.run(
    "INSERT INTO portfolio_manager_messages (id, seq, data, created_at) VALUES (?, ?, ?, ?)",
    [id, maxSeq + 1, JSON.stringify(data), now],
  );
  return id;
}

beforeAll(async () => {
  store = await import("./db.ts");
  orchestrator = await import("./orchestrator.ts");
  fake = (await import("./portfolio-manager-fake.ts")).fakeTurnLog;
  headBoard = await import("./head-board-proposals.ts");
  headScope = await import("./head-pm-scope.ts");
  const server = await import("./server.ts");
  const api = server.startApiServer();
  close = () => api.stop(true);
  token = server.API_TOKEN;
  store.harnesses.setEnabled("codex", true);
  const preflight = await call<{ isolation: { consentKey: string } }>("POST", "/project-interviews/preflight", {
    harness: "codex",
    model: "gpt-6-luna",
    effort: "low",
  });
  await call("PUT", "/portfolio-manager/config", {
    config: { harness: "codex", model: "gpt-6-luna", effort: "low", consentKey: preflight.isolation.consentKey },
  });
  store.projects.upsert(project, "Head Edit Fixture");
});

afterAll(() => close?.());

test("1. rename with omitted description changes only title and preserves task.prompt byte-for-byte", async () => {
  const task = await addTask("Add subtract helper");
  const state = await sendBoard({
    kind: "edit",
    taskId: task.id,
    title: "Add subtract helper function",
  });
  const proposal = state.boardProposals!.at(-1)!;
  expect(proposal.status).toBe("pending");
  expect(proposal.action).toEqual({
    kind: "edit",
    taskId: task.id,
    title: "Add subtract helper function",
  });
  expect(Object.hasOwn(proposal.action, "description")).toBe(false);
  expect(proposal.editPreview).toMatchObject({
    taskId: task.id,
    currentTitle: "Add subtract helper",
    nextTitle: "Add subtract helper function",
    titleChanged: true,
    descriptionStatus: "unchanged",
  });
  expect(proposal.sideEffects).not.toMatch(/prompt|description.*update/i);

  const turnsBefore = fake.portfolio;
  const runsBefore = runCount();
  const approved = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${proposal.messageId}/approve`, { confirm: true });
  expect(approved.status).toBe("applied");
  const updated = store.tasks.get(task.id)!;
  expect(updated.title).toBe("Add subtract helper function");
  expect(updated.prompt).toBe(ORIGINAL_PROMPT);
  expect(fake.portfolio).toBe(turnsBefore);
  expect(runCount()).toBe(runsBefore);
});

test("2. rename with blank or whitespace-only description normalizes to title-only and never erases task.prompt", async () => {
  // Exact §10 failure shape: { kind: "edit", taskId, title, description: "" }
  const taskEmpty = await addTask("Add subtract helper");
  const stateEmpty = await sendBoard({
    kind: "edit",
    taskId: taskEmpty.id,
    title: "Add subtract helper function",
    description: "",
  });
  const proposalEmpty = stateEmpty.boardProposals!.at(-1)!;
  expect(proposalEmpty.status).toBe("pending");
  expect(proposalEmpty.action).toEqual({
    kind: "edit",
    taskId: taskEmpty.id,
    title: "Add subtract helper function",
  });
  expect(Object.hasOwn(proposalEmpty.action, "description")).toBe(false);
  expect(JSON.parse(rawProposalRow(proposalEmpty.messageId)!.action_json)).toEqual({
    kind: "edit",
    taskId: taskEmpty.id,
    title: "Add subtract helper function",
  });
  expect(proposalEmpty.editPreview).toMatchObject({
    taskId: taskEmpty.id,
    currentTitle: "Add subtract helper",
    nextTitle: "Add subtract helper function",
    titleChanged: true,
    descriptionStatus: "unchanged",
  });

  const approvedEmpty = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${proposalEmpty.messageId}/approve`, { confirm: true });
  expect(approvedEmpty.status).toBe("applied");
  expect(store.tasks.get(taskEmpty.id)!.title).toBe("Add subtract helper function");
  expect(store.tasks.get(taskEmpty.id)!.prompt).toBe(ORIGINAL_PROMPT);

  // Whitespace-only description and blank prompt alias behave identically.
  const taskWs = await addTask("Add multiply helper");
  const stateWs = await sendBoard({
    kind: "edit",
    taskId: taskWs.id,
    title: "Add multiply helper function",
    description: "   \n\t  ",
  });
  const proposalWs = stateWs.boardProposals!.at(-1)!;
  expect(Object.hasOwn(proposalWs.action, "description")).toBe(false);
  expect(proposalWs.editPreview).toMatchObject({
    currentTitle: "Add multiply helper",
    nextTitle: "Add multiply helper function",
    titleChanged: true,
    descriptionStatus: "unchanged",
  });
  const approvedWs = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${proposalWs.messageId}/approve`, { confirm: true });
  expect(approvedWs.status).toBe("applied");
  expect(store.tasks.get(taskWs.id)!.title).toBe("Add multiply helper function");
  expect(store.tasks.get(taskWs.id)!.prompt).toBe(ORIGINAL_PROMPT);

  const taskPromptAlias = await addTask("Add divide helper");
  const stateAlias = await sendBoard({
    kind: "edit",
    taskId: taskPromptAlias.id,
    title: "Add divide helper function",
    prompt: "  \t ",
  });
  const proposalAlias = stateAlias.boardProposals!.at(-1)!;
  expect(Object.hasOwn(proposalAlias.action, "description")).toBe(false);
  await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${proposalAlias.messageId}/approve`, { confirm: true });
  expect(store.tasks.get(taskPromptAlias.id)!.title).toBe("Add divide helper function");
  expect(store.tasks.get(taskPromptAlias.id)!.prompt).toBe(ORIGINAL_PROMPT);
});

test("3. blank description without another valid change and invalid field types create no actionable proposal", async () => {
  const task = await addTask("Unchanged task title");
  const cases: Array<Record<string, unknown>> = [
    { kind: "edit", taskId: task.id, description: "" },
    { kind: "edit", taskId: task.id, description: "   \n\t  " },
    { kind: "edit", taskId: task.id, prompt: "" },
    { kind: "edit", taskId: task.id, title: "Unchanged task title", description: "" },
    { kind: "edit", taskId: task.id, title: "   ", description: "   " },
    { kind: "edit", taskId: task.id, title: "Unchanged task title" },
    // Non-string types must never be coerced to strings.
    { kind: "edit", taskId: task.id, title: "Renamed with null desc", description: null },
    { kind: "edit", taskId: task.id, title: "Renamed with numeric desc", description: 42 },
    { kind: "edit", taskId: task.id, title: "Renamed with array desc", description: ["x"] },
    { kind: "edit", taskId: task.id, title: "Renamed with null prompt", prompt: null },
    { kind: "edit", taskId: task.id, title: null, description: "Valid description" },
    { kind: "edit", taskId: task.id, title: 123, description: "Valid description" },
    { kind: "edit", taskId: task.id, description: "Desc A", prompt: "Desc B" },
  ];

  const beforeProposals = ((await call<PortfolioManagerState>("GET", "/portfolio-manager")).boardProposals ?? []).length;
  for (const payload of cases) {
    const state = await sendBoard(payload);
    expect((state.boardProposals ?? []).length, `payload should not create a proposal: ${JSON.stringify(payload)}`).toBe(beforeProposals);
    expect(state.messages.at(-1)!.protocolErrors.length, `payload should record protocolError: ${JSON.stringify(payload)}`).toBeGreaterThan(0);
  }
  const afterTask = store.tasks.get(task.id)!;
  expect(afterTask.title).toBe("Unchanged task title");
  expect(afterTask.prompt).toBe(ORIGINAL_PROMPT);
});

test("4. already-stored pending proposal with blank description refuses approval, keeps row unrewritten, allows rejection, and preserves historical rows", async () => {
  const task = await addTask("Legacy pending task");
  const resolved = headScope.resolveHeadScope(scope, "canonical");
  if (!resolved.ok) throw new Error(resolved.error);

  // Create a real manager message to anchor the stored legacy pending proposal.
  const msgId = insertManagerMessage("Legacy reply claiming description is unchanged.", resolved.value);
  const now = Date.now();
  const unsafeActionJson = JSON.stringify({
    kind: "edit",
    taskId: task.id,
    title: "Legacy renamed task",
    description: "",
  });
  store.db.run(
    `INSERT INTO head_board_proposals (message_id, context_json, action_json, status, created_at, updated_at, error)
     VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
    [msgId, JSON.stringify(resolved.value), unsafeActionJson, now, now],
  );

  // Reading state marks it unsafe-blank without mutating stored action_json.
  const state = await call<PortfolioManagerState>("GET", "/portfolio-manager");
  const legacy = state.boardProposals!.find((p) => p.messageId === msgId)!;
  expect(legacy.status).toBe("pending");
  expect(rawProposalRow(msgId)!.action_json).toBe(unsafeActionJson);

  // Approval MUST be refused (409), task MUST NOT change, stored action_json MUST NOT be silently rewritten, and status stays pending for rejection.
  const turnsBefore = fake.portfolio;
  const runsBefore = runCount();
  const refused = await call<{ error: string }>("POST", `/head-pm/board-proposals/${msgId}/approve`, { confirm: true }, 409);
  expect(refused.error).toMatch(/empty|blank|erase|prompt|description/i);
  expect(store.tasks.get(task.id)!.title).toBe("Legacy pending task");
  expect(store.tasks.get(task.id)!.prompt).toBe(ORIGINAL_PROMPT);
  expect(rawProposalRow(msgId)!.status).toBe("pending");
  expect(rawProposalRow(msgId)!.action_json).toBe(unsafeActionJson);
  expect(legacy.editPreview).toMatchObject({
    taskId: task.id,
    currentTitle: "Legacy pending task",
    nextTitle: "Legacy renamed task",
    descriptionStatus: "unsafe-blank",
  });

  // Rejection MUST still succeed and leave the task untouched with 0 extra launches.
  const rejected = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${msgId}/reject`, { confirm: true });
  expect(rejected.status).toBe("rejected");
  expect(store.tasks.get(task.id)!.title).toBe("Legacy pending task");
  expect(store.tasks.get(task.id)!.prompt).toBe(ORIGINAL_PROMPT);
  expect(rawProposalRow(msgId)!.action_json).toBe(unsafeActionJson);
  expect(fake.portfolio).toBe(turnsBefore);
  expect(runCount()).toBe(runsBefore);

  // Whitespace-only already-stored pending proposal is also refused without mutation and remains rejectable.
  const wsMsgId = insertManagerMessage("Legacy whitespace description proposal.", resolved.value);
  const wsUnsafeJson = JSON.stringify({
    kind: "edit",
    taskId: task.id,
    title: "Legacy ws rename",
    description: "  \n\t  ",
  });
  store.db.run(
    `INSERT INTO head_board_proposals (message_id, context_json, action_json, status, created_at, updated_at, error)
     VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
    [wsMsgId, JSON.stringify(resolved.value), wsUnsafeJson, now + 1, now + 1],
  );
  await call<{ error: string }>("POST", `/head-pm/board-proposals/${wsMsgId}/approve`, { confirm: true }, 409);
  expect(store.tasks.get(task.id)!.prompt).toBe(ORIGINAL_PROMPT);
  expect(rawProposalRow(wsMsgId)!.status).toBe("pending");
  expect(rawProposalRow(wsMsgId)!.action_json).toBe(wsUnsafeJson);
  expect((await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${wsMsgId}/reject`, { confirm: true })).status).toBe("rejected");

  // Historical already-rejected and already-applied rows remain untouched.
  const appliedMsgId = insertManagerMessage("Historical applied edit.", resolved.value);
  store.db.run(
    `INSERT INTO head_board_proposals (message_id, context_json, action_json, status, task_id, created_at, updated_at, error)
     VALUES (?, ?, ?, 'applied', ?, ?, ?, NULL)`,
    [appliedMsgId, JSON.stringify(resolved.value), unsafeActionJson, task.id, now + 2, now + 2],
  );
  const replayed = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${appliedMsgId}/approve`, { confirm: true });
  expect(replayed.status).toBe("applied");
  expect(rawProposalRow(appliedMsgId)!.action_json).toBe(unsafeActionJson);
  expect(rawProposalRow(appliedMsgId)!.status).toBe("applied");

  const histRejectedId = insertManagerMessage("Historical rejected edit.", resolved.value);
  store.db.run(
    `INSERT INTO head_board_proposals (message_id, context_json, action_json, status, task_id, created_at, updated_at, error)
     VALUES (?, ?, ?, 'rejected', NULL, ?, ?, NULL)`,
    [histRejectedId, JSON.stringify(resolved.value), unsafeActionJson, now + 3, now + 3],
  );
  expect((await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${histRejectedId}/reject`, { confirm: true })).status).toBe("rejected");
  expect(rawProposalRow(histRejectedId)!.action_json).toBe(unsafeActionJson);
  expect(rawProposalRow(histRejectedId)!.status).toBe("rejected");

  // Direct saveHeadBoardDraft defense-in-depth never persists an unsafe edit as pending.
  const directUnsafeId = insertManagerMessage("Direct unsafe draft.", resolved.value);
  headBoard.saveHeadBoardDraft(directUnsafeId, resolved.value, { kind: "edit", taskId: task.id, title: "Direct unsafe", description: "" });
  expect(rawProposalRow(directUnsafeId)!.status).toBe("failed");
  await call<{ error: string }>("POST", `/head-pm/board-proposals/${directUnsafeId}/approve`, { confirm: true }, 409);
  expect(store.tasks.get(task.id)!.prompt).toBe(ORIGINAL_PROMPT);
});

test("5. valid non-empty description edit (description-only and title+description) previews and applies reviewed fields", async () => {
  const taskDescOnly = await addTask("Keep exact title", "Old instructions v1.");
  const stateDescOnly = await sendBoard({
    kind: "edit",
    taskId: taskDescOnly.id,
    description: "New implementation instructions v2.\nKeep edge cases covered.",
  });
  const propDescOnly = stateDescOnly.boardProposals!.at(-1)!;
  expect(propDescOnly.status).toBe("pending");
  expect(propDescOnly.action).toEqual({
    kind: "edit",
    taskId: taskDescOnly.id,
    title: "Keep exact title",
    description: "New implementation instructions v2.\nKeep edge cases covered.",
  });
  expect(propDescOnly.editPreview).toMatchObject({
    taskId: taskDescOnly.id,
    currentTitle: "Keep exact title",
    nextTitle: "Keep exact title",
    titleChanged: false,
    currentDescription: "Old instructions v1.",
    nextDescription: "New implementation instructions v2.\nKeep edge cases covered.",
    descriptionStatus: "updated",
  });
  // Task stays unchanged before approval.
  expect(store.tasks.get(taskDescOnly.id)!.prompt).toBe("Old instructions v1.");

  const approvedDescOnly = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${propDescOnly.messageId}/approve`, { confirm: true });
  expect(approvedDescOnly.status).toBe("applied");
  expect(store.tasks.get(taskDescOnly.id)!.title).toBe("Keep exact title");
  expect(store.tasks.get(taskDescOnly.id)!.prompt).toBe("New implementation instructions v2.\nKeep edge cases covered.");

  // Combined title + description edit.
  const taskBoth = await addTask("Old combined title", "Old combined prompt.");
  const stateBoth = await sendBoard({
    kind: "edit",
    taskId: taskBoth.id,
    title: "New combined title",
    description: "New combined prompt.",
  });
  const propBoth = stateBoth.boardProposals!.at(-1)!;
  expect(propBoth.editPreview).toMatchObject({
    currentTitle: "Old combined title",
    nextTitle: "New combined title",
    titleChanged: true,
    currentDescription: "Old combined prompt.",
    nextDescription: "New combined prompt.",
    descriptionStatus: "updated",
  });
  const approvedBoth = await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${propBoth.messageId}/approve`, { confirm: true });
  expect(approvedBoth.status).toBe("applied");
  expect(store.tasks.get(taskBoth.id)!.title).toBe("New combined title");
  expect(store.tasks.get(taskBoth.id)!.prompt).toBe("New combined prompt.");
});

test("6. contradicting model prose never overrides the validated structured action in preview or application", async () => {
  const task = await addTask("Prose mismatch target", "Original preserved prompt.");
  const resolved = headScope.resolveHeadScope(scope, "canonical");
  if (!resolved.ok) throw new Error(resolved.error);
  const gathered = headScope.gatherScopedHeadContext(resolved.value);

  // Case A: Prose falsely says description is unchanged, while structured action carries a real non-empty description change.
  const replyWithRealDesc = [
    "<reply>I am ONLY renaming this task and leaving its description completely unchanged.</reply>",
    `<head_board_action>${JSON.stringify({
      kind: "edit",
      taskId: task.id,
      title: "Prose mismatch renamed",
      description: "Actual changed prompt from structured action.",
    })}</head_board_action>`,
  ].join("\n");
  const draftA = headBoard.readHeadBoardDraft(replyWithRealDesc, gathered, false);
  expect(draftA.ok).toBe(true);
  if (!draftA.ok || !draftA.value) throw new Error("expected draft");
  const msgA = insertManagerMessage("I am ONLY renaming this task and leaving its description completely unchanged.", resolved.value);
  headBoard.saveHeadBoardDraft(msgA, resolved.value, draftA.value);
  const propA = ((await call<PortfolioManagerState>("GET", "/portfolio-manager")).boardProposals ?? []).find((p) => p.messageId === msgA)!;
  expect(propA.editPreview).toMatchObject({
    currentTitle: "Prose mismatch target",
    nextTitle: "Prose mismatch renamed",
    titleChanged: true,
    currentDescription: "Original preserved prompt.",
    nextDescription: "Actual changed prompt from structured action.",
    descriptionStatus: "updated",
  });

  // Case B: Prose claims it cleared/changed the description, while structured action has blank description -> normalized to title-only.
  const replyWithBlankDesc = [
    "<reply>I updated the title and rewrote the description to clear old instructions.</reply>",
    `<head_board_action>${JSON.stringify({
      kind: "edit",
      taskId: task.id,
      title: "Prose mismatch safe rename",
      description: "",
    })}</head_board_action>`,
  ].join("\n");
  const draftB = headBoard.readHeadBoardDraft(replyWithBlankDesc, gathered, false);
  expect(draftB.ok).toBe(true);
  if (!draftB.ok || !draftB.value) throw new Error("expected draft");
  expect(Object.hasOwn(draftB.value, "description")).toBe(false);
  const msgB = insertManagerMessage("I updated the title and rewrote the description to clear old instructions.", resolved.value);
  headBoard.saveHeadBoardDraft(msgB, resolved.value, draftB.value);
  const propB = ((await call<PortfolioManagerState>("GET", "/portfolio-manager")).boardProposals ?? []).find((p) => p.messageId === msgB)!;
  expect(propB.editPreview).toMatchObject({
    currentTitle: "Prose mismatch target",
    nextTitle: "Prose mismatch safe rename",
    titleChanged: true,
    descriptionStatus: "unchanged",
  });
  await call<HeadBoardProposal>("POST", `/head-pm/board-proposals/${msgB}/approve`, { confirm: true });
  expect(store.tasks.get(task.id)!.title).toBe("Prose mismatch safe rename");
  expect(store.tasks.get(task.id)!.prompt).toBe("Original preserved prompt.");
});

test("7. ordinary manual editing via PATCH /tasks/:id remains intact", async () => {
  const task = await addTask("Manual edit task", "Initial manual prompt.");
  const patched = await call<{ title: string; prompt: string }>("PATCH", `/tasks/${task.id}`, {
    title: "Manual edit task renamed",
    prompt: "Explicit manual prompt edit.",
  });
  expect(patched.title).toBe("Manual edit task renamed");
  expect(patched.prompt).toBe("Explicit manual prompt edit.");
  const cleared = await call<{ prompt: string }>("PATCH", `/tasks/${task.id}`, { prompt: "" });
  expect(cleared.prompt).toBe("");
});
