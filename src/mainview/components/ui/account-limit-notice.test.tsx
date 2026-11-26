import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocale, localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { when } from "@/lib/accounts";
import { ProviderRefusalNotice } from "./provider-refusal-notice";
import { QuotaWindowLimit } from "./account-limit-notice";
import type { ProviderRefusalSummary } from "../../../shared/provider-refusal.ts";

const observedAt = Date.UTC(2026, 10, 19, 10);
const refusal: ProviderRefusalSummary = {
  id: "refusal-1", kind: "usage-limit", provider: "codex", harnessId: "harness-a", accountId: "profile-a",
  modelId: "model", observedAt, accountLabel: "Codex Profile A", proof: "codex-cli-usage-limit",
  surface: "developer-run", retryHint: "4:11 PM", supersededAt: null, diagnostics: "",
};

test("account and mission notices show the provider hint with its uncertainty and stale source details", async () => {
  const original = getLocale();
  await localeStore.choose("en", async () => {});
  const markup = renderToStaticMarkup(<LocaleProvider><ProviderRefusalNotice
    refusal={refusal} waiting now={observedAt + 48 * 60 * 60_000} /></LocaleProvider>);
  await localeStore.choose(original, async () => {});
  expect(markup).toContain("Codex Profile A reported a usage limit without a confirmed reset time.");
  expect(markup).toContain("4:11 PM");
  expect(markup).toContain("Stale observation");
  expect(markup).toContain("Developer run");
  expect(markup).not.toContain("Confirmed reset for Codex Profile A");
});

test("a verified reset renders using the same local time formatter in both languages", async () => {
  const resetAt = observedAt + 6 * 60 * 60_000;
  const original = getLocale();
  for (const [locale, phrase] of [["en", "Confirmed reset for Codex Profile A"], ["ru", "Подтверждённое время сброса для аккаунта Codex Profile A"]] as const) {
    await localeStore.choose(locale, async () => {});
    try {
      const markup = renderToStaticMarkup(<LocaleProvider><QuotaWindowLimit account="Codex Profile A"
        resetAt={resetAt} now={observedAt} windows={[{
          id: "verified", window: "daily", scope: "account", source: "trusted:fixture", resetAt,
          observedAt, expiresAt: resetAt,
        }]} /></LocaleProvider>);
      expect(markup).toContain('data-reset="confirmed"');
      expect(markup).toContain(phrase);
      expect(markup).toContain(when(resetAt));
      expect(markup).toContain("trusted:fixture");
    } finally {
      await localeStore.choose(original, async () => {});
    }
  }
});

test("verified exhaustion with an unknown reset preserves the uncertainty", async () => {
  const original = getLocale();
  await localeStore.choose("en", async () => {});
  try {
    const markup = renderToStaticMarkup(<LocaleProvider>
      <QuotaWindowLimit account="Codex Profile A" resetAt={null} windows={[]} />
    </LocaleProvider>);
    expect(markup).toContain('data-reset="unknown"');
    expect(markup).toContain("Reset time is unknown");
    expect(markup).not.toContain("Confirmed reset");
  } finally {
    await localeStore.choose(original, async () => {});
  }
});
