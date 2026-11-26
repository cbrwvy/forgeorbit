/**
 * FO-P2-005-B HTTP integration over the trusted activation core.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { makeRoot } from "./fixtures/profile-activation-test-util.ts";

const ROOT = mkdtempSync(path.join(tmpdir(), "fo-p2-005b-endpoints-"));
const PROFILE = path.join(ROOT, "profile");
const DATA_DIR = path.join(PROFILE, "data");
const BACKUPS = path.join(ROOT, "backups");
const RESTORES = path.join(ROOT, "restores");
const PICK_FILE = path.join(ROOT, "pick.txt");
const READY_FILE = path.join(ROOT, "ready.json");
const PORT = String(4561 + Math.floor(Math.random() * 200));

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
  await waitForReady();
}, 60_000);

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5_000)]);
  }
  rmSync(ROOT, { recursive: true, force: true });
});

test("profile activation routes require auth", async () => {
  const response = await call("/profile/activation", {}, false);
  expect(response.status).toBe(401);
});

test("restore → inspect → prepare activation over HTTP", async () => {
  writePick(realpathSync(BACKUPS));
  const picked = await post("/backup/destinations/pick", { purpose: "backup-parent" });
  const created = await post("/backup/create", { grantId: picked.body.grantId });
  const createOp = await waitForOperation(created.body.operation.id);
  const snapshotPath = createOp.snapshotPath as string;

  const verifiedResponse = await post("/backup/verify", { snapshotPath });
  const verified = await waitForOperation(verifiedResponse.body.operation.id);

  writePick(realpathSync(RESTORES));
  const restorePicked = await post("/backup/destinations/pick", { purpose: "restore-parent" });
  const restoredResponse = await post("/backup/restore", {
    snapshotPath,
    grantId: restorePicked.body.grantId,
    verificationId: verified.id,
    destinationName: "activation-http",
  });
  const restored = await waitForOperation(restoredResponse.body.operation.id);
  const destinationPath = restored.destinationPath as string;
  expect(restored.restore.activated).toBe(false);

  const statusBefore = await call("/profile/activation");
  expect(statusBefore.status).toBe(200);
  expect(realpathSync(statusBefore.body.active.profileRoot)).toBe(realpathSync(DATA_DIR));

  const inspect = await post("/profile/activation/candidate/inspect", { candidatePath: destinationPath });
  expect(inspect.status).toBe(200);
  expect(inspect.body.ok).toBe(true);

  const refused = await post("/profile/activation/prepare", { candidatePath: destinationPath });
  expect(refused.status).toBe(400);

  const prepared = await post("/profile/activation/prepare", {
    candidatePath: destinationPath,
    confirm: true,
  });
  expect(prepared.status).toBe(200);
  expect(prepared.body.action).toBe("activate");
  expect(prepared.body.requiresRestart).toBe(true);

  const statusPending = await call("/profile/activation");
  expect(statusPending.body.pendingTransition?.action).toBe("activate");
  expect(realpathSync(statusPending.body.active.profileRoot)).toBe(realpathSync(DATA_DIR));

  const duplicate = await post("/profile/activation/prepare", {
    candidatePath: destinationPath,
    confirm: true,
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe("ACTIVATION_PENDING");
}, 120_000);

test("active profile cannot be prepared as activation candidate", async () => {
  const response = await post("/profile/activation/candidate/inspect", { candidatePath: realpathSync(DATA_DIR) });
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(false);
  expect(response.body.code).toBe("CANDIDATE_ACTIVE");
});

test("corrupt candidate path is rejected at inspect", async () => {
  const scope = makeRoot("fo-005b-bad-");
  try {
    const missing = path.join(scope.root, "does-not-exist");
    const response = await post("/profile/activation/candidate/inspect", { candidatePath: missing });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.code).toBe("CANDIDATE_NOT_FOUND");
  } finally {
    scope.cleanup();
  }
});

test("candidate relink requires authentication", async () => {
  const response = await call("/profile/activation/candidate/relink", { method: "POST", body: "{}" }, false);
  expect(response.status).toBe(401);
});

test("candidate relink rejects missing candidate path", async () => {
  const response = await post("/profile/activation/candidate/relink", {});
  expect(response.status).toBe(400);
  expect(response.body.code).toBe("INVALID_INPUT");
});

test("candidate relink rejects operation when activation is pending", async () => {
  const response = await post("/profile/activation/candidate/relink", {
    candidatePath: path.join(ROOT, "unmanaged-candidate"),
    oldPath: "/old",
    newPath: "/new",
  });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("ACTIVATION_PENDING");
});
