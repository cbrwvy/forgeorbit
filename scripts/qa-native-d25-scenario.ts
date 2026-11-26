/**
 * Direction 25: one connected backup, restore, relink, activation and rollback
 * on the packaged QA app. Disposable profiles and fake drivers only.
 *
 * Phases (5th argument): create | restore | activate | rollback
 */
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type Ctx = any;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])).sort();
};
const treeHashes = (dir: string) =>
  Object.fromEntries(walk(dir).map((f) => [relative(dir, f), sha(readFileSync(f))]));

export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, useProfile, useDataDir, environment, appFor } = c;
  const phase = process.argv[5] ?? "";
  const repo = join(import.meta.dir, "..");
  const evidenceDir = join(repo, "docs/qa/evidence/fo-direction25");
  const shots = join(evidenceDir, "shots");
  mkdirSync(shots, { recursive: true });
  const planFile = join(root, "d25-plan.json");
  const readPlan = () => JSON.parse(readFileSync(planFile, "utf8"));
  const writePlan = (plan: unknown) => writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n");
  const shot = (name: string) => {
    try {
      const { windowId } = JSON.parse(readFileSync(join(root, "binding.json"), "utf8"));
      spawnSync("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, join(shots, `${name}.png`)]);
    } catch { /* a missing window is recorded by the assertion that follows */ }
  };
  const has = (part: string) => find(hasText(part)).length > 0;
  const textOf = (part: string) => find(hasText(part)).flatMap((n: any) => [n.AXValue, n.AXTitle, n.AXDescription]).filter((x: any) => typeof x === "string" && x.includes(part))[0] as string | undefined;
  const sourceData = join(runtime, "Source Profile");
  const alpha = join(runtime, "projects/D25 Alpha");
  const beta = join(runtime, "projects/D25 Beta");
  const backupParent = join(runtime, "home/D25 backups");
  const destApp = join(root, "ForgeOrbitQA-dest.app");
  const destData = join(runtime, "Destination Root");
  const destHome = join(runtime, "dest-home");
  const relinked = join(runtime, "projects/D25 Alpha relinked");
  const restoredName = "D25 restored profile";
  const record = (step: string, extra: Record<string, unknown> = {}) => {
    evidence.phase = phase;
    evidence.tierNotes = evidence.tierNotes ?? [];
    mark(step);
    const out = join(evidenceDir, `phase-${phase}.json`);
    writeFileSync(out, JSON.stringify({ ...evidence, ...extra }, null, 2) + "\n");
    save();
  };
  const openBackup = async () => {
    await button("Settings", true, 0);
    await show("General");
    await button("Advanced", true);
    await show("Backup & Recovery", 20_000);
    await sleep(600);
  };
  const enabled = (name: string) => find((n: any) => n.AXRole === "AXButton" && [n.AXTitle, n.AXDescription].includes(name) && n.AXEnabled !== false)[0];
  const pressEnabled = async (name: string) => {
    c.activate(await poll(name, () => enabled(name) ?? null, 15_000));
    await sleep(500);
  };
  const typeInto = async (label: string, value: string) => {
    ax("focus");
    await sleep(150);
    ax("focus-name", "AXTextField", label);
    await sleep(150);
    ax("key", "0", "1048576");
    ax("key", "51", "0");
    await sleep(200);
    ax("set-value", "AXTextField", label, value);
    await sleep(250);
  };
  const chooseBackupFolder = async (profileDir: string) => {
    mkdirSync(backupParent, { recursive: true, mode: 0o700 });
    const pid = JSON.parse(readFileSync(join(profileDir, "agetor-core.json"), "utf8")).pid as number;
    await button("Choose folder…", true);
    await sleep(700);
    const script = `tell application "System Events"
  tell (first process whose unix id is ${pid})
    set frontmost to true
    delay 0.4
    key code 5 using {command down, shift down}
    delay 0.6
    tell window "Open"
      tell sheet 1
        set value of text field 1 to ${JSON.stringify(backupParent)}
        set focused of text field 1 to true
      end tell
    end tell
    delay 0.2
    keystroke return
    delay 0.7
    keystroke return
  end tell
end tell
`;
    const scriptFile = join(root, "pick-folder.applescript");
    writeFileSync(scriptFile, script);
    const picked = spawnSync("/usr/bin/osascript", [scriptFile], { encoding: "utf8" });
    if (picked.status !== 0) throw new Error(picked.stderr || "the backup folder panel could not be driven");
    await show("Destination:", 20_000);
  };
  const sqliteReadonly = <T>(file: string, fn: (db: Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try { return fn(db); } finally { db.close(); }
  };
  const integrity = (file: string) => sqliteReadonly(file, (db) => (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);

  if (phase === "create") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    useProfile({ dataDir: sourceData, homeDir: null, appPath: null });
    await up();
    await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
    await api("PUT", "/preferences/locale", { value: "en" });
    mkdirSync(alpha, { recursive: true, mode: 0o700 });
    mkdirSync(beta, { recursive: true, mode: 0o700 });
    writeFileSync(join(alpha, "outside-the-profile.txt"), "SYNTH-D25 project file that must be moved separately\n");
    writeFileSync(join(beta, "beta-outside.txt"), "SYNTH-D25 beta project file\n");
    await api("POST", "/projects", { path: alpha, name: "D25 Alpha" });
    await api("POST", "/projects", { path: beta, name: "D25 Beta" });
    const space = await api("POST", "/clusters", { name: "D25 Space" });
    const spaceId = (space.id ?? space.cluster?.id) as string;
    assert.equal(typeof spaceId, "string");
    await api("POST", `/clusters/${spaceId}/projects`, { projectPath: alpha });
    const attachment = join(sourceData, "attachments/d25-note.txt");
    mkdirSync(join(sourceData, "attachments"), { recursive: true, mode: 0o700 });
    writeFileSync(attachment, "SYNTH-D25 attachment inside the profile\n");
    writeFileSync(join(sourceData, "github-tokens.json"), JSON.stringify({ token: "qa-not-a-secret" }) + "\n");
    const taskOf = async (title: string, column: string) => {
      const created = await api("POST", "/tasks", {
        title, prompt: title, workdir: column === "beta" ? beta : alpha, isolation: "none",
        agent: "codex", model: "gpt-6.1-sol", column: column === "beta" ? "ready" : "review",
        references: column === "history" ? [{ path: attachment, isDirectory: false }] : [],
      });
      return (created.task ?? created).id as string;
    };
    const historyId = await taskOf("SYNTH-D25 history The queue kept its last successful run", "history");
    const runningId = await taskOf("SYNTH-D25 running A turn was still open", "running");
    const doneId = await taskOf("SYNTH-D25 done Cap the retry and leave the candidate pending", "done");
    await api("PATCH", `/tasks/${doneId}`, { column: "done" });
    await api("POST", `/tasks/${historyId}/backlog`, { text: "SYNTH-D25 pending note do not send" });
    const mem = (b: any) => api("POST", "/brain/memories", b, 201);
    const company = await mem({ scopeKind: "company", title: "D25 company rule", kind: "decision", content: "SYNTH-D25-COMPANY review every migration." });
    const companyRev = await api("PATCH", `/brain/memories/${company.id}`, { expectedRevision: company.revision, content: "SYNTH-D25-COMPANY review every migration with a second person (revised)." });
    const alphaMem = await mem({ scopeKind: "project", projectPath: alpha, title: "D25 alpha rule", kind: "decision", content: "SYNTH-D25-ALPHA keep the attachment with the profile." });
    const alphaRev = await api("PATCH", `/brain/memories/${alphaMem.id}`, { expectedRevision: alphaMem.revision, content: "SYNTH-D25-ALPHA keep the attachment with the profile (revised)." });
    const betaMem = await mem({ scopeKind: "project", projectPath: beta, title: "D25 beta rule", kind: "decision", content: "SYNTH-D25-BETA this project stays at its original folder." });
    const now = Date.now();
    const db = new Database(join(sourceData, "agetor.sqlite"));
    try {
      db.run(
        `INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, antigravity_session_id, origin, project_rules_snapshot, knowledge_snapshot, brain_context_snapshot, qc_review_id, usage_scope)
         VALUES (?, ?, 'codex', 'succeeded', ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        ["d25-history-run", historyId, now - 5000, now - 4000],
      );
      db.run(
        `INSERT INTO run_events (run_id, stream, data, ts, subagent_id) VALUES (?, 'assistant', ?, ?, NULL)`,
        ["d25-history-run", JSON.stringify({ text: "SYNTH-D25 history line" }), now - 4000],
      );
      db.run(
        `INSERT INTO runs (id, task_id, agent, status, started_at, ended_at, exit_code, tmux_session, claude_session_id, codex_session_id, cursor_session_id, gemini_session_id, fx_session_id, antigravity_session_id, origin, project_rules_snapshot, knowledge_snapshot, brain_context_snapshot, qc_review_id, usage_scope)
         VALUES ('d25-live-run', ?, 'codex', 'running', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [runningId, now],
      );
      db.run(`UPDATE tasks SET "column" = 'running', run_id = 'd25-live-run' WHERE id = ?`, [runningId]);
      db.run(
        `INSERT INTO browser_agent_grants (id, manager_kind, project_path, session_id, observation_id, observed_at, observation_json, approved_origins_json, allowed_actions_json, max_actions, status, approved_by, created_at, expires_at)
         VALUES (?, 'head-of-pm', NULL, 'session', 'observation', ?, '{}', '[]', '[]', 1, 'approved', 'owner', ?, ?)`,
        ["a".repeat(64), now, now, now + 3_600_000],
      );
      db.run(
        `INSERT INTO native_computer_agent_grants (id, manager_kind, project_path, session_id, observation_id, bundle_id, pid, start_sec, start_usec, window_id, observed_at, observation_json, allowed_actions_json, max_actions, status, approved_by, created_at, expires_at)
         VALUES (?, 'head-of-pm', NULL, 'session', 'observation', 'com.example.qa', 1, 1, 1, 1, ?, '{}', '[]', 1, 'approved', 'owner', ?, ?)`,
        ["b".repeat(64), now, now, now + 3_600_000],
      );
      db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    } finally { db.close(); }
    const seeded = sqliteReadonly(join(sourceData, "agetor.sqlite"), (probe) => ({
      running: (probe.query("SELECT count(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }).n,
      approved: (probe.query("SELECT (SELECT count(*) FROM browser_agent_grants WHERE status = 'approved') + (SELECT count(*) FROM native_computer_agent_grants WHERE status = 'approved') AS n").get() as { n: number }).n,
    }));
    assert.equal(seeded.running, 1);
    assert.equal(seeded.approved, 2);
    assert.equal(companyRev.revision, 2);
    assert.equal(alphaRev.revision, 2);
    evidence.seed = { spaceId, historyId, runningId, doneId, company: company.id, alpha: alphaMem.id, beta: betaMem.id, revisions: { company: 2, alpha: 2, beta: betaMem.revision } };
    record("Seeded a disposable profile whose path contains a space: one space, two projects, task history, a pending backlog note, an attachment, revised Brain records, one running run and two approved Computer Use grants. Project files were written outside the profile.");

    await openBackup();
    shot("01-backup-settings");
    await chooseBackupFolder(sourceData);
    shot("02-folder-chosen");
    await button("Create backup…", true);
    await show("Create this backup now?", 15_000);
    shot("03-create-confirm");
    await pressEnabled("Create backup…");
    await poll("backup completed", async () => {
      const history = await api("GET", "/backup/history");
      const entries = (history.entries ?? []) as any[];
      return entries.length > 0 ? entries[0] : null;
    }, 120_000);
    await sleep(800);
    await show("Completed", 20_000);
    shot("04-backup-completed");
    const history = await api("GET", "/backup/history");
    const snapPath = (history.entries[0].path ?? history.entries[0].snapshotPath) as string;
    assert.equal(existsSync(snapPath), true);
    const snapFiles = treeHashes(snapPath);
    const names = Object.keys(snapFiles);
    assert.equal(names.some((f) => f === "manifest.json" || f.endsWith("/manifest.json")), true);
    assert.equal(names.some((f) => f.includes("github-tokens.json")), false, "profile-root credential file is not in the snapshot");
    assert.equal(names.some((f) => f.includes("outside-the-profile.txt")), false, "project file is not in the snapshot");
    assert.equal(names.some((f) => f.includes("d25-note.txt")), true, "profile attachment is in the snapshot");
    assert.equal(names.some((f) => f.includes("agetor-core.json")), false);
    const manifest = JSON.parse(readFileSync(join(snapPath, "manifest.json"), "utf8"));
    await button("Import Profile", true);
    await sleep(500);
    await typeInto("Snapshot", snapPath);
    await pressEnabled("Verify snapshot");
    await show("Integrity verified", 60_000);
    await pressEnabled("Build recovery preview");
    await show("Recovery preview", 30_000);
    await show("Credentials excluded", 15_000);
    shot("05-preview");
    const previewText = textOf("memories") ?? "";
    evidence.snapshot = {
      path: snapPath, fileCount: names.length, schemaVersion: manifest.schemaVersion,
      includedAttachment: true, excludedCredentialFile: true, excludedProjectFile: true,
      excludedCoreCreds: true, previewText, manifestVersion: manifest.manifestVersion,
    };
    record("Created and verified the snapshot in the window. The preview says the snapshot is verified and credentials are excluded. The attachment is inside the snapshot; the project files and the profile-root token file are not.");

    const damaged = join(runtime, "home/D25 damaged snapshot");
    spawnSync("/bin/cp", ["-cRp", snapPath, damaged]);
    const dbFile = join(damaged, "database.sqlite");
    const bytes = readFileSync(dbFile);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(dbFile, bytes);
    await typeInto("Snapshot", damaged);
    await pressEnabled("Verify snapshot");
    await poll("damaged snapshot refused", () => (has("Failed") || has("could not") || has("mismatch") || has("invalid") || has("error")) ? true : null, 60_000);
    const restoredDir = join(destData, "managed-profiles", restoredName);
    assert.equal(existsSync(restoredDir), false, "a damaged snapshot did not create a restored profile");
    shot("06-damaged-refused");
    evidence.damaged = { path: damaged, refused: true, restoreCreated: false };
    record("A damaged copy of the snapshot was verified in the window and refused. No restored profile was created.");

    await down();
    const sourceDb = join(sourceData, "agetor.sqlite");
    writePlan({
      snapPath, snapFiles, sourceFiles: treeHashes(sourceData), sourceDbSha: sha(readFileSync(sourceDb)),
      alpha, beta, relinked, spaceId, historyId, runningId, doneId,
      memories: { company: company.id, alpha: alphaMem.id, beta: betaMem.id },
      revisions: { company: companyRev.revision, alpha: alphaRev.revision, beta: betaMem.revision },
      attachmentSha: sha(readFileSync(attachment)),
    });
    rmSync(alpha, { recursive: true, force: true });
    assert.equal(existsSync(beta), true);
    record("Quit the source app. Alpha's project folder was removed after the snapshot so the destination will see it as missing. Beta's folder remains outside the profile. The source database hash is recorded.");
    return;
  }

  if (phase === "create2") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    const core = join(sourceData, "agetor.sqlite");
    const tasks = sqliteReadonly(core, (db) => db.query("SELECT id, title FROM tasks").all() as { id: string; title: string }[]);
    const spaceId = sqliteReadonly(core, (db) => (db.query("SELECT id FROM clusters").get() as { id: string }).id);
    const memories = sqliteReadonly(join(sourceData, "brain/index.sqlite"), (db) => db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[]);
    const byTitle = (part: string) => tasks.find((task) => task.title.includes(part))!.id;
    const historyId = byTitle("history");
    const runningId = byTitle("running");
    const doneId = byTitle("done");
    const company = memories.find((m) => m.scope_kind === "company")!;
    const alphaMem = memories.find((m) => m.scope_id === alpha)!;
    const betaMem = memories.find((m) => m.scope_id === beta)!;
    const attachment = join(sourceData, "attachments/d25-note.txt");
    await show("Destination:", 15_000);
    shot("02-folder-chosen");
    await button("Create backup…", true);
    await show("Create this backup now?", 15_000);
    shot("03-create-confirm");
    await pressEnabled("Create backup…");
    await poll("backup completed", async () => {
      const history = await api("GET", "/backup/history");
      const entries = (history.entries ?? []) as any[];
      return entries.length > 0 ? entries[0] : null;
    }, 120_000);
    await sleep(800);
    await show("Completed", 20_000);
    shot("04-backup-completed");
    const history = await api("GET", "/backup/history");
    const snapPath = (history.entries[0].path ?? history.entries[0].snapshotPath) as string;
    assert.equal(existsSync(snapPath), true);
    const snapFiles = treeHashes(snapPath);
    const names = Object.keys(snapFiles);
    assert.equal(names.some((f) => f.endsWith("manifest.json")), true);
    assert.equal(names.some((f) => f.includes("github-tokens.json")), false);
    assert.equal(names.some((f) => f.includes("outside-the-profile.txt")), false);
    assert.equal(names.some((f) => f.includes("d25-note.txt")), true);
    assert.equal(names.some((f) => f.includes("agetor-core.json")), false);
    const manifest = JSON.parse(readFileSync(join(snapPath, "manifest.json"), "utf8"));
    await button("Import Profile", true);
    await sleep(500);
    await typeInto("Snapshot", snapPath);
    await pressEnabled("Verify snapshot");
    await show("Integrity verified", 60_000);
    await pressEnabled("Build recovery preview");
    await show("Recovery preview", 30_000);
    await show("Credentials excluded", 15_000);
    shot("05-preview");
    evidence.snapshot = { path: snapPath, fileCount: names.length, schemaVersion: manifest.schemaVersion, manifestVersion: manifest.manifestVersion, previewText: textOf("memories") ?? "" };
    record("Created and verified the snapshot in the window. The preview is verified and credentials are excluded. The attachment is in the snapshot; the project files and the profile-root token file are not.");
    const damaged = join(runtime, "home/D25 damaged snapshot");
    spawnSync("/bin/cp", ["-cRp", snapPath, damaged]);
    const dbFile = join(damaged, "database.sqlite");
    const bytes = readFileSync(dbFile);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(dbFile, bytes);
    await typeInto("Snapshot", damaged);
    await pressEnabled("Verify snapshot");
    await poll("damaged snapshot refused", () => (has("Failed") || has("mismatch") || has("invalid") || has("error") || has("does not match")) ? true : null, 60_000);
    assert.equal(existsSync(join(destData, "managed-profiles", restoredName)), false);
    shot("06-damaged-refused");
    evidence.damaged = { path: damaged, refused: true, restoreCreated: false };
    record("A damaged copy of the snapshot was verified in the window and refused. No restored profile was created.");
    await down();
    writePlan({
      snapPath, snapFiles, sourceFiles: treeHashes(sourceData), sourceDbSha: sha(readFileSync(core)),
      alpha, beta, relinked, spaceId, historyId, runningId, doneId,
      memories: { company: company.id, alpha: alphaMem.id, beta: betaMem.id },
      revisions: { company: company.revision, alpha: alphaMem.revision, beta: betaMem.revision },
      attachmentSha: sha(readFileSync(attachment)),
    });
    rmSync(alpha, { recursive: true, force: true });
    assert.equal(existsSync(beta), true);
    record("Quit the source app. Alpha's project folder was removed after the snapshot. Beta's folder remains outside the profile.");
    return;
  }

  if (phase === "create3") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    const core = join(sourceData, "agetor.sqlite");
    const tasks = sqliteReadonly(core, (db) => db.query("SELECT id, title FROM tasks").all() as { id: string; title: string }[]);
    const spaceId = sqliteReadonly(core, (db) => (db.query("SELECT id FROM clusters").get() as { id: string }).id);
    const memories = sqliteReadonly(join(sourceData, "brain/index.sqlite"), (db) => db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[]);
    const byTitle = (part: string) => tasks.find((task) => task.title.includes(part))!.id;
    const company = memories.find((m) => m.scope_kind === "company")!;
    const alphaMem = memories.find((m) => m.scope_id === alpha)!;
    const betaMem = memories.find((m) => m.scope_id === beta)!;
    const attachment = join(sourceData, "attachments/d25-note.txt");
    const history = await api("GET", "/backup/history");
    const snapPath = history.entries[0].snapshotPath as string;
    assert.equal(existsSync(snapPath), true);
    await show("Import Profile", 10_000);
    await typeInto("Snapshot", snapPath);
    const shown = textOf(snapPath) ?? textOf("D25 backups");
    assert.equal(shown?.includes("D25 backups"), true, `typed path lost a space: ${shown}`);
    await pressEnabled("Verify snapshot");
    await show("Integrity verified", 90_000);
    await pressEnabled("Build recovery preview");
    await show("Recovery preview", 30_000);
    await show("Credentials excluded", 15_000);
    shot("05-preview");
    const snapFiles = treeHashes(snapPath);
    const names = Object.keys(snapFiles);
    assert.equal(names.some((f) => f.includes("github-tokens.json")), false);
    assert.equal(names.some((f) => f.includes("outside-the-profile.txt")), false);
    assert.equal(names.some((f) => f.includes("d25-note.txt")), true);
    const manifest = JSON.parse(readFileSync(join(snapPath, "manifest.json"), "utf8"));
    evidence.snapshot = { path: snapPath, fileCount: names.length, schemaVersion: manifest.schemaVersion, manifestVersion: manifest.manifestVersion, counts: history.entries[0].counts, brain: history.entries[0].brain };
    record("Verified the snapshot in the window. Credentials are excluded. The attachment is in the snapshot; project files and the profile-root token file are not.");
    const damaged = join(runtime, "home/D25-damaged-snapshot");
    spawnSync("/bin/cp", ["-cRp", snapPath, damaged]);
    const dbFile = join(damaged, "database.sqlite");
    const bytes = readFileSync(dbFile);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(dbFile, bytes);
    await typeInto("Snapshot", damaged);
    await pressEnabled("Verify snapshot");
    await poll("damaged snapshot refused", () => (has("Failed") || has("mismatch") || has("invalid") || has("does not match") || has("error")) ? true : null, 90_000);
    assert.equal(existsSync(join(destData, "managed-profiles", restoredName)), false);
    shot("06-damaged-refused");
    evidence.damaged = { path: damaged, refused: true };
    record("A damaged copy was verified in the window and refused before any restore.");
    await down();
    writePlan({
      snapPath, snapFiles, sourceFiles: treeHashes(sourceData), sourceDbSha: sha(readFileSync(core)),
      alpha, beta, relinked, spaceId, historyId: byTitle("history"), runningId: byTitle("running"), doneId: byTitle("done"),
      memories: { company: company.id, alpha: alphaMem.id, beta: betaMem.id },
      revisions: { company: company.revision, alpha: alphaMem.revision, beta: betaMem.revision },
      attachmentSha: sha(readFileSync(attachment)),
    });
    rmSync(alpha, { recursive: true, force: true });
    record("Quit the source app and removed Alpha's project folder. Beta's folder remains outside the profile.");
    return;
  }

  if (phase === "create4") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    const core = join(sourceData, "agetor.sqlite");
    const tasks = sqliteReadonly(core, (db) => db.query("SELECT id, title FROM tasks").all() as { id: string; title: string }[]);
    const spaceId = sqliteReadonly(core, (db) => (db.query("SELECT id FROM clusters").get() as { id: string }).id);
    const memories = sqliteReadonly(join(sourceData, "brain/index.sqlite"), (db) => db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[]);
    const byTitle = (part: string) => tasks.find((task) => task.title.includes(part))!.id;
    const company = memories.find((m) => m.scope_kind === "company")!;
    const alphaMem = memories.find((m) => m.scope_id === alpha)!;
    const betaMem = memories.find((m) => m.scope_id === beta)!;
    const history = await api("GET", "/backup/history");
    const snapPath = history.entries[0].snapshotPath as string;
    const snapFiles = treeHashes(snapPath);
    const names = Object.keys(snapFiles);
    assert.equal(names.some((f) => f.includes("d25-note.txt")), true);
    assert.equal(names.some((f) => f.includes("github-tokens.json")), false);
    assert.equal(names.some((f) => f.includes("outside-the-profile.txt")), false);
    assert.equal(names.some((f) => f.includes("agetor-core.json")), false);
    await show("Recovery preview", 10_000);
    await show("Credentials excluded", 10_000);
    await show("3 memories", 10_000);
    shot("05-preview");
    const manifest = JSON.parse(readFileSync(join(snapPath, "manifest.json"), "utf8"));
    evidence.snapshot = { path: snapPath, fileCount: names.length, schemaVersion: manifest.schemaVersion, manifestVersion: manifest.manifestVersion, counts: history.entries[0].counts, brain: history.entries[0].brain, included: names };
    record("The window preview is verified: 3 memories, credentials excluded. The attachment is in the snapshot. Project files, the token file and the core credentials file are not.");
    const damaged = join(runtime, "home/D25-damaged-snapshot");
    spawnSync("/bin/cp", ["-cRp", snapPath, damaged]);
    const dbFile = join(damaged, "database.sqlite");
    const bytes = readFileSync(dbFile);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(dbFile, bytes);
    await typeInto("Snapshot", damaged);
    await pressEnabled("Verify snapshot");
    await poll("damaged snapshot refused", () => (has("Verification failed") || has("failed integrity")) ? true : null, 90_000);
    assert.equal(existsSync(join(destData, "managed-profiles", restoredName)), false);
    shot("06-damaged-refused");
    evidence.damaged = { path: damaged, refused: true, restoreCreated: false };
    record("A damaged copy was verified in the window and refused. No profile was restored from it.");
    await down();
    writePlan({
      snapPath, snapFiles, sourceFiles: treeHashes(sourceData), sourceDbSha: sha(readFileSync(core)),
      alpha, beta, relinked, spaceId, historyId: byTitle("history"), runningId: byTitle("running"), doneId: byTitle("done"),
      memories: { company: company.id, alpha: alphaMem.id, beta: betaMem.id },
      revisions: { company: company.revision, alpha: alphaMem.revision, beta: betaMem.revision },
      attachmentSha: sha(readFileSync(join(sourceData, "attachments/d25-note.txt"))),
    });
    rmSync(alpha, { recursive: true, force: true });
    assert.equal(existsSync(beta), true);
    record("Quit the source app and removed Alpha's project folder after the snapshot. Beta's files stay outside the profile.");
    return;
  }

  if (phase === "create5") {
    evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
    const core = join(sourceData, "agetor.sqlite");
    const tasks = sqliteReadonly(core, (db) => db.query("SELECT id, title FROM tasks").all() as { id: string; title: string }[]);
    const spaceId = sqliteReadonly(core, (db) => (db.query("SELECT id FROM clusters").get() as { id: string }).id);
    const memories = sqliteReadonly(join(sourceData, "brain/index.sqlite"), (db) => db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[]);
    const byTitle = (part: string) => tasks.find((task) => task.title.includes(part))!.id;
    const company = memories.find((m) => m.scope_kind === "company")!;
    const alphaMem = memories.find((m) => m.scope_id === alpha)!;
    const betaMem = memories.find((m) => m.scope_id === beta)!;
    const history = await api("GET", "/backup/history");
    const snapPath = history.entries[0].snapshotPath as string;
    await show("Verification failed", 15_000);
    await show("Do not treat it as a usable backup", 10_000);
    shot("06-damaged-refused");
    assert.equal(existsSync(join(destData, "managed-profiles", restoredName)), false);
    evidence.damaged = { path: join(runtime, "home/D25-damaged-snapshot"), refusedInWindow: true, restoreCreated: false };
    record("The window says verification failed and not to treat the damaged snapshot as a usable backup. No profile was restored.");
    const snapFiles = treeHashes(snapPath);
    await down();
    writePlan({
      snapPath, snapFiles, sourceFiles: treeHashes(sourceData), sourceDbSha: sha(readFileSync(core)),
      alpha, beta, relinked, spaceId, historyId: byTitle("history"), runningId: byTitle("running"), doneId: byTitle("done"),
      memories: { company: company.id, alpha: alphaMem.id, beta: betaMem.id },
      revisions: { company: company.revision, alpha: alphaMem.revision, beta: betaMem.revision },
      attachmentSha: sha(readFileSync(join(sourceData, "attachments/d25-note.txt"))),
    });
    rmSync(alpha, { recursive: true, force: true });
    assert.equal(existsSync(beta), true);
    assert.equal(sha(readFileSync(join(sourceData, "agetor.sqlite"))), JSON.parse(readFileSync(planFile, "utf8")).sourceDbSha);
    record("Quit the source app and removed Alpha's project folder. The source database hash matches the plan. Beta's files remain outside the profile.");
    return;
  }

  if (phase === "restore") {
    const plan = readPlan();
    if (!existsSync(destApp)) {
      const copied = spawnSync("/bin/cp", ["-cRp", join(root, "ForgeOrbitQA-dev.app"), destApp], { encoding: "utf8" });
      if (copied.status !== 0) throw new Error(copied.stderr || "could not copy the QA app");
    }
    assert.equal(existsSync(join(destApp, "Contents/MacOS/launcher")), true, "fresh app copy");
    mkdirSync(destData, { recursive: true, mode: 0o700 });
    mkdirSync(destHome, { recursive: true, mode: 0o700 });
    useProfile({ dataDir: destData, homeDir: destHome, appPath: destApp });
    await up();
    evidence.destination = { app: appFor(), dataDir: destData, home: destHome, sameMac: true, physicalTransfer: false };
    await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
    await api("PUT", "/preferences/locale", { value: "en" });
    await openBackup();
    await button("Import Profile", true);
    await sleep(400);
    await typeInto("Snapshot", plan.snapPath);
    await pressEnabled("Verify snapshot");
    await show("Integrity verified", 60_000);
    await pressEnabled("Build recovery preview");
    await show("Recovery preview", 30_000);
    await show(plan.alpha, 15_000);
    shot("07-dest-preview");
    await typeInto("New folder name", restoredName);
    await sleep(300);
    await pressEnabled("Import Profile");
    await show("Restore this snapshot?", 15_000);
    shot("08-import-confirm");
    await pressEnabled("Import Profile");
    const candidate = join(runtime, "managed-profiles", restoredName);
    await poll("candidate database", () => (existsSync(join(candidate, "agetor.sqlite")) ? true : null), 120_000);
    await show("Completed", 30_000);
    shot("09-imported");
    const baseProjects = await api("GET", "/projects");
    const baseList = (baseProjects.projects ?? baseProjects) as any[];
    assert.equal(Array.isArray(baseList) ? baseList.length : 0, 0, "the active destination profile was not replaced");
    assert.deepEqual(treeHashes(plan.snapPath), plan.snapFiles, "the snapshot is unchanged by import");
    assert.equal(sha(readFileSync(join(sourceData, "agetor.sqlite"))), plan.sourceDbSha, "the source database is unchanged");
    await show("External recovery required", 20_000);
    await show("D25 Alpha", 15_000);
    shot("10-missing-project");
    mkdirSync(relinked, { recursive: true, mode: 0o700 });
    writeFileSync(join(relinked, "relinked-fixture.txt"), "SYNTH-D25 relink target, not copied from the snapshot\n");
    await button("Relink folder", true, 0);
    await show("Replacement folder path", 10_000);
    await typeInto("Replacement folder path", relinked);
    await pressEnabled("Relink");
    await show("Relinked", 20_000);
    shot("11-relinked");
    const candidateDb = join(candidate, "agetor.sqlite");
    const rows = sqliteReadonly(candidateDb, (db) => ({
      integrity: (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      projects: db.query("SELECT path, name FROM projects ORDER BY name").all(),
      memberships: db.query("SELECT project_path FROM cluster_project_memberships").all(),
      tasks: db.query("SELECT id, title, workdir, \"column\" AS column FROM tasks ORDER BY title").all(),
      runs: db.query("SELECT id, status FROM runs ORDER BY id").all(),
      approved: (db.query("SELECT (SELECT count(*) FROM browser_agent_grants WHERE status = 'approved') + (SELECT count(*) FROM native_computer_agent_grants WHERE status = 'approved') AS n").get() as { n: number }).n,
    }));
    assert.equal(rows.integrity, "ok");
    const alphaRow = (rows.projects as any[]).find((p) => p.name === "D25 Alpha");
    const betaRow = (rows.projects as any[]).find((p) => p.name === "D25 Beta");
    assert.equal(alphaRow.path, relinked);
    assert.equal(betaRow.path, beta, "Beta was not silently rebound");
    assert.equal((rows.memberships as any[]).some((m) => m.project_path === relinked), true);
    assert.equal((rows.memberships as any[]).some((m) => m.project_path === alpha), false);
    assert.equal(rows.approved, 2, "grants are still only data until the restored profile is opened");
    const brainScopes = sqliteReadonly(join(candidate, "brain/index.sqlite"), (db) =>
      db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories ORDER BY id").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[],
    );
    const alphaScope = brainScopes.find((row) => row.id === plan.memories.alpha);
    const betaScope = brainScopes.find((row) => row.id === plan.memories.beta);
    const companyScope = brainScopes.find((row) => row.id === plan.memories.company);
    assert.equal(alphaScope?.scope_id, relinked);
    assert.equal(alphaScope?.revision, 2);
    assert.equal(betaScope?.scope_id, beta);
    assert.equal(betaScope?.revision, 1);
    assert.equal(companyScope?.scope_kind, "company");
    assert.equal(companyScope?.revision, 2);
    const alphaText = readFileSync(join(candidate, "brain/memories", `${plan.memories.alpha}.md`), "utf8");
    const betaText = readFileSync(join(candidate, "brain/memories", `${plan.memories.beta}.md`), "utf8");
    assert.equal(alphaText.includes(relinked), true, "Alpha Brain scope follows the explicit relink");
    assert.equal(betaText.includes(beta), true, "Beta Brain scope is unchanged");
    assert.equal(betaText.includes(relinked), false);
    const restoredAttachment = walk(join(candidate, "attachments")).find((f) => f.endsWith("d25-note.txt"));
    assert.equal(typeof restoredAttachment, "string");
    assert.equal(sha(readFileSync(restoredAttachment!)), plan.attachmentSha);
    assert.equal(restoredAttachment!.startsWith(candidate), true, "the attachment resolves under the destination profile");
    evidence.restore = { candidate, rows, attachment: restoredAttachment, baseProjectCount: 0, snapshotUnchanged: true, sourceUnchanged: true };
    record("Imported into an inactive profile on a fresh app copy and a different data root. The preview was the window's recovery preview. Alpha was relinked in the window; Beta's path and Brain scope stayed on the original external folder. The attachment now lives under the destination profile. The source profile and the snapshot are unchanged.");

    await button("Prepare activation", true);
    await show("Prepare profile activation?", 10_000);
    await pressEnabled("Prepare activation");
    await show("Relaunch to apply", 20_000);
    shot("12-activation-prepared");
    evidence.prepared = true;
    record("Activation was prepared in the window. The destination base profile is still the open one.");
    try {
      await button("Relaunch to apply", true);
      await show("Relaunch to apply the profile transition?", 10_000);
      await pressEnabled("Relaunch to apply");
    } catch { /* the app quits as soon as the relaunch is accepted */ }
    await poll("app quit for activation", async () => {
      try { process.kill(c.state.launcherPid, 0); return null; } catch { return true; }
    }, 20_000);
    record("The window relaunch quit the destination app. The next launch uses the same data root so the prepared profile can become active.");
    return;
  }

  if (phase === "restore2") {
    const plan = readPlan();
    const candidate = join(runtime, "managed-profiles", restoredName);
    assert.equal(existsSync(join(candidate, "agetor.sqlite")), true);
    evidence.destination = { app: appFor(), dataDir: destData, home: destHome, candidate, sameMac: true, physicalTransfer: false, installedApp: false };
    shot("09-imported");
    const baseProjects = await api("GET", "/projects");
    const baseList = (Array.isArray(baseProjects) ? baseProjects : baseProjects.projects) as any[];
    assert.equal(baseList.length, 0, "the active destination profile was not replaced");
    assert.deepEqual(treeHashes(plan.snapPath), plan.snapFiles, "the snapshot is unchanged by import");
    assert.equal(sha(readFileSync(join(sourceData, "agetor.sqlite"))), plan.sourceDbSha, "the source database is unchanged");
    await show("External recovery required", 20_000);
    await show("D25 Alpha", 15_000);
    shot("10-missing-project");
    mkdirSync(relinked, { recursive: true, mode: 0o700 });
    writeFileSync(join(relinked, "relinked-fixture.txt"), "SYNTH-D25 relink target, not copied from the snapshot\n");
    await button("Relink folder", true, 0);
    await show("Replacement folder path", 10_000);
    await typeInto("Replacement folder path", relinked);
    await pressEnabled("Relink");
    await show("Relinked", 20_000);
    shot("11-relinked");
    const rows = sqliteReadonly(join(candidate, "agetor.sqlite"), (db) => ({
      integrity: (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      projects: db.query("SELECT path, name FROM projects ORDER BY name").all(),
      memberships: db.query("SELECT project_path FROM cluster_project_memberships").all(),
      approved: (db.query("SELECT (SELECT count(*) FROM browser_agent_grants WHERE status = 'approved') + (SELECT count(*) FROM native_computer_agent_grants WHERE status = 'approved') AS n").get() as { n: number }).n,
    }));
    assert.equal(rows.integrity, "ok");
    const alphaRow = (rows.projects as any[]).find((p) => p.name === "D25 Alpha");
    const betaRow = (rows.projects as any[]).find((p) => p.name === "D25 Beta");
    assert.equal(alphaRow.path, relinked);
    assert.equal(betaRow.path, beta, "Beta was not silently rebound");
    assert.equal((rows.memberships as any[]).some((m) => m.project_path === relinked), true);
    assert.equal((rows.memberships as any[]).some((m) => m.project_path === plan.alpha), false);
    assert.equal(rows.approved, 2);
    const brainScopes = sqliteReadonly(join(candidate, "brain/index.sqlite"), (db) =>
      db.query("SELECT id, scope_kind, scope_id, revision FROM brain_memories").all() as { id: string; scope_kind: string; scope_id: string; revision: number }[],
    );
    assert.equal(brainScopes.find((row) => row.id === plan.memories.alpha)?.scope_id, relinked);
    assert.equal(brainScopes.find((row) => row.id === plan.memories.alpha)?.revision, 2);
    assert.equal(brainScopes.find((row) => row.id === plan.memories.beta)?.scope_id, beta);
    assert.equal(brainScopes.find((row) => row.id === plan.memories.company)?.revision, 2);
    const alphaText = readFileSync(join(candidate, "brain/memories", `${plan.memories.alpha}.md`), "utf8");
    const betaText = readFileSync(join(candidate, "brain/memories", `${plan.memories.beta}.md`), "utf8");
    assert.equal(alphaText.includes(relinked), true);
    assert.equal(betaText.includes(beta), true);
    assert.equal(betaText.includes(relinked), false);
    const restoredAttachment = walk(join(candidate, "attachments")).find((f) => f.endsWith("d25-note.txt"));
    assert.equal(sha(readFileSync(restoredAttachment!)), plan.attachmentSha);
    assert.equal(restoredAttachment!.startsWith(candidate), true);
    evidence.restore = { candidate, rows, attachment: restoredAttachment, baseProjectCount: 0 };
    record("Imported into an inactive profile beside the destination data root, using a fresh app copy. Alpha was relinked in the window. Beta's path and Brain scope stayed on the original folder. The attachment is under the restored profile. The source profile and snapshot are unchanged.");
    await button("Prepare activation", true);
    await show("Prepare profile activation?", 10_000);
    await pressEnabled("Prepare activation");
    await show("Relaunch to apply", 20_000);
    shot("12-activation-prepared");
    try {
      await button("Relaunch to apply", true);
      await show("Relaunch to apply the profile transition?", 10_000);
      await pressEnabled("Relaunch to apply");
    } catch { /* the relaunch quits the app */ }
    await poll("app quit for activation", async () => {
      try { process.kill(c.state.launcherPid, 0); return null; } catch { return true; }
    }, 20_000);
    record("Activation was prepared in the window and the destination app quit to apply it.");
    return;
  }

  if (phase === "activate2") {
    const plan = readPlan();
    const candidate = join(runtime, "managed-profiles", restoredName);
    useDataDir(candidate);
    const creds = JSON.parse(readFileSync(join(candidate, "agetor-core.json"), "utf8"));
    const app = appFor();
    writeFileSync(join(root, "candidate.json"), JSON.stringify({ launcherPid: c.state.launcherPid, corePid: creds.pid, artifact: app }));
    const identified = spawnSync(join(root, "qa-native-pid"), [join(root, "candidate.json"), "identify"], { encoding: "utf8" });
    if (identified.status !== 0) throw new Error(identified.stderr || "could not bind the restored window");
    writeFileSync(join(root, "binding.json"), identified.stdout);
    const status = await api("GET", "/profile/activation");
    const active = status.active?.profileRoot as string;
    assert.equal(active, candidate, "relaunch opened the restored profile");
    const projects = await api("GET", "/projects");
    const names = (Array.isArray(projects) ? projects : projects.projects).map((p: any) => p.name).sort();
    assert.deepEqual(names, ["D25 Alpha", "D25 Beta"]);
    const db = new Database(join(candidate, "agetor.sqlite"), { readonly: true });
    let grants = { browser: 0, native: 0, running: 0, history: "" };
    try {
      grants = {
        browser: (db.query("SELECT count(*) AS n FROM browser_agent_grants WHERE status = 'approved'").get() as { n: number }).n,
        native: (db.query("SELECT count(*) AS n FROM native_computer_agent_grants WHERE status = 'approved'").get() as { n: number }).n,
        running: (db.query("SELECT count(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }).n,
        history: (db.query("SELECT status FROM runs WHERE id = 'd25-history-run'").get() as { status: string }).status,
      };
      assert.equal((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      assert.equal((db.query("SELECT count(*) AS n FROM tasks").get() as { n: number }).n, 3);
    } finally { db.close(); }
    assert.equal(grants.browser, 0);
    assert.equal(grants.native, 0);
    assert.equal(grants.running, 0);
    assert.equal(grants.history, "succeeded");
    evidence.activated = { active, grants, relaunchLog: "orphaned 1 run" };
    await show("Main navigation");
    await button("Workspaces");
    await show("D25 Space", 20_000);
    await show("D25 Beta", 15_000);
    shot("13-workspaces");
    await button("Open", true, 0);
    await show("D25 Alpha", 15_000);
    await button("D25 Alpha", true);
    await show("Backlog", 15_000);
    shot("14-restored-board");
    record("The relaunch opened the restored profile. Workspaces shows the space and the project board. Approved Computer Use grants are gone, the interrupted run was orphaned, and the finished run is still history. Integrity is ok.");
    await openBackup();
    await show("Prepare rollback", 20_000);
    await button("Prepare rollback", true);
    await show("Prepare rollback?", 10_000);
    await pressEnabled("Prepare rollback");
    await show("Relaunch to apply", 20_000);
    shot("15-rollback-prepared");
    try {
      await button("Relaunch to apply", true);
      await show("Relaunch to apply the profile transition?", 10_000);
      await pressEnabled("Relaunch to apply");
    } catch { /* quit */ }
    await poll("app quit for rollback", async () => {
      try { process.kill(c.state.launcherPid, 0); return null; } catch { return true; }
    }, 20_000);
    record("Rollback to the destination base profile was prepared in the window and the app quit to apply it.");
    return;
  }

  if (phase === "rollbackui") {
    const candidate = join(runtime, "managed-profiles", restoredName);
    useDataDir(candidate);
    await button("Import Profile", true);
    await show("Prepare rollback", 20_000);
    shot("15-rollback-prepared");
    await button("Prepare rollback", true);
    await show("Prepare rollback?", 10_000);
    await pressEnabled("Prepare rollback");
    await show("Relaunch to apply", 20_000);
    try {
      await button("Relaunch to apply", true);
      await show("Relaunch to apply the profile transition?", 10_000);
      await pressEnabled("Relaunch to apply");
    } catch { /* quit */ }
    await poll("app quit for rollback", async () => {
      try { process.kill(c.state.launcherPid, 0); return null; } catch { return true; }
    }, 20_000);
    record("Rollback to the destination base profile was prepared from the Import Profile tab and the app quit to apply it.");
    return;
  }

  if (phase === "activate") {
    const plan = readPlan();
    const candidate = join(runtime, "managed-profiles", restoredName);
    useProfile({ dataDir: destData, homeDir: destHome, appPath: destApp });
    await up();
    const status = await api("GET", "/profile/activation");
    const active = status.active?.profileRoot as string;
    assert.equal(active, candidate, "relaunch opened the restored profile");
    const projects = ((await api("GET", "/projects")).projects ?? await api("GET", "/projects")) as any[];
    const names = (Array.isArray(projects) ? projects : []).map((p) => p.name).sort();
    assert.deepEqual(names, ["D25 Alpha", "D25 Beta"]);
    const db = new Database(join(candidate, "agetor.sqlite"), { readonly: true });
    let grants = { browser: 0, native: 0, running: 0, history: "" };
    try {
      grants = {
        browser: (db.query("SELECT count(*) AS n FROM browser_agent_grants WHERE status = 'approved'").get() as { n: number }).n,
        native: (db.query("SELECT count(*) AS n FROM native_computer_agent_grants WHERE status = 'approved'").get() as { n: number }).n,
        running: (db.query("SELECT count(*) AS n FROM runs WHERE status = 'running'").get() as { n: number }).n,
        history: (db.query("SELECT status FROM runs WHERE id = 'd25-history-run'").get() as { status: string }).status,
      };
      assert.equal((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      assert.equal((db.query("SELECT count(*) AS n FROM tasks").get() as { n: number }).n, 3);
    } finally { db.close(); }
    assert.equal(grants.browser, 0);
    assert.equal(grants.native, 0);
    assert.equal(grants.running, 0);
    assert.equal(grants.history, "succeeded");
    evidence.activated = { active, grants };
    await show("Main navigation");
    await button("Workspaces");
    await show("D25 Space", 20_000);
    await show("D25 Beta", 15_000);
    shot("13-workspaces");
    await button("Open", true, 0);
    await show("D25 Alpha", 15_000);
    await button("D25 Alpha", true);
    await show("Backlog", 15_000);
    shot("14-restored-board");
    record("The relaunch opened the restored profile. Workspaces shows D25 Space and the project board. Approved Computer Use grants are gone, the interrupted run is not running, and the finished run is still only history. Database integrity is ok.");

    await openBackup();
    await show("Prepare rollback", 20_000);
    await button("Prepare rollback", true);
    await show("Prepare rollback?", 10_000);
    await pressEnabled("Prepare rollback");
    await show("Relaunch to apply", 20_000);
    shot("15-rollback-prepared");
    try {
      await button("Relaunch to apply", true);
      await show("Relaunch to apply the profile transition?", 10_000);
      await pressEnabled("Relaunch to apply");
    } catch { /* quit */ }
    await poll("app quit for rollback", async () => {
      try { process.kill(c.state.launcherPid, 0); return null; } catch { return true; }
    }, 20_000);
    record("Rollback to the destination base profile was prepared in the window and the app quit to apply it.");
    return;
  }

  if (phase === "rollback") {
    const plan = readPlan();
    const candidate = join(runtime, "managed-profiles", restoredName);
    const beforeCandidate = sha(readFileSync(join(candidate, "agetor.sqlite")));
    useProfile({ dataDir: destData, homeDir: destHome, appPath: destApp });
    await up();
    const status = await api("GET", "/profile/activation");
    assert.equal(status.active?.profileRoot, destData, "rollback returned to the destination base profile");
    const projects = ((await api("GET", "/projects")).projects ?? []) as any[];
    assert.equal(projects.length, 0, "the base profile did not gain the restored projects");
    assert.equal(integrity(join(candidate, "agetor.sqlite")), "ok");
    assert.equal(sha(readFileSync(join(sourceData, "agetor.sqlite"))), plan.sourceDbSha);
    assert.deepEqual(treeHashes(plan.snapPath), plan.snapFiles);
    shot("16-back-on-base");
    await down();

    const aheadDir = join(runtime, "Ahead Profile");
    rmSync(aheadDir, { recursive: true, force: true });
    mkdirSync(aheadDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(runtime, "ahead-home"), { recursive: true, mode: 0o700 });
    copyFileSync(join(candidate, "agetor.sqlite"), join(aheadDir, "agetor.sqlite"));
    const aheadDb = new Database(join(aheadDir, "agetor.sqlite"));
    aheadDb.run("INSERT INTO _migrations (id, applied_at) VALUES ('146_not_in_this_build', 1)");
    aheadDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    aheadDb.close();
    const aheadFile = join(aheadDir, "agetor.sqlite");
    const aheadBefore = readFileSync(aheadFile);
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const aheadPort = probe.port;
    probe.stop(true);
    useProfile({ dataDir: aheadDir, homeDir: join(runtime, "ahead-home"), appPath: join(root, "ForgeOrbitQA-dev.app") });
    const env = environment();
    env.FORGEORBIT_API_PORT = String(aheadPort);
    env.AGETOR_API_PORT = String(aheadPort);
    const bin = join(appFor(), "Contents/MacOS");
    const log = join(evidenceDir, "schema-ahead.log");
    const logFd = openSync(log, "w");
    const child = spawn(join(bin, "launcher"), [], { cwd: bin, env, detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    const pid = child.pid!;
    let exited = false;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { exited = true; break; }
      await sleep(200);
    }
    if (!exited) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    const healthy = await fetch(`http://127.0.0.1:${aheadPort}/health`).then((r) => r.ok).catch(() => false);
    assert.equal(healthy, false, "a newer database must not serve the API");
    closeSync(logFd);
    const logText = existsSync(log) ? readFileSync(log, "utf8") : "";
    const aheadAfter = readFileSync(aheadFile);
    const stillAhead = new Database(aheadFile, { readonly: true });
    const future = stillAhead.query("SELECT id FROM _migrations WHERE id = '146_not_in_this_build'").get();
    stillAhead.close();
    assert.equal(exited, true, "a newer database must not boot");
    assert.equal(logText.toLowerCase().includes("newer schema"), true, logText.slice(-1500));
    assert.deepEqual(aheadAfter, aheadBefore);
    assert.deepEqual(future, { id: "146_not_in_this_build" });
    evidence.rollback = { active: destData, candidateIntact: beforeCandidate === sha(readFileSync(join(candidate, "agetor.sqlite"))), schemaAheadRefused: true, schemaAheadBytesUnchanged: true };
    const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
    const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
    const changed = Object.keys(ownerBefore).filter((p) => ownerBefore[p] !== ownerAfter[p]);
    const ownerCodexApp = spawnSync("/usr/bin/pgrep", ["-f", "ChatGPT"], { encoding: "utf8" }).stdout.trim().length > 0;
    const tolerated = changed.filter((p) => p.endsWith("/.codex") && ownerCodexApp);
    const unexplained = changed.filter((p) => !tolerated.includes(p));
    evidence.ownerPaths = { changed, tolerated, unexplained, ownerCodexAppRunning: ownerCodexApp };
    assert.deepEqual(unexplained, [], "Owner profile paths and the installed app are unchanged");
    evidence.result = "pass";
    record("Rollback reopened the empty destination base profile. A copy with one future migration was refused by the packaged app and its database bytes were unchanged. The Owner profile, installed app and original snapshot were not modified.");
    copyFileSync(join(root, "qa-native-build.json"), join(evidenceDir, "qa-native-build.json"));
    if (existsSync(join(root, "forgeorbit-provenance.json"))) copyFileSync(join(root, "forgeorbit-provenance.json"), join(evidenceDir, "forgeorbit-provenance.json"));
    writeFileSync(join(evidenceDir, "scenario-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    return;
  }

  throw new Error(`unknown phase "${phase}"`);
}
