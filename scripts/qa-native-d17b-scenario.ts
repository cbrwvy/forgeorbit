/**
 * Direction 17, criterion 3: a native backup-and-restore round trip for Brain, in the packaged ForgeOrbitQA window.
 * Disposable profiles, fake drivers, no provider, no network. Phases (the runner takes the phase as its 5th argument):
 *
 *   seed     seed the source profile through its own API, fingerprint every Brain file and index row, open Settings.
 *   create   (after the folder panel was used to choose the backup folder) Create backup in the window; wait; fingerprint the snapshot.
 *   import   Import Profile tab: snapshot, verify, recovery preview, destination (folder panel), Import in the window.
 *   reopen   compare, then open the restored profile with the same packaged app and check it in the window.
 *
 * The two native folder panels are driven by the operator (full-screen control, outside this script); everything else here is
 * the window (AX) or a read of files and records. `evidence.phases` records which is which.
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])).sort();
};
/** Hash of every regular file under a directory, keyed by its relative path. */
const treeHashes = (dir: string, filter: (rel: string) => boolean = () => true) =>
  Object.fromEntries(walk(dir).map((f) => [relative(dir, f), sha(readFileSync(f))]).filter(([rel]) => filter(rel as string)));

/** Rows of the Brain index, read from a private copy so a live or restored profile is never opened for write. */
function indexRows(profileDir: string) {
  const tmp = mkdtempSync(join(tmpdir(), "fo-d17b-idx-"));
  try {
    for (const name of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
      const src = join(profileDir, "brain", name);
      if (existsSync(src)) copyFileSync(src, join(tmp, name));
    }
    const db = new Database(join(tmp, "index.sqlite"));
    try {
      const all = (sql: string) => db.query(sql).all() as any[];
      const integrity = (db.query("PRAGMA integrity_check").get() as any).integrity_check as string;
      const hasEmbeddingsTable = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brain_embeddings'").length > 0;
      const embeddings = (hasEmbeddingsTable ? all("SELECT memory_id, revision, dimension, model, content_sha256, vector_json FROM brain_embeddings ORDER BY memory_id, revision") : [])
        .map((r) => ({ memory_id: r.memory_id, revision: r.revision, dimension: r.dimension, model: r.model, content_sha256: r.content_sha256, vector_sha256: sha(r.vector_json) }));
      return {
        integrity,
        memories: all("SELECT * FROM brain_memories ORDER BY id"),
        revisions: all("SELECT * FROM brain_revisions ORDER BY memory_id, revision"),
        embeddings,
      };
    } finally { db.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const brainFiles = (profileDir: string) => treeHashes(join(profileDir, "brain"), (rel) => rel.endsWith(".md"));

export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, saveState, useDataDir } = c;
  const phase = process.argv[5] ?? "";
  const source = join(runtime, "data");
  const sourceFile = join(root, "d17b-source.json");
  const shots = join(root, "shots-b"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => {
    const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
    spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const textOf = (part: string) => find(hasText(part)).flatMap((n: any) => [n.AXValue, n.AXTitle, n.AXDescription]).filter((x: any) => typeof x === "string" && x.includes(part))[0] as string | undefined;
  const Alpha = join(runtime, "projects/Alpha"), Beta = join(runtime, "projects/Beta"), Gamma = join(runtime, "projects/Gamma");
  const phaseFile = join(root, `d17b-${phase}.json`);
  const finish = () => { evidence.phase = phase; save(); writeFileSync(phaseFile, JSON.stringify(evidence, null, 2) + "\n"); };
  const openAdvanced = async () => {
    await button("Settings", true, 0);
    await show("General");
    await button("Advanced", true);
    await show("Backup & Recovery", 20_000);
    await sleep(800);
  };
  const tab = async (name: string) => { await button(name, true, 0); await sleep(900); };
  const readSource = () => JSON.parse(readFileSync(sourceFile, "utf8"));

  // =======================================================================================================
  if (phase === "seed") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    await up();
    await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
    await api("PUT", "/preferences/locale", { value: "en" });
    for (const [p, n] of [[Alpha, "D17b Alpha"], [Beta, "D17b Beta"], [Gamma, "D17b Gamma"]] as const) { mkdirSync(p, { recursive: true }); await api("POST", "/projects", { path: p, name: n }); }
    const mem = (b: any) => api("POST", "/brain/memories", b, 201);
    const company = await mem({ scopeKind: "company", title: "Company review rule", kind: "decision", content: "SYNTH-D17B-COMPANY every migration is reviewed before merge." });
    const companyRev = await api("PATCH", `/brain/memories/${company.id}`, { expectedRevision: company.revision, content: "SYNTH-D17B-COMPANY every migration is reviewed by a second person before merge (revised)." });
    const alphaOwner = await mem({ scopeKind: "project", projectPath: Alpha, title: "Alpha storage rule", kind: "decision", content: "SYNTH-D17B-ALPHA-OWNER keep WAL mode on the queue database." });
    const betaOwner = await mem({ scopeKind: "project", projectPath: Beta, title: "Beta parser rule", kind: "decision", content: "SYNTH-D17B-BETA pin the parser to schema version two." });
    const gammaOwner = await mem({ scopeKind: "project", projectPath: Gamma, title: "Gamma export rule", kind: "decision", content: "SYNTH-D17B-GAMMA exports are idempotent across retries." });
    // Extraction path (production hook): one task approved, then revised; one left pending; one rejected.
    const mkDone = async (title: string) => {
      const t = await api("POST", "/tasks", { title, prompt: title, workdir: Alpha, isolation: "none", agent: "codex", model: "gpt-6.1-sol", column: "review" });
      const id = (t.task ?? t).id as string;
      await api("PATCH", `/tasks/${id}`, { column: "done" });
      return id;
    };
    const tApproved = await mkDone("SYNTH-D17B-APPROVED Cap the job queue retry delay at thirty seconds");
    const tPending = await mkDone("SYNTH-D17B-PENDING Rotate the structured log files every night");
    const tRejected = await mkDone("SYNTH-D17B-REJECTED Pin the audit export to one schema version");
    const cand = await poll("three candidates", async () => { const l = (await api("GET", `/brain/candidates?status=all&scopeKind=project&projectPath=${encodeURIComponent(Alpha)}&limit=100`)).candidates as any[]; return l.length >= 3 ? l : null; }, 25_000);
    const byTask = (id: string) => cand.find((x) => x.sourceRecordIds.includes(id));
    const approved = (await api("POST", `/brain/candidates/${byTask(tApproved).id}/approve`, {})).memory;
    const approvedRev = await api("PATCH", `/brain/memories/${approved.id}`, { expectedRevision: approved.revision, content: `${approved.content}\nRevised by the Owner: keep the cap under a minute.` });
    await api("POST", `/brain/candidates/${byTask(tRejected).id}/reject`, { reason: "not durable" });
    // Gamma's folder disappears before the backup: its memory must keep its original path and not be attached elsewhere.
    rmSync(Gamma, { recursive: true, force: true });
    const candidates = ((await api("GET", `/brain/candidates?status=all&scopeKind=project&projectPath=${encodeURIComponent(Alpha)}&limit=100`)).candidates as any[]).map((x) => ({ id: x.id, status: x.status, memoryId: x.memoryId, sourceRecordIds: x.sourceRecordIds, title: x.title }));
    const memories = [company, alphaOwner, betaOwner, gammaOwner, approved].map((m) => m.id);
    const full = Object.fromEntries(await Promise.all(memories.map(async (id) => [id, await api("GET", `/brain/memories/${id}`)])));
    const snapshot = { dataDir: source, projects: { Alpha, Beta, Gamma }, ids: { company: company.id, alphaOwner: alphaOwner.id, betaOwner: betaOwner.id, gammaOwner: gammaOwner.id, approved: approved.id }, tasks: { tApproved, tPending, tRejected },
      revisions: { company: companyRev.revision, approved: approvedRev.revision }, memories: full, candidates, files: brainFiles(source), index: indexRows(source) };
    assert.equal(companyRev.revision, 2); assert.equal(approvedRev.revision, 2);
    assert.deepEqual(candidates.map((x) => x.status).sort(), ["approved", "candidate", "rejected"]);
    assert.equal(snapshot.index.integrity, "ok");
    assert.equal(Object.keys(snapshot.files).filter((f) => f.startsWith("memories/")).length, 5, "five committed memories");
    writeFileSync(sourceFile, JSON.stringify(snapshot, null, 2));
    evidence.source = { ids: snapshot.ids, revisions: snapshot.revisions, candidateStatuses: candidates.map((x) => x.status), markdownFiles: Object.keys(snapshot.files).length, indexIntegrity: snapshot.index.integrity, embeddings: snapshot.index.embeddings.length, scopes: Object.fromEntries(Object.entries(full).map(([id, m]: any) => [id, m.scope])), provenanceOfApproved: full[approved.id].provenance };
    mark("Seeded the source profile through its own API: a company memory (revision 2), three project memories (Alpha, Beta, Gamma), one extracted memory approved and then revised to revision 2, one pending candidate, one rejected candidate; Gamma's folder was removed. Every Markdown file and index row was fingerprinted (private copy of the index)");
    await down(); await up(); await show("Main navigation");
    await openAdvanced();
    shot("01-backup-create");
    evidence.phases = { seed: "API + file reads (seeded, not window actions)" };
    finish();
    return;
  }

  // =======================================================================================================
  if (phase === "create") {
    const src = readSource();
    await show("Destination:", 10_000);
    const dest = textOf("Destination:");
    evidence.destinationShown = dest;
    shot("02-destination-chosen");
    await button("Create backup…", true);
    await show("Create this backup now?", 10_000);
    shot("03-create-confirm");
    await button("Create backup…", true, 0);
    const operation = await poll("backup completed", async () => {
      const state = textOf("Completed") ?? textOf("completed") ?? textOf("Succeeded");
      if (state) return state;
      const ops = (await api("GET", "/backup/history")).entries ?? (await api("GET", "/backup/history"));
      return Array.isArray(ops) && ops.length ? "history" : null;
    }, 90_000);
    await sleep(1500);
    shot("04-create-done");
    const history = await api("GET", "/backup/history");
    const list = (history.entries ?? history.snapshots ?? history) as any[];
    assert(Array.isArray(list) && list.length >= 1, "a snapshot is in the history");
    const snap = list[0];
    const snapPath = snap.path ?? snap.snapshotPath;
    assert(snapPath && existsSync(snapPath), `snapshot path exists: ${snapPath}`);
    const snapFiles = treeHashes(snapPath);
    writeFileSync(join(root, "d17b-snapshot.json"), JSON.stringify({ path: snapPath, files: snapFiles }, null, 2));
    evidence.snapshot = { path: snapPath, fileCount: Object.keys(snapFiles).length, manifest: Object.keys(snapFiles).filter((f) => f.includes("manifest")), brainFiles: Object.keys(snapFiles).filter((f) => f.startsWith("brain/")).length, uiState: operation };
    // The source is untouched by the backup.
    assert.deepEqual(brainFiles(source), src.files, "backup left the source Markdown unchanged");
    mark(`Create backup was pressed in the window (destination ${dest}); the snapshot ${snapPath} was written (${Object.keys(snapFiles).length} files); the source Markdown is byte-identical to before`);
    evidence.phases = { create: "window: Create backup, confirm; reads of files" };
    finish();
    return;
  }

  // =======================================================================================================
  if (phase === "import") {
    const src = readSource();
    const snap = JSON.parse(readFileSync(join(root, "d17b-snapshot.json"), "utf8"));
    const before = { sourceFiles: brainFiles(source), sourceIndex: indexRows(source), snapshot: treeHashes(snap.path) };
    assert.deepEqual(before.snapshot, snap.files, "the snapshot is unchanged since it was created");
    const restored = join(runtime, "home/qa-restores/d17b-restored");
    const alreadyRestored = existsSync(join(restored, "agetor.sqlite"));
    if (!alreadyRestored) {
      // Name the new folder in the window, then Import Profile (the destination parent was chosen in the folder panel).
      await show("Destination parent folder", 10_000);
      ax("focus"); await sleep(300);
      ax("focus-name", "AXTextField", "New folder name"); await sleep(400);
      ax("key", "0", "1048576"); ax("text", "d17b-restored"); await sleep(600);
      shot("05-import-ready");
      const importButton = () => find((n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].includes("Import Profile") && n.AXEnabled !== false)[0];
      c.activate(await poll("Import Profile enabled", () => importButton() ?? null, 10_000)); await sleep(900);
      await show("Restore this snapshot", 10_000);
      shot("06-import-confirm");
      c.activate(await poll("confirm button", () => importButton() ?? null, 10_000));
    }
    await poll("restored profile exists", () => (existsSync(join(restored, "brain", "index.sqlite")) ? true : null), 120_000);
    const operations = ((await api("GET", "/backup/operations")).operations ?? []) as any[];
    const restoreOp = operations.find((o) => o.kind === "restore");
    assert.equal(restoreOp?.state, "completed"); assert.equal(restoreOp?.integrity, "verified");
    const uiText = ["Completed", "Integrity verified"].filter(has);
    await sleep(2000);
    shot("07-import-done");
    // Source and snapshot are not changed by the restore.
    const after = { sourceFiles: brainFiles(source), sourceIndex: indexRows(source), snapshot: treeHashes(snap.path) };
    assert.deepEqual(after.sourceFiles, before.sourceFiles, "restore left the source Markdown unchanged");
    assert.deepEqual(after.sourceIndex, before.sourceIndex, "restore left the source index rows unchanged");
    assert.deepEqual(after.snapshot, before.snapshot, "restore left the snapshot unchanged");
    // Restored files (read before the restored profile is ever opened by the app).
    const restoredFiles = brainFiles(restored);
    const restoredIndex = indexRows(restored);
    assert.deepEqual(restoredFiles, src.files, "restored Markdown is byte-identical to the source");
    assert.equal(restoredIndex.integrity, "ok");
    assert.deepEqual(restoredIndex.memories, src.index.memories, "restored memory rows equal the source rows");
    assert.deepEqual(restoredIndex.revisions, src.index.revisions, "restored revision history rows equal the source rows");
    const embeddingsEqual = JSON.stringify(restoredIndex.embeddings) === JSON.stringify(src.index.embeddings);
    writeFileSync(join(root, "d17b-restored.json"), JSON.stringify({ restored, files: restoredFiles, embeddingsEqual, embeddingCount: restoredIndex.embeddings.length }, null, 2));
    evidence.import = { restored, restoreOperation: { state: restoreOp.state, phase: restoreOp.phase, integrity: restoreOp.integrity, destinationPath: restoreOp.destinationPath }, operations: operations.map((o) => ({ kind: o.kind, state: o.state, phase: o.phase, integrity: o.integrity })), uiText, markdownFiles: Object.keys(restoredFiles).length, byteIdenticalToSource: true, indexIntegrity: restoredIndex.integrity, memoryRowsEqual: true, revisionRowsEqual: true, embeddingsEqual, restoredEmbeddings: restoredIndex.embeddings.length, sourceEmbeddings: src.index.embeddings.length, sourceUnchanged: true, snapshotUnchanged: true };
    mark("Import Profile was pressed in the window (snapshot and destination parent chosen in the folder panel, new folder named in the window, confirmation accepted); the restore completed. Restored Markdown is byte-identical to the source's, index integrity ok, memory and revision rows equal; the source files and rows and the snapshot are unchanged by the restore");
    evidence.phases = { import: "window: Verify snapshot, recovery preview, destination name, Import Profile, confirm (folder panels by the operator); file and index comparisons by script" };
    finish();
    return;
  }

  // =======================================================================================================
  if (phase === "reopen") {
    const src = readSource();
    const snap = JSON.parse(readFileSync(join(root, "d17b-snapshot.json"), "utf8"));
    const rest = JSON.parse(readFileSync(join(root, "d17b-restored.json"), "utf8"));
    await down();
    useDataDir(rest.restored);
    await up();
    await show("Main navigation");
    evidence.openedProfile = rest.restored;
    // Records of the restored profile.
    const ids = src.ids;
    const checks: Record<string, unknown> = {};
    for (const [name, id] of Object.entries(ids) as [string, string][]) {
      const m = await api("GET", `/brain/memories/${id}`);
      const o = src.memories[id];
      assert.equal(m.id, o.id); assert.deepEqual(m.scope, o.scope); assert.equal(m.revision, o.revision);
      assert.equal(m.contentSha256, o.contentSha256); assert.deepEqual(m.provenance, o.provenance); assert.equal(m.origin, o.origin); assert.equal(m.status, o.status);
      checks[name] = { id, scope: m.scope, revision: m.revision, origin: m.origin, sameSha256: true, sameProvenance: true };
    }
    assert.equal(src.memories[ids.company].revision, 2); assert.equal(src.memories[ids.approved].revision, 2);
    const candidates = ((await api("GET", `/brain/candidates?status=all&scopeKind=project&projectPath=${encodeURIComponent(src.projects.Alpha)}&limit=100`)).candidates as any[]);
    assert.deepEqual(candidates.map((x) => [x.id, x.status, x.memoryId]).sort(), src.candidates.map((x: any) => [x.id, x.status, x.memoryId]).sort(), "candidate statuses are restored as they were");
    const pending = candidates.find((x) => x.status === "candidate"), rejected = candidates.find((x) => x.status === "rejected");
    assert(pending && rejected);
    const all = (await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(src.projects.Alpha)}&inherit=company&status=active`));
    const search = async (q: string, scope: string) => (await api("GET", `/brain/memories/search?${scope}&q=${encodeURIComponent(q)}&mode=lexical&status=active`)).results as any[];
    const alphaScope = `scopeKind=project&projectPath=${encodeURIComponent(src.projects.Alpha)}`;
    assert((await search("SYNTH-D17B-APPROVED", alphaScope)).some((r) => r.id === ids.approved), "the approved memory is found");
    assert.equal((await search("SYNTH-D17B-PENDING", alphaScope)).length, 0, "the pending candidate is not memory");
    assert.equal((await search("SYNTH-D17B-REJECTED", alphaScope)).length, 0, "the rejected candidate is not memory");
    const listed = (await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(src.projects.Alpha)}&status=active`)).memories as any[];
    assert.deepEqual(listed.map((m) => m.id).sort(), [ids.alphaOwner, ids.approved].sort(), "Alpha holds exactly its two approved memories");
    const betaListed = (await api("GET", `/brain/memories?scopeKind=project&projectPath=${encodeURIComponent(src.projects.Beta)}&status=active`)).memories as any[];
    assert.deepEqual(betaListed.map((m) => m.id), [ids.betaOwner]);
    const status = await api("GET", "/brain/status");
    const emb = await api("GET", "/brain/embeddings/status");
    evidence.records = { memories: checks, candidates: candidates.map((x) => ({ status: x.status, memoryId: x.memoryId })), alphaMemories: listed.length, betaMemories: betaListed.length, brainStatus: status, embeddings: emb, gammaPathUnchanged: src.memories[ids.gammaOwner].scope.id === src.projects.Gamma };
    mark("The restored profile was opened by the same packaged app (a separate disposable profile). Every memory has the same id, scope, revision, content hash and provenance as in the source; candidates are restored as pending, rejected and approved; searching the pending and rejected markers finds nothing; Alpha holds exactly its two approved memories");

    // The window: Alpha's memory page.
    await button("D17b Alpha", true, 0); await sleep(900);
    await button("More project pages", false); await sleep(600);
    await button("Brain for this project", false);
    await show("D17b Alpha memory", 20_000); await sleep(800);
    await show("SYNTH-D17B-APPROVED", 20_000);
    assert(!has("SYNTH-D17B-PENDING") && !has("SYNTH-D17B-REJECTED") && !has("SYNTH-D17B-BETA") && !has("SYNTH-D17B-GAMMA"), "no pending, rejected or other-project memory is listed");
    shot("08-restored-alpha-memories");
    const indexLine = textOf("Search index") ?? textOf("Semantic embeddings") ?? null;
    ax("focus"); await sleep(300);
    ax("focus-name", "AXTextField", "Search titles and text"); await sleep(400);
    ax("text", "retry delay"); await sleep(500);
    await button("Search", true, 0); await sleep(1500);
    await show("SYNTH-D17B-APPROVED", 15_000);
    shot("09-restored-search");
    await button("Extraction Candidates", false);
    await show("SYNTH-D17B-PENDING", 15_000);
    assert(!has("SYNTH-D17B-REJECTED"), "the rejected candidate is not offered again");
    shot("10-restored-candidates");
    await button("Memories", true, 0); await sleep(800);
    evidence.window = { indexLine, searchFoundApproved: true, pendingCandidateListed: true, rejectedCandidateListed: false };
    mark(`In the window of the restored profile: Alpha's memory page lists the approved memories and none of the pending, rejected, Beta or Gamma text; search "retry delay" finds the approved memory; the candidates tab offers the pending candidate and not the rejected one. Index line: "${indexLine}"`);

    // Index: coverage and, if needed, a rebuild from the window.
    let rebuilt = false;
    if (emb.coveragePercent !== 100 || emb.indexedCount !== emb.activeCount) {
      await button("Rebuild Index", true, 0);
      await poll("index rebuilt", async () => { const e = await api("GET", "/brain/embeddings/status"); return e.coveragePercent === 100 ? e : null; }, 60_000);
      rebuilt = true;
    }
    const emb2 = await api("GET", "/brain/embeddings/status");
    evidence.index = { before: emb, after: emb2, rebuiltInWindow: rebuilt, embeddingsRestoredFromSnapshot: rest.embeddingsEqual, restoredEmbeddingRows: rest.embeddingCount };
    mark(rebuilt ? `The restored index covered ${emb.indexedCount}/${emb.activeCount}; Rebuild Index was pressed in the window and coverage is now ${emb2.coveragePercent}%` : `The restored index already covers ${emb.indexedCount}/${emb.activeCount} (${emb.engine}); no rebuild was needed`);

    // Source and snapshot unchanged at the end.
    assert.deepEqual(brainFiles(source), src.files, "the source Markdown is unchanged");
    assert.deepEqual(treeHashes(snap.path), snap.files, "the snapshot is unchanged");
    assert.deepEqual(brainFiles(rest.restored), rest.files, "the restored Markdown was not changed by opening it");
    evidence.unchangedAtEnd = { sourceMarkdown: true, snapshot: true, restoredMarkdownAfterOpen: true };
    mark("At the end: the source Markdown, the snapshot and the restored Markdown (after the app opened and searched it) are all byte-identical to their fingerprints");
    evidence.result = "pass";
    const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
    const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
    const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
    const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "/Applications/ChatGPT.app/.*codex app-server"], { encoding: "utf8" }).stdout.trim().length > 0;
    const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
    const unexplained = changed.filter((p) => !tolerated.includes(p));
    evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
    assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
    mark(tolerated.length ? "Owner paths: unchanged except ~/.codex, which changed while the Owner's own ChatGPT/Codex app server was running (an external writer); recorded, not hidden" : "Owner profile paths and the installed app were unchanged");
    evidence.phases = { reopen: "window: restored profile opened by the packaged app, Alpha memory page, search, candidates tab, Rebuild Index if needed; API reads of the restored profile" };
    finish();
    return;
  }

  throw new Error(`unknown phase "${phase}"`);
}
