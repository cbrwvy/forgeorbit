import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeBridge } from "./native-computer-bridge.ts";
import { NativeComputerSessionManager } from "./native-computer-session.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID, type NativeApplicationRecord } from "../shared/native-computer/types.ts";

/**
 * FO-NATIVE-CU02 through Head of PM and Project Manager turns.
 * The model is the fake driver. The native computer environment is an in-memory mock bridge,
 * not the Owner's real applications or windows.
 */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-native-cu02-mgr-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4784";
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CURSOR_BIN = "/nonexistent/cursor-agent";
process.env.AGETOR_TMUX_BIN = "/bin/echo";

const stats = { presses: 0, observations: 0, scrolls: 0, tabSelections: 0, textSets: 0, lastText: "", menuOpens: 0, menuItemSelections: 0 };
const fixtureAppRecord: NativeApplicationRecord = {
  bundleId: FIXTURE_BUNDLE_ID,
  executablePath: "/tmp/ForgeOrbitNativeCuFixture.app/Contents/MacOS/fixture",
  pid: 42,
  startSec: 100,
  startUsec: 5,
  displayName: "ForgeOrbit Native CU Fixture",
};
const fixtureWindow = {
  windowId: 7,
  title: "ForgeOrbit Native CU Fixture",
  titleRedacted: false,
  width: 420,
  height: 160,
};

function fixtureButton() {
  return {
    path: "0",
    role: "AXButton",
    subrole: "",
    identifier: FIXTURE_BUTTON_ID,
    label: "Harmless press",
    labelHash: "0123456789abcdef",
    enabled: true,
    depth: 1,
    valueRedacted: false,
  };
}

function fixtureElements() {
  return [
    fixtureButton(),
    {
      path: "1",
      role: "AXScrollArea",
      subrole: "",
      identifier: "fixture-scroll",
      label: "Content Scroll",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsScroll: true,
    },
    {
      path: "2",
      role: "AXTabGroup",
      subrole: "",
      identifier: "fixture-tabs",
      label: "Tabs",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
    },
    {
      path: "2/0",
      role: "AXRadioButton",
      subrole: "AXTabButton",
      parentRole: "AXTabGroup",
      inTabGroup: true,
      identifier: "fixture-tab-2",
      label: "Tab 2",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 2,
      valueRedacted: false,
      supportsSelectTab: true,
    },
    {
      path: "3",
      role: "AXTextField",
      subrole: "",
      identifier: "fixture-text-field",
      label: "Name Input",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsSetText: true,
    },
    {
      path: "menu/2",
      role: "AXMenuBarItem",
      subrole: "",
      identifier: "fixture-view-menu",
      label: "View",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsOpenMenu: true,
    },
    {
      path: "menu/2/0/0",
      role: "AXMenuItem",
      subrole: "",
      identifier: "fixture-harmless-item",
      label: "Harmless Menu Action",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 3,
      valueRedacted: false,
      supportsSelectMenuItem: true,
    },
  ];
}

let base = "";
let token = "";
let server: { stop: () => void };
let db: typeof import("./db.ts");
let fakePm: typeof import("./project-manager-fake.ts");
let fakePortfolio: typeof import("./portfolio-manager-fake.ts");
let nativeSession: typeof import("./native-computer-session.ts");
let consent = "";
const spies: Array<ReturnType<typeof spyOn>> = [];

beforeAll(async () => {
  for (const method of ["log", "warn", "error", "info"] as const) {
    spies.push(spyOn(console, method).mockImplementation(() => {}));
  }
  db = await import("./db.ts");
  fakePm = await import("./project-manager-fake.ts");
  fakePortfolio = await import("./portfolio-manager-fake.ts");
  nativeSession = await import("./native-computer-session.ts");

  const bridge: NativeBridge = {
    cancel() {},
    async call(request) {
      const command = String(request.command);
      if (command === "permissions") return { ok: true, result: { accessibility: "granted", screenRecording: "granted" } };
      if (command === "list-apps") return { ok: true, result: { applications: [fixtureAppRecord], truncated: false } };
      if (command === "list-windows" || command === "validate") {
        return command === "validate"
          ? { ok: true, result: { application: fixtureAppRecord, window: fixtureWindow } }
          : { ok: true, result: { windows: [fixtureWindow], truncated: false } };
      }
      if (command === "observe") {
        stats.observations += 1;
        return {
          ok: true,
          result: {
            elements: fixtureElements(),
            truncated: false,
            omitted: 0,
            title: fixtureWindow.title,
            titleRedacted: false,
          },
        };
      }
      if (command === "press-button") {
        stats.presses += 1;
        return { ok: true, result: { pressed: true } };
      }
      if (command === "scroll-area") {
        stats.scrolls += 1;
        return { ok: true, result: { scrolled: true, direction: request.direction, increment: request.increment } };
      }
      if (command === "select-tab") {
        stats.tabSelections += 1;
        return { ok: true, result: { selected: true, role: "AXRadioButton" } };
      }
      if (command === "set-text") {
        stats.textSets += 1;
        stats.lastText = String(request.text ?? "");
        return { ok: true, result: { textSet: true, characterCount: stats.lastText.length } };
      }
      if (command === "open-menu") {
        stats.menuOpens += 1;
        return { ok: true, result: { menuOpened: true } };
      }
      if (command === "select-menu-item") {
        stats.menuItemSelections += 1;
        return { ok: true, result: { menuItemSelected: true } };
      }
      return { ok: false, code: "invalid_request", message: `unknown: ${command}` };
    },
  };

  const root = mkdtempSync(path.join(tmpdir(), "fo-native-cu02-mgr-session-"));
  nativeSession.useNativeComputerSessionManager(new NativeComputerSessionManager({
    root,
    bridge,
    now: () => Date.now(),
  }));

  const started = await import("./server.ts");
  token = started.API_TOKEN;
  server = started.startApiServer() as unknown as { stop: () => void };
  base = `http://127.0.0.1:${process.env.AGETOR_API_PORT}`;
  db.harnesses.setEnabled("codex", true);
  const preflight = await call("POST", "/project-interviews/preflight", { harness: "codex", model: "gpt-6.1-sol" });
  expect(preflight.status).toBe(200);
  consent = preflight.json.isolation.consentKey;
});

afterAll(() => {
  server?.stop?.();
  nativeSession?.useNativeComputerSessionManager(null);
  for (const spy of spies) spy.mockRestore();
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function newProject(name: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-native-cu02-proj-")));
  db.projects.upsert(dir, name);
  return dir;
}

async function configure(dir: string | null): Promise<void> {
  const config = { harness: "codex", model: "gpt-6.1-sol", effort: "low", consentKey: consent };
  const res = dir
    ? await call("PUT", "/project-manager/config", { path: dir, config })
    : await call("PUT", "/portfolio-manager/config", { config });
  expect(res.status).toBe(200);
}

async function settle(route: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const { json } = await call("GET", route);
    if (json?.status && json.status !== "running") return json;
    await Bun.sleep(20);
  }
  throw new Error(`turn never settled: ${route}`);
}

async function allowNative(managerKind: "head-of-pm" | "project-manager", projectPath?: string) {
  const listed = await call("GET", "/native-computer/sessions");
  let sessionId = listed.json.sessions?.[0]?.id as string | undefined;
  if (!sessionId) {
    const created = await call("POST", "/native-computer/sessions", {
      bundleId: fixtureAppRecord.bundleId,
      executablePath: fixtureAppRecord.executablePath,
      pid: fixtureAppRecord.pid,
      startSec: fixtureAppRecord.startSec,
      startUsec: fixtureAppRecord.startUsec,
      windowId: fixtureWindow.windowId,
    });
    expect(created.status).toBe(201);
    sessionId = created.json.id;
  }

  const obs = await call("POST", `/native-computer/sessions/${sessionId}/observation`, {});
  expect(obs.status).toBe(200);

  const grant = await call("POST", "/native-computer/agent-grants", {
    managerKind,
    ...(projectPath ? { projectPath } : {}),
    sessionId,
  });
  expect(grant.status).toBe(201);
  expect(grant.json.maxActions).toBe(1);
  expect(grant.json.observation.elements.length).toBeGreaterThanOrEqual(1);
  expect(grant.json.observation.elements[0].id).toBe("el_0");
  return grant.json as { grantId: string; sessionId: string };
}

test("manager turns do not see native application until the owner allows that message", async () => {
  const alpha = newProject("Alpha Native");
  await configure(alpha);
  await configure(null);
  const turns = fakePortfolio.fakeTurnLog.manager;
  const sent = await call("POST", "/project-manager/messages", { path: alpha, text: fakePm.FAKE_PM_NATIVE_PROBE_MARKER });
  expect(sent.status).toBe(202);
  expect((await settle(`/project-manager/turns/${sent.json.turn.id}`)).status).toBe("succeeded");
  expect(fakePortfolio.fakeTurnLog.manager).toBe(turns + 1);
  expect(fakePortfolio.fakeTurnLog.lastManagerPrompt).not.toContain("BEGIN native application observation");
  const state = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  expect(state.json.messages.at(-1).text).toContain("No native window observation");
  expect(process.env.AGETOR_CODEX_DRIVER).toBe("fake");
});

test("Head of PM and Project Manager each receive their observation and execute action automatically", async () => {
  const alpha = newProject("Alpha Native CU");
  const beta = newProject("Beta Native CU");
  await configure(alpha);
  await configure(beta);
  await configure(null);

  // 1. Head of PM probe
  const headGrant = await allowNative("head-of-pm");
  const headTurns = fakePortfolio.fakeTurnLog.portfolio;
  const headSent = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_PROBE_MARKER,
    nativeGrantId: headGrant.grantId,
  });
  expect(headSent.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSent.json.turn.id}`)).status).toBe("succeeded");
  expect(fakePortfolio.fakeTurnLog.portfolio).toBe(headTurns + 1);
  expect(fakePortfolio.fakeTurnLog.lastPortfolioPrompt).toContain("BEGIN native computer observation");
  expect(fakePortfolio.fakeTurnLog.lastPortfolioPrompt).toContain("ForgeOrbit Native CU Fixture");
  const headState = await call("GET", "/portfolio-manager");
  expect(headState.json.messages.at(-1).text).toContain("Observed app: app.forgeorbit.native-cu-fixture (pid 42)");

  // 2. Cross-manager refusal: Head grant cannot be used in Project Manager
  const crossMgr = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_PROBE_MARKER,
    nativeGrantId: headGrant.grantId,
  });
  expect(crossMgr.status).toBe(409);

  // 3. Cross-project refusal: PM grant for alpha cannot be used in beta
  const pmGrant = await allowNative("project-manager", alpha);
  const otherProject = await call("POST", "/project-manager/messages", {
    path: beta,
    text: fakePm.FAKE_PM_NATIVE_PROBE_MARKER,
    nativeGrantId: pmGrant.grantId,
  });
  expect(otherProject.status).toBe(409);

  // 4. Automatic action execution in Project Manager
  const beforePresses = stats.presses;
  const pmTurns = fakePortfolio.fakeTurnLog.manager;
  const pmSent = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_PRESS_MARKER,
    nativeGrantId: pmGrant.grantId,
  });
  expect(pmSent.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSent.json.turn.id}`)).status).toBe("succeeded");
  expect(fakePortfolio.fakeTurnLog.manager).toBe(pmTurns + 1);
  expect(stats.presses).toBe(beforePresses + 1);

  const pmState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const reply = pmState.json.messages.at(-1);
  expect(reply.text).toContain("Observed app: app.forgeorbit.native-cu-fixture (pid 42)");
  expect(reply.text).not.toContain("<native_action>");
  expect(reply.nativeAction).not.toBeNull();
  expect(reply.nativeAction.status).toBe("accepted");
  expect(reply.nativeAction.kind).toBe("press_accessible_button");
  expect(reply.nativeAction.elementId).toBe("el_0");

  // 5. Automatic action execution in Head of PM
  const headActionGrant = await allowNative("head-of-pm");
  const headSentAction = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_PRESS_MARKER,
    nativeGrantId: headActionGrant.grantId,
  });
  expect(headSentAction.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSentAction.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.presses).toBe(beforePresses + 2);

  const headActionState = await call("GET", "/portfolio-manager");
  const headReply = headActionState.json.messages.at(-1);
  expect(headReply.text).toContain("Observed app: app.forgeorbit.native-cu-fixture (pid 42)");
  expect(headReply.text).not.toContain("<native_action>");
  expect(headReply.nativeAction).not.toBeNull();
  expect(headReply.nativeAction.status).toBe("accepted");
  expect(headReply.nativeAction.kind).toBe("press_accessible_button");
  expect(headReply.nativeAction.elementId).toBe("el_0");

  // 6. Duplicate action prevention: used grant cannot be reused
  const reuseConsumed = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_PRESS_MARKER,
    nativeGrantId: headActionGrant.grantId,
  });
  expect(reuseConsumed.status).toBe(409);

  // 7. Refused action on wrong element does not press button
  const pmRefuseGrant = await allowNative("project-manager", alpha);
  const pressesBeforeRefuse = stats.presses;
  const pmSentWrong = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_WRONG_EL_MARKER,
    nativeGrantId: pmRefuseGrant.grantId,
  });
  expect(pmSentWrong.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSentWrong.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.presses).toBe(pressesBeforeRefuse);

  const pmRefuseState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const refuseReply = pmRefuseState.json.messages.at(-1);
  expect(refuseReply.nativeAction).not.toBeNull();
  expect(refuseReply.nativeAction.status).toBe("refused");
  expect(refuseReply.nativeAction.reasonCode).toBe("element_not_found");

  // 8. Automatic scroll action execution in Head of PM
  const headScrollGrant = await allowNative("head-of-pm");
  const beforeScrolls = stats.scrolls;
  const headSentScroll = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_SCROLL_MARKER,
    nativeGrantId: headScrollGrant.grantId,
  });
  expect(headSentScroll.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSentScroll.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.scrolls).toBe(beforeScrolls + 1);

  const headScrollState = await call("GET", "/portfolio-manager");
  const headScrollReply = headScrollState.json.messages.at(-1);
  expect(headScrollReply.text).not.toContain("<native_action>");
  expect(headScrollReply.nativeAction).not.toBeNull();
  expect(headScrollReply.nativeAction.status).toBe("accepted");
  expect(headScrollReply.nativeAction.kind).toBe("scroll_accessible_area");

  // 9. Automatic tab selection in Project Manager
  const pmTabGrant = await allowNative("project-manager", alpha);
  const beforeTabs = stats.tabSelections;
  const pmSentTab = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_TAB_MARKER,
    nativeGrantId: pmTabGrant.grantId,
  });
  expect(pmSentTab.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSentTab.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.tabSelections).toBe(beforeTabs + 1);

  const pmTabState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const pmTabReply = pmTabState.json.messages.at(-1);
  expect(pmTabReply.text).not.toContain("<native_action>");
  expect(pmTabReply.nativeAction).not.toBeNull();
  expect(pmTabReply.nativeAction.status).toBe("accepted");
  expect(pmTabReply.nativeAction.kind).toBe("select_accessible_tab");

  // 10. Automatic set_accessible_text in Head of PM
  const headTextGrant = await allowNative("head-of-pm");
  const beforeHeadTexts = stats.textSets;
  const headSentText = await call("POST", "/portfolio-manager/messages", {
    text: `${fakePortfolio.FAKE_PORTFOLIO_NATIVE_SET_TEXT_MARKER} text:HeadOfPMNote`,
    nativeGrantId: headTextGrant.grantId,
  });
  expect(headSentText.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSentText.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.textSets).toBe(beforeHeadTexts + 1);
  expect(stats.lastText).toBe("HeadOfPMNote");

  const headTextState = await call("GET", "/portfolio-manager");
  const headTextReply = headTextState.json.messages.at(-1);
  expect(headTextReply.text).not.toContain("<native_action>");
  expect(headTextReply.nativeAction).not.toBeNull();
  expect(headTextReply.nativeAction.status).toBe("accepted");
  expect(headTextReply.nativeAction.kind).toBe("set_accessible_text");

  // 11. Automatic set_accessible_text in Project Manager
  const pmTextGrant = await allowNative("project-manager", alpha);
  const beforePmTexts = stats.textSets;
  const pmSentText = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: `${fakePm.FAKE_PM_NATIVE_SET_TEXT_MARKER} text:ProjectManagerNote`,
    nativeGrantId: pmTextGrant.grantId,
  });
  expect(pmSentText.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSentText.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.textSets).toBe(beforePmTexts + 1);
  expect(stats.lastText).toBe("ProjectManagerNote");

  const pmTextState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const pmTextReply = pmTextState.json.messages.at(-1);
  expect(pmTextReply.text).not.toContain("<native_action>");
  expect(pmTextReply.nativeAction).not.toBeNull();
  expect(pmTextReply.nativeAction.status).toBe("accepted");
  expect(pmTextReply.nativeAction.kind).toBe("set_accessible_text");

  // 12. Automatic open_accessible_menu in Head of PM
  const headOpenMenuGrant = await allowNative("head-of-pm");
  const beforeHeadMenuOpens = stats.menuOpens;
  const headSentOpenMenu = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_OPEN_MENU_MARKER,
    nativeGrantId: headOpenMenuGrant.grantId,
  });
  expect(headSentOpenMenu.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSentOpenMenu.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.menuOpens).toBe(beforeHeadMenuOpens + 1);

  const headOpenMenuState = await call("GET", "/portfolio-manager");
  const headOpenMenuReply = headOpenMenuState.json.messages.at(-1);
  expect(headOpenMenuReply.text).not.toContain("<native_action>");
  expect(headOpenMenuReply.nativeAction).not.toBeNull();
  expect(headOpenMenuReply.nativeAction.status).toBe("accepted");
  expect(headOpenMenuReply.nativeAction.kind).toBe("open_accessible_menu");

  // 13. Automatic select_accessible_menu_item in Head of PM
  const headSelectItemGrant = await allowNative("head-of-pm");
  const beforeHeadItemSelections = stats.menuItemSelections;
  const headSentSelectItem = await call("POST", "/portfolio-manager/messages", {
    text: fakePortfolio.FAKE_PORTFOLIO_NATIVE_SELECT_MENU_ITEM_MARKER,
    nativeGrantId: headSelectItemGrant.grantId,
  });
  expect(headSentSelectItem.status).toBe(202);
  expect((await settle(`/portfolio-manager/turns/${headSentSelectItem.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.menuItemSelections).toBe(beforeHeadItemSelections + 1);

  const headSelectItemState = await call("GET", "/portfolio-manager");
  const headSelectItemReply = headSelectItemState.json.messages.at(-1);
  expect(headSelectItemReply.text).not.toContain("<native_action>");
  expect(headSelectItemReply.nativeAction).not.toBeNull();
  expect(headSelectItemReply.nativeAction.status).toBe("accepted");
  expect(headSelectItemReply.nativeAction.kind).toBe("select_accessible_menu_item");

  // 14. Automatic open_accessible_menu in Project Manager
  const pmOpenMenuGrant = await allowNative("project-manager", alpha);
  const beforePmMenuOpens = stats.menuOpens;
  const pmSentOpenMenu = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_OPEN_MENU_MARKER,
    nativeGrantId: pmOpenMenuGrant.grantId,
  });
  expect(pmSentOpenMenu.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSentOpenMenu.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.menuOpens).toBe(beforePmMenuOpens + 1);

  const pmOpenMenuState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const pmOpenMenuReply = pmOpenMenuState.json.messages.at(-1);
  expect(pmOpenMenuReply.text).not.toContain("<native_action>");
  expect(pmOpenMenuReply.nativeAction).not.toBeNull();
  expect(pmOpenMenuReply.nativeAction.status).toBe("accepted");
  expect(pmOpenMenuReply.nativeAction.kind).toBe("open_accessible_menu");

  // 15. Automatic select_accessible_menu_item in Project Manager
  const pmSelectItemGrant = await allowNative("project-manager", alpha);
  const beforePmItemSelections = stats.menuItemSelections;
  const pmSentSelectItem = await call("POST", "/project-manager/messages", {
    path: alpha,
    text: fakePm.FAKE_PM_NATIVE_SELECT_MENU_ITEM_MARKER,
    nativeGrantId: pmSelectItemGrant.grantId,
  });
  expect(pmSentSelectItem.status).toBe(202);
  expect((await settle(`/project-manager/turns/${pmSentSelectItem.json.turn.id}`)).status).toBe("succeeded");
  expect(stats.menuItemSelections).toBe(beforePmItemSelections + 1);

  const pmSelectItemState = await call("GET", `/project-manager?path=${encodeURIComponent(alpha)}`);
  const pmSelectItemReply = pmSelectItemState.json.messages.at(-1);
  expect(pmSelectItemReply.text).not.toContain("<native_action>");
  expect(pmSelectItemReply.nativeAction).not.toBeNull();
  expect(pmSelectItemReply.nativeAction.status).toBe("accepted");
  expect(pmSelectItemReply.nativeAction.kind).toBe("select_accessible_menu_item");
});
