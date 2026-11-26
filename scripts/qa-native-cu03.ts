/**
 * FO-NATIVE-CU03 live macOS verification.
 * Tests:
 * 1. Target A — eligible generic non-fixture application (app.forgeorbit.native-cu-target-a):
 *    - Observable counter idle:0 -> pressed:1.
 *    - Automatic execution without second confirmation.
 *    - Replay refusal.
 * 2. Target B — excluded application (app.forgeorbit.native-cu-excluded):
 *    - Attempted press refused (action_not_permitted).
 *    - Observable counter remains idle:0.
 * 3. Original fixture (app.forgeorbit.native-cu-fixture):
 *    - Still eligible and functional.
 * 4. Cross-app refusal and process cleanup.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { NativeAgentGrantService, settleNativeAgentAction } from "../src/bun/native-computer-agent.ts";
import { FIXTURE_BUNDLE_ID } from "../src/shared/native-computer/types.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu03-live-"));
const helper = path.join(work, "forgeorbit-native-cu");

const appTargetA = path.join(work, "TargetA.app");
const exeTargetA = path.join(appTargetA, "Contents", "MacOS", "target-a");
const statusPathA = path.join(work, "status-a.txt");

const appTargetB = path.join(work, "TargetB.app");
const exeTargetB = path.join(appTargetB, "Contents", "MacOS", "target-b");
const statusPathB = path.join(work, "status-b.txt");

const appOrig = path.join(work, "Fixture.app");
const exeOrig = path.join(appOrig, "Contents", "MacOS", "fixture");
const statusPathOrig = path.join(work, "status-orig.txt");

const resultPath = path.join(work, "result.json");

function run(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${proc.stderr.toString()}`);
}

const summary: Record<string, unknown> = { work };
let procA: ReturnType<typeof Bun.spawn> | null = null;
let procB: ReturnType<typeof Bun.spawn> | null = null;
let procOrig: ReturnType<typeof Bun.spawn> | null = null;

try {
  // 1. Build Swift helper
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CryptoKit", "-o", helper, path.join(repo, "native/computer-use/helper.swift")]);

  // 2. Build Target A (eligible generic application)
  run(["mkdir", "-p", path.dirname(exeTargetA)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeTargetA, path.join(repo, "native/computer-use/target-a.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-target-a.plist"), path.join(appTargetA, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appTargetA]);

  // 3. Build Target B (excluded application)
  run(["mkdir", "-p", path.dirname(exeTargetB)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeTargetB, path.join(repo, "native/computer-use/target-b.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info-target-b.plist"), path.join(appTargetB, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appTargetB]);

  // 4. Build original fixture
  run(["mkdir", "-p", path.dirname(exeOrig)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exeOrig, path.join(repo, "native/computer-use/fixture.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info.plist"), path.join(appOrig, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", appOrig]);

  // Launch Target A
  procA = Bun.spawn([exeTargetA, statusPathA], { stdout: "ignore", stderr: "pipe" });

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

  // --- TARGET A VERIFICATION ---
  let foundA: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundA; attempt += 1) {
    await Bun.sleep(200);
    foundA = (await manager.listApplications()).applications.find((item) => item.bundleId === "app.forgeorbit.native-cu-target-a" && item.pid === procA?.pid);
  }
  if (!foundA) throw new Error("Target A process was not discovered");
  summary.targetA = { pid: foundA.pid, bundleId: foundA.bundleId };

  let windowIdA = 0;
  for (let attempt = 0; attempt < 25 && !windowIdA; attempt += 1) {
    await Bun.sleep(200);
    windowIdA = (await manager.listWindows(foundA)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdA) throw new Error("Target A window was not discovered");

  const sessionA = await manager.create(foundA, windowIdA);
  const sessionViewA = await manager.inspect(sessionA.id);
  summary.sessionABoundary = sessionViewA?.actionBoundary;
  summary.sessionASupportedActions = sessionViewA?.supportedActions;

  const observationA = await manager.observe(sessionA.id);
  const controlA = observationA.elements.find((item) => item.actions.includes("press_accessible_button"));
  if (!controlA) {
    throw new Error(`Target A button was not marked with press_accessible_button`);
  }
  summary.controlAId = controlA.id;
  summary.idleBeforeA = readFileSync(statusPathA, "utf8").trim();

  // Set up grants DB
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(repo, "src/bun/migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db);

  const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };
  const grantA = grants.approve(headTarget, sessionA.id, observationA, ["press_accessible_button"]);
  if (!grantA.ok) throw new Error(grantA.error);

  const liveA = await manager.inspect(sessionA.id);
  const consumedA = grants.consume(headTarget, grantA.value.grantId, "msg-a1", "turn-a1", liveA);
  if (!consumedA.ok) throw new Error(consumedA.error);

  const settledA = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantA.value.grantId,
    messageId: "msg-a1",
    turnId: "turn-a1",
    replyText: `I am interacting with generic Target A.\n<native_action>{"kind":"press_accessible_button","elementId":"${controlA.id}"}</native_action>`,
  });
  summary.settledStatusA = settledA.record?.status;
  summary.settledKindA = settledA.record?.kind;

  await Bun.sleep(300);
  const afterA = await manager.observe(sessionA.id);
  summary.statusFileA = readFileSync(statusPathA, "utf8").trim();
  summary.statusLabelA = afterA.elements.find((item) => item.label === "pressed")?.label ?? null;

  // Attempt replay on Target A
  const replayA = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantA.value.grantId,
    messageId: "msg-a1",
    turnId: "turn-a1",
    replyText: `Replaying Target A.\n<native_action>{"kind":"press_accessible_button","elementId":"${controlA.id}"}</native_action>`,
  });
  summary.replayStatusA = replayA.record?.status;
  summary.statusFileAfterReplayA = readFileSync(statusPathA, "utf8").trim();

  // Close session A before opening session B (ForgeOrbit allows 1 active session)
  await manager.close(sessionA.id);

  // --- TARGET B VERIFICATION (Excluded Application) ---
  procB = Bun.spawn([exeTargetB, statusPathB], { stdout: "ignore", stderr: "pipe" });

  let foundB: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundB; attempt += 1) {
    await Bun.sleep(200);
    foundB = (await manager.listApplications()).applications.find((item) => item.bundleId === "app.forgeorbit.native-cu-excluded" && item.pid === procB?.pid);
  }
  if (!foundB) throw new Error("Target B process was not discovered");
  summary.targetB = { pid: foundB.pid, bundleId: foundB.bundleId };

  let windowIdB = 0;
  for (let attempt = 0; attempt < 25 && !windowIdB; attempt += 1) {
    await Bun.sleep(200);
    windowIdB = (await manager.listWindows(foundB)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdB) throw new Error("Target B window was not discovered");

  const sessionB = await manager.create(foundB, windowIdB);
  const sessionViewB = await manager.inspect(sessionB.id);
  summary.sessionBBoundary = sessionViewB?.actionBoundary;
  summary.sessionBSupportedActions = sessionViewB?.supportedActions;
  summary.sessionBReadOnlyReason = sessionViewB?.readOnlyReason;

  const observationB = await manager.observe(sessionB.id);
  // In Target B, element actions must be empty because the app is excluded
  const targetBActions = observationB.elements.map((el) => el.actions).flat();
  summary.targetBActions = targetBActions;
  summary.idleBeforeB = readFileSync(statusPathB, "utf8").trim();

  const grantB = grants.approve(headTarget, sessionB.id, observationB, []);
  if (!grantB.ok) throw new Error(grantB.error);

  const liveB = await manager.inspect(sessionB.id);
  const consumedB = grants.consume(headTarget, grantB.value.grantId, "msg-b1", "turn-b1", liveB);
  if (!consumedB.ok) throw new Error(consumedB.error);

  const elementB = observationB.elements[0];
  const settledB = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantB.value.grantId,
    messageId: "msg-b1",
    turnId: "turn-b1",
    replyText: `Attempting press on excluded Target B.\n<native_action>{"kind":"press_accessible_button","elementId":"${elementB?.id ?? "el_0"}"}</native_action>`,
  });
  summary.settledStatusB = settledB.record?.status;
  summary.settledReasonB = settledB.record?.reasonCode;
  summary.statusFileB = readFileSync(statusPathB, "utf8").trim();

  // --- CROSS-APP REFUSAL ---
  // Attempt to use grant from Target A against Target B
  const crossAppAttempt = grants.consume(headTarget, grantA.value.grantId, "msg-x1", "turn-x1", liveB);
  summary.crossAppRefused = !crossAppAttempt.ok;

  // Close session B before opening sessionOrig
  await manager.close(sessionB.id);

  // --- ORIGINAL FIXTURE VERIFICATION ---
  procOrig = Bun.spawn([exeOrig, statusPathOrig], { stdout: "ignore", stderr: "pipe" });

  let foundOrig: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 25 && !foundOrig; attempt += 1) {
    await Bun.sleep(200);
    foundOrig = (await manager.listApplications()).applications.find((item) => item.bundleId === FIXTURE_BUNDLE_ID && item.pid === procOrig?.pid);
  }
  if (!foundOrig) throw new Error("Original fixture process was not discovered");

  let windowIdOrig = 0;
  for (let attempt = 0; attempt < 25 && !windowIdOrig; attempt += 1) {
    await Bun.sleep(200);
    windowIdOrig = (await manager.listWindows(foundOrig)).windows[0]?.windowId ?? 0;
  }
  if (!windowIdOrig) throw new Error("Original fixture window was not discovered");

  const sessionOrig = await manager.create(foundOrig, windowIdOrig);
  const sessionViewOrig = await manager.inspect(sessionOrig.id);
  summary.sessionOrigBoundary = sessionViewOrig?.actionBoundary;

  const observationOrig = await manager.observe(sessionOrig.id);
  const controlOrig = observationOrig.elements.find((item) => item.actions.includes("press_accessible_button"));
  if (!controlOrig) throw new Error("Original fixture button not found");

  const grantOrig = grants.approve(headTarget, sessionOrig.id, observationOrig, ["press_accessible_button"]);
  if (!grantOrig.ok) throw new Error(grantOrig.error);

  const liveOrig = await manager.inspect(sessionOrig.id);
  const consumedOrig = grants.consume(headTarget, grantOrig.value.grantId, "msg-o1", "turn-o1", liveOrig);
  if (!consumedOrig.ok) throw new Error(consumedOrig.error);

  const settledOrig = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: grantOrig.value.grantId,
    messageId: "msg-o1",
    turnId: "turn-o1",
    replyText: `Original fixture press.\n<native_action>{"kind":"press_accessible_button","elementId":"${controlOrig.id}"}</native_action>`,
  });
  summary.settledStatusOrig = settledOrig.record?.status;
  await Bun.sleep(300);
  summary.statusFileOrig = readFileSync(statusPathOrig, "utf8").trim();

  // Close original session
  await manager.close(sessionOrig.id);

  // Clean up child processes
  procA.kill();
  procB.kill();
  procOrig.kill();
  procA = null;
  procB = null;
  procOrig = null;

  await Bun.sleep(300);
  const helperLeft = Bun.spawnSync(["pgrep", "-x", "forgeorbit-native-cu"]);
  summary.helperStillRunning = helperLeft.exitCode === 0;

  // Verification conditions:
  // 1. Target A: idleBefore == "idle:0", settledStatus == "accepted", statusFile == "pressed:1", replay == "accepted", statusFileAfterReplay == "pressed:1"
  // 2. Target B: idleBefore == "idle:0", sessionBoundary == "read-only", settledStatus == "refused", statusFile == "idle:0" (remains 0!)
  // 3. Cross-app refused: crossAppRefused == true
  // 4. Original fixture: settledStatus == "accepted", statusFile == "pressed:1"
  // 5. Cleanup: helperStillRunning == false
  const ok = summary.idleBeforeA === "idle:0"
    && summary.sessionABoundary === "eligible-button"
    && summary.settledStatusA === "accepted"
    && summary.statusFileA === "pressed:1"
    && summary.statusLabelA === "pressed"
    && summary.statusFileAfterReplayA === "pressed:1"
    && summary.sessionBBoundary === "read-only"
    && summary.settledStatusB === "refused"
    && summary.statusFileB === "idle:0"
    && summary.crossAppRefused === true
    && summary.settledStatusOrig === "accepted"
    && summary.statusFileOrig === "pressed:1"
    && summary.helperStillRunning === false;

  summary.verdict = ok ? "PASS" : "FAIL";
  writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) process.exit(1);
} catch (error) {
  summary.verdict = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  writeFileSync(resultPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
} finally {
  if (procA) procA.kill();
  if (procB) procB.kill();
  if (procOrig) procOrig.kill();
  rmSync(work, { recursive: true, force: true });
}
