/**
 * FO-P2-004 end-to-end HTTP integration.
 *
 * A real API server runs in a child Bun process against a synthetic profile, so
 * the route layer, authentication, native-pick grants, the lazy worker runner
 * and the webview transport all meet the same way they do in the app.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupOperationCard } from "../mainview/components/settings/BackupRecoverySection.tsx";
import {
  backupOperationOutcomeKey,
  backupStateLabelKey,
} from "../mainview/lib/backup-recovery.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "fo-p2-004-endpoints-"));
const PROFILE = path.join(ROOT, "profile");
const DATA_DIR = path.join(PROFILE, "data");
const BACKUPS = path.join(ROOT, "backups");
const RESTORES = path.join(ROOT, "restores");
const PICK_FILE = path.join(ROOT, "pick.txt");
const READY_FILE = path.join(ROOT, "ready.json");
const PORT = String(4551 + Math.floor(Math.random() * 200));

let child: ReturnType<typeof Bun.spawn> | null = null;
let token = "";
let stderr = "";

function makeProfile(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const category of ["knowledge", "attachments", "screenshots", "issue-threads", "pipeline-runs"]) {
    mkdirSync(path.join(DATA_DIR, category), { recursive: true, mode: 0o700 });
  }
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  mkdirSync(RESTORES, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(DATA_DIR, "agetor.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
  migrate(db, migrations);
  const now = Date.now();
  db.run(
    "INSERT INTO tasks (id, title, prompt, column, agent, workdir, refs, created_at, updated_at) VALUES ('task-1', 'Synthetic endpoint task', 'Synthetic prompt', 'backlog', 'claude-code', ?, '[]', ?, ?);",
    [DATA_DIR, now, now],
  );
  writeFileSync(path.join(DATA_DIR, "attachments", "note.txt"), "synthetic attachment\n");
  db.close();
}

function writePick(picked: string): void {
  writeFileSync(PICK_FILE, picked);
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(READY_FILE)) {
      const parsed = JSON.parse(readFileSync(READY_FILE, "utf8")) as { token?: string };
      if (parsed.token) {
        token = parsed.token;
        return;
      }
    }
    if (child && child.exitCode !== null) {
      throw new Error(`server child exited early: ${stderr}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`server child did not become ready: ${stderr}`);
}

async function call(
  route: string,
  init: RequestInit = {},
  withToken = true,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(withToken ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const post = (route: string, body: unknown) => call(route, { method: "POST", body: JSON.stringify(body) });

async function waitForOperation(operationId: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const response = await call(`/backup/operations/${operationId}`);
    expect(response.status).toBe(200);
    last = response.body.operation;
    if (
      last.state === "completed" ||
      last.state === "cancelled-before-publication" ||
      last.state === "published-unconfirmed" ||
      last.state === "indeterminate" ||
      last.state === "verification-failed" ||
      last.state === "failed-before-publication"
    ) {
      return last;
    }
    await Bun.sleep(60);
  }
  throw new Error(`operation did not settle: ${JSON.stringify(last)}`);
}

beforeAll(async () => {
  makeProfile();
  const script = path.join(ROOT, "server.ts");
  const serverModule = path.resolve(import.meta.dir, "server.ts");
  const nativeModule = path.resolve(import.meta.dir, "test-native.ts");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
import { startApiServer, API_TOKEN } from ${JSON.stringify(serverModule)};
import { makeTestNative } from ${JSON.stringify(nativeModule)};
const native = makeTestNative({
  openFileDialog: async () => {
    try { return [readFileSync(process.env.BACKUP_PICK_FILE!, "utf8")]; } catch { return []; }
  },
});
const server = startApiServer({ native });
writeFileSync(process.env.BACKUP_READY_FILE!, JSON.stringify({ token: API_TOKEN, port: process.env.AGETOR_API_PORT }));
process.on("SIGTERM", () => { try { server.stop(true); } catch {} process.exit(0); });
`,
  );
  child = Bun.spawn([process.execPath, "run", script], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      FORGEORBIT_DATA_DIR: DATA_DIR,
      AGETOR_DATA_DIR: DATA_DIR,
      AGETOR_API_PORT: PORT,
      BACKUP_PICK_FILE: PICK_FILE,
      BACKUP_READY_FILE: READY_FILE,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrStream = child.stderr as ReadableStream<Uint8Array> | undefined;
  const stderrReader = stderrStream?.getReader();
  if (stderrReader) {
    void (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderr += new TextDecoder().decode(value);
        }
      } catch {
        /* ignore */
      }
    })();
  }
  await waitForReady();
}, 60_000);

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5_000)]);
  }
  rmSync(ROOT, { recursive: true, force: true });
});

test("backup routes require the per-launch token", async () => {
  const response = await call("/backup/profile", {}, false);
  expect(response.status).toBe(401);
});

test("complete-profile create → verify → preview → inactive restore over HTTP", async () => {
  const profile = await call("/backup/profile");
  expect(profile.status).toBe(200);
  expect(profile.body.coverage).toBe("complete-profile");
  expect(profile.body.manifestVersion).toBe(4);

  writePick(realpathSync(BACKUPS));
  const picked = await post("/backup/destinations/pick", { purpose: "backup-parent" });
  expect(picked.status).toBe(200);
  expect(picked.body.grantId).toBeString();
  expect(picked.body.path).toBe(realpathSync(BACKUPS));

  const created = await post("/backup/create", { grantId: picked.body.grantId });
  expect(created.status).toBe(200);
  const createOp = await waitForOperation(created.body.operation.id);
  expect(createOp.state).toBe("completed");
  expect(createOp.integrity).toBe("not_verified");
  // The real backend view feeds the UI state model directly.
  expect(backupStateLabelKey(createOp.state)).toBe("backup.state_completed");
  expect(backupOperationOutcomeKey(createOp)).toBe("backup.outcome_backup_created_unverified");
  const snapshotPath = createOp.snapshotPath as string;
  expect(existsSync(path.join(snapshotPath, "manifest.json"))).toBe(true);

  const inspected = await post("/backup/inspect", { snapshotPath });
  expect(inspected.status).toBe(200);
  expect(inspected.body.snapshot.manifestVersion).toBe(4);
  expect(inspected.body.snapshot.coverage).toBe("complete-profile");

  // Preview before verification is refused, never silently trusted.
  const refused = await post("/backup/restore/preview", { snapshotPath });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("VERIFICATION_REQUIRED");

  const verifiedResponse = await post("/backup/verify", { snapshotPath });
  const verified = await waitForOperation(verifiedResponse.body.operation.id);
  expect(verified.state).toBe("completed");
  expect(verified.integrity).toBe("verified");
  expect(verified.verify.ok).toBe(true);
  expect(backupOperationOutcomeKey(verified)).toBe("backup.outcome_verified");

  const preview = await post("/backup/restore/preview", {
    snapshotPath,
    verificationId: verified.id,
  });
  expect(preview.status).toBe(200);
  expect(preview.body.snapshot.legacy).toBe(false);
  expect(preview.body.recovery.readiness).toBe("ready");
  expect(preview.body.recovery.readinessAdvisory).toBe(true);

  const history = await call("/backup/history");
  expect(history.status).toBe(200);
  const entry = history.body.entries.find((candidate: any) => candidate.snapshotPath === snapshotPath);
  expect(entry?.integrity).toBe("verified");

  writePick(realpathSync(RESTORES));
  const restorePicked = await post("/backup/destinations/pick", { purpose: "restore-parent" });
  expect(restorePicked.status).toBe(200);
  const restoredResponse = await post("/backup/restore", {
    snapshotPath,
    grantId: restorePicked.body.grantId,
    verificationId: verified.id,
    destinationName: "http-restored",
  });
  expect(restoredResponse.status).toBe(200);
  const restored = await waitForOperation(restoredResponse.body.operation.id);
  expect(restored.state).toBe("completed");
  expect(restored.destinationPath).toBe(path.join(realpathSync(RESTORES), "http-restored"));
  expect(restored.restore.activated).toBe(false);
  expect(backupOperationOutcomeKey(restored)).toBe("backup.outcome_restored_not_activated");
  const html = renderToStaticMarkup(
    createElement(BackupOperationCard, { operation: restored, onCancel: () => {} }),
  );
  expect(html).toContain("Restored — not activated");
  expect(existsSync(path.join(restored.destinationPath, "agetor.sqlite"))).toBe(true);
  expect(existsSync(path.join(restored.destinationPath, ".forgeorbit-recovery.json"))).toBe(true);

  // The session operation list exposes bounded history only.
  const operations = await call("/backup/operations");
  expect(operations.status).toBe(200);
  expect(operations.body.operations.every((op: any) => typeof op.state === "string")).toBe(true);
});

test("active-profile destination is rejected at the native-pick boundary", async () => {
  writePick(DATA_DIR);
  const response = await post("/backup/destinations/pick", { purpose: "backup-parent" });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("ACTIVE_PROFILE_PROTECTED");
});

test("restore refuses an existing destination and preserves it", async () => {
  // Reuse the verified snapshot created above.
  const history = await call("/backup/history");
  const verifiedEntry = history.body.entries.find((entry: any) => entry.integrity === "verified");
  expect(verifiedEntry).toBeDefined();
  const snapshotPath = verifiedEntry.snapshotPath as string;
  const verifyResponse = await post("/backup/verify", { snapshotPath });
  const verified = await waitForOperation(verifyResponse.body.operation.id);
  const existingName = "already-there";
  mkdirSync(path.join(RESTORES, existingName), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(RESTORES, existingName, "keep.txt"), "keep me");
  writePick(realpathSync(RESTORES));
  const grant = await post("/backup/destinations/pick", { purpose: "restore-parent" });
  const response = await post("/backup/restore", {
    snapshotPath,
    grantId: grant.body.grantId,
    verificationId: verified.id,
    destinationName: existingName,
  });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("TARGET_EXISTS");
  expect(readFileSync(path.join(RESTORES, existingName, "keep.txt"), "utf8")).toBe("keep me");
});

test("a valid snapshot outside every known location needs an explicit native selection", async () => {
  const history = await call("/backup/history");
  const known = history.body.entries[0];
  expect(known).toBeDefined();
  const external = path.join(ROOT, "external-snapshot");
  cpSync(known.snapshotPath, external, { recursive: true });
  const refused = await post("/backup/verify", { snapshotPath: external });
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe("SNAPSHOT_SELECTION_REQUIRED");
  writePick(external);
  const selection = await post("/backup/destinations/pick", { purpose: "snapshot" });
  expect(selection.status).toBe(200);
  expect(selection.body.path).toBe(path.resolve(external));
  const accepted = await post("/backup/verify", { snapshotPath: external });
  expect(accepted.status).toBe(200);
  const settled = await waitForOperation(accepted.body.operation.id);
  expect(settled.state).toBe("completed");
  expect(settled.integrity).toBe("verified");
});

test("malformed snapshots get descriptive bounded errors, not worker internals", async () => {
  const bogus = path.join(ROOT, "not-a-snapshot");
  mkdirSync(bogus, { recursive: true, mode: 0o700 });
  // A path that is not a snapshot fails structural validation.
  const unpicked = await post("/backup/verify", { snapshotPath: bogus });
  expect(unpicked.status).toBe(400);
  expect(unpicked.body.code).toBe("INVALID_SNAPSHOT");
  writePick(bogus);
  const selection = await post("/backup/destinations/pick", { purpose: "snapshot" });
  expect(selection.status).toBe(400);
  expect(selection.body.code).toBe("INVALID_SNAPSHOT");
  const response = await post("/backup/verify", { snapshotPath: bogus });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("INVALID_SNAPSHOT");
  expect(String(response.body.error)).not.toMatch(/at Object|node:internal|SELECT /);
});

test("three sequential backups into one parent succeed through one long-lived server", async () => {
  const paths: string[] = [];
  for (let i = 0; i < 3; i++) {
    writePick(realpathSync(BACKUPS));
    const picked = await post("/backup/destinations/pick", { purpose: "backup-parent" });
    expect(picked.status).toBe(200);
    const created = await post("/backup/create", { grantId: picked.body.grantId });
    expect(created.status).toBe(200);
    const operation = await waitForOperation(created.body.operation.id);
    expect(operation.state).toBe("completed");
    paths.push(operation.snapshotPath as string);
  }
  expect(new Set(paths).size).toBe(3);
  const firstDb = readFileSync(path.join(paths[0]!, "database.sqlite"));
  for (const snapshotPath of paths) {
    expect(existsSync(path.join(snapshotPath, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(snapshotPath, "database.sqlite"))).toBe(true);
  }
  // Earlier published snapshots are immutable across later backups.
  expect(readFileSync(path.join(paths[0]!, "database.sqlite"))).toEqual(firstDb);
});

test("oversized backup request bodies are rejected before parsing", async () => {
  const oversized = JSON.stringify({ grantId: "x", padding: "a".repeat(40_000) });
  const byLength = await call("/backup/create", { method: "POST", body: oversized });
  expect(byLength.status).toBe(413);
  expect(byLength.body.code).toBe("REQUEST_TOO_LARGE");

  // Chunked (no Content-Length) takes the capped-read path.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized));
      controller.close();
    },
  });
  const response = await fetch(`http://127.0.0.1:${PORT}/backup/restore/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: stream,
    // @ts-expect-error Bun supports half-duplex streaming bodies.
    duplex: "half",
  });
  expect(response.status).toBe(413);
  expect((await response.json()).code).toBe("REQUEST_TOO_LARGE");
});

test("invalid backup JSON is rejected with a bounded 400", async () => {
  const response = await call("/backup/verify", { method: "POST", body: "{not json" });
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("INVALID_JSON");
});
