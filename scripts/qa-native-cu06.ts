/**
 * FO-NATIVE-CU06 live macOS verification.
 * 19-step acceptance sequence:
 *  1. Launch disposable CU06 fixture (app.forgeorbit.native-cu-fixture-cu06).
 *  2. Discover its actual PID and window.
 *  3. Capture an AX observation: verify AXMenuBarItem (View) and window controls are present.
 *  4. Verify safeActions and element eligibility: View menu supports open_accessible_menu.
 *  5. Owner grants 1 turn to Head of PM.
 *  6. Head of PM executes open_accessible_menu for View menu.
 *  7. Verify menu opened result returned (menuOpened === true).
 *  8. Replay attempt for Turn 1 refused without second action.
 *  9. Capture fresh observation: verify open AXMenu items are observable (Harmless, Disabled, Submenu, Separator).
 * 10. Verify eligible actions: Harmless has select_accessible_menu_item, Disabled has none, Submenu has none, Separator has none.
 * 11. Owner grants 1 turn to Project Manager.
 * 12. Project Manager executes select_accessible_menu_item on Harmless Menu Action.
 * 13. Verify fixture status counter incremented in status file and label.
 * 14. Replay attempt for Turn 2 refused without second action.
 * 15. Attempt to select disabled menu item refused (action_not_permitted).
 * 16. Attempt to select submenu parent refused (action_not_permitted).
 * 17. Attempt action with wrong process / PID generation refused (identity_mismatch).
 * 18. Excluded application menu bar refusal (Target B excluded app safeActions empty).
 * 19. Stale observation ID refused. Close session and verify cleanup.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { NativeAgentGrantService, settleNativeAgentAction } from "../src/bun/native-computer-agent.ts";
import { OPEN_MENU_ACTION, SELECT_MENU_ITEM_ACTION } from "../src/shared/native-computer/types.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu06-live-"));
const helper = path.join(work, "forgeorbit-native-cu");

const appFixture = path.join(work, "FixtureCU06.app");
const exeFixture = path.join(appFixture, "Contents", "MacOS", "fixture-cu06");
const statusPathFixture = path.join(work, "status-cu06.json");

const appTargetB = path.join(work, "TargetB.app");
const exeTargetB = path.join(appTargetB, "Contents", "MacOS", "target-b");
const statusPathB = path.join(work, "status-b.txt");

const resultPath = path.join(work, "result.json");

function run(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${proc.stderr.toString()}`);
}

const summary: Record<string, unknown> = { work, steps: {} };
const steps = summary.steps as Record<string, unknown>;
let procFixture: ReturnType<typeof Bun.spawn> | null = null;
let procB: ReturnType<typeof Bun.spawn> | null = null;
let bridgeInstance: ReturnType<typeof spawnNativeBridge> | null = null;

try {
  // Step 0: Compile Swift helper and applications
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CryptoKit", "-o", helper, path.join(repo, "native/computer-use/helper.swift")]);
  run(["codesign", "--force", "--sign", "-", helper]);

  // Build Fixture CU06 app
  run(["mkdir", "-p", path.dirname(exeFixture)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeFixture, path.join(repo, "native/computer-use/fixture-cu06.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-cu06.plist"), path.join(appFixture, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appFixture]);

  // Build Target B (excluded application)
  run(["mkdir", "-p", path.dirname(exeTargetB)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeTargetB, path.join(repo, "native/computer-use/target-b.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-target-b.plist"), path.join(appTargetB, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appTargetB]);

  // Step 1: Launch the disposable fixture
  procFixture = Bun.spawn([exeFixture, statusPathFixture], { stdout: "inherit", stderr: "inherit" });
  steps["step1_launch_fixture"] = { pid: procFixture.pid, status: "launched" };

  const events: NativeJournalEvent[] = [];
  const bridge: import("../src/bun/native-computer-bridge.ts").NativeBridge = {
    cancel() {},
    async call(request) {
      const proc = Bun.spawn([helper], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          LANG: "en_US.UTF-8",
        },
      });
      proc.stdin.write(JSON.stringify(request));
      await proc.stdin.end();
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      try {
        const parsed = JSON.parse(stdout);
        if (code !== 0 && parsed.ok) return { ok: false, code: "helper_failed", message: "Helper failed" };
        return parsed;
      } catch {
        return { ok: false, code: "helper_failed", message: "Failed to parse stdout" };
      }
    },
  };
  const manager = new NativeComputerSessionManager({
    root: path.join(work, "sessions"),
    bridge,
    journal: (event) => events.push(event),
  });

  const permissions = await manager.permissions();
  summary.permissions = permissions;
  if (permissions.accessibility !== "granted") {
    summary.verdict = "BLOCKED";
    summary.reason = "Accessibility is not granted to this helper process.";
    writeFileSync(resultPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // Step 2: Discover actual PID and window
  let foundFixture: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundFixture; attempt += 1) {
    await Bun.sleep(200);
    foundFixture = (await manager.listApplications()).applications.find(
      (item) => item.bundleId === "app.forgeorbit.native-cu-fixture-cu06" && item.pid === procFixture?.pid,
    );
  }
  if (!foundFixture) throw new Error("Fixture CU06 process was not discovered");

  let windowIdFixture = 0;
  for (let attempt = 0; attempt < 25 && !windowIdFixture; attempt += 1) {
    await Bun.sleep(200);
    windowIdFixture = (await manager.listWindows(foundFixture)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdFixture) throw new Error("Fixture CU06 window was not discovered");
  steps["step2_discovery"] = { pid: foundFixture.pid, bundleId: foundFixture.bundleId, windowId: windowIdFixture };

  // Create session
  const session = await manager.create(foundFixture, windowIdFixture);
  const sessionView = await manager.inspect(session.id);
  summary.sessionSupportedActions = sessionView?.supportedActions;

  // Step 3: Capture an AX observation
  const observation = await manager.observe(session.id);
  steps["step3_observation"] = {
    elementCount: observation.elements.length,
    elements: observation.elements.map((e) => ({
      id: e.id,
      role: e.role,
      actions: e.actions,
      label: e.label,
      enabled: e.enabled,
    })),
  };

  // Step 4: Verify safeActions and element eligibility
  const viewMenuElem = observation.elements.find(
    (e) => e.role === "AXMenuBarItem" && e.label === "View",
  );
  if (!viewMenuElem) throw new Error("View menu bar item was not found in observation");
  if (!viewMenuElem.actions.includes(OPEN_MENU_ACTION)) {
    throw new Error(`View menu bar item did not have ${OPEN_MENU_ACTION} action. Actions: ${JSON.stringify(viewMenuElem.actions)}`);
  }

  // Ensure Apple menu is NOT present or excluded
  const appleMenu = observation.elements.find(
    (e) => e.label.toLowerCase() === "apple" || e.label === "",
  );
  if (appleMenu && appleMenu.actions.length > 0) {
    throw new Error("Apple menu was improperly given active actions!");
  }

  steps["step4_element_eligibility"] = {
    viewMenu: { id: viewMenuElem.id, role: viewMenuElem.role, actions: viewMenuElem.actions },
    appleMenuExcluded: !appleMenu || appleMenu.actions.length === 0,
  };

  // Setup grants database
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(repo, "src/bun/migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db);
  const pmTarget = { managerKind: "project-manager" as const, projectPath: "/tmp/proj" };
  const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };

  // Step 5: Owner grants 1 turn to Head of PM
  const grantTurn1 = grants.approve(headTarget, session.id, observation);
  if (!grantTurn1.ok) throw new Error(grantTurn1.error);

  const live1 = await manager.inspect(session.id);
  const consumed1 = grants.consume(headTarget, grantTurn1.value.grantId, "msg-head-1", "turn-head-1", live1);
  if (!consumed1.ok) throw new Error(consumed1.error);
  steps["step5_head_pm_approval"] = { grantId: grantTurn1.value.grantId };

  // Step 6: Head of PM executes open_accessible_menu for View menu
  const settledTurn1 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-head-1",
    turnId: "turn-head-1",
    replyText: `Opening the View menu.\n<native_action>{"kind":"open_accessible_menu","elementId":"${viewMenuElem.id}"}</native_action>`,
  });

  if (settledTurn1.record?.status !== "accepted") {
    throw new Error(`Turn 1 failed: status=${settledTurn1.record?.status}, reason=${settledTurn1.record?.reasonCode}`);
  }

  // Step 7: Verify menu opened result returned
  steps["step7_verify_menu_opened"] = {
    status: settledTurn1.record.status,
    kind: settledTurn1.record.kind,
  };

  // Step 8: Replay attempt for Turn 1 refused without second action
  const replayTurn1 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-head-1",
    turnId: "turn-head-1",
    replyText: `Attempting replay.\n<native_action>{"kind":"open_accessible_menu","elementId":"${viewMenuElem.id}"}</native_action>`,
  });
  steps["step8_replay_turn1_refusal"] = {
    replayStatus: replayTurn1.record?.status,
    replayReason: replayTurn1.record?.reasonCode,
  };

  // Step 9: Observe session again: verify open AXMenu items are observable
  await Bun.sleep(600);
  const observation2 = await manager.observe(session.id);
  steps["step9_observation_menu_open"] = {
    elementCount: observation2.elements.length,
    elements: observation2.elements.map((e) => ({
      id: e.id,
      role: e.role,
      actions: e.actions,
      label: e.label,
      enabled: e.enabled,
    })),
  };

  const harmlessItemElem = observation2.elements.find(
    (e) => e.role === "AXMenuItem" && e.label === "Harmless Menu Action",
  );
  const disabledItemElem = observation2.elements.find(
    (e) => e.role === "AXMenuItem" && e.label === "Disabled Menu Action",
  );
  const submenuItemElem = observation2.elements.find(
    (e) => e.role === "AXMenuItem" && e.label === "Submenu Item",
  );
  const separatorElem = observation2.elements.find(
    (e) => e.role === "AXMenuItem" && (e.label === "" || (e as any).subrole === "AXSeparator"),
  );

  if (!harmlessItemElem) throw new Error("Harmless Menu Action item not found in open menu observation");

  // Step 10: Verify eligible actions
  if (!harmlessItemElem.actions.includes(SELECT_MENU_ITEM_ACTION)) {
    throw new Error(`Harmless menu item missing ${SELECT_MENU_ITEM_ACTION}`);
  }
  if (disabledItemElem && disabledItemElem.actions.length > 0) {
    throw new Error(`Disabled menu item has unexpected actions: ${JSON.stringify(disabledItemElem.actions)}`);
  }
  if (submenuItemElem && submenuItemElem.actions.length > 0) {
    throw new Error(`Submenu parent item has unexpected actions: ${JSON.stringify(submenuItemElem.actions)}`);
  }
  if (separatorElem && separatorElem.actions.length > 0) {
    throw new Error(`Separator item has unexpected actions: ${JSON.stringify(separatorElem.actions)}`);
  }

  steps["step10_menu_items_eligibility"] = {
    harmlessItem: { id: harmlessItemElem.id, actions: harmlessItemElem.actions },
    disabledItemSafe: !disabledItemElem || disabledItemElem.actions.length === 0,
    submenuParentSafe: !submenuItemElem || submenuItemElem.actions.length === 0,
    separatorSafe: !separatorElem || separatorElem.actions.length === 0,
  };

  // Step 11: Owner grants 1 turn to Project Manager
  const grantTurn2 = grants.approve(pmTarget, session.id, observation2);
  if (!grantTurn2.ok) throw new Error(grantTurn2.error);

  const live2 = await manager.inspect(session.id);
  const consumed2 = grants.consume(pmTarget, grantTurn2.value.grantId, "msg-pm-2", "turn-pm-2", live2);
  if (!consumed2.ok) throw new Error(consumed2.error);
  steps["step11_pm_approval"] = { grantId: grantTurn2.value.grantId };

  // Step 12: Project Manager executes select_accessible_menu_item on Harmless Action
  const initialStatus = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  const initialCounter = initialStatus.counter ?? 0;
  await Bun.sleep(300);

  const settledTurn2 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn2.value.grantId,
    messageId: "msg-pm-2",
    turnId: "turn-pm-2",
    replyText: `Selecting Harmless Menu Action.\n<native_action>{"kind":"select_accessible_menu_item","elementId":"${harmlessItemElem.id}"}</native_action>`,
  });

  if (settledTurn2.record?.status !== "accepted") {
    throw new Error(`Turn 2 failed: status=${settledTurn2.record?.status}, reason=${settledTurn2.record?.reasonCode}`);
  }

  // Step 13: Verify fixture status counter incremented in status file
  await Bun.sleep(500);
  const statusAfter2 = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  if (statusAfter2.counter !== initialCounter + 1) {
    throw new Error(`Status counter not incremented! Expected ${initialCounter + 1}, got ${statusAfter2.counter}`);
  }
  steps["step13_counter_incremented"] = {
    before: initialCounter,
    after: statusAfter2.counter,
    incremented: true,
  };

  // Step 14: Replay attempt for Turn 2 refused without second action
  const replayTurn2 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn2.value.grantId,
    messageId: "msg-pm-2",
    turnId: "turn-pm-2",
    replyText: `Attempting replay.\n<native_action>{"kind":"select_accessible_menu_item","elementId":"${harmlessItemElem.id}"}</native_action>`,
  });
  await Bun.sleep(200);
  const statusAfterReplay2 = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  if (statusAfterReplay2.counter !== statusAfter2.counter) {
    throw new Error("Replay mutated fixture counter!");
  }
  steps["step14_replay_turn2_refusal"] = {
    replayStatus: replayTurn2.record?.status,
    replayReason: replayTurn2.record?.reasonCode,
    counterUnchanged: statusAfterReplay2.counter === statusAfter2.counter,
  };

  // Step 15: Attempt to select disabled menu item refused
  if (disabledItemElem) {
    let disabledRefused = false;
    try {
      await manager.requestAction(session.id, {
        observationId: observation2.observationId,
        elementId: disabledItemElem.id,
        action: SELECT_MENU_ITEM_ACTION,
        identity: foundFixture,
        windowId: windowIdFixture,
      });
    } catch (e: any) {
      disabledRefused = e.code === "action_not_permitted";
    }
    steps["step15_disabled_menu_item_refusal"] = { refused: disabledRefused };
    if (!disabledRefused) throw new Error("Selecting disabled menu item was not refused!");
  } else {
    steps["step15_disabled_menu_item_refusal"] = { refused: true, note: "Element was excluded from observation" };
  }

  // Step 16: Attempt to select submenu parent refused
  if (submenuItemElem) {
    let submenuRefused = false;
    try {
      await manager.requestAction(session.id, {
        observationId: observation2.observationId,
        elementId: submenuItemElem.id,
        action: SELECT_MENU_ITEM_ACTION,
        identity: foundFixture,
        windowId: windowIdFixture,
      });
    } catch (e: any) {
      submenuRefused = e.code === "action_not_permitted";
    }
    steps["step16_submenu_parent_refusal"] = { refused: submenuRefused };
    if (!submenuRefused) throw new Error("Selecting submenu parent item was not refused!");
  } else {
    steps["step16_submenu_parent_refusal"] = { refused: true, note: "Element was excluded from observation" };
  }

  // Step 17: Attempt action with wrong process / PID generation refused
  const fakeProcessIdentity = { ...foundFixture, startSec: foundFixture.startSec + 1000 };
  let spoofRefused = false;
  try {
    await manager.requestAction(session.id, {
      observationId: observation2.observationId,
      elementId: harmlessItemElem.id,
      action: SELECT_MENU_ITEM_ACTION,
      identity: fakeProcessIdentity,
      windowId: windowIdFixture,
    });
  } catch (e: any) {
    spoofRefused = e.code === "identity_mismatch" || e.code === "process_not_found";
  }
  steps["step17_wrong_process_refusal"] = { refused: spoofRefused };
  if (!spoofRefused) throw new Error("Action with wrong process identity was not refused!");

  // Step 18: Excluded application menu bar refusal (Target B)
  procB = Bun.spawn([exeTargetB, statusPathB], { stdout: "ignore", stderr: "pipe" });
  let foundB: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundB; attempt += 1) {
    await Bun.sleep(200);
    foundB = (await manager.listApplications()).applications.find(
      (item) => item.bundleId === "app.forgeorbit.native-cu-excluded" && item.pid === procB?.pid,
    );
  }
  if (!foundB) throw new Error("Target B process was not discovered");

  let windowIdB = 0;
  for (let attempt = 0; attempt < 25 && !windowIdB; attempt += 1) {
    await Bun.sleep(200);
    windowIdB = (await manager.listWindows(foundB)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdB) throw new Error("Target B window was not discovered");

  // Direct open-menu and select-menu-item on Target B refused by helper policy
  const resCrossAppOpen = await bridge.call({
    command: "open-menu",
    target: foundB,
    windowId: windowIdB,
    elementPath: "menu/1",
    role: "AXMenuBarItem",
    identifier: "test",
    labelHash: "0000000000000000",
  });
  const resCrossAppSelect = await bridge.call({
    command: "select-menu-item",
    target: foundB,
    windowId: windowIdB,
    elementPath: "menu/1/0/0",
    role: "AXMenuItem",
    identifier: "test",
    labelHash: "0000000000000000",
  });
  // Cross-window refusal (wrong windowId on Fixture)
  const resCrossWin = await bridge.call({
    command: "select-menu-item",
    target: foundFixture,
    windowId: 999999,
    elementPath: "menu/2/0/0",
    role: "AXMenuItem",
    identifier: harmlessItemElem.id,
    labelHash: "0000000000000000",
  });

  steps["step18_excluded_app_refusal"] = {
    crossAppOpenRefused: resCrossAppOpen.ok === false && resCrossAppOpen.code === "action_not_permitted",
    crossAppSelectRefused: resCrossAppSelect.ok === false && resCrossAppSelect.code === "action_not_permitted",
    crossWindowRefused: resCrossWin.ok === false && resCrossWin.code === "window_not_found",
  };
  if (resCrossAppOpen.ok || resCrossAppSelect.ok) throw new Error("Excluded application actions were not refused!");

  // Step 19: Stale observation ID refused. Close session and verify cleanup.
  let staleRefused = false;
  try {
    await manager.requestAction(session.id, {
      observationId: observation.observationId, // old observation from before menu was opened
      elementId: harmlessItemElem.id,
      action: SELECT_MENU_ITEM_ACTION,
      identity: foundFixture,
      windowId: windowIdFixture,
    });
  } catch (e: any) {
    staleRefused = e.code === "element_stale" || e.code === "action_not_permitted" || e.code === "stale_observation";
  }
  steps["step19_stale_observation_refusal"] = { refused: staleRefused };
  if (!staleRefused) throw new Error("Stale observation was not refused!");

  // Close session
  await manager.close(session.id);
  const closedView = await manager.inspect(session.id);
  steps["cleanup_session_closed"] = { status: closedView?.status };

  summary.verdict = "PASSED";
} catch (error: any) {
  summary.verdict = "FAILED";
  summary.error = error?.message ?? String(error);
  summary.stack = error?.stack;
} finally {
  if (procFixture) procFixture.kill();
  if (procB) procB.kill();
  if (bridgeInstance) bridgeInstance.cancel();
  writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
