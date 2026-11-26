import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-live-harness-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CLAUDE_DRIVER = "fake";

beforeAll(async () => {
  await import("./db.ts");
});

afterAll(async () => {
  const { rmTestDataDir } = await import("./test-data-dir.ts");
  rmTestDataDir(DATA_DIR);
});

test("checkAllHarnesses returns availability without secret-shaped strings", async () => {
  const { checkAllHarnesses } = await import("./agent-status.ts");
  const statuses = await checkAllHarnesses();
  expect(statuses.length).toBeGreaterThan(0);
  const blob = JSON.stringify(statuses);
  expect(blob).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
  expect(blob).not.toMatch(/Bearer\s+[a-zA-Z0-9._-]{20,}/);
  const claude = statuses.find((s) => s.kind === "claude-code");
  expect(claude).toBeDefined();
});

test("harnessUnavailableReason for nonsense id", async () => {
  const { harnessUnavailableReason } = await import("./supervised-live-workflow.ts");
  const reason = await harnessUnavailableReason("totally-unknown-harness-id");
  expect(reason).toContain("Unknown harness");
});
