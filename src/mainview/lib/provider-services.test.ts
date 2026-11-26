import { describe, expect, test } from "bun:test";
import { buildProviderServiceGroups } from "./provider-services.ts";
import { buildAllTopbarServices } from "../components/usage/service-status.ts";
import type { Harness, HarnessStatus } from "../../shared/types.ts";
import type { ExecutionProfile } from "../../shared/accounts/execution-profile.ts";

function makeHarness(partial: Partial<Harness> & Pick<Harness, "id" | "kind" | "label">): Harness {
  return {
    isBuiltin: false,
    home: null,
    bin: null,
    env: {},
    enabled: true,
    ...partial,
  };
}

function makeStatus(harnessId: string, kind: Harness["kind"], available = true, loggedIn: boolean | null = null): HarnessStatus {
  return {
    harnessId,
    kind,
    bin: harnessId,
    available,
    path: available ? `/usr/local/bin/${harnessId}` : null,
    version: null,
    reason: available ? null : "not found",
    installHint: null,
    loggedIn,
    authHelp: null,
    account: null,
    usage: null,
  };
}

describe("Provider service deduplication & Topbar integration", () => {
  test("groups built-in harness, additional accounts, and execution profiles into ONE card per service", () => {
    const harnesses: Harness[] = [
      makeHarness({ id: "codex", kind: "codex", label: "Codex", isBuiltin: true }),
      makeHarness({ id: "codex-work", kind: "codex", label: "Codex Work", home: "/tmp/codex-work" }),
      makeHarness({ id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true }),
      makeHarness({ id: "cursor", kind: "cursor", label: "Cursor", isBuiltin: true }),
      makeHarness({
        id: "my-cli",
        kind: "custom",
        label: "My Custom CLI",
        bin: "/usr/local/bin/my-cli",
        cliConfig: { args: ["run"], promptDelivery: "arg", interactionMode: "manual", serviceId: "my-cli" },
      }),
    ];
    const statuses: HarnessStatus[] = [
      makeStatus("codex", "codex", true, true),
      makeStatus("codex-work", "codex", true, true),
      makeStatus("claude-code", "claude-code", true, true),
      makeStatus("cursor", "cursor", true, true),
      makeStatus("my-cli", "custom", true, null),
    ];
    const executionProfiles: ExecutionProfile[] = [
      {
        accountId: "acct-codex-1",
        harnessId: "codex-work",
        kind: "codex",
        provider: "openai",
        displayName: "Work Codex",
        configuredIdentity: "work@example.com",
        verifiedSubject: null,
        subjectLabel: "Configured",
        authProfile: { mechanism: "CODEX_HOME", path: "/tmp/codex-work", directoryIdentity: null },
        authentication: "authenticated",
        lastAuthentication: "authenticated",
        readiness: "ready",
        support: "supported",
        disabled: false,
        executionReady: true,
        homeAccessAccepted: null,
        quota: { status: "unknown", remaining: null, unit: null },
        models: [],
        modes: ["auto", "ask"],
        concurrencyLimit: null,
        providerSharedLimit: null,
        blockers: [],
        limitations: [],
        lastVerifiedAt: null,
        providerRefusal: null,
      },
    ];

    const groups = buildProviderServiceGroups({
      harnesses,
      statuses,
      executionProfiles,
      installations: [
        {
          id: "deepseek-dsh",
          provider: "deepseek",
          label: "DeepSeek Harness",
          path: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
          version: "0.2.2-rc.1",
          status: "execution-unsupported",
          authentication: "unknown",
          quota: "unknown",
          models: [],
          executionSupported: false,
        },
      ],
    });

    // Exactly ONE card per service
    const serviceIds = groups.map((g) => g.serviceId);
    expect(new Set(serviceIds).size).toBe(serviceIds.length);
    expect(serviceIds).toContain("codex");
    expect(serviceIds).toContain("claude-code");
    expect(serviceIds).toContain("cursor");
    expect(serviceIds).toContain("deepseek");
    expect(serviceIds).toContain("my-cli");

    // Codex keeps BOTH accounts distinct inside ONE card
    const codexGroup = groups.find((g) => g.serviceId === "codex")!;
    expect(codexGroup.accountCount).toBe(2);
    expect(codexGroup.accounts.map((a) => a.harness?.id)).toEqual(["codex", "codex-work"]);

    // Custom CLI shows manual_only (yellow), never falsely claiming autonomous
    const customGroup = groups.find((g) => g.serviceId === "my-cli")!;
    expect(customGroup.capabilities.autonomousDeveloper).toBe(false);
    expect(customGroup.capabilities.manualRun).toBe(true);
    expect(customGroup.shortStatus).toBe("manual_only");
  });

  test("Topbar includes connected custom CLI as ONE icon with truthful yellow (unknown quota) status", () => {
    const harnesses: Harness[] = [
      makeHarness({ id: "codex", kind: "codex", label: "Codex", isBuiltin: true }),
      makeHarness({
        id: "opencode",
        kind: "custom",
        label: "OpenCode",
        bin: "/opt/homebrew/bin/opencode",
        cliConfig: { args: ["run"], promptDelivery: "arg", interactionMode: "manual", serviceId: "opencode" },
      }),
      makeHarness({
        id: "opencode-2",
        kind: "custom",
        label: "OpenCode Work",
        bin: "/opt/homebrew/bin/opencode",
        home: "/tmp/opencode-2",
        cliConfig: { args: ["run"], promptDelivery: "arg", interactionMode: "manual", serviceId: "opencode" },
      }),
    ];
    const agents = [
      makeStatus("codex", "codex", true, true),
      makeStatus("opencode", "custom", true, null),
      makeStatus("opencode-2", "custom", true, null),
    ];

    const services = buildAllTopbarServices({
      agents,
      harnesses,
      usage: {},
      profiles: [],
    }).filter((s) => s.connected);

    const opencodeItems = services.filter((s) => s.id === "opencode");
    // One icon regardless of 2 accounts!
    expect(opencodeItems).toHaveLength(1);
    // Installed with unknown quota → yellow (never green, never red!)
    expect(opencodeItems[0]!.light).toBe("yellow");
    expect(opencodeItems[0]!.reason).toBe("limit_unknown");
    expect(opencodeItems[0]!.profiles).toHaveLength(2);
  });
});
