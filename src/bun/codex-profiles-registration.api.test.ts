import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../e2e/codex-profile-fixture.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("isolated API registration persists across a backend restart", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-codex-reg-api-")));
  const dataDir = path.join(root, "data");
  const ownerHome = path.join(root, "owner");
  mkdirSync(dataDir);
  mkdirSync(ownerHome);
  const homes = ["profile-a", "profile-b"].map((name, index) => {
    const directory = path.join(ownerHome, name);
    writeSyntheticCodexProfile(directory, `api-subject-${index}`);
    return directory;
  });
  mkdirSync(path.join(ownerHome, ".ssh"));
  const port = await freePort();
  const token = crypto.randomUUID();
  const env = {
    ...process.env,
    HOME: ownerHome,
    AGETOR_DATA_DIR: dataDir,
    FORGEORBIT_DATA_DIR: dataDir,
    AGETOR_API_PORT: String(port),
    FORGEORBIT_API_PORT: String(port),
    AGETOR_API_TOKEN: token,
    FORGEORBIT_API_TOKEN: token,
    AGETOR_DAEMON_IDLE_MS: "600000",
    AGETOR_CODEX_DRIVER: "fake",
    AGETOR_CLAUDE_DRIVER: "fake",
    AGETOR_CURSOR_DRIVER: "fake",
    AGETOR_GEMINI_DRIVER: "fake",
    AGETOR_FX_DRIVER: "fake",
    AGETOR_USAGE_OFFLINE: "1",
    AGETOR_DISABLE_UPDATES: "1",
  };
  const base = `http://127.0.0.1:${port}`;
  let child: Bun.Subprocess | undefined;
  const output: string[] = [];
  async function start() {
    child = Bun.spawn([process.execPath, "src/bun/headless.ts"], {
      cwd: path.join(import.meta.dir, "../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const collect = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
      if (!stream || typeof stream === "number") return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        output.push(decoder.decode(next.value));
      }
    };
    void collect(child.stdout);
    void collect(child.stderr);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`backend exited\n${output.join("")}`);
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch { /* not up */ }
      await Bun.sleep(100);
    }
    throw new Error(`backend did not listen\n${output.join("")}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await child.exited;
  }
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(base + route, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as { error?: string; accountId?: string; harnessId?: string; directory?: string } : {} };
  };
  try {
    await start();
    const created: Array<{ accountId: string; harnessId: string; directory: string }> = [];
    for (const [index, directory] of homes.entries()) {
      const response = await call("POST", "/account-core/codex-profiles", { displayName: `Profile ${index === 0 ? "A" : "B"}`, directory });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      if (!response.body.accountId || !response.body.harnessId || !response.body.directory) throw new Error("incomplete profile");
      created.push({ accountId: response.body.accountId, harnessId: response.body.harnessId, directory: response.body.directory });
    }
    expect(created[0]!.accountId).not.toBe(created[1]!.accountId);
    expect(created[0]!.harnessId).not.toBe(created[1]!.harnessId);
    expect(created.map((row) => row.directory)).toEqual(homes);
    expect(created.every((row) => row.harnessId === `codex-profile-${row.accountId}`)).toBe(true);
    const duplicate = await call("POST", "/account-core/codex-profiles", { displayName: "Duplicate", directory: homes[0] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).not.toBe("Account operation failed.");
    const forbidden = await call("POST", "/account-core/codex-profiles", { displayName: "SSH", directory: path.join(ownerHome, ".ssh") });
    expect(forbidden.status).toBe(409);
    expect(forbidden.body.error).toContain("cannot overlap");
    const missing = await call("POST", "/account-core/codex-profiles", { displayName: "Missing", directory: path.join(ownerHome, "missing") });
    expect(missing.status).toBe(409);
    expect(missing.body.error).not.toBe("Account operation failed.");
    await stop();
    const database = new Database(path.join(dataDir, "agetor.sqlite"), { readonly: true });
    const harnesses = database.query<{ id: string; home: string | null; env_json: string }, []>("SELECT id, home, env_json FROM harnesses WHERE kind = 'codex'").all();
    database.close();
    for (const [index, directory] of homes.entries()) {
      const harness = harnesses.find((row) => row.id === created[index]!.harnessId);
      expect(harness).toMatchObject({ home: null, env_json: JSON.stringify({ CODEX_HOME: directory }) });
    }
    expect(harnesses.find((row) => row.id === "codex")?.env_json).not.toContain(homes[0]!);
    await start();
    const listed = await call("GET", "/account-core/codex-profiles");
    expect(listed.status).toBe(200);
    const rows = listed.body as unknown as Array<{ accountId: string; harnessId: string; directory: string }>;
    expect(rows.map((row) => row.accountId).sort()).toEqual(created.map((row) => row.accountId).sort());
    expect(rows.map((row) => row.directory).sort()).toEqual([...homes].sort());
    expect(new Set(rows.map((row) => row.harnessId)).size).toBe(2);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
