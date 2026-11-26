/**
 * FO-NATIVE-CU02 live macOS check.
 * Builds a disposable fixture, creates a native session, authorizes an agent grant,
 * executes one structured button-press action through settleNativeAgentAction automatically,
 * observes the real idle:0 -> pressed:1 transition, verifies replay refusal, and closes cleanly.
 * Does not touch the Owner's applications except to discover the fixture process.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { NativeAgentGrantService, settleNativeAgentAction } from "../src/bun/native-computer-agent.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID } from "../src/shared/native-computer/types.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu02-live-"));
const helper = path.join(work, "forgeorbit-native-cu");
const app = path.join(work, "ForgeOrbitNativeCuFixture.app");
const exe = path.join(app, "Contents", "MacOS", "fixture");
const statusPath = path.join(work, "status.txt");
const resultPath = path.join(work, "result.json");

function run(cmd: string[]) {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}\n${proc.stderr.toString()}`);
}

const summary: Record<string, unknown> = { work };
let fixture: ReturnType<typeof Bun.spawn> | null = null;
try {
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CryptoKit", "-o", helper, path.join(repo, "native/computer-use/helper.swift")]);
  run(["mkdir", "-p", path.dirname(exe)]);
  run(["xcrun", "swiftc", "-O", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-o", exe, path.join(repo, "native/computer-use/fixture.swift")]);
  run(["cp", path.join(repo, "native/computer-use/Info.plist"), path.join(app, "Contents", "Info.plist")]);
  run(["codesign", "--force", "--sign", "-", app]);
  fixture = Bun.spawn([exe, statusPath], { stdout: "ignore", stderr: "pipe" });

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

  let found: Awaited<ReturnType<typeof manager.listApplications>>["applications"][number] | undefined;
  for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
    await Bun.sleep(250);
    found = (await manager.listApplications()).applications.find((item) => item.bundleId === FIXTURE_BUNDLE_ID && item.pid === fixture?.pid);
  }
  if (!found) throw new Error("fixture process was not discovered");
  summary.pid = found.pid;
  summary.executable = found.executablePath;

  let windowId = 0;
  for (let attempt = 0; attempt < 20 && !windowId; attempt += 1) {
    await Bun.sleep(250);
    windowId = (await manager.listWindows(found)).windows[0]?.windowId ?? 0;
  }
  if (!windowId) throw new Error("fixture window was not discovered");
  summary.windowId = windowId;

  const session = await manager.create(found, windowId);
  const observation = await manager.observe(session.id);
  const control = observation.elements.find((item) => item.actions.includes("press_accessible_button"));
  if (!control) {
    const seen = observation.elements.map((item) => `${item.id}:${item.role}:${item.label}:${item.actions.join("|")}`).join(" | ");
    throw new Error(`fixture button missing: ${seen}`);
  }
  summary.elementId = control.id;
  summary.idleBefore = readFileSync(statusPath, "utf8").trim();

  // Set up grants database
  const db = new Database(":memory:");
  db.exec(readFileSync(path.join(repo, "src/bun/migrations/119_native_computer_agent_grants.sql"), "utf8"));
  const grants = new NativeAgentGrantService(db);

  const headTarget = { managerKind: "head-of-pm" as const, projectPath: null };
  const approved = grants.approve(headTarget, session.id, observation, ["press_accessible_button"]);
  if (!approved.ok) throw new Error(approved.error);
  summary.grantId = approved.value.grantId;

  const live = await manager.inspect(session.id);
  const consumed = grants.consume(headTarget, approved.value.grantId, "msg-1", "turn-1", live);
  if (!consumed.ok) throw new Error(consumed.error);

  // Settle action: Agent proposes press_accessible_button
  const settled = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: approved.value.grantId,
    messageId: "msg-1",
    turnId: "turn-1",
    replyText: `I reviewed the fixture app and will press the button.\n<native_action>{"kind":"press_accessible_button","elementId":"${control.id}"}</native_action>`,
  });
  summary.settledStatus = settled.record?.status;
  summary.settledKind = settled.record?.kind;
  summary.settledElementId = settled.record?.elementId;

  await Bun.sleep(300);
  const after = await manager.observe(session.id);
  summary.statusFile = readFileSync(statusPath, "utf8").trim();
  summary.statusLabel = after.elements.find((item) => item.label === "pressed")?.label ?? null;

  // Attempt replay with the same grant
  const replaySettled = await settleNativeAgentAction(grants, manager, {
    target: headTarget,
    grantId: approved.value.grantId,
    messageId: "msg-1",
    turnId: "turn-1",
    replyText: `Attempting replay.\n<native_action>{"kind":"press_accessible_button","elementId":"${control.id}"}</native_action>`,
  });
  summary.replayStatus = replaySettled.record?.status;
  summary.statusFileAfterReplay = readFileSync(statusPath, "utf8").trim();

  // Attempt consume on already-used grant
  const reuseAttempt = grants.consume(headTarget, approved.value.grantId, "msg-2", "turn-2", await manager.inspect(session.id));
  summary.reuseRejected = !reuseAttempt.ok;

  await manager.close(session.id);
  summary.buttonIdentifier = FIXTURE_BUTTON_ID;

  const helperLeft = Bun.spawnSync(["pgrep", "-x", "forgeorbit-native-cu"]);
  summary.helperStillRunning = helperLeft.exitCode === 0;

  const ok = summary.idleBefore === "idle:0"
    && summary.settledStatus === "accepted"
    && summary.settledKind === "press_accessible_button"
    && summary.statusFile === "pressed:1"
    && summary.statusLabel === "pressed"
    && summary.statusFileAfterReplay === "pressed:1"
    && summary.reuseRejected === true
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
  if (fixture) fixture.kill();
  rmSync(work, { recursive: true, force: true });
}
