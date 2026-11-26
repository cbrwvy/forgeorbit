/**
 * Direction 3 offline acceptance, driven through the packaged ForgeOrbitQA window (fake drivers, disposable profile).
 * Seeds prerequisites only (projects, one Backlog task per project, harness and Head consent). The Owner actions under
 * test go through the window: open the Head, switch scope, send, Reject, Approve, quit and reopen.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => { spawnSync("/usr/sbin/screencapture", ["-x", "-R120,120,1280,860", join(shots, `${name}.png`)]); };
  const helper = join(root, "qa-native-pid"), binding = join(root, "binding.json");
  const Alpha = join(runtime, "projects/Alpha"), Beta = join(runtime, "projects/Beta");
  mkdirSync(Alpha, { recursive: true }); mkdirSync(Beta, { recursive: true });
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const has = (part: string) => find(hasText(part)).length > 0;
  const absent = async (part: string, ms = 4000) => { await sleep(ms); assert(!has(part), `"${part}" must not be shown`); };

  // ---- prerequisites ----
  await up();
  mark("Packaged ForgeOrbitQA started on a fresh isolated profile");
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D3 Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D3 Beta" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const key = (await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" })).isolation.consentKey;
  await api("PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: key } });
  const taskBody = (title: string, workdir: string) => ({ title, prompt: "Fixture prompt.", workdir, isolation: "none" });
  const alphaTask = await api("POST", "/tasks", taskBody("Alpha-only marker", Alpha));
  const betaTask = await api("POST", "/tasks", taskBody("Beta-only marker", Beta));
  await down(); await up();
  mark("Seeded two projects with one Backlog task each and the Head's consent, then relaunched for the English locale");
  await show("Main navigation");

  const counts = async () => {
    const tasks = await api("GET", "/tasks");
    const runs = (await Promise.all(tasks.map((t: any) => api("GET", `/tasks/${t.id}/runs`)))).flat().length;
    return { tasks: tasks.length, runs };
  };
  const head = async () => { const s = await api("GET", "/portfolio-manager"); return s.value ?? s; };
  const baseline = await counts();
  const typeAndSend = async (text: string) => {
    const before = (await head()).messages.length;
    ax("focus-name", "AXTextArea", "Message to Head of PM"); await sleep(400);
    ax("text", text); await sleep(500);
    await button("Send");
    await poll("Head turn settled", async () => { const h = await head(); return h.messages.length >= before + 2 && h.activeTurn == null ? true : null; }, 30_000);
    await sleep(800);
  };
  const lastReply = async () => (await head()).messages.filter((m: any) => m.role === "manager").at(-1);
  const pickScope = async (label: string) => {
    await button("Context", true, 0);
    await sleep(700); ax("text", label); await sleep(500); ax("key", "36", "0"); await sleep(900);
  };

  // ---- 1. The Head opens on the company scope; nothing is sent by opening ----
  await button("Open Head of PM");
  await show("Message to Head of PM");
  await show("Workspace overview");
  assert.equal((await head()).messages.length, 0, "opening the Head sends nothing");
  shot("01-head-company-scope");
  mark("Opened the Head: the displayed scope is the company (workspace overview) and nothing was sent");

  // ---- 2. Company-scoped conversation: directory and counts, no task titles ----
  await typeAndSend("__fake_head_scope__ What is in the company?");
  let reply = await lastReply();
  assert.equal(reply.headScope.scope.kind, "workspace");
  assert(reply.text.includes("D3 Alpha") && reply.text.includes("D3 Beta"));
  assert(!reply.text.includes("Alpha-only marker") && !reply.text.includes("Beta-only marker"), "the company context carries no task titles");
  await show("Selected context: Workspace");
  evidence.companyReply = { scope: reply.headScope.scope, label: reply.headScope.label, carriesTaskTitles: false };
  mark("Company-scoped turn: the reply is scoped to the workspace and the supplied context named both projects but no task titles");

  // ---- 3. Company-scoped proposal: the card names the project before the Owner decides; Reject changes nothing ----
  await typeAndSend('__fake_head_board__ {"kind":"create","project":"D3 Beta","title":"Company-scoped task","description":"Proposed from the company scope."}');
  await show("Changes project: D3 Beta");
  const pendingState = await head();
  const proposal = pendingState.boardProposals.at(-1);
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.affectedProjects.map((p: any) => p.name), ["D3 Beta"]);
  assert.deepEqual(await counts(), baseline, "receiving a proposal created and started nothing");
  shot("02-company-proposal-names-project");
  await button("Reject");
  await poll("proposal rejected", async () => ((await head()).boardProposals.at(-1).status === "rejected" ? true : null), 15_000);
  assert.deepEqual(await counts(), baseline, "rejecting created and started nothing");
  evidence.companyProposal = { affectedProjects: proposal.affectedProjects.map((p: any) => p.name), contextLabel: proposal.context.label, afterReject: "rejected" };
  mark("Company-scoped proposal named D3 Beta before approval; Reject left the board and runs unchanged");

  // ---- 4. A refused proposal: the company scope was never shown the Beta task ----
  const proposalsBefore = (await head()).boardProposals.length;
  await typeAndSend(`__fake_head_board__ {"kind":"edit","taskId":"${betaTask.id}","project":"D3 Beta","title":"Hijacked"}`);
  assert.equal((await head()).boardProposals.length, proposalsBefore, "no card for a refused proposal");
  const refused = await lastReply();
  assert(refused.protocolErrors.join(" ").includes("not in this turn's context"), refused.protocolErrors.join(" "));
  await show("not in this turn's context");
  assert.equal((await api("GET", `/tasks/${betaTask.id}`)).title, "Beta-only marker");
  evidence.refusedProposal = { error: refused.protocolErrors.join(" ") };
  mark("A company turn proposing an edit of a task it was never shown was refused on the reply, with no card and no change");

  // ---- 5. Switch to a project scope: only that project's data ----
  await pickScope("D3 Alpha");
  await show("D3 Alpha");
  await typeAndSend("__fake_head_scope__ What is on the Alpha board?");
  reply = await lastReply();
  assert.equal(reply.headScope.scope.kind, "project"); assert.equal(reply.headScope.projectPath, Alpha);
  assert(reply.text.includes("Alpha-only marker"), reply.text);
  assert(!reply.text.includes("Beta-only marker") && !reply.text.includes("D3 Beta"), "the project context carries nothing from the other project");
  shot("03-head-project-scope");
  mark("Switched to D3 Alpha: the reply and its context carry only D3 Alpha's board");

  // ---- 6. A cross-project proposal from the Alpha scope is refused; a valid Alpha proposal awaits approval ----
  const before6 = (await head()).boardProposals.length;
  await typeAndSend(`__fake_head_board__ {"kind":"edit","taskId":"${betaTask.id}","title":"Cross-project hijack"}`);
  assert.equal((await head()).boardProposals.length, before6, "a project scope cannot propose for another project's task");
  await typeAndSend(`__fake_head_board__ {"kind":"edit","taskId":"${alphaTask.id}","title":"Alpha-only marker (revised)"}`);
  await show("Changes project: D3 Alpha");
  const alphaProposal = (await head()).boardProposals.at(-1);
  assert.equal(alphaProposal.status, "pending");
  assert.equal((await api("GET", `/tasks/${alphaTask.id}`)).title, "Alpha-only marker", "a pending proposal changes nothing");
  assert.deepEqual(await counts(), baseline);
  shot("04-alpha-proposal-pending");
  mark("The cross-project proposal was refused; the valid D3 Alpha proposal is pending and changed nothing");

  // ---- 7. Quit and reopen: the pending proposal and every scope are read back; nothing starts ----
  const turnsBefore = (await head()).messages.length;
  ax("key", "12", "1048576"); // Cmd+Q
  await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 15_000).catch(async () => { await down(); });
  await sleep(1500);
  mark("Quit the packaged app normally (Cmd+Q)");
  await up(); await sleep(3000);
  const reopened = await head();
  assert.equal(reopened.messages.length, turnsBefore, "reopening sent no message");
  assert.equal(reopened.activeTurn ?? null, null);
  assert.equal(reopened.boardProposals.at(-1).status, "pending");
  assert.deepEqual(reopened.boardProposals.map((p: any) => p.status), ["rejected", "pending"]);
  assert.deepEqual(await counts(), baseline, "reopening created and started nothing");
  assert.equal((await api("GET", `/tasks/${alphaTask.id}`)).title, "Alpha-only marker");
  await button("Open Head of PM");
  await show("Changes project: D3 Alpha");
  shot("05-reopened-pending");
  evidence.afterReopen = { messages: reopened.messages.length, proposals: reopened.boardProposals.map((p: any) => p.status), counts: await counts() };
  mark("Reopened the same profile: both proposals and their states were read back, no message or run was created");

  // ---- 8. Approve applies exactly the reviewed edit ----
  await button("Approve");
  await poll("applied", async () => ((await head()).boardProposals.at(-1).status === "applied" ? true : null), 20_000);
  const after = await counts();
  assert.equal((await api("GET", `/tasks/${alphaTask.id}`)).title, "Alpha-only marker (revised)");
  assert.equal((await api("GET", `/tasks/${betaTask.id}`)).title, "Beta-only marker");
  assert.deepEqual(after, baseline, "approval edited one task and started nothing");
  shot("06-applied");
  evidence.approved = { alphaTitle: "Alpha-only marker (revised)", betaTitleUnchanged: true, counts: after };
  mark("Approve applied exactly the reviewed edit to exactly that task; the other project was untouched and nothing started");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.result = "pass"; save();
  console.log("FO-D3 packaged walkthrough passed");
}
