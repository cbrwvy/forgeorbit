import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import type { BrowserSessionView } from "../../../../shared/browser/types.ts";
import type { BrowserActionView } from "../../../../shared/browser/agent.ts";
import { BrowserAccessPicker, BrowserActionCard } from "./BrowserAccessPicker";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const session: BrowserSessionView = {
  id: "brw_" + "a".repeat(32),
  createdAt: 1,
  url: "https://docs.example/guide",
  history: ["https://docs.example/guide"],
  state: "active",
  ownerId: "owner",
  approvedOrigins: ["https://docs.example"],
  expiresAt: 2,
  idleTimeoutMs: 1000,
  lastActivityAt: 1,
  pid: null,
  pageTitle: "Fixture Page",
  error: null,
  storage: "ephemeral-session-profile",
  agentControl: "unavailable",
};

function picker() {
  return renderToStaticMarkup(
    <LocaleProvider>
      <BrowserAccessPicker
        managerKind="head-of-pm"
        grantId={null}
        onGrantChange={() => {}}
        onOpenBrowser={() => {}}
        testId="browser-access"
        sessions={[session]}
      />
    </LocaleProvider>,
  );
}

test("browser permission controls state the one-action limit in English and Russian", async () => {
  const english = picker();
  expect(english).toContain("One browser action allowed for this message.");
  expect(english).toContain("Browser access is off until you allow this message to use one active session.");
  expect(english).toContain("Fixture Page");
  expect(english).toContain("https://docs.example");
  expect(english).toContain("Allow for this message");
  expect(english).toContain("Open Browser");
  expect(english).not.toContain("browse indefinitely");

  await choose("ru");
  const russian = picker();
  expect(russian).toContain("Для этого сообщения разрешено одно действие в браузере.");
  expect(russian).toContain("Разрешить для этого сообщения");
  expect(russian).toContain("Открыть браузер");
  expect(russian).toContain("Fixture Page");
});

test("the owner sees whether the one browser action was accepted or refused", async () => {
  const accepted: BrowserActionView = {
    grantId: "a".repeat(64),
    sessionId: session.id,
    kind: "open_link",
    status: "accepted",
    reasonCode: null,
    destinationHost: "docs.example",
  };
  const refused: BrowserActionView = {
    grantId: "b".repeat(64),
    sessionId: session.id,
    kind: "navigate",
    status: "refused",
    reasonCode: "origin_not_approved",
    destinationHost: "evil.example",
  };
  const ok = renderToStaticMarkup(
    <LocaleProvider>
      <BrowserActionCard action={accepted} onOpenBrowser={() => {}} />
    </LocaleProvider>,
  );
  expect(ok).toContain('data-status="accepted"');
  expect(ok).toContain("Open link");
  expect(ok).toContain("Accepted");
  expect(ok).toContain("Open observation");
  const no = renderToStaticMarkup(
    <LocaleProvider>
      <BrowserActionCard action={refused} onOpenBrowser={() => {}} />
    </LocaleProvider>,
  );
  expect(no).toContain('data-status="refused"');
  expect(no).toContain("Refused");
  expect(no).toContain("origin_not_approved");
  expect(no).not.toContain("Open observation");
});
