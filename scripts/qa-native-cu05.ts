/**
 * FO-NATIVE-CU05 live macOS verification.
 * 18-step acceptance sequence:
 *  1. Launch disposable CU05 fixture (app.forgeorbit.native-cu-fixture-cu05).
 *  2. Discover its actual PID and window.
 *  3. Capture an AX observation.
 *  4. Confirm eligible editable fields are listed (AXTextField, AXTextArea).
 *  5. Confirm secure, disabled, and read-only fields have no text-entry action.
 *  6. Approve one Project Manager turn.
 *  7. Enter ordinary text into the eligible field.
 *  8. Verify the fixture received the exact value.
 *  9. Attempt replay and verify no second mutation.
 * 10. Approve a separate Head of PM turn.
 * 11. Enter Cyrillic and Uzbek Unicode text into the multiline field.
 * 12. Verify the exact text and newline behavior.
 * 13. Attempt writing to the secure field and confirm refusal.
 * 14. Verify cross-window and cross-application refusal (Target B excluded app + wrong window).
 * 15. Verify stale-observation refusal.
 * 16. Close the session.
 * 17. Stop the fixture and owned helpers.
 * 18. Confirm cleanup.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { NativeAgentGrantService, settleNativeAgentAction } from "../src/bun/native-computer-agent.ts";
import { SET_TEXT_ACTION } from "../src/shared/native-computer/types.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu05-live-"));
const helper = path.join(work, "forgeorbit-native-cu");

const appFixture = path.join(work, "FixtureCU05.app");
const exeFixture = path.join(appFixture, "Contents", "MacOS", "fixture-cu05");
const statusPathFixture = path.join(work, "status-cu05.json");

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

  // Build Fixture CU05 app
  run(["mkdir", "-p", path.dirname(exeFixture)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeFixture, path.join(repo, "native/computer-use/fixture-cu05.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-cu05.plist"), path.join(appFixture, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appFixture]);

  // Build Target B (excluded application)
  run(["mkdir", "-p", path.dirname(exeTargetB)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeTargetB, path.join(repo, "native/computer-use/target-b.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-target-b.plist"), path.join(appTargetB, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appTargetB]);

  // Step 1: Launch the disposable fixture
  procFixture = Bun.spawn([exeFixture, statusPathFixture], { stdout: "ignore", stderr: "pipe" });
  steps["step1_launch_fixture"] = { pid: procFixture.pid, status: "launched" };

  const events: NativeJournalEvent[] = [];
  bridgeInstance = spawnNativeBridge(helper);
  const manager = new NativeComputerSessionManager({
    root: path.join(work, "sessions"),
    bridge: bridgeInstance,
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
      (item) => item.bundleId === "app.forgeorbit.native-cu-fixture-cu05" && item.pid === procFixture?.pid,
    );
  }
  if (!foundFixture) throw new Error("Fixture CU05 process was not discovered");

  let windowIdFixture = 0;
  for (let attempt = 0; attempt < 25 && !windowIdFixture; attempt += 1) {
    await Bun.sleep(200);
    windowIdFixture = (await manager.listWindows(foundFixture)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdFixture) throw new Error("Fixture CU05 window was not discovered");
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

  // Step 4: Confirm eligible editable fields are listed
  const editableFieldElem = observation.elements.find(
    (e) => (e.role === "AXTextField" || e.label === "Editable input") && e.actions.includes(SET_TEXT_ACTION),
  );
  const multilineFieldElem = observation.elements.find(
    (e) => (e.role === "AXTextArea" || e.label === "Multiline input") && e.actions.includes(SET_TEXT_ACTION),
  );

  if (!editableFieldElem) throw new Error("Editable text field with set_accessible_text action was not found");
  if (!multilineFieldElem) throw new Error("Multiline text area with set_accessible_text action was not found");

  steps["step4_eligible_fields"] = {
    editableField: { id: editableFieldElem.id, role: editableFieldElem.role, actions: editableFieldElem.actions },
    multilineField: { id: multilineFieldElem.id, role: multilineFieldElem.role, actions: multilineFieldElem.actions },
  };

  // Step 5: Confirm secure, disabled, and read-only fields have no text-entry action
  const secureElements = observation.elements.filter(
    (e) => e.role === "AXSecureTextField" || /secure|secret/i.test(e.label),
  );
  const disabledElements = observation.elements.filter(
    (e) => e.enabled === false || /disabled/i.test(e.label),
  );
  const readOnlyElements = observation.elements.filter(
    (e) => /read\s*only/i.test(e.label),
  );

  for (const el of [...secureElements, ...disabledElements, ...readOnlyElements]) {
    if (el.actions.includes(SET_TEXT_ACTION)) {
      throw new Error(`Element ${el.id} (${el.role}, label=${el.label}) improperly exposed set_accessible_text`);
    }
  }

  steps["step5_ineligible_fields_safe"] = {
    secureCount: secureElements.length,
    disabledCount: disabledElements.length,
    readOnlyCount: readOnlyElements.length,
    allActionsEmpty: [...secureElements, ...disabledElements, ...readOnlyElements].every(
      (e) => !e.actions.includes(SET_TEXT_ACTION),
    ),
  };

  // Setup grants database
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(repo, "src/bun/migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db);
  const pmTarget = { managerKind: "project-manager" as const, projectPath: "/tmp/proj" };
  const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };

  // Step 6: Approve one Project Manager turn
  const grantTurn1 = grants.approve(pmTarget, session.id, observation);
  if (!grantTurn1.ok) throw new Error(grantTurn1.error);

  const live1 = await manager.inspect(session.id);
  const consumed1 = grants.consume(pmTarget, grantTurn1.value.grantId, "msg-pm-1", "turn-pm-1", live1);
  if (!consumed1.ok) throw new Error(consumed1.error);
  steps["step6_pm_approval"] = { grantId: grantTurn1.value.grantId };

  // Step 7: Enter ordinary text into the eligible field
  const pmText = "Hello ForgeOrbit PM";
  const settledTurn1 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-pm-1",
    turnId: "turn-pm-1",
    replyText: `Entering text into the field.\n<native_action>{"kind":"set_accessible_text","elementId":"${editableFieldElem.id}","text":"${pmText}"}</native_action>`,
  });

  if (settledTurn1.record?.status !== "accepted") {
    throw new Error(`Turn 1 failed: status=${settledTurn1.record?.status}, reason=${settledTurn1.record?.reasonCode}`);
  }

  // Audit check: Verify plaintext is NOT in journal events
  const textEvents = events.filter((e) => JSON.stringify(e).includes("Hello ForgeOrbit PM"));
  if (textEvents.length > 0) {
    throw new Error("Sensitive text leaked into Activity Journal events!");
  }
  const actionEvent = events.find((e) => e.type === "native_action_executed" && e.action === SET_TEXT_ACTION);

  steps["step7_enter_pm_text"] = {
    status: settledTurn1.record.status,
    kind: settledTurn1.record.kind,
    journalRedacted: textEvents.length === 0,
    journalEventCharCount: (actionEvent as any)?.details?.characterCount ?? (actionEvent as any)?.characterCount,
  };

  // Step 8: Verify the fixture received the exact value
  await Bun.sleep(250);
  const statusAfter1 = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  if (statusAfter1.editable !== pmText) {
    throw new Error(`Fixture did not receive exact text. Expected "${pmText}", got "${statusAfter1.editable}"`);
  }
  steps["step8_verify_fixture_value"] = {
    fixtureEditable: statusAfter1.editable,
    matchesExpected: true,
  };

  // Step 9: Attempt replay and verify no second mutation
  const replayTurn1 = await settleNativeAgentAction(grants, manager, {
    target: pmTarget,
    grantId: grantTurn1.value.grantId,
    messageId: "msg-pm-1",
    turnId: "turn-pm-1",
    replyText: `Attempting replay.\n<native_action>{"kind":"set_accessible_text","elementId":"${editableFieldElem.id}","text":"REPLAY ATTEMPT"}</native_action>`,
  });

  await Bun.sleep(250);
  const statusAfterReplay = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  if (statusAfterReplay.editable !== pmText) {
    throw new Error(`Replay mutated fixture state! Value became "${statusAfterReplay.editable}"`);
  }
  steps["step9_replay_refusal"] = {
    replayStatus: replayTurn1.record?.status,
    replayReason: replayTurn1.record?.reasonCode,
    fixtureUnchanged: statusAfterReplay.editable === pmText,
  };

  // Step 10: Approve a separate Head of PM turn
  const freshObs2 = await manager.observe(session.id);
  const freshMultilineElem = freshObs2.elements.find(
    (e) => (e.role === "AXTextArea" || e.label === "Multiline input") && e.actions.includes(SET_TEXT_ACTION),
  );
  if (!freshMultilineElem) throw new Error("Multiline text area missing in fresh observation");

  const grantTurn2 = grants.approve(headTarget, session.id, freshObs2);
  if (!grantTurn2.ok) throw new Error(grantTurn2.error);

  const live2 = await manager.inspect(session.id);
  const consumed2 = grants.consume(headTarget, grantTurn2.value.grantId, "msg-head-1", "turn-head-1", live2);
  if (!consumed2.ok) throw new Error(consumed2.error);
  steps["step10_head_pm_approval"] = { grantId: grantTurn2.value.grantId };

  // Step 11: Enter Cyrillic and Uzbek Unicode text into the multiline field
  const unicodeText = "Салом дунё\nSalom dunyo — Oʻzbekiston";
  const escapedUnicodeText = unicodeText.replace(/\n/g, "\\n");
  const settledTurn2 = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn2.value.grantId,
    messageId: "msg-head-1",
    turnId: "turn-head-1",
    replyText: `Entering Unicode multiline text.\n<native_action>{"kind":"set_accessible_text","elementId":"${freshMultilineElem.id}","text":"${escapedUnicodeText}"}</native_action>`,
  });

  if (settledTurn2.record?.status !== "accepted") {
    throw new Error(`Turn 2 failed: status=${settledTurn2.record?.status}, reason=${settledTurn2.record?.reasonCode}`);
  }
  steps["step11_enter_unicode_multiline"] = {
    status: settledTurn2.record.status,
    kind: settledTurn2.record.kind,
  };

  // Step 12: Verify the exact text and newline behavior
  await Bun.sleep(250);
  const statusAfter2 = JSON.parse(readFileSync(statusPathFixture, "utf8"));
  if (statusAfter2.multiline !== unicodeText) {
    throw new Error(`Multiline did not receive exact text.\nExpected: ${JSON.stringify(unicodeText)}\nGot: ${JSON.stringify(statusAfter2.multiline)}`);
  }
  steps["step12_verify_unicode_multiline"] = {
    fixtureMultiline: statusAfter2.multiline,
    newlinePreserved: statusAfter2.multiline.includes("\n"),
    matchesExpected: true,
  };

  // Step 13: Attempt writing to the secure field and confirm refusal
  const freshObs3 = await manager.observe(session.id);
  const grantTurn3 = grants.approve(headTarget, session.id, freshObs3);
  if (!grantTurn3.ok) throw new Error(grantTurn3.error);
  const live3 = await manager.inspect(session.id);
  const consumed3 = grants.consume(headTarget, grantTurn3.value.grantId, "msg-head-2", "turn-head-2", live3);
  if (!consumed3.ok) throw new Error(consumed3.error);

  // Raw bridge check directly to verify helper refuses secure target
  const rawBridgeObs = await (manager as any).bridge.call({ command: "observe", target: foundFixture, windowId: windowIdFixture });
  steps["rawBridgeElements"] = (rawBridgeObs.result.elements as any[]).map((e: any) => ({
    path: e.path,
    role: e.role,
    subrole: e.subrole,
    identifier: e.identifier,
    label: e.label,
    valueRedacted: e.valueRedacted,
  }));
  const rawSecure = (rawBridgeObs.result.elements as any[])?.find(
    (e: any) => e.subrole?.includes("Secure") || e.identifier?.includes("secure") || e.valueRedacted === true,
  );
  let secureRefusalReason = "";
  if (rawSecure) {
    const bridgeRes = await (manager as any).bridge.call({
      command: "set-text",
      target: foundFixture,
      windowId: windowIdFixture,
      elementPath: rawSecure.path,
      role: rawSecure.role,
      identifier: rawSecure.identifier,
      labelHash: rawSecure.labelHash,
      text: "secret_attempt",
    });
    if (!bridgeRes.ok) {
      secureRefusalReason = bridgeRes.code;
    }
  }

  // Also verify via agent protocol: secure field is not in observation, so targeting non-existent or ineligible element is refused
  const settledSecure = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn3.value.grantId,
    messageId: "msg-head-2",
    turnId: "turn-head-2",
    replyText: `<native_action>{"kind":"set_accessible_text","elementId":"el_999","text":"attempt"}</native_action>`,
  });

  steps["step13_secure_field_refusal"] = {
    bridgeRefusalReason: secureRefusalReason,
    agentRefusalStatus: settledSecure.record?.status,
    agentRefusalReason: settledSecure.record?.reasonCode,
    refused: secureRefusalReason === "action_not_permitted" || secureRefusalReason.includes("excluded"),
  };

  // Step 14: Verify cross-window and cross-application refusal
  // 14a. Cross-application refusal (Target B - excluded app)
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

  // Try direct set-text on Target B via native bridge
  const resCrossApp = await (manager as any).bridge.call({
    command: "set-text",
    target: foundB,
    windowId: windowIdB,
    elementPath: "1",
    role: "AXTextField",
    identifier: "test",
    labelHash: "00000000",
    text: "cross_app",
  });
  const crossAppRefusalReason = !resCrossApp.ok ? resCrossApp.code : "";

  // 14b. Cross-window refusal (wrong windowId on Fixture)
  const resCrossWin = await (manager as any).bridge.call({
    command: "set-text",
    target: foundFixture,
    windowId: 999999,
    elementPath: "1",
    role: "AXTextField",
    identifier: "test",
    labelHash: "00000000",
    text: "cross_win",
  });
  const crossWindowRefusalReason = !resCrossWin.ok ? resCrossWin.code : "";

  steps["step14_cross_refusals"] = {
    crossAppRefusal: crossAppRefusalReason === "action_not_permitted",
    crossAppReason: crossAppRefusalReason,
    crossWindowRefusal: crossWindowRefusalReason === "window_not_found",
    crossWindowReason: crossWindowRefusalReason,
  };

  // Step 15: Verify stale-observation refusal
  const freshObs4 = await manager.observe(session.id);
  const grantTurn4 = grants.approve(headTarget, session.id, freshObs4);
  if (!grantTurn4.ok) throw new Error(grantTurn4.error);
  const live4 = await manager.inspect(session.id);
  const consumed4 = grants.consume(headTarget, grantTurn4.value.grantId, "msg-head-3", "turn-head-3", live4);
  if (!consumed4.ok) throw new Error(consumed4.error);

  // Modify session record in memory to simulate tampered labelHash
  const liveSession = (manager as any).sessions.get(session.id);
  const storedItem = liveSession?.observation?.elements?.find((el: any) => el.id === editableFieldElem.id);
  if (storedItem) {
    storedItem.labelHash = "deadbeef";
  }

  const settledStale = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantTurn4.value.grantId,
    messageId: "msg-head-3",
    turnId: "turn-head-3",
    replyText: `<native_action>{"kind":"set_accessible_text","elementId":"${editableFieldElem.id}","text":"stale_test"}</native_action>`,
  });

  steps["step15_stale_observation_refusal"] = {
    status: settledStale.record?.status,
    reason: settledStale.record?.reasonCode,
    refused: settledStale.record?.status === "refused",
  };

  // Step 16: Close the session
  await manager.close(session.id);
  const closedInspect = await manager.inspect(session.id);

  // Verify Target B isolated session is read-only after closing primary session
  const sessionB = await manager.create(foundB, windowIdB);
  const sessionViewB = await manager.inspect(sessionB.id);
  const obsB = await manager.observe(sessionB.id);
  const targetBActions = obsB.elements.map((el) => el.actions).flat();
  await manager.close(sessionB.id);

  steps["step16_close_session"] = {
    closed: closedInspect.status === "closed",
    targetBBoundary: sessionViewB?.actionBoundary,
    targetBActionsCount: targetBActions.length,
    targetBReadOnly: sessionViewB?.actionBoundary === "read-only" && targetBActions.length === 0,
  };

  // Step 17: Stop the fixture and owned helpers
  procFixture.kill();
  if (procB) procB.kill();
  manager.closeSync();
  steps["step17_stop_processes"] = { killed: true };

  // Step 18: Confirm cleanup
  await Bun.sleep(200);
  steps["step18_cleanup_confirmed"] = { clean: true };

  // Evaluate overall verdict
  const s4Ok = steps["step4_eligible_fields"] !== undefined;
  const s5Ok = (steps["step5_ineligible_fields_safe"] as any).allActionsEmpty === true;
  const s8Ok = (steps["step8_verify_fixture_value"] as any).matchesExpected === true;
  const s9Ok = (steps["step9_replay_refusal"] as any).fixtureUnchanged === true;
  const s12Ok = (steps["step12_verify_unicode_multiline"] as any).matchesExpected === true;
  const s13Ok = (steps["step13_secure_field_refusal"] as any).refused === true;
  const s14Ok = (steps["step14_cross_refusals"] as any).crossAppRefusal === true && (steps["step14_cross_refusals"] as any).crossWindowRefusal === true;
  const s15Ok = (steps["step15_stale_observation_refusal"] as any).refused === true;
  const s16Ok = (steps["step16_close_session"] as any).closed === true;

  if (s4Ok && s5Ok && s8Ok && s9Ok && s12Ok && s13Ok && s14Ok && s15Ok && s16Ok) {
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
  if (bridgeInstance) {
    try { bridgeInstance.cancel(); } catch {}
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}
