import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NATIVE_QA_STUB } from "../native-qa-environment.ts";
import { syntheticRecordedAuthentication } from "./synthetic-auth.ts";
import { ownerExecutionState } from "../../shared/provider-runtime/owner-state.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-live-ready-launch-")));
const home = path.join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.AGETOR_DATA_DIR = path.join(root, "data");
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CLAUDE_DRIVER = "fake";

const { spawnClaudeViaTmux } = await import("../claude-tmux.ts");
const { spawnCodexViaTmux } = await import("../codex-tmux.ts");
const {
  assessTrustedLiveAuthorization,
  bindQaFixtureTransportForTest,
  invokeAuthorizedLiveLauncher,
  invokeQaFixtureTransport,
  productionClaudeLauncher,
  productionCodexLauncher,
} = await import("./live-launch.ts");

test("the production dispatch binds the real launchers and an environment flag cannot start them", async () => {
  expect(productionCodexLauncher).toBe(spawnCodexViaTmux);
  expect(productionClaudeLauncher).toBe(spawnClaudeViaTmux);
  process.env.AGETOR_PROVIDER_LIVE_SPAWN = "authorized";
  const decision = assessTrustedLiveAuthorization();
  expect(decision).toMatchObject({ executionReady: false, method: "native-owner-proof", code: "application-identity-unestablished" });
  const launched = await invokeAuthorizedLiveLauncher({ transport: "claude-live" });
  expect(launched).toMatchObject({
    processStarted: false,
    launched: false,
    launcher: "spawnClaudeViaTmux",
    launcherBound: true,
    code: "application-identity-unestablished",
  });
  delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;
});

test("a QA fixture transport is not a provider process and is not selected by the environment flag", async () => {
  let calls = 0;
  bindQaFixtureTransportForTest(async () => { calls += 1; });
  process.env.AGETOR_PROVIDER_LIVE_SPAWN = "authorized";
  const live = await invokeAuthorizedLiveLauncher({ transport: "codex-live" });
  expect(live.processStarted).toBe(false);
  expect(calls).toBe(0);
  const fixture = await invokeQaFixtureTransport();
  expect(fixture).toMatchObject({ processStarted: false, launcher: "none", provenance: "qa-fixture" });
  expect(calls).toBe(1);
  bindQaFixtureTransportForTest(null);
  delete process.env.AGETOR_PROVIDER_LIVE_SPAWN;
  expect((await invokeQaFixtureTransport()).code).toBe("qa-fixture-unbound");
});

test("only an inert QA stub and a synthetic marker count as recorded authentication", () => {
  const directory = path.join(home, "profile");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "synthetic-authenticated"), "synthetic-codex-a");
  const stub = path.join(root, "stub");
  const other = path.join(root, "other");
  writeFileSync(stub, NATIVE_QA_STUB);
  writeFileSync(other, "#!/bin/sh\necho logged in\n");
  expect(syntheticRecordedAuthentication("codex", stub, directory)).toBe("authenticated");
  expect(syntheticRecordedAuthentication("claude-code", stub, directory)).toBe("authenticated");
  expect(syntheticRecordedAuthentication("codex", other, directory)).toBeNull();
  const previous = process.env.AGETOR_CODEX_DRIVER;
  delete process.env.AGETOR_CODEX_DRIVER;
  expect(syntheticRecordedAuthentication("codex", stub, directory)).toBeNull();
  process.env.AGETOR_CODEX_DRIVER = previous;
});

test("the inert QA stub is not treated as an old Codex CLI", async () => {
  const { minCliVersionError } = await import("../orchestrator.ts");
  const stub = path.join(root, "floor-stub");
  const other = path.join(root, "floor-other");
  writeFileSync(stub, NATIVE_QA_STUB);
  writeFileSync(other, "#!/bin/sh\necho 0.0.0-qa\n");
  const harness = { id: "codex", kind: "codex" as const, label: "Codex", bin: "codex" };
  const status = (bin: string) => ({ version: "0.0.0-qa", path: bin, installHint: null }) as never;
  expect(await minCliVersionError(harness as never, "gpt-6.1-sol", status(stub))).toBeNull();
  expect(await minCliVersionError(harness as never, "gpt-6.1-sol", status(other))).toContain("0.159.0");
  const previous = process.env.AGETOR_CODEX_DRIVER;
  delete process.env.AGETOR_CODEX_DRIVER;
  expect(await minCliVersionError(harness as never, "gpt-6.1-sol", status(stub))).toContain("0.159.0");
  process.env.AGETOR_CODEX_DRIVER = previous;
});

test("owner execution labels keep a developer result distinct from task completion", () => {
  expect(ownerExecutionState({ phase: "running", reworkEpoch: 0 })).toBe("provider-running");
  expect(ownerExecutionState({ phase: "running", reworkEpoch: 1 })).toBe("rework-running");
  expect(ownerExecutionState({ phase: "authorized", reworkEpoch: 1, qcVerdict: "CHANGES_REQUESTED" })).toBe("changes-requested");
  expect(ownerExecutionState({ column: "review", qcVerdict: "PASS", phase: "awaiting_owner" })).toBe("owner-acceptance-pending");
  expect(ownerExecutionState({ phase: "awaiting_owner" })).toBe("owner-acceptance-pending");
  expect(ownerExecutionState({ column: "review" })).toBe("developer-completed");
  expect(ownerExecutionState({ column: "done" })).toBe("task-done");
  expect(ownerExecutionState({ phase: "cancelled" })).toBe("provider-cancelled");
  expect(ownerExecutionState({ phase: "failed" })).toBe("provider-failed");
  expect(ownerExecutionState({})).toBe("resource-recommended");
});
