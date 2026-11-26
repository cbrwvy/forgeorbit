/**
 * FO-ORCH09 native QA driver. Talks ONLY to the core of a QA app that is
 * already running from a disposable runtime root (credentials come from that
 * root's agetor-core.json, never from the environment). Every agent is a fake
 * driver there; nothing here launches an app or reaches a provider.
 *
 *   bun scripts/qa/orch09-core-scenario.ts <runtime-root> setup
 *   bun scripts/qa/orch09-core-scenario.ts <runtime-root> verify
 *
 * `setup` walks Owner goal -> plan -> tasks -> assignments -> queue -> batch ->
 * bounded grant -> start and stops with the first task waiting in Review.
 * `verify` (after a restart) checks what persisted, resumes nothing by itself
 * and then accepts the first task, which unblocks the next ones.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const phase = process.argv[3];
if (!root || !path.isAbsolute(root) || !["setup", "verify"].includes(phase ?? "")) throw new Error("usage: orch09-core-scenario.ts <runtime-root> setup|verify");
const credsFile = path.join(root, "data/agetor-core.json");
if (!existsSync(credsFile)) throw new Error("no running QA core (agetor-core.json missing)");
const creds = JSON.parse(readFileSync(credsFile, "utf8")) as { port: number; token: string; pid: number };
const base = `http://127.0.0.1:${creds.port}`;
const project = path.join(root, "projects");
// The QA stub reports codex 0.0.0-qa, below the GPT-6 CLI floors; GPT-5.6 Sol has none.
const NO_FLOOR_MODEL = "gpt-5.6-sol";
const out: Record<string, unknown> = { phase, corePid: creds.pid };

async function api(method: string, route: string, data?: unknown, expect?: number): Promise<any> {
  const res = await fetch(base + route, {
    method,
    headers: { authorization: `Bearer ${creds.token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await res.text();
  if (expect !== undefined ? res.status !== expect : !res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const q = `path=${encodeURIComponent(project)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | false | undefined>, label: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
}
const tasksNow = async () => ((await api("GET", "/tasks")) as any[]).filter((t) => t.workdir === project);
const runsOf = async (id: string) => (await api("GET", `/tasks/${id}/runs`)) as any[];

if (phase === "setup") {
  await api("PATCH", "/harnesses/codex", { enabled: true });
  // PM agent + the Owner's consent to its isolation (what the UI checkbox stores).
  const state = await api("GET", `/project-manager?${q}`);
  await api("PUT", "/project-manager/config", { path: project, config: { ...state.config, harness: "codex", model: NO_FLOOR_MODEL, consentKey: null } });
  const preflight = await api("POST", "/project-manager/preflight", { path: project });
  await api("PUT", "/project-manager/config", { path: project, config: { ...state.config, harness: "codex", model: NO_FLOOR_MODEL, consentKey: preflight.isolation.consentKey } });
  out.manager = { harness: preflight.harness.id, model: preflight.model };

  const existing = await api("GET", `/project-manager?${q}`);
  if (!(existing.proposals as any[]).some((p) => p.status === "pending")) {
    await api("POST", "/project-manager/messages", { path: project, text: "Разработать небольшой REST API с авторизацией, тестами и документацией" });
    await until(async () => (await api("GET", `/project-manager?${q}`)).activeTurn === null, "PM turn");
  }
  const after = await api("GET", `/project-manager?${q}`);
  const proposal = (after.proposals as any[]).find((p) => p.status === "pending");
  if (!proposal) throw new Error("no pending proposal");
  if ((await tasksNow()).length !== 0) throw new Error("tasks exist before approval");
  await api("POST", `/project-manager/proposals/${proposal.id}/approve`, { path: project, revision: proposal.revision, items: (proposal.items as any[]).map((item) => ({ id: item.id, include: true })) });
  const tasks = await tasksNow();
  const by = (title: string) => tasks.find((t) => t.title === title)!.id as string;
  const [A, B, C, D] = ["Design the API", "Implement the API", "Write the API tests", "Prepare the API documentation"].map(by);
  out.tasks = { A, B, C, D, count: tasks.length, columns: tasks.map((t) => t.column) };
  for (const id of [A, B, C, D]) await api("PATCH", `/tasks/${id}`, { agent: "codex" });
  await sleep(700);
  for (const id of [A, B, C, D]) await api("PATCH", `/tasks/${id}`, { model: NO_FLOOR_MODEL, mode: "ask" });

  const ada = await api("POST", "/employees", { name: "Ada", jobTitle: "API Architect", projectPath: project }, 201);
  for (const id of [A, B, C, D]) await api("POST", "/task-assignments", { taskId: id, employeeId: ada.id }, 201);
  const plans = await api("GET", `/project-manager/plans?${q}`);
  const proposalId = plans.plans[0].proposalId as string;
  const plan = await api("GET", `/project-manager/plans/${proposalId}?${q}`);
  out.plan = { counts: plan.counts, states: plan.nodes.map((n: any) => `${n.title}:${n.state}`) };
  const queue = (await api("PUT", `/project-manager/plans/${proposalId}/queue`, { path: project, taskIds: [A], planKey: plan.planKey }, 200)).queue;
  const draft = (await api("POST", `/project-manager/queues/${queue.id}/batch`, { path: project, revision: queue.revision, planKey: plan.planKey, policy: { noOverageHarnessIds: ["codex"] } }, 201)).batch;
  const approved = (await api("POST", `/project-manager/batches/${draft.id}/approve`, { path: project, revision: draft.revision, previewKey: draft.preview.key, acknowledgedHarnessIds: draft.preview.spendingHarnessIds }, 200)).batch;
  const granted = (await api("POST", `/project-manager/batches/${approved.id}/autonomy`, { path: project, confirm: true, previewKey: approved.approval.previewKey, acknowledgeUnknownQuota: true, maxRuns: 2, maxParallelism: 1, ttlMinutes: 60 }, 200)).batch;
  if ((await runsOf(A)).length !== 0) throw new Error("a grant started a run");
  await api("POST", `/project-manager/batches/${granted.id}/start`, { path: project }, 200);
  await until(async () => (await api("GET", `/project-manager/batches/${granted.id}?${q}`)).entries[0].state === "review", "A in review");
  const view = await api("GET", `/project-manager/batches/${granted.id}?${q}`);
  out.stage1 = { batchId: granted.id, proposalId, batchStatus: view.status, grant: view.autonomy.status, runsUsed: view.autonomyView.runsUsed, runsOfA: (await runsOf(A)).length, runsOfOthers: (await runsOf(B)).length + (await runsOf(C)).length + (await runsOf(D)).length };
  out.ids = { A, B, C, D, batchId: granted.id, proposalId };
} else {
  const ids = JSON.parse(readFileSync(path.join(root, "../evidence/orch09-ids.json"), "utf8"));
  const { A, B, C, D, batchId, proposalId } = ids as Record<string, string>;
  const view = await api("GET", `/project-manager/batches/${batchId}?${q}`);
  out.persisted = {
    batchStatus: view.status, reason: view.reason?.code ?? null, grant: view.autonomy?.status, runsUsed: view.autonomyView?.runsUsed,
    runs: { A: (await runsOf(A)).length, B: (await runsOf(B)).length, C: (await runsOf(C)).length, D: (await runsOf(D)).length },
    columnA: (await api("GET", `/tasks/${A}`)).column,
  };
  const journal = async (t: string) => (((await api("GET", `/activity?eventType=${encodeURIComponent(t)}`)).events ?? []) as any[]).filter((e) => e.eventType === t).length;
  out.journal = { granted: await journal("autonomy.grant.approved"), started: await journal("autonomy.execution.started"), queueConfirmed: await journal("queue.plan.confirmed"), handoff: await journal("queue.handoff.prepared") };
  // Accept A (Owner action), then B and D become ready; C stays blocked on B.
  const executions = (await api("GET", `/project-manager/executions?${q}`)) as any[];
  const exec = executions.find((e) => e.taskId === A && e.batchId === batchId);
  await api("POST", `/project-manager/executions/${exec.id}/review`, { path: project, action: "accept" }, 200);
  const plan = await api("GET", `/project-manager/plans/${proposalId}?${q}`);
  out.afterAccept = { states: plan.nodes.map((n: any) => `${n.title}:${n.state}`), runsOfB: (await runsOf(B)).length, runsOfD: (await runsOf(D)).length, runsOfC: (await runsOf(C)).length };
}
console.log(JSON.stringify(out, null, 1));
