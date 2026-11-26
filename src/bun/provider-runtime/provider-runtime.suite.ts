/** FO-PROVIDERS-RUNTIME01 account binding with synthetic profiles. No provider spawn. */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSyntheticCodexProfile } from "../../../e2e/codex-profile-fixture.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-providers-runtime-")));
const ownerHome = path.join(root, "owner");
mkdirSync(ownerHome);
process.env.HOME = ownerHome;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";

const { db } = await import("../db.ts");
const { AccountCore } = await import("../account-core.ts");
const { CodexProfiles } = await import("../codex-profiles.ts");
const { explainBinding } = await import("../multiaccount/binding.ts");
const { executeRecordedProviderRun } = await import("./coordinator.ts");

const core = new AccountCore(db);
const codex = new CodexProfiles(core);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("registered synthetic Codex profiles bind exactly and a recorded run starts no process", () => {
  const directoryA = path.join(ownerHome, "codex-a");
  const directoryB = path.join(ownerHome, "codex-b");
  writeSyntheticCodexProfile(directoryA, "synthetic-a");
  writeSyntheticCodexProfile(directoryB, "synthetic-b");
  const first = codex.register({ displayName: "Synthetic A", directory: directoryA });
  const second = codex.register({ displayName: "Synthetic B", directory: directoryB });
  expect(first.accountId).not.toBe(second.accountId);
  expect(explainBinding({ harnessId: first.harnessId, accountId: second.accountId, modelId: "gpt-6.1-sol", mode: "auto" }, db).ok).toBe(false);
  const bound = explainBinding({ harnessId: first.harnessId, accountId: first.accountId, modelId: "gpt-6.1-sol", mode: "auto" }, db);
  expect(bound.ok).toBe(true);
  let spawned = 0;
  const result = executeRecordedProviderRun({
    database: db,
    binding: { harnessId: first.harnessId, accountId: first.accountId, modelId: "gpt-6.1-sol", mode: "auto" },
    spawn: () => { spawned += 1; },
    fixture: [
      JSON.stringify({ method: "thread/started", params: { threadId: "thr-suite" } }),
      JSON.stringify({ method: "turn/completed", params: { turnId: "turn-suite", model: "gpt-6.1-sol", usage: { input_tokens: 11, output_tokens: 2, cached_input_tokens: 3 } } }),
      JSON.stringify({ method: "account/rateLimits/read", result: { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 } } } } }),
    ].join("\n"),
    request: {
      providerId: "codex",
      harnessId: first.harnessId,
      accountId: first.accountId,
      boundAccountId: first.accountId,
      modelId: "gpt-6.1-sol",
      role: "developer",
      permissionMode: "auto",
      projectPath: path.join(root, "project"),
      taskId: "task-suite",
      missionId: "mission-suite",
      runId: "run-suite",
      attemptId: "attempt-suite",
      profileDirectory: directoryA,
      homeAccessAccepted: true,
      transport: "recorded-fixture",
      installed: true,
    },
  });
  expect(spawned).toBe(0);
  expect(result.launched).toBe(false);
  expect(result.processStarted).toBe(false);
  expect(result.rateLimitRemainingRequests).toBeNull();
  expect(result.receipt?.inputTokens).toBe(11);
  expect(result.receipt?.cacheReadTokens).toBe(3);
  expect(result.receipt?.rankingEligible).toBe(false);
  expect(result.receipt?.executionType).toBe("fixture");
  expect(result.receipt?.costKind).toBe("subscription");
  expect(result.receipt?.money).toBeNull();
});
