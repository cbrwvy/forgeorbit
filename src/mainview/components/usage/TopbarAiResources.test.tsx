import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { TopbarAiResources, TopbarOverflowMenu } from "./TopbarAiResources";
import { TopbarServiceCard, serviceTooltipText } from "./TopbarServicePopover";
import {
  TOPBAR_SERVICES,
  buildAllTopbarServices,
  buildTopbarServiceSummary,
} from "./service-status";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";
import type { AgentStatus, Harness, HarnessQuota } from "../../../shared/types.ts";

const NOW = 1_795_700_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function makeProfile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    accountId: "codex-alpha",
    provider: "codex",
    kind: "codex",
    harnessId: "codex-profile:codex-alpha",
    displayName: "Codex · Primary Alpha",
    support: "supported",
    authProfile: {
      mechanism: "CODEX_HOME",
      path: "/Users/test/.codex-alpha",
      directoryIdentity: "dev-1:ino-1",
    },
    configuredIdentity: "codex-alpha · /Users/test/.codex-alpha",
    verifiedSubject: null,
    subjectLabel: "Configured",
    authentication: "authenticated",
    lastAuthentication: "authenticated",
    lastVerifiedAt: NOW - HOUR,
    models: [{ id: "gpt-6.1-sol", eligibility: "declared", modes: ["auto"] }],
    modes: ["auto"],
    readiness: "ready",
    blockers: [],
    limitations: [],
    quota: { status: "unknown", remaining: null, unit: null },
    concurrencyLimit: 1,
    providerSharedLimit: null,
    disabled: false,
    executionReady: true,
    homeAccessAccepted: null,
    providerRefusal: null,
    ...overrides,
  };
}

function makeHarness(overrides: Partial<Harness>): Harness {
  return {
    id: "claude-code",
    label: "Claude Code",
    kind: "claude-code",
    isBuiltin: true,
    home: null,
    bin: null,
    env: {},
    enabled: true,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    harnessId: "claude-code",
    kind: "claude-code",
    bin: "claude",
    available: true,
    loggedIn: true,
    authHelp: null,
    version: "2.1.0",
    path: "/usr/local/bin/claude",
    reason: null,
    installHint: null,
    account: null,
    usage: null,
    ...overrides,
  };
}

function makeQuota(overrides: Partial<HarnessQuota>): HarnessQuota {
  return {
    harnessId: "codex",
    kind: "codex",
    planType: "plus",
    status: "ok",
    source: "api",
    fetchedAtMs: NOW,
    meters: [],
    reason: null,
    ...overrides,
  };
}

describe("service-status aggregation model", () => {
  test("emits services in order: Codex, Claude, Cursor, Antigravity, DeepSeek", () => {
    const services = buildAllTopbarServices({
      agents: [],
      harnesses: [],
      usage: {},
      profiles: [],
    });
    expect(services.map((s) => s.id)).toEqual(["codex", "claude", "cursor", "antigravity", "deepseek"]);
    expect(services.every((s) => s.light === "red" && s.reason === "disabled" && !s.connected)).toBe(true);
  });

  test("includes DeepSeek only when detected/connected and marks blocked execution red", () => {
    const detected = buildTopbarServiceSummary(TOPBAR_SERVICES[4]!, {
      agents: [],
      harnesses: [],
      usage: {},
      profiles: [],
      installations: [
        {
          id: "deepseek-dsh",
          provider: "deepseek",
          label: "DeepSeek Harness",
          path: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
          version: "0.2.2-rc.3",
          status: "unassessed-version",
          authentication: "unknown",
          quota: "unknown",
          models: [],
          executionSupported: false,
        },
      ],
    });
    expect(detected.connected).toBe(true);
    expect(detected.light).toBe("red");
    expect(detected.reason).toBe("blocked");
    expect(detected.technicalNotes.version).toBe("0.2.2-rc.3");
    expect(detected.technicalNotes.hasDeepSeekBlockedNote).toBe(true);

    const missing = buildTopbarServiceSummary(TOPBAR_SERVICES[4]!, {
      agents: [],
      harnesses: [],
      usage: {},
      profiles: [],
      installations: [
        {
          id: "deepseek-dsh",
          provider: "deepseek",
          label: "DeepSeek Harness",
          path: null,
          version: null,
          status: "missing",
          authentication: "unknown",
          quota: "unknown",
          models: [],
          executionSupported: false,
        },
      ],
    });
    expect(missing.connected).toBe(false);
  });

  test("classifies green (>50% left), yellow (<=50% left / almost out / unknown limit), and red (exhausted / auth / disabled / missing)", () => {
    const harnesses: Harness[] = [
      makeHarness({ id: "codex", kind: "codex", label: "Codex", enabled: true }),
      makeHarness({ id: "claude-code", kind: "claude-code", label: "Claude Code", enabled: true }),
      makeHarness({ id: "cursor", kind: "cursor", label: "Cursor", enabled: true }),
      makeHarness({ id: "antigravity", kind: "antigravity", label: "Antigravity", enabled: true }),
    ];
    const agents: AgentStatus[] = [
      makeAgent({ harnessId: "codex", kind: "codex", available: true, loggedIn: true }),
      makeAgent({ harnessId: "claude-code", kind: "claude-code", available: true, loggedIn: false }),
      makeAgent({ harnessId: "cursor", kind: "cursor", available: true, loggedIn: true }),
      makeAgent({ harnessId: "antigravity", kind: "antigravity", available: true, loggedIn: null }),
    ];
    const usage: Record<string, HarnessQuota> = {
      codex: makeQuota({
        harnessId: "codex",
        kind: "codex",
        meters: [
          { id: "session", label: "Session (5h)", usedPercent: 20, resetsAtMs: NOW + 3 * HOUR },
          { id: "weekly", label: "Weekly", usedPercent: 35, resetsAtMs: NOW + 4 * DAY },
        ],
      }),
      cursor: makeQuota({
        harnessId: "cursor",
        kind: "cursor",
        planType: "pro",
        meters: [{ id: "plan", label: "Monthly", usedPercent: 62, resetsAtMs: NOW + 10 * DAY }],
      }),
    };

    const services = buildAllTopbarServices({ agents, harnesses, usage, profiles: [], nowMs: NOW });
    const byId = Object.fromEntries(services.map((s) => [s.id, s]));

    expect(byId.codex!.light).toBe("green");
    expect(byId.codex!.reason).toBe("ok");
    expect(byId.codex!.meters[0]!.remainingPercent).toBe(80);

    expect(byId.claude!.light).toBe("red");
    expect(byId.claude!.reason).toBe("auth_required");
    expect(byId.claude!.auth).toBe("not_signed_in");

    expect(byId.cursor!.light).toBe("yellow");
    expect(byId.cursor!.reason).toBe("low_limit");
    expect(byId.cursor!.meters[0]!.remainingPercent).toBe(38);

    expect(byId.antigravity!.light).toBe("yellow");
    expect(byId.antigravity!.reason).toBe("limit_unknown");
  });

  test("marks almost_out yellow at 85..99% used and limit_reached red at 100% used with reset time", () => {
    const harnesses = [
      makeHarness({ id: "codex", kind: "codex", enabled: true }),
      makeHarness({ id: "claude-code", kind: "claude-code", enabled: true }),
    ];
    const agents = [
      makeAgent({ harnessId: "codex", kind: "codex", available: true, loggedIn: true }),
      makeAgent({ harnessId: "claude-code", kind: "claude-code", available: true, loggedIn: true }),
    ];
    const usage: Record<string, HarnessQuota> = {
      codex: makeQuota({
        harnessId: "codex",
        kind: "codex",
        meters: [
          { id: "session", label: "Session (5h)", usedPercent: 100, resetsAtMs: NOW + 2 * HOUR },
          { id: "weekly", label: "Weekly", usedPercent: 47, resetsAtMs: NOW + 5 * DAY },
        ],
      }),
      "claude-code": makeQuota({
        harnessId: "claude-code",
        kind: "claude-code",
        planType: "max",
        meters: [
          { id: "five_hour", label: "Session (5h)", usedPercent: 42, resetsAtMs: NOW + 3 * HOUR },
          { id: "seven_day", label: "Weekly", usedPercent: 95, resetsAtMs: NOW + 2 * DAY },
        ],
      }),
    };

    const codex = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, { agents, harnesses, usage, profiles: [], nowMs: NOW });
    expect(codex.light).toBe("red");
    expect(codex.reason).toBe("limit_reached");
    expect(codex.nextResetAtMs).toBe(NOW + 2 * HOUR);

    const claude = buildTopbarServiceSummary(TOPBAR_SERVICES[1]!, { agents, harnesses, usage, profiles: [], nowMs: NOW });
    expect(claude.light).toBe("yellow");
    expect(claude.reason).toBe("almost_out");
    expect(claude.nextResetAtMs).toBe(NOW + 2 * DAY);
  });

  test("enforces strict status truth: 90% weekly + 0% 5h is red, raw positive count is never green, stale data is never green, and quotas never mix across accounts", () => {
    const harnesses = [makeHarness({ id: "codex", kind: "codex", enabled: true })];
    const agents = [makeAgent({ harnessId: "codex", kind: "codex", available: true, loggedIn: true })];

    // 1. Codex: 90% weekly left (10% used) + 0% 5h left (100% used) -> RED (exhausted)
    const exhausted5h = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          meters: [
            { id: "session", label: "Session (5h)", usedPercent: 100, resetsAtMs: NOW + 2 * HOUR },
            { id: "weekly", label: "Weekly", usedPercent: 10, resetsAtMs: NOW + 5 * DAY },
          ],
        }),
      },
    });
    expect(exhausted5h.light).toBe("red");
    expect(exhausted5h.reason).toBe("limit_reached");
    expect(exhausted5h.meters[0]!.remainingPercent).toBe(0);
    expect(exhausted5h.meters[1]!.remainingPercent).toBe(90);

    // 2. Boundary: exactly 50% remaining -> YELLOW; 51% remaining -> GREEN
    const exact50 = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 50, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(exact50.light).toBe("yellow");
    expect(exact50.reason).toBe("low_limit");
    expect(exact50.meters[0]!.remainingPercent).toBe(50);

    const left51 = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 49, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(left51.light).toBe("green");
    expect(left51.meters[0]!.remainingPercent).toBe(51);

    // 3. Raw positive verified remaining without a percentage/cap -> YELLOW (never green)
    const rawCountProfile = makeProfile({
      accountId: "codex-raw",
      harnessId: "codex-profile:codex-raw",
      quota: { status: "verified", remaining: 25, unit: "requests" },
    });
    const rawCountSummary = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [rawCountProfile],
      usage: {},
      nowMs: NOW,
    });
    expect(rawCountSummary.light).toBe("yellow");
    expect(rawCountSummary.reason).toBe("limit_unknown");
    expect(rawCountSummary.verifiedQuota).toEqual({ remaining: 25, unit: "requests" });

    // 4. Stale snapshot (> 60m old) or expired reset window -> YELLOW (never green)
    const staleOld = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          fetchedAtMs: NOW - 90 * 60_000,
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 10, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(staleOld.light).toBe("yellow");
    expect(staleOld.reason).toBe("stale_quota");
    expect(staleOld.quotaStale).toBe(true);

    const staleExpiredReset = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          fetchedAtMs: NOW - 5 * 60_000,
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 10, resetsAtMs: NOW - 60_000 }],
        }),
      },
    });
    expect(staleExpiredReset.light).toBe("yellow");
    expect(staleExpiredReset.reason).toBe("stale_quota");

    // 5. Never mix quotas across accounts: profile with no quota must NOT inherit built-in harness quota
    const profileNoQuota = makeProfile({
      accountId: "codex-clean",
      harnessId: "codex-profile:codex-clean",
    });
    const noMixSummary = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [profileNoQuota],
      nowMs: NOW,
      usage: {
        codex: makeQuota({
          harnessId: "codex",
          planType: "pro",
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 10, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(noMixSummary.light).toBe("yellow");
    expect(noMixSummary.reason).toBe("limit_unknown");
    expect(noMixSummary.meters).toHaveLength(0);
    expect(noMixSummary.planType).toBeNull();
  });

  test("aggregates multiple profiles: green if any healthy profile exists, yellow if only limited remains, red if all blocked/refused", () => {
    const harnesses = [makeHarness({ id: "codex", kind: "codex", enabled: true })];
    const agents = [makeAgent({ harnessId: "codex", kind: "codex", available: true, loggedIn: true })];

    const healthyProfile = makeProfile({
      accountId: "codex-a",
      harnessId: "codex-profile:codex-a",
      displayName: "Codex · Profile A",
    });
    const refusedProfile = makeProfile({
      accountId: "codex-b",
      harnessId: "codex-profile:codex-b",
      displayName: "Codex · Profile B",
      providerRefusal: {
        id: "ref-1",
        provider: "openai",
        harnessId: "codex-profile:codex-b",
        accountId: "codex-b",
        modelId: "gpt-6.1-sol",
        kind: "usage-limit",
        surface: "developer-run",
        observedAt: NOW - 1000,
        supersededAt: null,
        diagnostics: "usage limit reached",
        retryHint: "Try again at 4:14 PM.",
        proof: "usage_limit_exceeded",
      },
    });
    const limitedProfile = makeProfile({
      accountId: "codex-c",
      harnessId: "codex-profile:codex-c",
      displayName: "Codex · Profile C",
    });

    // Case 1: Profile A (green, 80% left) + Profile B (red, refused) -> GREEN overall, both listed
    const greenSummary = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [healthyProfile, refusedProfile],
      nowMs: NOW,
      usage: {
        "codex-profile:codex-a": makeQuota({
          harnessId: "codex-profile:codex-a",
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 20, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(greenSummary.light).toBe("green");
    expect(greenSummary.profiles).toHaveLength(2);
    expect(greenSummary.profiles[0]!.displayName).toBe("Profile A");
    expect(greenSummary.profiles[0]!.light).toBe("green");
    expect(greenSummary.profiles[1]!.displayName).toBe("Profile B");
    expect(greenSummary.profiles[1]!.light).toBe("red");
    expect(greenSummary.profiles[1]!.retryHint).toBe("Try again at 4:14 PM.");

    // Case 2: Profile C (yellow, 30% left) + Profile B (red, refused) -> YELLOW overall
    const yellowSummary = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [limitedProfile, refusedProfile],
      nowMs: NOW,
      usage: {
        "codex-profile:codex-c": makeQuota({
          harnessId: "codex-profile:codex-c",
          meters: [{ id: "session", label: "Session (5h)", usedPercent: 70, resetsAtMs: NOW + 2 * HOUR }],
        }),
      },
    });
    expect(yellowSummary.light).toBe("yellow");
    expect(yellowSummary.reason).toBe("low_limit");

    // Case 3: Only refused profile -> RED overall with retry hint
    const redSummary = buildTopbarServiceSummary(TOPBAR_SERVICES[0]!, {
      agents,
      harnesses,
      profiles: [refusedProfile],
      usage: {},
      nowMs: NOW,
    });
    expect(redSummary.light).toBe("red");
    expect(redSummary.reason).toBe("provider_refusal");
    expect(redSummary.retryHint).toBe("Try again at 4:14 PM.");
  });

  test("marks fail-closed Claude HOME acceptance missing as red", () => {
    const harnesses = [makeHarness({ id: "claude-code", kind: "claude-code", enabled: true })];
    const agents = [makeAgent({ harnessId: "claude-code", kind: "claude-code", available: true })];
    const claudeProfile = makeProfile({
      accountId: "claude-1",
      provider: "anthropic",
      kind: "claude",
      harnessId: "claude-profile:claude-1",
      displayName: "Claude Work",
      support: "partial",
      homeAccessAccepted: false,
    });
    const summary = buildTopbarServiceSummary(TOPBAR_SERVICES[1]!, {
      agents,
      harnesses,
      profiles: [claudeProfile],
      usage: {},
    });
    expect(summary.light).toBe("red");
    expect(summary.reason).toBe("acceptance_required");
    expect(summary.technicalNotes.hasClaudePartialNote).toBe(true);
  });
});

describe("TopbarAiResources & TopbarServiceCard rendering", () => {
  test("renders only connected service icon indicators without borders or profile-name clutter in EN and RU", () => {
    const harnesses = [
      makeHarness({ id: "codex", kind: "codex", enabled: true }),
      makeHarness({ id: "claude-code", kind: "claude-code", enabled: true }),
      makeHarness({ id: "cursor", kind: "cursor", enabled: true }),
      makeHarness({ id: "antigravity", kind: "antigravity", enabled: false }),
    ];
    const agents = [
      makeAgent({ harnessId: "codex", kind: "codex", available: true, loggedIn: true }),
      makeAgent({ harnessId: "claude-code", kind: "claude-code", available: true, loggedIn: false }),
      makeAgent({ harnessId: "cursor", kind: "cursor", available: true, loggedIn: true }),
      makeAgent({ harnessId: "antigravity", kind: "antigravity", available: false, loggedIn: null }),
    ];
    const usage: Record<string, HarnessQuota> = {
      codex: makeQuota({
        harnessId: "codex",
        kind: "codex",
        meters: [{ id: "session", label: "Session (5h)", usedPercent: 25, resetsAtMs: NOW + 2 * HOUR }],
      }),
    };
    const longProfile = makeProfile({
      displayName: "Enterprise Architecture Primary Codex Profile Alpha-01",
    });

    localeStore.reconcile("en");
    const enHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarAiResources, {
          agents,
          harnesses,
          usage,
          onOpenAccounts: () => {},
          initialProfiles: [longProfile],
        }),
      ),
    );
    expect(enHtml).toContain('data-testid="topbar-ai-resources"');
    expect(enHtml).toContain('data-testid="topbar-service-codex"');
    expect(enHtml).toContain('data-testid="topbar-service-claude"');
    expect(enHtml).toContain('data-testid="topbar-service-cursor"');
    // Disconnected Antigravity is hidden from the topbar
    expect(enHtml).not.toContain('data-testid="topbar-service-antigravity"');
    // No border/outline around the icon group or status dots
    expect(enHtml).not.toContain("border-border");
    expect(enHtml).not.toContain("ring-[1.5px]");
    expect(enHtml).toContain("Claude — not signed in");
    expect(enHtml).not.toContain("Enterprise Architecture Primary Codex Profile Alpha-01");

    localeStore.reconcile("ru");
    const ruHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarAiResources, {
          agents,
          harnesses,
          usage,
          onOpenAccounts: () => {},
          initialProfiles: [longProfile],
        }),
      ),
    );
    expect(ruHtml).toContain("Claude — не авторизован");
    expect(ruHtml).not.toContain('data-testid="topbar-service-antigravity"');
    expect(ruHtml).not.toContain("Enterprise Architecture Primary Codex Profile Alpha-01");

    // When no services are connected, nothing is rendered in the topbar
    const emptyHtml = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarAiResources, {
          agents: [],
          harnesses: [],
          usage: {},
          onOpenAccounts: () => {},
          initialProfiles: [],
        }),
      ),
    );
    expect(emptyHtml).toBe("");
    localeStore.reconcile("en");
  });

  test("TopbarServiceCard shows clear human summary, limits, profiles, and hides technical notes inside collapsed details", () => {
    const summary = buildTopbarServiceSummary(TOPBAR_SERVICES[1]!, {
      harnesses: [makeHarness({ id: "claude-code", kind: "claude-code", enabled: true })],
      agents: [makeAgent({ harnessId: "claude-code", kind: "claude-code", available: true, loggedIn: true })],
      nowMs: NOW,
      profiles: [
        makeProfile({
          accountId: "claude-work",
          provider: "anthropic",
          kind: "claude",
          harnessId: "claude-profile:claude-work",
          displayName: "Claude · Work",
          support: "partial",
          homeAccessAccepted: true,
        }),
      ],
      usage: {
        "claude-profile:claude-work": makeQuota({
          harnessId: "claude-profile:claude-work",
          kind: "claude-code",
          planType: "max",
          meters: [{ id: "five_hour", label: "Session (5h)", usedPercent: 30, resetsAtMs: NOW + 3 * HOUR }],
        }),
      },
    });

    localeStore.reconcile("ru");
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarServiceCard, {
          service: summary,
          nowMs: NOW,
          onOpenAccounts: () => {},
        }),
      ),
    );
    expect(html).toContain("Claude");
    expect(html).toContain("Доступен");
    expect(html).toContain("Осталось 70%");
    expect(html).toContain("Открыть в Аккаунтах");
    // Technical partial-isolation note lives inside <details> (collapsed), not as a top-level warning banner
    expect(html).toContain("<details");
    expect(html).not.toContain('data-testid="topbar-service-reason"');
    expect(serviceTooltipText(summary)).toBe("Claude — доступен");
    localeStore.reconcile("en");
  });

  test("renders compact overflow trigger in EN and RU", () => {
    localeStore.reconcile("en");
    const enMenu = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarOverflowMenu, {
          hasProjects: true,
          pipelinesActive: false,
          onOpenGit: () => {},
          onOpenWorktrees: () => {},
          onTogglePipelines: () => {},
        }),
      ),
    );
    expect(enMenu).toContain('data-testid="topbar-more-actions"');
    expect(enMenu).toContain('aria-label="More actions"');

    localeStore.reconcile("ru");
    const ruMenu = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        null,
        createElement(TopbarOverflowMenu, {
          hasProjects: true,
          pipelinesActive: false,
          onOpenGit: () => {},
          onOpenWorktrees: () => {},
          onTogglePipelines: () => {},
        }),
      ),
    );
    expect(ruMenu).toContain('data-testid="topbar-more-actions"');
    expect(ruMenu).toContain('aria-label="Ещё действия"');
    localeStore.reconcile("en");
  });
});
