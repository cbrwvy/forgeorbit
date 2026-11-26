import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeCodexProfileFixture, writeSyntheticCodexProfile } from "./codex-profile-fixture";
import { REPO_ROOT, isolatedCoreEnv, seedIsolatedHarnessHomes, writeFxStubBin } from "./isolated-env";

/** FO-ROUTING03: allocation plan lifecycle via API (fake drivers; no Runs/grants). */
test("FO-ROUTING03: propose, approve, apply allocation plan", async ({ request }) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "fo-routing03-chromium-")));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  const profileHome = path.join(root, "owner");
  await mkdir(profileHome);
  const codexBin = writeCodexProfileFixture(root, process.execPath);
  const port = await new Promise<number>((resolve, reject) => {
    const net = require("node:net") as typeof import("node:net");
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") reject(new Error("no port"));
      else {
        const p = addr.port;
        s.close(() => resolve(p));
      }
    });
  });
  const apiToken = crypto.randomUUID();
  const apiBase = `http://127.0.0.1:${port}`;
  const fxBin = writeFxStubBin(dataDir);
  expect(seedIsolatedHarnessHomes(dataDir, fxBin).ok).toBe(true);
  const child = Bun.spawn(["bun", "src/bun/headless.ts"], {
    cwd: REPO_ROOT,
    env: isolatedCoreEnv({ dataDir, apiPort: port, apiToken, fxBin, extra: { CI: "1", AGETOR_CODEX_DRIVER: "fake", HOME: profileHome, AGETOR_CODEX_BIN: codexBin } }),
    stdout: "ignore",
    stderr: "ignore",
  });
  await expect.poll(async () => fetch(`${apiBase}/health`).then((r) => r.ok, () => false), { timeout: 30_000 }).toBe(true);
  const auth = { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const projectPath = path.join(root, "proj");
  await mkdir(projectPath);
  await request.post(`${apiBase}/projects`, { headers: auth, data: { path: projectPath, name: "Routing03" } });
  const directory = path.join(profileHome, "p1");
  writeSyntheticCodexProfile(directory, "p1");
  const reg = await request.post(`${apiBase}/account-core/codex-profiles`, { headers: auth, data: { displayName: "Profile A", directory } });
  const profile = await reg.json();
  await request.post(`${apiBase}/account-core/codex-profiles/${profile.accountId}/check`, { headers: auth, data: {} });
  const taskRes = await request.post(`${apiBase}/tasks`, {
    headers: auth,
    data: { title: "Alloc task", prompt: "x", workdir: projectPath, agent: profile.harnessId, model: "gpt-6.1-sol", column: "ready", isolation: "none" },
  });
  const task = await taskRes.json();
  const propose = await request.post(`${apiBase}/allocation-plans/project`, {
    headers: auth,
    data: { projectPath, taskIds: [task.id] },
  });
  expect(propose.ok()).toBeTruthy();
  const plan = await propose.json();
  const approve = await request.post(`${apiBase}/allocation-plans/${plan.record.id}/approve`, {
    headers: auth,
    data: { planDigest: plan.planDigest },
  });
  expect(approve.ok()).toBeTruthy();
  const approved = await approve.json();
  const apply = await request.post(`${apiBase}/allocation-plans/${plan.record.id}/apply`, {
    headers: auth,
    data: { approvedDigest: approved.record.approvedDigest },
  });
  expect(apply.ok()).toBeTruthy();
  expect((await apply.json()).record.status).toBe("applied");
  const runs = await request.get(`${apiBase}/runs?taskId=${task.id}`, { headers: auth });
  expect(((await runs.json()).runs ?? []).length).toBe(0);
  child.kill();
});
