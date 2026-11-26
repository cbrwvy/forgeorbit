/**
 * FO-NATIVE-CU01 live macOS check.
 * Builds a disposable fixture, observes it, presses its button once, and refuses a replay.
 * Does not touch the Owner's applications except to discover the fixture process.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnNativeBridge } from "../src/bun/native-computer-bridge.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "../src/bun/native-computer-session.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID } from "../src/shared/native-computer/types.ts";

const repo = path.resolve(import.meta.dir, "..");
const work = mkdtempSync(path.join(tmpdir(), "fo-native-cu-live-"));
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
  const claim = await manager.requestAction(session.id, {
    observationId: observation.observationId,
    elementId: control.id,
    action: "press_accessible_button",
    identity: found,
    windowId,
  });
  const pressed = await manager.confirmAction(session.id, claim.id, { identity: found, windowId });
  await Bun.sleep(300);
  const after = await manager.observe(session.id);
  let replay = "refused";
  try {
    await manager.confirmAction(session.id, claim.id, { identity: found, windowId });
    replay = "pressed-again";
  } catch (error) {
    replay = error instanceof Error && "code" in error ? String(error.code) : "refused";
  }
  const shot = await manager.captureScreenshot(session.id);
  await manager.close(session.id);
  summary.statusFile = readFileSync(statusPath, "utf8").trim();
  summary.pressed = pressed.pressed;
  summary.statusLabel = after.elements.find((item) => item.label === "pressed")?.label ?? null;
  summary.replay = replay;
  summary.screenshot = { state: shot.info.state, bytes: shot.info.bytes, width: shot.info.width, height: shot.info.height };
  summary.journal = events.map((event) => event.eventType);
  summary.buttonIdentifier = FIXTURE_BUTTON_ID;
  const helperLeft = Bun.spawnSync(["pgrep", "-x", "forgeorbit-native-cu"]);
  summary.helperStillRunning = helperLeft.exitCode === 0;
  const ok = summary.idleBefore === "idle:0"
    && summary.statusFile === "pressed:1"
    && summary.statusLabel === "pressed"
    && pressed.pressed === true
    && replay === "action_already_used"
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
