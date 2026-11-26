import { expect, test } from "bun:test";
import { PROVIDER_RUNTIME_IDS, providerRuntimeContract } from "./contract.ts";
import { interpretCodexRateLimit } from "./transports.ts";
import { planProviderExecution } from "./negotiate.ts";
import { readinessMatrix } from "./readiness.ts";
import { runProviderRuntimeScenario } from "./scenario.ts";

test("every supported harness has an explicit contract and is not marked genuinely executed", () => {
  expect(PROVIDER_RUNTIME_IDS).toHaveLength(7);
  for (const id of PROVIDER_RUNTIME_IDS) {
    const contract = providerRuntimeContract(id);
    expect(contract?.adapterImplemented).toBe(true);
    expect(contract?.genuineExecutionVerified).toBe(false);
    expect(contract?.accountIdentityVerified).toBe(false);
    expect(contract?.quotaDataVerified).toBe(false);
  }
  expect(providerRuntimeContract("codex")?.capabilities.parallelAccounts.state).toBe("supported");
  expect(providerRuntimeContract("claude-code")?.capabilities.parallelAccounts.state).toBe("unsupported");
  expect(providerRuntimeContract("cursor")?.capabilities.developerExecution.state).toBe("unsupported");
  expect(providerRuntimeContract("deepseek-dsh")?.capabilities.developerExecution.state).toBe("unsupported");
});

test("a Codex percent is not a remaining-request count and credits are not redeemed", () => {
  const window = interpretCodexRateLimit({ limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_700_000_000 } });
  expect(window.remainingRequests).toBeNull();
  expect(window.usedPercent).toBe(40);
  const redeemed = planProviderExecution({
    providerId: "codex", harnessId: "codex-a", accountId: "codex-a", boundAccountId: "codex-a", modelId: "gpt-6.1-sol",
    role: "developer", permissionMode: "auto", projectPath: "/tmp/project", taskId: "t", missionId: "m", runId: "r", attemptId: "a",
    profileDirectory: "/tmp/codex-a", homeAccessAccepted: true, transport: "live", installed: true,
  });
  expect(redeemed.ok).toBe(false);
  if (!redeemed.ok) expect(redeemed.code).toBe("live-not-authorized");
});

test("the disposable company scenario keeps every recorded check and starts no process", () => {
  const evidence = runProviderRuntimeScenario();
  expect(evidence.processStarted).toBe(false);
  const failed = Object.entries(evidence.checks).filter(([, ok]) => !ok).map(([name]) => name);
  expect(failed).toEqual([]);
});

test("readiness never reports an executable live provider", () => {
  const rows = readinessMatrix({
    codex: { installed: true, cliVersion: "0.0.0-fixture", authentication: "cli-reported" },
    gemini: { installed: false, authentication: "unknown" },
    cursor: { installed: true, authentication: "cli-reported" },
  });
  expect(rows.every((row) => row.executableNow === false && row.authorizedExecution === "not-authorized" && row.identity === "unknown")).toBe(true);
  expect(rows.find((row) => row.providerId === "gemini")?.developer).toBe("missing-cli");
  expect(rows.find((row) => row.providerId === "cursor")?.developer).toBe("blocked");
  expect(rows.find((row) => row.providerId === "codex")?.developer).toBe("needs-authorization");
});
