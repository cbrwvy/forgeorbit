import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeAgentGrantService, recoverNativeAgentGrants, settleNativeAgentAction } from "./native-computer-agent.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "./native-computer-session.ts";
import type { NativeBridge } from "./native-computer-bridge.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID, type NativeApplicationRecord } from "../shared/native-computer/types.ts";
import { NATIVE_AGENT_LIMITS } from "../shared/native-computer/agent.ts";

function fixtureApp(pid = 42, bundleId = FIXTURE_BUNDLE_ID): NativeApplicationRecord {
  return {
    bundleId,
    executablePath: "/tmp/ForgeOrbitNativeCuFixture.app/Contents/MacOS/fixture",
    pid,
    startSec: 100,
    startUsec: 5,
    displayName: "Fixture",
  };
}

function fixtureButton(extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

function harness(options?: {
  application?: NativeApplicationRecord;
  elements?: Record<string, unknown>[];
  pressFails?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "fo-native-cu02-agent-"));
  const application = options?.application ?? fixtureApp();
  const windowRecord = { windowId: 7, title: "ForgeOrbit Native CU Fixture", titleRedacted: false, width: 420, height: 160 };
  const calls: Record<string, unknown>[] = [];
  const stats = { presses: 0, observations: 0, scrolls: 0, tabSelections: 0, textSets: 0, menuOpens: 0, menuItemSelections: 0 };
  let currentObsId = 0;

  const bridge: NativeBridge = {
    cancel() {},
    async call(request) {
      calls.push(request);
      const command = String(request.command);
      if (command === "permissions") return { ok: true, result: { accessibility: "granted", screenRecording: "granted" } };
      if (command === "list-apps") return { ok: true, result: { applications: [application], truncated: false } };
      if (command === "list-windows" || command === "validate") {
        return command === "validate"
          ? { ok: true, result: { application, window: windowRecord } }
          : { ok: true, result: { windows: [windowRecord], truncated: false } };
      }
      if (command === "observe") {
        stats.observations += 1;
        currentObsId += 1;
        return {
          ok: true,
          result: {
            elements: options?.elements ?? [fixtureButton()],
            truncated: false,
            omitted: 0,
            title: windowRecord.title,
            titleRedacted: false,
          },
        };
      }
      if (command === "press-button") {
        if (options?.pressFails) {
          return { ok: false, code: "ax_action_failed", message: "Button failed to press." };
        }
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
        return { ok: true, result: { textSet: true, characterCount: String(request.text ?? "").length } };
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

  let now = 1_700_000_000_000;
  const events: NativeJournalEvent[] = [];
  const manager = new NativeComputerSessionManager({
    root,
    bridge,
    now: () => now,
    journal: (event) => events.push(event),
  });

  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(import.meta.dir, "migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db, () => now);

  return {
    root,
    stats,
    calls,
    events,
    manager,
    grants,
    db,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };
const pmTarget = { managerKind: "project-manager" as const, projectPath: "/tmp/proj" };

function identityOf(application: NativeApplicationRecord) {
  const { displayName: _displayName, ...identity } = application;
  return identity;
}

async function grantedFixture(target = headTarget, harnessOpts?: Parameters<typeof harness>[0]) {
  const env = harness(harnessOpts);
  const application = harnessOpts?.application ?? fixtureApp();
  const session = await env.manager.create(identityOf(application), 7);
  const observation = await env.manager.observe(session.id);
  const live = await env.manager.inspect(session.id);
  expect(live).not.toBeNull();
  expect(live!.observationId).not.toBeNull();
  const approved = env.grants.approve(
    target,
    session.id,
    observation,
  );
  expect(approved.ok).toBe(true);
  if (!approved.ok) throw new Error(approved.error);
  return { ...env, session, live: live!, grant: approved.value, observation };
}

test("native access is off until the owner grants one message", async () => {
  const env = harness();
  const settled = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: null,
    messageId: "m1",
    turnId: "t1",
    replyText: 'Press it.\n<native_action>{"kind":"press_accessible_button","elementId":"el_1"}</native_action>',
  });
  expect(settled.record?.status).toBe("ignored");
  expect(settled.record?.reasonCode).toBe("not_authorized");
  expect(env.stats.presses).toBe(0);
});

test("one grant is bound to one manager, session, PID, and observation", async () => {
  const env = await grantedFixture(headTarget);
  const live = await env.manager.inspect(env.session.id);

  // Wrong manager kind
  const wrongManager = env.grants.consume(pmTarget, env.grant.grantId, "m1", "t1", live);
  expect(wrongManager.ok).toBe(false);

  // Still approved
  const still = env.grants.get(headTarget, env.grant.grantId);
  expect(still.ok && still.value.status).toBe("approved");

  // Wrong session
  const wrongSession = env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", live ? { ...live, id: `ncu_${"c".repeat(32)}` } : null);
  expect(wrongSession.ok).toBe(false);

  // Wrong PID
  const wrongPid = env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", live ? { ...live, application: { ...live.application, pid: 9999 } } : null);
  expect(wrongPid.ok).toBe(false);

  // Expired grant
  const expiring = await grantedFixture(headTarget);
  expiring.advance(NATIVE_AGENT_LIMITS.grantTtlMs + 1);
  const expired = expiring.grants.consume(headTarget, expiring.grant.grantId, "m1", "t1", await expiring.manager.inspect(expiring.session.id));
  expect(expired.ok).toBe(false);
  if (expired.ok) throw new Error("expected the grant to expire");
  expect(expired.error).toContain("expired");
  expect(expiring.stats.presses).toBe(0);
});

test("stale observation and excluded application refuse action execution, while eligible generic works", async () => {
  // Excluded application (Target B)
  const excludedApp = await grantedFixture(headTarget, { application: fixtureApp(42, "app.forgeorbit.native-cu-excluded") });
  const liveExcluded = await excludedApp.manager.inspect(excludedApp.session.id);
  expect(excludedApp.grants.consume(headTarget, excludedApp.grant.grantId, "m1", "t1", liveExcluded).ok).toBe(true);

  const settledExcluded = await settleNativeAgentAction(excludedApp.grants, excludedApp.manager, {
    target: headTarget,
    grantId: excludedApp.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
  });
  expect(settledExcluded.record?.status).toBe("refused");
  expect(settledExcluded.record?.reasonCode).toBe("action_not_permitted");
  expect(excludedApp.stats.presses).toBe(0);

  // Eligible generic application (Target A) works
  const genericApp = await grantedFixture(headTarget, { application: fixtureApp(43, "app.forgeorbit.native-cu-target-a") });
  const liveGeneric = await genericApp.manager.inspect(genericApp.session.id);
  expect(genericApp.grants.consume(headTarget, genericApp.grant.grantId, "m2", "t2", liveGeneric).ok).toBe(true);

  const settledGeneric = await settleNativeAgentAction(genericApp.grants, genericApp.manager, {
    target: headTarget,
    grantId: genericApp.grant.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
  });
  expect(settledGeneric.record?.status).toBe("accepted");
  expect(settledGeneric.record?.kind).toBe("press_accessible_button");
  expect(genericApp.stats.presses).toBe(1);

  // Stale observation
  const staleEnv = await grantedFixture(headTarget);
  await staleEnv.manager.observe(staleEnv.session.id);
  const liveStale = await staleEnv.manager.inspect(staleEnv.session.id);
  // Consuming with old observation ID in grant but new observation in live snapshot
  const consumed = staleEnv.grants.consume(headTarget, staleEnv.grant.grantId, "m3", "t3", liveStale);
  expect(consumed.ok).toBe(false);
  expect(staleEnv.stats.presses).toBe(0);
});

test("malformed or multiple actions in reply text are handled cleanly", async () => {
  // Malformed JSON
  const env1 = await grantedFixture(headTarget);
  expect(env1.grants.consume(headTarget, env1.grant.grantId, "m1", "t1", env1.live).ok).toBe(true);
  const settledMalformed = await settleNativeAgentAction(env1.grants, env1.manager, {
    target: headTarget,
    grantId: env1.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: '<native_action>{"kind":</native_action>',
  });
  expect(settledMalformed.record?.status).toBe("ignored");
  expect(settledMalformed.record?.reasonCode).toBe("malformed");
  expect(env1.stats.presses).toBe(0);

  // Multiple action tags
  const env2 = await grantedFixture(headTarget);
  expect(env2.grants.consume(headTarget, env2.grant.grantId, "m2", "t2", env2.live).ok).toBe(true);
  const settledMultiple = await settleNativeAgentAction(env2.grants, env2.manager, {
    target: headTarget,
    grantId: env2.grant.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: '<native_action>{"kind":"none"}</native_action><native_action>{"kind":"none"}</native_action>',
  });
  expect(settledMultiple.record?.status).toBe("ignored");
  expect(settledMultiple.record?.reasonCode).toBe("malformed");
  expect(env2.stats.presses).toBe(0);

  // None action
  const env3 = await grantedFixture(headTarget);
  expect(env3.grants.consume(headTarget, env3.grant.grantId, "m3", "t3", env3.live).ok).toBe(true);
  const settledNone = await settleNativeAgentAction(env3.grants, env3.manager, {
    target: headTarget,
    grantId: env3.grant.grantId,
    messageId: "m3",
    turnId: "t3",
    replyText: 'I reviewed the app and decided not to press.\n<native_action>{"kind":"none"}</native_action>',
  });
  expect(settledNone.record?.status).toBe("accepted");
  expect(settledNone.record?.kind).toBe("none");
  expect(env3.stats.presses).toBe(0);
});

test("one permitted button press executes once, then duplicate or restart does not replay it", async () => {
  const env = await grantedFixture(headTarget);
  expect(env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", env.live).ok).toBe(true);

  // First execution: accepted and executed
  const first = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
  });
  expect(first.record?.status).toBe("accepted");
  expect(first.record?.kind).toBe("press_accessible_button");
  expect(first.record?.elementId).toBe("el_0");
  expect(env.stats.presses).toBe(1);

  // Duplicate call on same settled turn: does not re-execute
  const second = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
  });
  expect(second.record?.status).toBe("accepted");
  expect(env.stats.presses).toBe(1);

  // Restart recovery cleans up claimed actions without replay
  const pendingEnv = await grantedFixture(headTarget);
  expect(pendingEnv.grants.consume(headTarget, pendingEnv.grant.grantId, "m2", "t2", pendingEnv.live).ok).toBe(true);
  const claimed = await pendingEnv.grants.claim(
    headTarget,
    pendingEnv.grant.grantId,
    "m2",
    "t2",
    '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
    pendingEnv.live,
  );
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw new Error(claimed.error);
  expect(claimed.value.claimToken).not.toBeNull();

  // Simulate restart: recover marks claimed as interrupted and expires old approved grants
  pendingEnv.advance(100);
  const recovered = pendingEnv.grants.recover();
  expect(recovered.expired).toBeGreaterThanOrEqual(0);
  expect(recovered.interrupted).toBe(1);

  // Claim after restart sees interrupted status and does not replay
  const afterRestart = await settleNativeAgentAction(pendingEnv.grants, pendingEnv.manager, {
    target: headTarget,
    grantId: pendingEnv.grant.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: '<native_action>{"kind":"press_accessible_button","elementId":"el_0"}</native_action>',
  });
  expect(afterRestart.record?.status).toBe("interrupted");
  expect(pendingEnv.stats.presses).toBe(0);
});

test("revocation marks grant revoked and prevents subsequent consumption", async () => {
  const env = await grantedFixture(headTarget);
  const revoked = env.grants.revoke(headTarget, env.grant.grantId);
  expect(revoked.ok && revoked.value.revoked).toBe(true);
  const fetched = env.grants.get(headTarget, env.grant.grantId);
  expect(fetched.ok && fetched.value.status).toBe("revoked");

  const consumeAttempt = env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", env.live);
  expect(!consumeAttempt.ok && consumeAttempt.error).toContain("not valid any more");
});

test("scroll and tab actions execute once per turn and reject duplicate or ineligible operations", async () => {
  const elements = [
    {
      path: "0",
      role: "AXScrollArea",
      subrole: "",
      identifier: "content-scroll",
      label: "Content Area",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsScroll: true,
    },
    {
      path: "1",
      role: "AXTabGroup",
      subrole: "",
      identifier: "tabs",
      label: "Tabs",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
    },
    {
      path: "1/0",
      role: "AXRadioButton",
      subrole: "AXTabButton",
      parentRole: "AXTabGroup",
      inTabGroup: true,
      identifier: "tab-settings",
      label: "Settings Tab",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 2,
      valueRedacted: false,
      supportsSelectTab: true,
    },
    {
      path: "2",
      role: "AXButton",
      subrole: "",
      identifier: "disabled-btn",
      label: "Disabled Button",
      labelHash: "0123456789abcdef",
      enabled: false,
      depth: 1,
      valueRedacted: false,
      supportsPress: false,
    },
    {
      path: "3",
      role: "AXTextField",
      subrole: "",
      identifier: "name-field",
      label: "Name Field",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsSetText: true,
    },
  ];

  const env = await grantedFixture(headTarget, {
    application: fixtureApp(55, "app.forgeorbit.native-cu-target-a"),
    elements,
  });

  const scrollEl = env.observation.elements.find((e) => e.role === "AXScrollArea")!;
  const tabEl = env.observation.elements.find((e) => e.role === "AXRadioButton")!;
  const textEl = env.observation.elements.find((e) => e.role === "AXTextField")!;

  // 1. Permitted scroll action
  expect(env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", env.live).ok).toBe(true);
  const settledScroll = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: `<native_action>{"kind":"scroll_accessible_area","elementId":"${scrollEl.id}","direction":"down","increment":2}</native_action>`,
  });
  expect(settledScroll.record?.status).toBe("accepted");
  expect(settledScroll.record?.kind).toBe("scroll_accessible_area");
  expect(env.stats.scrolls).toBe(1);

  // Duplicate replay refusal on same message
  const replayScroll = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: `<native_action>{"kind":"scroll_accessible_area","elementId":"${scrollEl.id}","direction":"down","increment":2}</native_action>`,
  });
  expect(replayScroll.record?.status).toBe("accepted");
  expect(env.stats.scrolls).toBe(1); // No second execution

  // 2. Tab selection in a new granted turn
  const freshObs = await env.manager.observe(env.session.id);
  const turn2Grant = env.grants.approve(headTarget, env.session.id, freshObs);
  expect(turn2Grant.ok).toBe(true);
  if (!turn2Grant.ok) throw new Error(turn2Grant.error);
  const live2 = await env.manager.inspect(env.session.id);

  expect(env.grants.consume(headTarget, turn2Grant.value.grantId, "m2", "t2", live2).ok).toBe(true);
  const settledTab = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: turn2Grant.value.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: `<native_action>{"kind":"select_accessible_tab","elementId":"${tabEl.id}"}</native_action>`,
  });
  expect(settledTab.record?.status).toBe("accepted");
  expect(settledTab.record?.kind).toBe("select_accessible_tab");
  expect(env.stats.tabSelections).toBe(1);

  // Duplicate replay refusal for tab
  const replayTab = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: turn2Grant.value.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: `<native_action>{"kind":"select_accessible_tab","elementId":"${tabEl.id}"}</native_action>`,
  });
  expect(replayTab.record?.status).toBe("accepted");
  expect(env.stats.tabSelections).toBe(1);

  // 3. Text entry in a new granted turn
  const freshObs3 = await env.manager.observe(env.session.id);
  const turn3Grant = env.grants.approve(headTarget, env.session.id, freshObs3);
  expect(turn3Grant.ok).toBe(true);
  if (!turn3Grant.ok) throw new Error(turn3Grant.error);
  const live3 = await env.manager.inspect(env.session.id);

  expect(env.grants.consume(headTarget, turn3Grant.value.grantId, "m3", "t3", live3).ok).toBe(true);
  const settledText = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: turn3Grant.value.grantId,
    messageId: "m3",
    turnId: "t3",
    replyText: `<native_action>{"kind":"set_accessible_text","elementId":"${textEl.id}","text":"Authorized Text"}</native_action>`,
  });
  expect(settledText.record?.status).toBe("accepted");
  expect(settledText.record?.kind).toBe("set_accessible_text");
  expect(env.stats.textSets).toBe(1);

  // Duplicate replay refusal for text
  const replayText = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: turn3Grant.value.grantId,
    messageId: "m3",
    turnId: "t3",
    replyText: `<native_action>{"kind":"set_accessible_text","elementId":"${textEl.id}","text":"Authorized Text"}</native_action>`,
  });
  expect(replayText.record?.status).toBe("accepted");
  expect(env.stats.textSets).toBe(1);

  // 4. Turn without grant is ignored
  const noGrantSettled = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: null,
    messageId: "m4",
    turnId: "t4",
    replyText: `<native_action>{"kind":"select_accessible_tab","elementId":"${tabEl.id}"}</native_action>`,
  });
  expect(noGrantSettled.record?.status).toBe("ignored");
  expect(noGrantSettled.record?.reasonCode).toBe("not_authorized");
  expect(env.stats.tabSelections).toBe(1);
});

test("manager can open an accessible menu and select a menu item in separate granted turns", async () => {
  const menuElements = [
    {
      path: "menu/2",
      role: "AXMenuBarItem",
      subrole: "",
      identifier: "view-menu",
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
      identifier: "harmless-menu-item",
      label: "Harmless Action",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 3,
      valueRedacted: false,
      supportsSelectMenuItem: true,
    },
    fixtureButton(),
  ];

  const env = await grantedFixture(headTarget, { elements: menuElements });
  const menuEl = env.observation.elements.find((e) => e.role === "AXMenuBarItem")!;
  const itemEl = env.observation.elements.find((e) => e.role === "AXMenuItem")!;

  expect(menuEl.actions).toEqual(["open_accessible_menu"]);
  expect(itemEl.actions).toEqual(["select_accessible_menu_item"]);

  // Turn 1: Head of PM opens View menu
  const live1 = await env.manager.inspect(env.session.id);
  expect(env.grants.consume(headTarget, env.grant.grantId, "m1", "t1", live1).ok).toBe(true);

  const settledMenu = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: `Opening the menu.\n<native_action>{"kind":"open_accessible_menu","elementId":"${menuEl.id}"}</native_action>`,
  });
  expect(settledMenu.record?.status).toBe("accepted");
  expect(settledMenu.record?.kind).toBe("open_accessible_menu");
  expect(env.stats.menuOpens).toBe(1);

  // Duplicate replay refusal for open_accessible_menu
  const replayMenu = await settleNativeAgentAction(env.grants, env.manager, {
    target: headTarget,
    grantId: env.grant.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: `<native_action>{"kind":"open_accessible_menu","elementId":"${menuEl.id}"}</native_action>`,
  });
  expect(replayMenu.record?.status).toBe("accepted");
  expect(env.stats.menuOpens).toBe(1);

  // Turn 2: Project Manager selects menu item in a new granted turn
  const freshObs = await env.manager.observe(env.session.id);
  const turn2Grant = env.grants.approve(pmTarget, env.session.id, freshObs);
  expect(turn2Grant.ok).toBe(true);
  if (!turn2Grant.ok) throw new Error(turn2Grant.error);
  const live2 = await env.manager.inspect(env.session.id);

  expect(env.grants.consume(pmTarget, turn2Grant.value.grantId, "m2", "t2", live2).ok).toBe(true);
  const settledItem = await settleNativeAgentAction(env.grants, env.manager, {
    target: pmTarget,
    grantId: turn2Grant.value.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: `Selecting the item.\n<native_action>{"kind":"select_accessible_menu_item","elementId":"${itemEl.id}"}</native_action>`,
  });
  expect(settledItem.record?.status).toBe("accepted");
  expect(settledItem.record?.kind).toBe("select_accessible_menu_item");
  expect(env.stats.menuItemSelections).toBe(1);

  // Duplicate replay refusal for select_accessible_menu_item
  const replayItem = await settleNativeAgentAction(env.grants, env.manager, {
    target: pmTarget,
    grantId: turn2Grant.value.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: `<native_action>{"kind":"select_accessible_menu_item","elementId":"${itemEl.id}"}</native_action>`,
  });
  expect(replayItem.record?.status).toBe("accepted");
  expect(env.stats.menuItemSelections).toBe(1);
});

test("agent actions mark helper_failed as interrupted, helper_missing as refused, and block excluded window titles", async () => {
  let pressOutcome: "uncertain" | "missing" = "uncertain";
  const events: NativeJournalEvent[] = [];
  const agentEvents: Array<{ eventType: string }> = [];
  const root = mkdtempSync(path.join(tmpdir(), "fo-native-cu20-agent-"));
  const targetApp = fixtureApp();
  let windowTitle = "ForgeOrbit Native CU Fixture";
  const bridge: NativeBridge = {
    cancel() {},
    async call(req) {
      const cmd = String(req.command);
      if (cmd === "validate") return { ok: true, result: { application: targetApp, window: { windowId: 7, title: windowTitle, titleRedacted: false, width: 420, height: 160 } } };
      if (cmd === "observe") return { ok: true, result: { elements: [fixtureButton()], truncated: false, omitted: 0, title: windowTitle, titleRedacted: false } };
      if (cmd === "press-button") {
        return pressOutcome === "uncertain"
          ? { ok: false, code: "helper_failed", message: "helper crashed mid-action" }
          : { ok: false, code: "helper_missing", message: "helper binary missing" };
      }
      return { ok: true, result: { accessibility: "granted", screenRecording: "denied" } };
    },
  };
  const manager = new NativeComputerSessionManager({ root, bridge, journal: (event) => events.push(event) });
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(import.meta.dir, "migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db, undefined, (event) => agentEvents.push({ eventType: event.eventType }));

  const session = await manager.create(identityOf(targetApp), 7);
  const obs = await manager.observe(session.id);

  // 1. helper_failed -> interrupted (uncertain), never retried
  const g1 = grants.approve(headTarget, session.id, obs);
  expect(g1.ok).toBe(true);
  if (!g1.ok) throw new Error(g1.error);
  const live1 = await manager.inspect(session.id);
  expect(grants.consume(headTarget, g1.value.grantId, "m1", "t1", live1).ok).toBe(true);
  const res1 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: g1.value.grantId,
    messageId: "m1",
    turnId: "t1",
    replyText: `<native_action>{"kind":"press_accessible_button","elementId":"${obs.elements[0]!.id}"}</native_action>`,
  });
  expect(res1.record?.status).toBe("interrupted");
  expect(res1.record?.reasonCode).toBe("action_uncertain");
  expect(grants.actionOutcomeByGrantId(g1.value.grantId)?.actionStatus).toBe("interrupted");
  expect(agentEvents.some((e) => e.eventType === "native.agent.action.interrupted")).toBe(true);

  // 2. helper_missing -> refused (never ran)
  pressOutcome = "missing";
  const g2 = grants.approve(headTarget, session.id, obs);
  expect(g2.ok).toBe(true);
  if (!g2.ok) throw new Error(g2.error);
  expect(grants.consume(headTarget, g2.value.grantId, "m2", "t2", await manager.inspect(session.id)).ok).toBe(true);
  const res2 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: g2.value.grantId,
    messageId: "m2",
    turnId: "t2",
    replyText: `<native_action>{"kind":"press_accessible_button","elementId":"${obs.elements[0]!.id}"}</native_action>`,
  });
  expect(res2.record?.status).toBe("refused");
  expect(res2.record?.reasonCode).toBe("helper_missing");

  // 3. Unknown / post-restart missing session in settleNativeAgentAction refuses cleanly without throwing
  const orphanGrant = grants.approve(headTarget, session.id, obs);
  if (!orphanGrant.ok) throw new Error(orphanGrant.error);
  await manager.close(session.id);
  // Simulate cold session manager with empty memory map (post clean-close restart)
  const coldManager = new NativeComputerSessionManager({ root: mkdtempSync(path.join(tmpdir(), "fo-native-cu20-cold-")), bridge });
  const liveClosed = await coldManager.inspect(session.id).catch(() => null);
  expect(grants.consume(headTarget, orphanGrant.value.grantId, "m3", "t3", liveClosed).ok).toBe(false);

  // 4. Excluded window title produces empty allowedActions and refuses claim even if invoked directly
  windowTitle = "Authentication Security Prompt";
  const s2 = await manager.create(identityOf(targetApp), 7);
  const obsExcluded = await manager.observe(s2.id);
  const gExcluded = grants.approve(headTarget, s2.id, obsExcluded);
  expect(gExcluded.ok).toBe(true);
  if (!gExcluded.ok) throw new Error(gExcluded.error);
  expect(gExcluded.value.allowedActions).toEqual([]);
  expect(grants.consume(headTarget, gExcluded.value.grantId, "m4", "t4", await manager.inspect(s2.id)).ok).toBe(true);
  const settledExcluded = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: gExcluded.value.grantId,
    messageId: "m4",
    turnId: "t4",
    replyText: `<native_action>{"kind":"press_accessible_button","elementId":"${obsExcluded.elements[0]!.id}"}</native_action>`,
  });
  expect(settledExcluded.record?.status).toBe("refused");
  expect(settledExcluded.record?.reasonCode).toBe("action_not_permitted");
});
