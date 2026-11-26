/**
 * Direction 17 (Brain and long-term agent memory): one connected flow in the packaged ForgeOrbitQA window
 * (fake drivers, disposable profile, no provider, no network).
 *
 *   1. Capture and review. Two Done tasks (seeded, then moved to Done through the production route, so the
 *      production extraction hook runs) become pending candidates. In the window: the candidate list shows source
 *      and scope; a pending candidate is not a memory; Reject one; Approve & Save the other.
 *   2. Find it later. Search the Memory page (text, then meaning); restart the app; search again.
 *   3. Reuse with the right scope. Two projects with distinct markers. A Head turn with no grant receives no memory;
 *      a one-message grant delivers exactly the Alpha record; the Beta marker is absent; a replay is refused.
 *   4. Lexical-only. The sanctioned model-less mode (a missing model directory inside the runtime): the page says
 *      the search is lexical, and a meaning search does not pretend otherwise.
 * Seeded (prerequisites, not accepted actions): two projects, the Head's consent, four Done tasks, one Beta memory.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, clickByPosition, state, saveState } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  evidence.tiers = {
    "PN (observed in the packaged window)": "candidate list, Reject, Approve & Save, search, restart, Head grant picker/preview/approve/send, lexical-only wording",
    "PN records read from the packaged core (API of the same isolated profile)": "candidate and memory records, embedding status, the grant record, what the fake driver computed from the prompt it received",
    "Seeded through the API": "projects, Head consent, four Done tasks (moved to Done through PATCH /tasks/:id, which runs the production extraction hook), one Beta memory",
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const textOf = (part: string) => find(hasText(part)).flatMap((n: any) => [n.AXValue, n.AXTitle, n.AXDescription]).filter((x: any) => typeof x === "string" && x.includes(part))[0] as string | undefined;
  const Alpha = join(runtime, "projects/Alpha"), Beta = join(runtime, "projects/Beta");
  mkdirSync(Alpha, { recursive: true }); mkdirSync(Beta, { recursive: true });
  const MARK_A = "SYNTH-ALPHA-17K", MARK_A2 = "SYNTH-ALPHA-REJECT-17R", MARK_B = "SYNTH-BETA-17M", MARK_B2 = "SYNTH-BETA-PENDING-17P";

  // ---- prerequisites (API of the isolated profile) ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  await api("POST", "/projects", { path: Alpha, name: "D17 Alpha" });
  await api("POST", "/projects", { path: Beta, name: "D17 Beta" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const consent = (await api("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol", effort: "low" })).isolation.consentKey;
  await api("PUT", "/portfolio-manager/config", { config: { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent } });
  const mkDone = async (workdir: string, title: string, prompt: string) => {
    const t = await api("POST", "/tasks", { title, prompt, workdir, isolation: "none", agent: "codex", model: "gpt-6.1-sol", column: "review" });
    const id = (t.task ?? t).id as string;
    await api("PATCH", `/tasks/${id}`, { column: "done" });
    return id;
  };
  const taskA = await mkDone(Alpha, `${MARK_A} Cap the job queue retry delay at thirty seconds`, "Cap the retry delay used by the job queue.");
  const taskA2 = await mkDone(Alpha, `${MARK_A2} Rotate the structured log files every night`, "Rotate logs nightly.");
  const taskB = await mkDone(Beta, `${MARK_B} Keep the export worker idempotent across retries`, "Make the export worker idempotent.");
  await mkDone(Beta, `${MARK_B2} Pin the parser to one supported schema version`, "Pin the parser.");
  const candidatesFor = async (path: string, status = "all") => (await api("GET", `/brain/candidates?status=${status}&scopeKind=project&projectPath=${encodeURIComponent(path)}&limit=100`)).candidates as any[];
  const alphaCandidates = await poll("two Alpha candidates", async () => { const l = await candidatesFor(Alpha); return l.length >= 2 ? l : null; }, 20_000);
  const betaCandidates = await poll("two Beta candidates", async () => { const l = await candidatesFor(Beta); return l.length >= 2 ? l : null; }, 20_000);
  // Beta's first candidate is approved by the Owner (seeded), so Beta has one accepted memory with its own marker.
  const betaB = betaCandidates.find((x) => x.title.includes(MARK_B))!;
  const betaMemory = (await api("POST", `/brain/candidates/${betaB.id}/approve`, {})).memory;
  assert.equal(alphaCandidates.length, 2);
  assert(alphaCandidates.every((x) => x.status === "candidate" && x.scopeId === Alpha && x.sourceEventKind === "completed_task"));
  assert.equal((await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(Alpha)}`)).memories.length, 0, "pending candidates are not memories");
  evidence.seeded = { projects: ["D17 Alpha", "D17 Beta"], alphaCandidates: alphaCandidates.map((x) => ({ status: x.status, source: x.sourceEventKind, scope: x.scopeKind, sourceRecordIds: x.sourceRecordIds })), betaMemoryId: betaMemory.id, betaPendingCandidates: 1 };
  await down(); await up(); await show("Main navigation");
  mark("Seeded through the API of the isolated profile: two projects, the Head's consent, four Done tasks (the production extraction hook queued four pending candidates), and one approved Beta memory. No Alpha memory exists yet");

  const openBrain = async (project: string) => {
    await button(project, true, 0).catch(async () => { await button(project, false, 0); });
    await sleep(900);
    await button("More project pages", false);
    await sleep(600);
    await button("Brain for this project", false);
    await show(`${project} memory`, 20_000);
    await sleep(700);
  };

  // ---- 1. Capture and review in the window ----
  await openBrain("D17 Alpha");
  assert(!has(MARK_A), "no Alpha memory is listed before approval");
  await show("No memories in this view yet");
  shot("01-memory-empty");
  await button("Extraction Candidates", false);
  await show(MARK_A, 20_000);
  await show(MARK_A2, 20_000);
  assert(!has(MARK_B) && !has(MARK_B2), "the other project's candidates are not listed");
  shot("02-candidates");
  evidence.candidateList = { shown: [MARK_A, MARK_A2], otherProjectShown: false };
  mark("Alpha's Memory page: no memory listed; the Extraction Candidates tab lists exactly Alpha's two pending candidates and none from Beta");

  // Select the rejected one and read its source details.
  await button(MARK_A2, false);
  await show("Event: completed_task", 10_000);
  const sourceLine = textOf("Task IDs") ?? textOf(taskA2.slice(0, 8)) ?? null;
  shot("03-candidate-detail");
  evidence.candidateDetail = { event: "completed_task", sourceLine, expectedSourceTask: taskA2 };
  await button("Reject", true);
  await poll("reject recorded", async () => ((await candidatesFor(Alpha)).find((x) => x.sourceRecordIds.includes(taskA2))?.status === "rejected" ? true : null), 15_000);
  assert.equal((await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(Alpha)}`)).memories.length, 0, "a rejected candidate is not a memory");
  mark("Reject was pressed in the window: that candidate is rejected and Alpha still has no memory");

  await sleep(600);
  await button(MARK_A, false);
  await show("Event: completed_task", 10_000);
  await button("Approve & Save", true);
  const approvedCandidate = await poll("approve recorded", async () => { const x = (await candidatesFor(Alpha)).find((y) => y.sourceRecordIds.includes(taskA)); return x?.status === "approved" ? x : null; }, 20_000);
  const alphaMemories = (await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(Alpha)}`)).memories as any[];
  assert.equal(alphaMemories.length, 1, "exactly one memory");
  const memory = await api("GET", `/brain/memories/${alphaMemories[0].id}`);
  assert.equal(memory.origin, "automatic-extraction");
  assert.equal(approvedCandidate.memoryId, memory.id);
  assert.deepEqual(memory.scope, { kind: "project", id: Alpha });
  assert(JSON.stringify(memory).includes(taskA), "the memory's provenance names the source task");
  assert.equal((await api("GET", `/brain/memories/search?scopeKind=project&projectPath=${encodeURIComponent(Alpha)}&q=${MARK_A2}&mode=lexical&status=all`)).results.length, 0, "the rejected candidate's marker is in no memory");
  shot("04-approved");
  evidence.approved = { memoryId: memory.id, revision: memory.revision, origin: memory.origin, scope: memory.scope, sourceTask: taskA, candidateStatus: approvedCandidate.status, memoriesInAlpha: 1, rejectedCandidateStatus: "rejected" };
  mark("Approve & Save was pressed in the window: exactly one Alpha memory exists (origin automatic-extraction, scope Alpha, provenance names the source task); the rejected candidate produced none");

  // ---- 2. Find it later ----
  await button("Memories", true, 0);
  await show(MARK_A, 20_000);
  const statusText = textOf("Search index") ?? null;
  const engine = (await api("GET", "/brain/embeddings/status"));
  evidence.embeddingStatus = engine;
  mark(`Memory list shows the approved memory. The page's index line reads "${statusText}"; the core reports engine=${engine.engine}, model=${engine.model}, dimension=${engine.dimension}`);
  const search = async (query: string) => {
    ax("focus"); await sleep(300);
    ax("focus-name", "AXTextField", "Search titles and text"); await sleep(400);
    ax("key", "0", "1048576"); // cmd+a
    ax("text", query); await sleep(500);
    await button("Search", true, 0);
    await sleep(1500);
  };
  const pickMode = async (from: string) => {
    void from;
    await button("Search mode", true, 0);
    await sleep(600); ax("key", "125", "0"); await sleep(400); ax("key", "36", "0"); await sleep(800);
  };
  await search("retry delay");
  await show(MARK_A, 15_000);
  shot("05-text-search");
  evidence.textSearch = { query: "retry delay", found: true };
  mark("Search \"retry delay\" (hybrid) found the memory");
  if (engine.engine === "transformers-local") {
    await pickMode("Hybrid");
    await show("Semantic", 5_000);
    await search("how long the queue waits before it tries again");
    await show(MARK_A, 15_000);
    assert(!has("This search ran as lexical"), "a semantic search served by the local model does not say lexical");
    shot("06-semantic-search");
    evidence.semanticSearch = { query: "how long the queue waits before it tries again", found: true, servedAs: "semantic", engine: engine.engine, realLocalModel: true };
    mark("A search by meaning with different wording found the memory; the page did not say it ran as lexical (the bundled local model produced the vectors)");
  } else {
    evidence.semanticSearch = { realLocalModel: false, engine: engine.engine };
    mark(`The local model is not active in this build (engine=${engine.engine}); no semantic search was claimed`);
  }

  // Restart: the memory, its revision and the search survive.
  await down(); await up(); await show("Main navigation");
  await openBrain("D17 Alpha");
  await show(MARK_A, 20_000);
  const afterRestart = await api("GET", `/brain/memories/${memory.id}`);
  assert.equal(afterRestart.revision, memory.revision);
  assert.equal(afterRestart.contentSha256, memory.contentSha256);
  await search("retry delay");
  await show(MARK_A, 15_000);
  shot("07-after-restart");
  evidence.afterRestart = { memoryId: memory.id, revision: afterRestart.revision, sameSha256: true, foundByTextSearch: true, engine: (await api("GET", "/brain/embeddings/status")).engine };
  mark("After quitting and reopening the app, the same memory (same revision and content hash) was listed and found again by search");

  // ---- 3. Reuse with the right scope (Head, one message) ----
  const head = async () => { const s = await api("GET", "/portfolio-manager"); return s.value ?? s; };
  const typeAndSend = async (text: string) => {
    const before = (await head()).messages.length;
    ax("focus-name", "AXTextArea", "Message to Head of PM"); await sleep(400);
    ax("text", text); await sleep(500);
    await button("Send");
    await poll("Head turn settled", async () => { const h = await head(); return h.messages.length >= before + 2 && h.activeTurn == null ? true : null; }, 30_000);
    await sleep(800);
  };
  const lastReply = async () => (await head()).messages.filter((m: any) => m.role === "manager").at(-1);
  await button("Open Head of PM");
  await show("Message to Head of PM");
  await button("Context", true, 0);
  await sleep(700); ax("text", "D17 Alpha"); await sleep(500); ax("key", "36", "0"); await sleep(900);
  await show("D17 Alpha");
  shot("08-head-scoped-alpha");
  // Default: no grant -> no memory, even though Alpha and Beta memories exist.
  await typeAndSend("__fake_head_context__ Which records did you receive?");
  const noGrant = await lastReply();
  assert(noGrant.text.includes("Brain records received: 0."), noGrant.text);
  assert(noGrant.text.includes("Tokens in those records: none."), noGrant.text);
  assert(!noGrant.text.includes(MARK_B) && !noGrant.text.includes(MARK_B2), "no other project's token anywhere in the prompt");
  evidence.defaultWithoutMemory = { driverReply: noGrant.text };
  mark(`Default: a Head turn with no Brain grant received no memory. The fake driver's own report from the prompt it received: "${noGrant.text}"`);

  await button("Brain for the next message", false);
  await show("Alpha", 20_000);
  await show(MARK_A, 20_000);
  assert(!has(MARK_B), "the picker offers only the scoped project's memory");
  shot("09-brain-picker");
  const checkbox = find((n: any) => n.AXRole === "AXCheckBox" && [n.AXTitle, n.AXDescription].some((x: any) => typeof x === "string" && x.includes(MARK_A)))[0];
  if (checkbox) { c.activate(checkbox); await sleep(600); }
  else await clickByPosition((n: any) => [n.AXTitle, n.AXDescription, n.AXValue].some((x: any) => typeof x === "string" && x.includes(MARK_A)));
  await sleep(500);
  await button("Preview context", true);
  await sleep(1200);
  shot("10-brain-preview");
  await button("Use these memories on the next message", true);
  await show("approved for the next message", 15_000);
  const grantRow = (await api("GET", "/brain/context/transmissions?managerKind=portfolio")).transmissions.at(0);
  assert.equal(grantRow.status, "approved"); assert.equal(grantRow.used, false);
  assert.deepEqual(grantRow.items.map((i: any) => i.id), [memory.id]);
  assert.equal(grantRow.items[0].revision, memory.revision);
  shot("11-grant-approved");
  evidence.grantBeforeSend = { status: grantRow.status, used: grantRow.used, items: grantRow.items.map((i: any) => ({ id: i.id, revision: i.revision, title: i.title })) };
  mark("Brain picker: previewed and approved exactly D17 Alpha's memory (named revision) for the next message; nothing sent yet");

  await typeAndSend("__fake_head_context__ Which records did you receive?");
  const probe = await lastReply();
  assert(probe.text.includes("Brain records received: 1."), probe.text);
  assert(probe.text.includes(`Tokens in those records: ${MARK_A}.`), probe.text);
  // Alpha's own task titles are board data the Head always sees for its project (they carry the same markers);
  // what must hold is that the Brain records are exactly the granted one and nothing of Beta is in the prompt.
  const [recordsPart, anywherePart] = probe.text.split("Tokens anywhere in the prompt:");
  assert(!recordsPart.includes(MARK_A2), "the rejected candidate's marker is in no Brain record");
  for (const other of [MARK_B, MARK_B2]) assert(!probe.text.includes(other), `${other} reached the driver`);
  assert(anywherePart.includes(MARK_A), "the granted marker is in the prompt");
  const spent = (await api("GET", "/brain/context/transmissions?managerKind=portfolio")).transmissions.at(0);
  assert.equal(spent.status, "consumed"); assert.equal(spent.used, true);
  shot("12-granted-turn");
  evidence.granted = { driverReply: probe.text, grant: { status: spent.status, used: spent.used, items: spent.items.map((i: any) => ({ id: i.id, revision: i.revision })), digest: spent.digest.slice(0, 12) } };
  mark(`The granted turn was sent from the window. The fake driver's own report: "${probe.text}" — the Brain records are exactly the granted Alpha memory, and nothing of Beta (its memory or its pending candidate) is anywhere in the prompt. The grant is consumed`);

  // A next turn gets nothing; the consumed grant cannot be replayed.
  await typeAndSend("__fake_head_context__ And now?");
  const next = await lastReply();
  assert(next.text.includes("Brain records received: 0."), next.text);
  evidence.nextTurnAndReplay = { nextTurnDriverReply: next.text, replay: "The grant id is a capability that the API never lists again, so a replay is pinned by the backend suite (brain-context-managers, brain-direction17), not driven here." };
  mark(`The next turn received no memory ("${next.text}"). Replay of a spent grant is pinned in the backend suites (the API does not list a grant id again)`);
  ax("key", "53", "0"); await sleep(800);

  // ---- 4. Lexical-only (no model directory) ----
  state.lexicalOnly = true; saveState();
  await down(); await up(); await show("Main navigation");
  await openBrain("D17 Alpha");
  await show(MARK_A, 20_000);
  const lexStatus = await api("GET", "/brain/embeddings/status");
  assert.equal(lexStatus.engine, "lexical-fallback"); assert.equal(lexStatus.enabled, false);
  await show("Semantic embeddings unavailable", 15_000);
  const unavailable = textOf("Semantic embeddings unavailable");
  shot("13-lexical-only-status");
  await pickMode("Hybrid");
  await search("how long the queue waits before it tries again");
  await show("This search ran as lexical", 15_000);
  shot("14-lexical-served");
  const meaningSearch = await api("GET", `/brain/memories/search?scopeKind=project&projectPath=${encodeURIComponent(Alpha)}&q=${encodeURIComponent("how long the queue waits before it tries again")}&mode=semantic`);
  assert.equal(meaningSearch.mode, "lexical"); assert.equal(meaningSearch.results.length, 0, "word overlap is not presented as meaning");
  await pickMode("Semantic");
  await search("retry delay");
  await show(MARK_A, 15_000);
  evidence.lexicalOnly = { engine: lexStatus.engine, enabled: lexStatus.enabled, model: lexStatus.model, pageStatusText: unavailable ?? null, meaningSearchServedAs: meaningSearch.mode, meaningSearchResults: meaningSearch.results.length, lexicalSearchFound: true, mechanism: "FORGEORBIT_EMBEDDING_MODEL_ROOT pointing at a missing directory inside the runtime (the sanctioned QA lexical-only mode); nothing downloaded" };
  mark(`Model-less mode: the page reads "${unavailable}"; a search by meaning is labelled as run lexical and returns nothing; a lexical search still finds the memory`);

  evidence.result = "pass";
  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
  const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
  const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
  const unexplained = changed.filter((p) => !tolerated.includes(p));
  evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
  assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
  evidence.ownerUntouched = unexplained.length === 0 && tolerated.length === 0;
  mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
  save();
}
