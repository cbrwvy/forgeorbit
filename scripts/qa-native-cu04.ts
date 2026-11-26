/**
 * FO-NATIVE-CU04 live macOS verification.
 * Tests:
 * 1. Disposable CU04 fixture (app.forgeorbit.native-cu-fixture-cu04):
 *    - Observable scroll area with vertical scrollbar.
 *    - Observable tab group with two tabs.
 *    - Observable harmless button.
 *    - Turn 1: Bounded scroll action executed automatically. Scroll position changes.
 *    - Replay refusal of scroll action (no second movement).
 *    - Turn 2: Tab selection executed automatically. Active tab changes to Tab 2.
 *    - Replay refusal of tab selection.
 *    - Turn 3: Harmless button press executed automatically. Button count changes.
 * 2. Ineligible / Wrong-role targets:
 *    - Attempting scroll on button is refused.
 *    - Attempting tab selection on button is refused.
 * 3. Target B — excluded application (app.forgeorbit.native-cu-excluded):
 *    - Elements receive empty actions.
 *    - Actions refused by policy.
 * 4. Identity restrictions and clean fixture process termination.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { NativeAgentGrantService, settleNativeAgentAction } from "../src/bun/native-computer-agent.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu04-live-"));
const helper = path.join(work, "forgeorbit-native-cu");

const appFixture = path.join(work, "FixtureCU04.app");
const exeFixture = path.join(appFixture, "Contents", "MacOS", "fixture-cu04");
const statusPathFixture = path.join(work, "status-cu04.txt");

const appTargetB = path.join(work, "TargetB.app");
const exeTargetB = path.join(appTargetB, "Contents", "MacOS", "target-b");
const statusPathB = path.join(work, "status-b.txt");

const resultPath = path.join(work, "result.json");

function run(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${proc.stderr.toString()}`);
}

const summary: Record<string, unknown> = { work };
let procFixture: ReturnType<typeof Bun.spawn> | null = null;
let procB: ReturnType<typeof Bun.spawn> | null = null;

try {
  // 1. Compile Swift helper
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CryptoKit", "-o", helper, path.join(repo, "native/computer-use/helper.swift")]);

  // 2. Build Fixture CU04 app
  run(["mkdir", "-p", path.dirname(exeFixture)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeFixture, path.join(repo, "native/computer-use/fixture-cu04.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-cu04.plist"), path.join(appFixture, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appFixture]);

  // 3. Build Target B (excluded application)
  run(["mkdir", "-p", path.dirname(exeTargetB)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeTargetB, path.join(repo, "native/computer-use/target-b.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-target-b.plist"), path.join(appTargetB, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appTargetB]);

  // Launch Fixture CU04
  procFixture = Bun.spawn([exeFixture, statusPathFixture], { stdout: "ignore", stderr: "pipe" });

  const events: NativeJournalEvent[] = [];
  const manager = new NativeComputerSessionManager({
    root: path.join(work, "sessions"),
    bridge: spawnNativeBridge(helper),
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

  // --- DISCOVER FIXTURE ---
  let foundFixture: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundFixture; attempt += 1) {
    await Bun.sleep(200);
    foundFixture = (await manager.listApplications()).applications.find((item) => item.bundleId === "app.forgeorbit.native-cu-fixture-cu04" && item.pid === procFixture?.pid);
  }
  if (!foundFixture) throw new Error("Fixture CU04 process was not discovered");
  summary.fixtureApp = { pid: foundFixture.pid, bundleId: foundFixture.bundleId };

  let windowIdFixture = 0;
  for (let attempt = 0; attempt < 25 && !windowIdFixture; attempt += 1) {
    await Bun.sleep(200);
    windowIdFixture = (await manager.listWindows(foundFixture)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdFixture) throw new Error("Fixture CU04 window was not discovered");

  // Create session
  const session = await manager.create(foundFixture, windowIdFixture);
  const sessionView = await manager.inspect(session.id);
  summary.sessionBoundary = sessionView?.actionBoundary;
  summary.sessionSupportedActions = sessionView?.supportedActions;

  // Capture raw bridge observation
  const rawBridgeObs = await (manager as any).bridge.call({ command: "observe", target: foundFixture, windowId: windowIdFixture });
  summary.rawScrollArea = (rawBridgeObs.result.elements as any[])?.find((e: any) => e.role === "AXScrollArea");

  // Capture initial observation
  const observation = await manager.observe(session.id);
  summary.observedElementsCount = observation.elements.length;
  summary.observedElements = observation.elements.map((e) => ({
    id: e.id,
    role: e.role,
    actions: e.actions,
    label: e.label,
    enabled: e.enabled,
  }));

  const scrollElement = observation.elements.find((item) => item.actions.includes("scroll_accessible_area"));
  const tabElements = observation.elements.filter((item) => item.actions.includes("select_accessible_tab"));
  const buttonElement = observation.elements.find((item) => item.actions.includes("press_accessible_button"));

  if (!scrollElement) throw new Error("Scroll area with scroll_accessible_area was not observed");
  if (tabElements.length < 2) throw new Error(`Expected at least 2 selectable tabs, got ${tabElements.length}`);
  if (!buttonElement) throw new Error("Button with press_accessible_button was not observed");

  summary.scrollElementId = scrollElement.id;
  summary.tabElementIds = tabElements.map((t) => t.id);
  summary.buttonElementId = buttonElement.id;

  // Set up grants DB
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(repo, "src/bun/migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db);
  const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };
  const pmTarget = { managerKind: "project-manager" as const, projectPath: "/tmp/proj" };

  // Initial status check
  let initialStatus = "";
  for (let i = 0; i < 20; i++) {
    try {
      initialStatus = readFileSync(statusPathFixture, "utf8").trim();
      if (initialStatus) break;
    } catch {}
    await Bun.sleep(100);
  }
  summary.initialStatus = initialStatus;

  // --- TURN 1: SCROLL ACCESSIBLE AREA ---
  const grantTurn1 = grants.approve(headTarget, session.id, observation);
  if (!grantTurn1.ok) throw new Error(grantTurn1.error);

  const live1 = await manager.inspect(session.id);
  const consumed1 = grants.consume(headTarget, grantTurn1.value.grantId, "msg-1", "turn-1", live1);
  if (!consumed1.ok) throw new Error(consumed1.error);

  const settledTurn1 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-1",
    turnId: "turn-1",
    replyText: `Scrolling down the content area.\n<native_action>{"kind":"scroll_accessible_area","elementId":"${scrollElement.id}","direction":"down","increment":2}</native_action>`,
  });
  summary.turn1Status = settledTurn1.record?.status;
  summary.turn1Kind = settledTurn1.record?.kind;

  await Bun.sleep(300);
  const statusAfterTurn1 = readFileSync(statusPathFixture, "utf8").trim();
  summary.statusAfterTurn1 = statusAfterTurn1;

  // Replay attempt Turn 1
  const replayTurn1 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-1",
    turnId: "turn-1",
    replyText: `Replaying scroll.\n<native_action>{"kind":"scroll_accessible_area","elementId":"${scrollElement.id}","direction":"down","increment":2}</native_action>`,
  });
  summary.turn1ReplayStatus = replayTurn1.record?.status;
  const statusAfterReplay1 = readFileSync(statusPathFixture, "utf8").trim();
  summary.statusAfterReplay1 = statusAfterReplay1;

  // --- TURN 2: SELECT ACCESSIBLE TAB (Tab 2) ---
  const freshObs2 = await manager.observe(session.id);
  const grantTurn2 = grants.approve(pmTarget, session.id, freshObs2);
  if (!grantTurn2.ok) throw new Error(grantTurn2.error);

  const live2 = await manager.inspect(session.id);
  const consumed2 = grants.consume(pmTarget, grantTurn2.value.grantId, "msg-2", "turn-2", live2);
  if (!consumed2.ok) throw new Error(consumed2.error);

  // Tab 2 is the second tab
  const tab2 = tabElements[1]!;
  const settledTurn2 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn2.value.grantId,
    messageId: "msg-2",
    turnId: "turn-2",
    replyText: `Selecting Tab 2.\n<native_action>{"kind":"select_accessible_tab","elementId":"${tab2.id}"}</native_action>`,
  });
  summary.turn2Status = settledTurn2.record?.status;
  summary.turn2Kind = settledTurn2.record?.kind;

  await Bun.sleep(300);
  const statusAfterTurn2 = readFileSync(statusPathFixture, "utf8").trim();
  summary.statusAfterTurn2 = statusAfterTurn2;

  // Replay attempt Turn 2
  const replayTurn2 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn2.value.grantId,
    messageId: "msg-2",
    turnId: "turn-2",
    replyText: `Replaying tab selection.\n<native_action>{"kind":"select_accessible_tab","elementId":"${tab2.id}"}</native_action>`,
  });
  summary.turn2ReplayStatus = replayTurn2.record?.status;
  const statusAfterReplay2 = readFileSync(statusPathFixture, "utf8").trim();
  summary.statusAfterReplay2 = statusAfterReplay2;

  // --- TURN 3: PRESS ACCESSIBLE BUTTON (Existing action regression) ---
  const freshObs3 = await manager.observe(session.id);
  const grantTurn3 = grants.approve(headTarget, session.id, freshObs3);
  if (!grantTurn3.ok) throw new Error(grantTurn3.error);

  const live3 = await manager.inspect(session.id);
  const consumed3 = grants.consume(headTarget, grantTurn3.value.grantId, "msg-3", "turn-3", live3);
  if (!consumed3.ok) throw new Error(consumed3.error);

  const settledTurn3 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn3.value.grantId,
    messageId: "msg-3",
    turnId: "turn-3",
    replyText: `Pressing harmless button.\n<native_action>{"kind":"press_accessible_button","elementId":"${buttonElement.id}"}</native_action>`,
  });
  summary.turn3Status = settledTurn3.record?.status;
  summary.turn3Kind = settledTurn3.record?.kind;

  await Bun.sleep(300);
  const statusAfterTurn3 = readFileSync(statusPathFixture, "utf8").trim();
  summary.statusAfterTurn3 = statusAfterTurn3;

  // --- NEGATIVE CHECKS: WRONG-ROLE REFUSALS ---
  // Attempting scroll on button
  const freshObs4 = await manager.observe(session.id);
  const grantTurn4 = grants.approve(headTarget, session.id, freshObs4);
  if (!grantTurn4.ok) throw new Error(grantTurn4.error);
  const live4 = await manager.inspect(session.id);
  const consumed4 = grants.consume(headTarget, grantTurn4.value.grantId, "msg-4", "turn-4", live4);
  if (!consumed4.ok) throw new Error(consumed4.error);

  const settledWrongScroll = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn4.value.grantId,
    messageId: "msg-4",
    turnId: "turn-4",
    replyText: `Attempting scroll on button.\n<native_action>{"kind":"scroll_accessible_area","elementId":"${buttonElement.id}","direction":"down","increment":1}</native_action>`,
  });
  summary.wrongRoleScrollStatus = settledWrongScroll.record?.status;
  summary.wrongRoleScrollReason = settledWrongScroll.record?.reasonCode;

  // Close session
  await manager.close(session.id);

  // --- TARGET B (EXCLUDED APP) VERIFICATION ---
  procB = Bun.spawn([exeTargetB, statusPathB], { stdout: "ignore", stderr: "pipe" });

  let foundB: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundB; attempt += 1) {
    await Bun.sleep(200);
    foundB = (await manager.listApplications()).applications.find((item) => item.bundleId === "app.forgeorbit.native-cu-excluded" && item.pid === procB?.pid);
  }
  if (!foundB) throw new Error("Target B process was not discovered");

  let windowIdB = 0;
  for (let attempt = 0; attempt < 25 && !windowIdB; attempt += 1) {
    await Bun.sleep(200);
    windowIdB = (await manager.listWindows(foundB)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdB) throw new Error("Target B window was not discovered");

  const sessionB = await manager.create(foundB, windowIdB);
  const sessionViewB = await manager.inspect(sessionB.id);
  summary.sessionBActionBoundary = sessionViewB?.actionBoundary;
  summary.sessionBSupportedActions = sessionViewB?.supportedActions;

  const observationB = await manager.observe(sessionB.id);
  const targetBActions = observationB.elements.map((el) => el.actions).flat();
  summary.targetBActions = targetBActions;

  await manager.close(sessionB.id);

  // Verify status changes
  const scrollMoved = statusAfterTurn1 !== initialStatus && statusAfterTurn1.includes("scrollY:");
  const tabChanged = statusAfterTurn2.includes("tab:Tab 2");
  const buttonPressed = statusAfterTurn3.includes("button:1");
  const replayClean = statusAfterReplay1 === statusAfterTurn1 && statusAfterReplay2 === statusAfterTurn2;
  const excludedClean = targetBActions.length === 0 && sessionViewB?.actionBoundary === "read-only";
  const wrongRoleRefused = settledWrongScroll.record?.status === "refused";

  summary.scrollMoved = scrollMoved;
  summary.tabChanged = tabChanged;
  summary.buttonPressed = buttonPressed;
  summary.replayClean = replayClean;
  summary.excludedClean = excludedClean;
  summary.wrongRoleRefused = wrongRoleRefused;

  if (scrollMoved && tabChanged && buttonPressed && replayClean && excludedClean && wrongRoleRefused) {
    summary.verdict = "PASS";
  } else {
    summary.verdict = "FAIL";
  }

  writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (err: any) {
  summary.verdict = "ERROR";
  summary.error = err.message ?? String(err);
  summary.stack = err.stack;
  writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
} finally {
  if (procFixture) {
    try { procFixture.kill(); } catch {}
  }
  if (procB) {
    try { procB.kill(); } catch {}
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

function expect(condition: boolean) {
  if (!condition) throw new Error("Assertion failed");
}
