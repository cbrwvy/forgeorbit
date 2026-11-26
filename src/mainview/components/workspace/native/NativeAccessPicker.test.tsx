import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { localeStore } from "@/i18n/core";
import { LocaleProvider } from "@/i18n/react";
import type { NativeSessionView } from "../../../../shared/native-computer/types.ts";
import type { NativeActionView } from "../../../../shared/native-computer/agent.ts";
import { NativeAccessPicker, NativeActionCard } from "./NativeAccessPicker";

const choose = (locale: "en" | "ru") => localeStore.choose(locale, async () => {});

afterEach(async () => {
  await choose("en");
});

const session: NativeSessionView = {
  id: "ncu_" + "a".repeat(32),
  createdAt: 1,
  status: "active",
  ownerId: "owner",
  idleTimeoutMs: 900_000,
  maxLifetimeMs: 3_600_000,
  expiresAt: 3_600_001,
  lastActivityAt: 1,
  application: {
    bundleId: "app.forgeorbit.native-cu-fixture",
    executablePath: "/tmp/fixture",
    pid: 42,
    startSec: 100,
    startUsec: 5,
    displayName: "Fixture App",
  },
  window: {
    windowId: 7,
    title: "Fixture Window",
    titleRedacted: false,
    width: 420,
    height: 160,
  },
  observationId: "nobs_" + "b".repeat(32),
  supportedActions: ["press_accessible_button"],
  actionBoundary: "fixture-button",
  agentControl: "unavailable",
  lastError: null,
};

function picker() {
  return renderToStaticMarkup(
    <LocaleProvider>
      <NativeAccessPicker
        managerKind="head-of-pm"
        grantId={null}
        onGrantChange={() => {}}
        onOpenNativeComputer={() => {}}
        testId="native-access"
        sessions={[session]}
      />
    </LocaleProvider>,
  );
}

test("native permission controls state the one-action limit in English and Russian", async () => {
  const english = picker();
  expect(english).toContain("One native action allowed for this message.");
  expect(english).toContain("Native access is off until you allow this message to use one active session.");
  expect(english).toContain("Fixture Window");
  expect(english).toContain("Fixture App");
  expect(english).toContain("Allow for this message");
  expect(english).toContain("Open Native computer");
  expect(english).toContain("Actions supported");

  await choose("ru");
  const russian = picker();
  expect(russian).toContain("Для этого сообщения разрешено одно действие в приложении.");
  expect(russian).toContain("Разрешить для этого сообщения");
  expect(russian).toContain("Открыть нативный компьютер");
  expect(russian).toContain("Fixture Window");
  expect(russian).toContain("Действия поддерживаются");
});

test("picker explains why an excluded session is read-only", async () => {
  const excludedSession: NativeSessionView = {
    ...session,
    id: "ncu_excluded",
    actionBoundary: "read-only",
    readOnlyReason: "Terminal and shell execution interfaces are excluded.",
    supportedActions: [],
  };
  const html = renderToStaticMarkup(
    <LocaleProvider>
      <NativeAccessPicker
        managerKind="head-of-pm"
        grantId={null}
        onGrantChange={() => {}}
        onOpenNativeComputer={() => {}}
        testId="native-access"
        sessions={[excludedSession]}
      />
    </LocaleProvider>,
  );
  expect(html).toContain('data-testid="native-access-read-only"');
  expect(html).toContain("Terminal and shell execution interfaces are excluded.");
});

test("the owner sees whether the one native action was accepted, refused, or interrupted", async () => {
  const accepted: NativeActionView = {
    grantId: "a".repeat(64),
    sessionId: session.id,
    kind: "press_accessible_button",
    elementId: "el_0",
    status: "accepted",
    reasonCode: null,
  };
  const refused: NativeActionView = {
    grantId: "b".repeat(64),
    sessionId: session.id,
    kind: "press_accessible_button",
    elementId: "el_9",
    status: "refused",
    reasonCode: "element_not_found",
  };
  const interrupted: NativeActionView = {
    grantId: "c".repeat(64),
    sessionId: session.id,
    kind: "press_accessible_button",
    elementId: "el_0",
    status: "interrupted",
    reasonCode: "restart",
  };

  const ok = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={accepted} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(ok).toContain('data-status="accepted"');
  expect(ok).toContain("Press button");
  expect(ok).toContain("Accepted");
  expect(ok).toContain("Open observation");

  const no = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={refused} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(no).toContain('data-status="refused"');
  expect(no).toContain("Refused");
  expect(no).toContain("element_not_found");
  expect(no).not.toContain("Open observation");

  const intr = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={interrupted} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(intr).toContain('data-status="interrupted"');
  expect(intr).toContain("Interrupted");
  expect(intr).toContain("restart");
  expect(intr).toContain('data-testid="native-action-interrupted-note"');
  expect(intr).toContain("did not finish in a known state");

  // Scroll and tab action cards
  const scrollAction: NativeActionView = {
    grantId: "d".repeat(64),
    sessionId: session.id,
    kind: "scroll_accessible_area",
    elementId: "el_scroll",
    status: "accepted",
    reasonCode: null,
  };
  const tabAction: NativeActionView = {
    grantId: "e".repeat(64),
    sessionId: session.id,
    kind: "select_accessible_tab",
    elementId: "el_tab",
    status: "accepted",
    reasonCode: null,
  };
  const textAction: NativeActionView = {
    grantId: "f".repeat(64),
    sessionId: session.id,
    kind: "set_accessible_text",
    elementId: "el_text",
    status: "accepted",
    reasonCode: null,
  };
  const openMenuAction: NativeActionView = {
    grantId: "1".repeat(64),
    sessionId: session.id,
    kind: "open_accessible_menu",
    elementId: "el_menu_2",
    status: "accepted",
    reasonCode: null,
  };
  const selectMenuItemAction: NativeActionView = {
    grantId: "2".repeat(64),
    sessionId: session.id,
    kind: "select_accessible_menu_item",
    elementId: "el_menu_2_0_0",
    status: "accepted",
    reasonCode: null,
  };

  const scrollHtml = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={scrollAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(scrollHtml).toContain("Scroll area");
  expect(scrollHtml).toContain("Accepted");

  const tabHtml = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={tabAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(tabHtml).toContain("Select tab");
  expect(tabHtml).toContain("Accepted");

  const textHtml = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={textAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(textHtml).toContain("Set text");
  expect(textHtml).toContain("Accepted");

  const openMenuHtml = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={openMenuAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(openMenuHtml).toContain("Open menu");
  expect(openMenuHtml).toContain("Accepted");

  const selectMenuItemHtml = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={selectMenuItemAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(selectMenuItemHtml).toContain("Select menu item");
  expect(selectMenuItemHtml).toContain("Accepted");

  await choose("ru");
  const scrollHtmlRu = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={scrollAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(scrollHtmlRu).toContain("Прокрутить область");
  expect(scrollHtmlRu).toContain("Принято");

  const tabHtmlRu = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={tabAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(tabHtmlRu).toContain("Выбрать вкладку");
  expect(tabHtmlRu).toContain("Принято");

  const textHtmlRu = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={textAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(textHtmlRu).toContain("Ввести текст");
  expect(textHtmlRu).toContain("Принято");

  const openMenuHtmlRu = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={openMenuAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(openMenuHtmlRu).toContain("Открыть меню");
  expect(openMenuHtmlRu).toContain("Принято");

  const selectMenuItemHtmlRu = renderToStaticMarkup(
    <LocaleProvider>
      <NativeActionCard action={selectMenuItemAction} onOpenNativeComputer={() => {}} />
    </LocaleProvider>,
  );
  expect(selectMenuItemHtmlRu).toContain("Выбрать пункт меню");
  expect(selectMenuItemHtmlRu).toContain("Принято");
});
