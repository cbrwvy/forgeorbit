import path from "node:path";
import { test, expect } from "./fixtures";
import { STUB_BIN } from "./isolated-env";

/**
 * FO-007B: the worker backend every spec shares (`agent-profiles-launch`,
 * `todo-progress`, `theme` and the rest) is isolated — every harness home
 * lives in its own data dir and every harness resolves to a stub binary, so
 * no real CLI, account or setting of the machine is used.
 */
test("the shared backend uses isolated homes and only stub binaries", async ({ request, backend }) => {
  const auth = { authorization: `Bearer ${backend.apiToken}` };
  const list = await request.get(`${backend.apiBase}/harnesses`, { headers: auth });
  expect(list.ok()).toBeTruthy();
  const { harnesses } = (await list.json()) as { harnesses: { id: string; home: string | null }[] };
  expect(harnesses.length).toBeGreaterThan(0);
  for (const harness of harnesses) {
    expect(harness.home, harness.id).not.toBeNull();
    expect(harness.home!.startsWith(path.join(backend.dataDir, "test-accounts")), harness.id).toBe(true);
  }

  const agents = await request.get(`${backend.apiBase}/agents`, { headers: auth });
  expect(agents.ok()).toBeTruthy();
  const statuses = (await agents.json()) as { harnessId: string; bin: string; path: string | null }[];
  const fxStub = path.join(backend.dataDir, "fx-stub-bin", "fx");
  for (const status of statuses) {
    expect([STUB_BIN, fxStub], status.harnessId).toContain(status.bin);
    if (status.path) expect([STUB_BIN, fxStub], status.harnessId).toContain(status.path);
  }
});
