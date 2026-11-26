import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { CLAUDE_PROFILE_LIMITATIONS } from "../../../shared/accounts/claude-profile.ts";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";
import { ExecutionProfileList } from "./ExecutionProfiles";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});
afterEach(async () => { await choose("en"); });

function profile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    accountId: "acct-work",
    provider: "openai",
    displayName: "Work",
    kind: "codex",
    support: "supported",
    authProfile: { mechanism: "CODEX_HOME", path: "/Users/owner/.codex-work", directoryIdentity: "1:1" },
    configuredIdentity: "work-label",
    verifiedSubject: null,
    subjectLabel: "Configured",
    authentication: "unknown",
    lastAuthentication: "unknown",
    lastVerifiedAt: null,
    models: [{ id: "gpt-6-luna", eligibility: "declared", modes: ["ask"] }],
    modes: ["ask"],
    readiness: "unchecked",
    blockers: [],
    limitations: ["Login status does not prove a distinct provider subject. The subject stays Unknown unless separate documented identity evidence exists."],
    quota: { status: "unknown", remaining: null, unit: null },
    concurrencyLimit: 1,
    providerSharedLimit: null,
    disabled: false,
    executionReady: false,
    harnessId: "codex-profile-acct-work",
    homeAccessAccepted: null,
    ...overrides,
  };
}

test("execution profiles label unknown subject, unknown quota, and partial Claude support", async () => {
  const profiles = [
    profile({ authentication: "authenticated" }),
    profile({
      accountId: "acct-claude",
      provider: "anthropic",
      displayName: "Claude A",
      kind: "claude",
      support: "partial",
      authProfile: { mechanism: "CLAUDE_CONFIG_DIR", path: "/Users/owner/.claude-a", directoryIdentity: "1:2" },
      configuredIdentity: null,
      subjectLabel: "Unknown",
      quota: { status: "verified", remaining: 12, unit: "requests" },
      limitations: [...CLAUDE_PROFILE_LIMITATIONS],
    }),
  ];
  await choose("en");
  const english = renderToStaticMarkup(<LocaleProvider><ExecutionProfileList profiles={profiles} /></LocaleProvider>);
  expect(english).toContain("Verified subject");
  expect(english).toContain("Unknown");
  expect(english).toContain("Remaining limit: Unknown");
  expect(english).toContain("Verified remaining");
  expect(english).toContain("Partial support");
  expect(english).toContain("Signed in");
  expect(english).toContain("macOS Keychain and ~/.claude.json are not isolated by CLAUDE_CONFIG_DIR alone");
  expect(english).toContain("HOME-access disclosure");
  expect(english).not.toContain("sk-");
  await choose("ru");
  const russian = renderToStaticMarkup(<LocaleProvider><ExecutionProfileList profiles={profiles} /></LocaleProvider>);
  expect(russian).toContain("Подтверждённый субъект");
  expect(russian).toContain("Неизвестно");
  expect(russian).toContain("Остаток лимита: Неизвестно");
});
