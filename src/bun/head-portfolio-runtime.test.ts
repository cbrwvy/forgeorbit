import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedCoreEnv, isDeniedInheritedEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "../../e2e/isolated-env.ts";

const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo012b-runtime-")));
const fxBin = writeFxStubBin(dataDir); seedIsolatedHarnessHomes(dataDir, fxBin);
const env = isolatedCoreEnv({ dataDir, apiPort: 0, apiToken: crypto.randomUUID(), fxBin,
  extra: { AGETOR_FAKE_PORTFOLIO_DELAY_MS: "100", AGETOR_FAKE_MANAGER_DELAY_MS: "100" } });
for (const key of Object.keys(process.env)) if (isDeniedInheritedEnv(key)) delete process.env[key];
Object.assign(process.env, env);
let store: typeof import("./db.ts");
let pm: typeof import("./portfolio-manager.ts");
let fake: typeof import("./portfolio-manager-fake.ts");
let server: ReturnType<typeof import("./server.ts")["startApiServer"]>;
let base: string;
let consent: string;
async function call(method: string, route: string, body?: unknown, auth = true) {
  const res = await fetch(base + route, { method, headers: { ...(auth ? { authorization: `Bearer ${env.AGETOR_API_TOKEN}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, headers: res.headers, data: await res.json() as any };
}
async function change(employeeId: string | null, revision?: number) {
  const current = await call("GET", "/portfolio-manager/head-binding");
  return call("PUT", "/portfolio-manager/head-binding", { employeeId, revision: revision ?? current.data.revision, confirm: true });
}
async function settle(turnId: string) {
  for (let i = 0; i < 300; i++) {
    const t = pm.getPortfolioTurn(turnId);
    if (t?.status !== "running") return t;
    await Bun.sleep(20);
  }
  throw new Error("Fake turn did not settle.");
}
const state = async () => (await call("GET", "/portfolio-manager")).data;
const head = async (name: string) => (await call("PUT", "/employees/head", { name })).data.employee;
beforeAll(async () => {
  store = await import("./db.ts"); pm = await import("./portfolio-manager.ts"); fake = await import("./portfolio-manager-fake.ts");
  const mod = await import("./server.ts"); server = mod.startApiServer(); base = `http://127.0.0.1:${server.port}`;
  store.harnesses.setEnabled("codex", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  expect(preflight.status).toBe(200); consent = preflight.data.isolation.consentKey;
  expect((await call("PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent } })).status).toBe(200);
});
afterAll(() => server?.stop(true));

test("Owner bearer before parsing, no query tokens, strict schema, body cap, no-store", async () => {
  expect((await call("PUT", "/portfolio-manager/head-binding", "invalid", false)).status).toBe(401);
  expect((await call("GET", `/portfolio-manager/head-binding?token=${env.AGETOR_API_TOKEN}`, undefined, false)).status).toBe(401);
  expect((await call("GET", "/portfolio-manager/head-binding?path=/tmp")).status).toBe(400);
  expect((await call("PUT", "/portfolio-manager/head-binding", { employeeId: null, revision: 0, confirm: true, model: "x" })).status).toBe(400);
  expect((await call("PUT", "/portfolio-manager/head-binding", { payload: "x".repeat(4100) })).status).toBe(413);
  expect((await call("GET", "/portfolio-manager/head-binding")).headers.get("cache-control")).toBe("no-store");
});
test("unbound existing runtime creates unattributed snapshot; old raw history unchanged on Bind and rename, no CLI/account change", async () => {
  const sent = await call("POST", "/portfolio-manager/messages", { text: "Portfolio summary" });
  expect(sent.status).toBe(202); await settle(sent.data.turn.id);
  expect(sent.data.turn.attribution.head).toBeNull();
  const legacy = { id: "legacy", role: "manager", text: "Historical text", createdAt: 1 };
  store.portfolioManagerStore.appendMessage("legacy", JSON.stringify(legacy), 200);
  const before = store.portfolioManagerStore.listMessages();
  const config = store.portfolioManagerStore.getConfig(); const harnesses = store.harnesses.list();
  const counts = { ...fake.fakeTurnLog };
  const h = await head("Morgan");
  const spawn = spyOn(Bun, "spawn"); const spawnSync = spyOn(Bun, "spawnSync");
  try { expect((await change(h.id)).status).toBe(200); expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled(); }
  finally { spawn.mockRestore(); spawnSync.mockRestore(); }
  await call("PATCH", `/employees/${h.id}`, { name: "Morgan renamed" });
  expect(store.portfolioManagerStore.listMessages()).toEqual(before);
  expect(store.portfolioManagerStore.getConfig()).toEqual(config); expect(store.harnesses.list()).toEqual(harnesses);
  expect(fake.fakeTurnLog).toEqual(counts);
  expect((await state()).messages.find((m: any) => m.id === "legacy").attribution).toBeUndefined();
});
test("actual existing turn prompt/job/messages/durable record share exact Head and scope; archive during turn cannot replace author", async () => {
  const s = await state(); const h = s.headBinding.head;
  const sent = await call("POST", "/portfolio-manager/messages", { text: "__fake_portfolio_slow__ Summary", attribution: { head: "forged" } });
  expect(sent.status).toBe(202);
  const attr = sent.data.turn.attribution;
  expect(attr).toMatchObject({ sessionId: "global", head: { employeeId: h.employeeId }, provenance: "owner-confirmed-binding", turnId: sent.data.turn.id });
  expect((await change(null)).status).toBe(409);
  await call("DELETE", `/employees/${h.employeeId}`);
  expect((await call("GET", "/portfolio-manager/head-binding")).data.status).toBe("invalid");
  const replacement = await head("Taylor"); expect((await change(replacement.id)).status).toBe(409);
  await settle(sent.data.turn.id);
  expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain(JSON.stringify(attr));
  const reply = (await state()).messages.filter((m: any) => m.role === "manager").at(-1);
  expect(reply.attribution).toEqual(attr);
  const row = store.db.query<any, [string]>("SELECT * FROM portfolio_manager_turn_attributions WHERE turn_id = ?").get(sent.data.turn.id);
  expect(JSON.parse(row.data)).toEqual(attr);
  expect(JSON.parse(row.requested_runtime)).toMatchObject({ harnessId: "codex", model: "gpt-6.1-sol", actualModel: null, actualAccountId: null });
  const invalid = await call("POST", "/portfolio-manager/messages", { text: "Summary" }); await settle(invalid.data.turn.id);
  expect(invalid.data.turn.attribution).toMatchObject({ bindingStatus: "invalid", head: null });
  expect((await change(replacement.id)).status).toBe(200);
});
test("concurrent Owner HTTP bind and unbind requests serialize stale revisions with one event", async () => {
  const h = (await state()).headBinding.head;
  await change(null);
  let revision = (await call("GET", "/portfolio-manager/head-binding")).data.revision;
  const binds = await Promise.all([change(h.employeeId, revision), change(h.employeeId, revision)]);
  expect(binds.map(r => r.status).sort()).toEqual([200, 409]);
  revision++;
  const unbinds = await Promise.all([change(null, revision), change(null, revision)]);
  expect(unbinds.map(r => r.status).sort()).toEqual([200, 409]);
  await change(h.employeeId);
});
test("delegation → PM → assignment proposal retains exact old Head across change; approvals and knowledge stay independent", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo012b-project-")));
  store.projects.upsert(dir, "Assignment project");
  await call("PUT", "/project-manager/config", { path: dir, config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent } });
  const worker = await call("POST", "/employees", { name: "Ada", jobTitle: "Engineer", projectPath: dir }); expect(worker.status).toBe(201);
  const task = await call("POST", "/tasks", { title: "Write notes", prompt: "Write notes", workdir: dir, isolation: "none", column: "ready" }); expect(task.status).toBe(200);
  const grantsBefore = store.db.query("SELECT * FROM knowledge_context_grants").all();
  const sent = await call("POST", "/portfolio-manager/messages", { text: "Delegate to Assignment project" }); await settle(sent.data.turn.id);
  let s = await state(); const d = s.delegations.at(-1); const attr = sent.data.turn.attribution;
  expect(d.attribution).toEqual(attr); expect(attr.scope.projectPaths).toContain(dir);
  expect(store.projectManagers.listMessages(dir)).toEqual([]);
  // Change Head before approval: pending proposals must retain the source Head.
  await call("DELETE", `/employees/${attr.head.employeeId}`);
  const next = await head("Jordan"); await change(next.id);
  const bad = await call("POST", `/portfolio-manager/delegations/${d.id}/approve`, { revision: d.revision - 1 }); expect(bad.status).toBe(409);
  const approved = await call("POST", `/portfolio-manager/delegations/${d.id}/approve`, { revision: d.revision }); expect(approved.status).toBe(200);
  const owner = JSON.parse(store.projectManagers.getMessage(dir, approved.data.delegation.pmMessageId)!);
  expect(owner.portfolioAttribution).toEqual(attr);
  for (let i = 0; i < 300; i++) { s = await state(); if (s.delegations.find((v: any) => v.id === d.id).status !== "sent") break; await Bun.sleep(20); }
  expect(s.delegations.find((v: any) => v.id === d.id).status).toBe("answered");
  const proposals = store.db.query<any, [string]>("SELECT * FROM assignment_proposals WHERE project_path = ?").all(dir);
  expect(proposals).toHaveLength(1); expect(proposals[0]).toMatchObject({ delegation_id: d.id, status: "pending", proposed_by_kind: "project-manager" });
  expect(store.db.query("SELECT * FROM employee_task_assignments").all()).toEqual([]);
  expect(store.db.query("SELECT * FROM runs").all()).toEqual([]);
  expect(store.db.query("SELECT * FROM knowledge_context_grants").all()).toEqual(grantsBefore);
  const pmReply = store.projectManagers.listMessages(dir).map(v => JSON.parse(v)).find(v => v.role === "manager");
  expect(pmReply.portfolioAttribution).toEqual(attr);
  expect((await call("POST", `/portfolio-manager/delegations/${d.id}/approve`, { revision: d.revision })).data.alreadySent).toBe(true);
});
test("binding changes during delegation send refuse, while rename/archive never mutate provenance", async () => {
  const d = (await state()).delegations.at(-1);
  const proposed = { ...d, id: crypto.randomUUID(), status: "proposed", revision: 1, pmMessageId: null, pmTurnId: null, result: null };
  store.portfolioManagerStore.putDelegation(proposed.id, proposed.projectPath, proposed.messageId, "proposed", JSON.stringify(proposed), Date.now());
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const pending = pm.approveDelegation(proposed.id, { revision: 1 }, {}, async () => {
    await gate; return { ok: false, status: 409, error: "Fake gated refusal" };
  });
  expect((await change(null)).status).toBe(409);
  release(); expect((await pending).ok).toBe(false);
  const stored = JSON.parse(store.portfolioManagerStore.getDelegation(proposed.id)!);
  expect(stored.attribution).toEqual(d.attribution);
});
test("retry under a different binding captures a fresh attempt without rewriting original owner attribution", async () => {
  const first = await call("POST", "/portfolio-manager/messages", { text: "__fake_portfolio_fail__" }); await settle(first.data.turn.id);
  const original = JSON.parse(store.portfolioManagerStore.getMessage(first.data.message.id)!);
  await change(null);
  const retried = await call("POST", "/portfolio-manager/messages", { retryMessageId: original.id }); expect(retried.status).toBe(202); await settle(retried.data.turn.id);
  expect(retried.data.turn.attribution.head).toBeNull();
  expect(JSON.parse(store.portfolioManagerStore.getMessage(original.id)!).attribution).toEqual(original.attribution);
  const rows = store.db.query<any, [string]>("SELECT data FROM portfolio_manager_turn_attributions WHERE message_id = ?").all(original.id);
  expect(rows).toHaveLength(2); expect(rows.map(r => JSON.parse(r.data).head === null).sort()).toEqual([false, true]);
});

test("nonempty Knowledge grant and account registry survive binding changes; notes still require their separate one-turn approval", async () => {
  const h = (await call("GET", "/employees/head")).data.head;
  const note = await call("POST", "/knowledge/documents", { ownerKind: "company", ownerId: "company:forgeorbit", title: "Owner private policy", content: "BINDING_KNOWLEDGE_EXPLICIT_ONLY" });
  expect(note.status).toBe(201);
  const preview = await call("POST", "/knowledge/context/preview", { managerKind: "portfolio", documents: [{ id: note.data.id }] });
  expect(preview.data.canApprove).toBe(true);
  const grant = await call("POST", "/knowledge/context/grants", { managerKind: "portfolio", documents: preview.data.items.map((v: any) => ({ id: v.id, revision: v.revision, sha256: v.sha256 })), previewKey: preview.data.previewKey, confirm: true });
  expect(grant.status).toBe(201);
  const { AccountCore } = await import("./account-core.ts");
  const accounts = new AccountCore(store.db); const account = accounts.createAccount({ provider: "fixture", displayName: "Independent account" }); accounts.bindHarness(account.id, "codex");
  const before = accounts.listAccounts(); const bindings = store.db.query("SELECT * FROM account_harness_bindings").all();
  const grants = store.db.query("SELECT * FROM knowledge_context_grants").all();
  await change(h.id); await change(null); await change(h.id);
  expect(accounts.listAccounts()).toEqual(before); expect(store.db.query("SELECT * FROM account_harness_bindings").all()).toEqual(bindings);
  expect(store.db.query("SELECT * FROM knowledge_context_grants").all()).toEqual(grants);
  const plain = await call("POST", "/portfolio-manager/messages", { text: "Portfolio summary" }); await settle(plain.data.turn.id);
  expect(fake.fakeTurnLog.lastPortfolioPrompt).not.toContain("BINDING_KNOWLEDGE_EXPLICIT_ONLY");
  const granted = await call("POST", "/portfolio-manager/messages", { text: "Read approved policy", knowledgeGrantId: grant.data.grantId });
  expect(granted.status).toBe(202); await settle(granted.data.turn.id);
  expect(fake.fakeTurnLog.lastPortfolioPrompt).toContain("BINDING_KNOWLEDGE_EXPLICIT_ONLY");
  expect(granted.data.turn.attribution.head.employeeId).toBe(h.id);
  expect((await call("POST", "/portfolio-manager/messages", { text: "Reuse grant", knowledgeGrantId: grant.data.grantId })).status).toBe(409);
});

test("two windows targeting different Head UUIDs cannot rebind an archived predecessor", async () => {
  const old = (await call("GET", "/employees/head")).data.head;
  const revision = (await call("GET", "/portfolio-manager/head-binding")).data.revision;
  await call("DELETE", `/employees/${old.id}`); const next = await head("Successor");
  const results = await Promise.all([change(old.id, revision), change(next.id, revision)]);
  expect(results.map(r => r.status)).toEqual([409, 200]);
  const current = (await call("GET", "/portfolio-manager/head-binding")).data;
  expect(current).toMatchObject({ employeeId: next.id, revision: revision + 1, status: "bound" });
  expect(store.db.query<any, [number]>("SELECT COUNT(*) AS n FROM head_portfolio_binding_events WHERE revision > ?").get(revision)).toEqual({ n: 1 });
});
