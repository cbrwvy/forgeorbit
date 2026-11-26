import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import { ConfirmProvider } from "@/components/ui/confirm";
import { ProvidersSection } from "./ProvidersSection";
import { AddCliView } from "./AddCliView";
import type { HarnessesPayload } from "@/lib/api";

const samplePayload: HarnessesPayload = {
  harnesses: [
    { id: "codex", kind: "codex", label: "Codex", isBuiltin: true, home: null, bin: null, env: {}, enabled: true },
    { id: "codex-work", kind: "codex", label: "Codex Work", isBuiltin: false, home: "/tmp/codex-work", bin: null, env: {}, enabled: true },
    { id: "claude-code", kind: "claude-code", label: "Claude Code", isBuiltin: true, home: null, bin: null, env: {}, enabled: true },
    { id: "cursor", kind: "cursor", label: "Cursor", isBuiltin: true, home: null, bin: null, env: {}, enabled: true },
    {
      id: "opencode",
      kind: "custom",
      label: "OpenCode",
      isBuiltin: false,
      home: null,
      bin: "/opt/homebrew/bin/opencode",
      env: {},
      enabled: true,
      cliConfig: { args: ["run"], promptDelivery: "arg", interactionMode: "manual", serviceId: "opencode" },
    },
  ],
  statuses: [
    { harnessId: "codex", kind: "codex", bin: "codex", available: true, path: "/opt/homebrew/bin/codex", version: null, reason: null, installHint: null, loggedIn: true, authHelp: null, account: null, usage: null },
    { harnessId: "codex-work", kind: "codex", bin: "codex", available: true, path: "/opt/homebrew/bin/codex", version: null, reason: null, installHint: null, loggedIn: true, authHelp: null, account: null, usage: null },
    { harnessId: "claude-code", kind: "claude-code", bin: "claude", available: true, path: "/usr/local/bin/claude", version: null, reason: null, installHint: null, loggedIn: true, authHelp: null, account: null, usage: null },
    { harnessId: "cursor", kind: "cursor", bin: "cursor-agent", available: true, path: "/usr/local/bin/cursor-agent", version: null, reason: null, installHint: null, loggedIn: true, authHelp: null, account: null, usage: null },
    { harnessId: "opencode", kind: "custom", bin: "/opt/homebrew/bin/opencode", available: true, path: "/opt/homebrew/bin/opencode", version: null, reason: null, installHint: null, loggedIn: null, authHelp: null, account: null, usage: null },
  ],
};

function renderWithProviders(node: React.ReactNode, locale: "en" | "ru"): string {
  localeStore.reconcile(locale);
  return renderToStaticMarkup(
    <LocaleProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </LocaleProvider>,
  );
}

describe("ProvidersSection & AddCliView rendering (EN + RU)", () => {
  test("renders compact single-card-per-service layout without exposing runtime matrix by default", () => {
    const view = (
      <ProvidersSection
        payload={samplePayload}
        homeDir="/Users/test"
        canAdd
        pendingToggle={{}}
        onAddCli={() => {}}
        onQuickConnect={async () => {}}
        onAddAccountForService={() => {}}
        onEditHarness={() => {}}
        onDeleteHarness={() => {}}
        onToggleHarness={() => {}}
        onOpenTerminal={() => {}}
        onRefresh={async () => {}}
      />
    );
    const htmlRu = renderWithProviders(view, "ru");
    expect(htmlRu).toContain("Добавить CLI");
    expect(htmlRu).toContain('data-testid="provider-card-codex"');
    expect(htmlRu).toContain('data-testid="provider-card-claude-code"');
    expect(htmlRu).toContain('data-testid="provider-card-cursor"');
    expect(htmlRu).toContain('data-testid="provider-card-opencode"');
    expect(htmlRu.match(/data-testid="provider-card-codex"/g)?.length).toBe(1);
    expect(htmlRu).toContain("Аккаунтов: 2");
    expect(htmlRu).not.toContain("/opt/homebrew/bin/codex");
    expect(htmlRu).not.toContain("runtime.execution.not-authorized");

    const htmlEn = renderWithProviders(view, "en");
    expect(htmlEn).toContain("Add CLI");
    expect(htmlEn).toContain("2 accounts");
  });

  test("AddCliView renders custom CLI form with simple fields and collapsed additional settings", () => {
    const html = renderWithProviders(
      <AddCliView
        discoveredClis={[]}
        existingHarnesses={samplePayload.harnesses}
        homeDir="/Users/test"
        dataDir="/tmp/data"
        onQuickConnect={async () => {}}
        onPickTemplate={() => {}}
        onCreateCustom={async () => {}}
        onCancel={() => {}}
      />,
      "ru",
    );
    expect(html).toContain("Произвольный CLI");
    expect(html).toContain("Использовать текущий вход CLI");
    expect(html).toContain("Дополнительные настройки");
    expect(html).toContain("Сохранить CLI");
    expect(html).not.toContain('data-testid="custom-cli-advanced-fields"');
    localeStore.reconcile("en");
  });
});
