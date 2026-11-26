import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActivityJournalCore } from "./activity-journal-core.ts";
import { nativeComputerHttp } from "./native-computer-http.ts";
import { NativeComputerError } from "./native-computer-error.ts";
import { NativeComputerSessionManager, type NativeJournalEvent } from "./native-computer-session.ts";
import type { NativeBridge } from "./native-computer-bridge.ts";
import { nativeComputerJournalMigration } from "./migrations/118_native_computer_journal.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID, type NativeApplicationRecord, type NativeProcessIdentity } from "../shared/native-computer/types.ts";

const rootFor = () => mkdtempSync(path.join(tmpdir(), "fo-native-cu-"));

function app(bundleId = FIXTURE_BUNDLE_ID, pid = 42): NativeApplicationRecord {
  return {
    bundleId,
    executablePath: "/tmp/ForgeOrbitNativeCuFixture.app/Contents/MacOS/fixture",
    pid,
    startSec: 100,
    startUsec: 5,
    displayName: "Fixture",
  };
}

function identityOf(application: NativeApplicationRecord): NativeProcessIdentity {
  const { displayName: _displayName, ...identity } = application;
  return identity;
}

function button(extra: Record<string, unknown> = {}) {
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

function bridgeFor(reply: (command: string, request: Record<string, unknown>) => Promise<unknown> | unknown) {
  const calls: Record<string, unknown>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let cancelled = 0;
  const bridge: NativeBridge = {
    cancel() { cancelled += 1; },
    async call(request) {
      calls.push(request);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const value = await reply(String(request.command), request);
        if (value && typeof value === "object" && "ok" in value) return value as { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };
        return { ok: true as const, result: value as Record<string, unknown> };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { bridge, calls, cancelled: () => cancelled, maxInFlight: () => maxInFlight };
}

function harness(reply: Parameters<typeof bridgeFor>[0], now = () => Date.now()) {
  const events: NativeJournalEvent[] = [];
  const scripted = bridgeFor(reply);
  const manager = new NativeComputerSessionManager({
    root: rootFor(),
    bridge: scripted.bridge,
    now,
    journal: (event) => events.push(event),
  });
  return { manager, events, ...scripted };
}

function happy(command: string) {
  const application = app();
  if (command === "permissions") return { accessibility: "granted", screenRecording: "granted" };
  if (command === "list-apps") return { applications: [application], truncated: false };
  if (command === "list-windows" || command === "validate") {
    return command === "validate"
      ? { application, window: { windowId: 7, title: "ForgeOrbit Native CU Fixture", titleRedacted: false, width: 420, height: 160 } }
      : { windows: [{ windowId: 7, title: "ForgeOrbit Native CU Fixture", titleRedacted: false, width: 420, height: 160 }], truncated: false };
  }
  if (command === "observe") return { elements: [button(), { ...button(), path: "1", role: "AXStaticText", identifier: "", label: "idle", labelHash: "abcdef0123456789" }], truncated: false, omitted: 0, title: "ForgeOrbit Native CU Fixture", titleRedacted: false };
  if (command === "screenshot") return { available: true, reason: "", pngBase64: Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1])).toString("base64"), width: 8, height: 8, bytes: 9 };
  if (command === "press-button") return { pressed: true };
  if (command === "scroll-area") return { scrolled: true, direction: "down", increment: 1 };
  if (command === "select-tab") return { selected: true };
  if (command === "open-menu") return { menuOpened: true };
  if (command === "select-menu-item") return { menuItemSelected: true };
  return { ok: false, code: "invalid_request", message: "no" };
}

test("stopping a TextEdit workflow during read prevents edit and save", async () => {
  const abort = new AbortController();
  const fixture = harness(command => {
    if (command === "task-document-open") return { target: app("com.apple.TextEdit"), windowId: 7, documentVerified: true };
    if (command === "task-document-read") {
      abort.abort();
      return { verified: true };
    }
    throw new Error("Unexpected native mutation");
  });
  await expect(fixture.manager.runTaskDocument(
    { kind: "textedit", document: "fixture.txt", edit: { find: "Draft", replace: "Reviewed" } },
    "/tmp", "a".repeat(64), "edit", abort.signal, () => abort.signal.throwIfAborted(), () => {},
  )).rejects.toThrow();
  expect(fixture.calls.map(request => request.command)).toEqual(["task-document-open", "task-document-read"]);
  expect(fixture.cancelled()).toBe(1);
});

test("permission unavailable and revoked fail closed", async () => {
  const missing = harness(() => ({ ok: false, code: "helper_missing", message: "gone" }));
  const status = await missing.manager.permissions();
  expect(status.accessibility).toBe("unavailable");
  expect(status.helperAvailable).toBe(false);

  let calls = 0;
  const revoked = harness((command) => {
    calls += 1;
    if (command === "validate") return happy(command);
    if (command === "observe" && calls === 2) return happy(command);
    return { ok: false, code: "accessibility_denied", message: "Accessibility access is not available." };
  });
  const created = await revoked.manager.create(identityOf(app()), 7);
  const seen = await revoked.manager.observe(created.id);
  expect(seen.elements.length).toBeGreaterThan(0);
  await expect(revoked.manager.observe(created.id)).rejects.toMatchObject({ code: "permission_revoked" });
  expect((await revoked.manager.inspect(created.id)).status).toBe("active");
});

test("application, pid, window and element identity are revalidated", async () => {
  const mismatch = harness((command) => command === "validate"
    ? { application: app("com.apple.finder", 9), window: { windowId: 7, title: "Finder", titleRedacted: false, width: 10, height: 10 } }
    : happy(command));
  await expect(mismatch.manager.create(identityOf(app()), 7)).rejects.toMatchObject({ code: "identity_mismatch" });
  expect(mismatch.calls.filter((call) => call.command === "press-button")).toHaveLength(0);

  const reused = harness((command) => command === "observe" ? { ok: false, code: "pid_reused", message: "reused" } : happy(command));
  const session = await reused.manager.create(identityOf(app()), 7);
  await expect(reused.manager.observe(session.id)).rejects.toMatchObject({ code: "pid_reused" });
  expect((await reused.manager.inspect(session.id)).status).toBe("interrupted");

  const wrongWindow = harness((command) => command === "validate"
    ? { application: app(), window: { windowId: 8, title: "Other", titleRedacted: false, width: 10, height: 10 } }
    : happy(command));
  await expect(wrongWindow.manager.create(identityOf(app()), 7)).rejects.toMatchObject({ code: "identity_mismatch" });

  const stale = harness((command) => command === "press-button" ? { ok: false, code: "element_stale", message: "moved" } : happy(command));
  const live = await stale.manager.create(identityOf(app()), 7);
  const observation = await stale.manager.observe(live.id);
  const claim = await stale.manager.requestAction(live.id, {
    observationId: observation.observationId,
    elementId: observation.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(app()),
    windowId: 7,
  });
  await expect(stale.manager.confirmAction(live.id, claim.id, { identity: identityOf(app()), windowId: 7 })).rejects.toMatchObject({ code: "element_stale" });
  await expect(stale.manager.confirmAction(live.id, claim.id, { identity: identityOf(app()), windowId: 7 })).rejects.toMatchObject({ code: "action_already_used" });
  expect(stale.calls.filter((call) => call.command === "press-button")).toHaveLength(1);
});

test("stale observations, sensitive fields, size limits and one-time press stay bounded", async () => {
  const sensitive = harness((command) => command === "observe"
    ? { elements: [button(), { path: "2", role: "AXSecureTextField", subrole: "AXSecureTextField", identifier: "", label: "hidden", labelHash: "aaaaaaaaaaaaaaaa", enabled: true, depth: 1, valueRedacted: false, value: "hunter2" }], truncated: false, omitted: 0, title: "Fixture", titleRedacted: false }
    : happy(command));
  const session = await sensitive.manager.create(identityOf(app()), 7);
  const seen = await sensitive.manager.observe(session.id);
  expect(JSON.stringify(seen)).not.toContain("hunter2");
  expect(seen.redactedFields).toBeGreaterThan(0);

  const many = Array.from({ length: 100 }, (_, index) => ({ ...button(), path: String(index), role: "AXStaticText", identifier: "", depth: 1 }));
  const limited = harness((command) => command === "observe" ? { elements: many, truncated: false, omitted: 0, title: "Fixture", titleRedacted: false } : happy(command));
  const limitedSession = await limited.manager.create(identityOf(app()), 7);
  const bounded = await limited.manager.observe(limitedSession.id);
  expect(bounded.elements).toHaveLength(80);
  expect(bounded.truncated).toBe(true);

  let presses = 0;
  const once = harness((command) => {
    if (command === "press-button") presses += 1;
    return happy(command);
  });
  const owned = await once.manager.create(identityOf(app()), 7);
  const first = await once.manager.observe(owned.id);
  const approved = await once.manager.requestAction(owned.id, {
    observationId: first.observationId,
    elementId: first.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(app()),
    windowId: 7,
  });
  const again = await once.manager.observe(owned.id);
  await expect(once.manager.confirmAction(owned.id, approved.id, { identity: identityOf(app()), windowId: 7 })).rejects.toMatchObject({ code: "stale_observation" });
  const fresh = await once.manager.requestAction(owned.id, {
    observationId: again.observationId,
    elementId: again.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(app()),
    windowId: 7,
  });
  const done = await once.manager.confirmAction(owned.id, fresh.id, { identity: identityOf(app()), windowId: 7 });
  expect(done.pressed).toBe(true);
  await expect(once.manager.confirmAction(owned.id, fresh.id, { identity: identityOf(app()), windowId: 7 })).rejects.toMatchObject({ code: "action_already_used" });
  expect(presses).toBe(1);
  expect(once.events.some((event) => event.eventType === "native.action.completed")).toBe(true);
  expect(JSON.stringify(once.events)).not.toContain("Harmless press");
});

test("timeouts, target exit, serialization, screenshots and other applications do not gain control", async () => {
  let clock = 0;
  const timed = harness((command) => happy(command), () => clock);
  const session = await timed.manager.create(identityOf(app()), 7);
  clock = 15 * 60 * 1000 + 1;
  expect((await timed.manager.inspect(session.id)).status).toBe("expired");
  await expect(timed.manager.observe(session.id)).rejects.toMatchObject({ code: "session_expired" });

  const exited = harness((command) => command === "observe" ? { ok: false, code: "target_exited", message: "gone" } : happy(command));
  const running = await exited.manager.create(identityOf(app()), 7);
  await expect(exited.manager.observe(running.id)).rejects.toMatchObject({ code: "target_exited" });
  expect((await exited.manager.inspect(running.id)).status).toBe("interrupted");

  const slow = harness(async (command) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return happy(command);
  });
  await Promise.all([slow.manager.permissions(), slow.manager.permissions()]);
  expect(slow.maxInFlight()).toBe(1);

  const denied = harness((command) => command === "screenshot" ? { available: false, reason: "screen_recording_denied", pngBase64: "", width: 0, height: 0, bytes: 0 } : happy(command));
  const shotSession = await denied.manager.create(identityOf(app()), 7);
  const shot = await denied.manager.captureScreenshot(shotSession.id);
  expect(shot.info.state).toBe("permission_required");
  expect(shot.bytes).toBeNull();

  // Excluded target (Target B / Terminal) is read-only
  const foreign = harness((command) => command === "validate" || command === "list-windows"
    ? { ...happy(command) as Record<string, unknown>, application: command === "validate" ? app("com.apple.Terminal", 3) : undefined }
    : happy(command));
  const other = app("com.apple.Terminal", 3);
  const readOnly = await foreign.manager.create(identityOf(other), 7);
  expect(readOnly.actionBoundary).toBe("read-only");
  expect(readOnly.readOnlyReason).toContain("Terminal");
  const looked = await foreign.manager.observe(readOnly.id);
  expect(looked.elements[0]!.actions).toEqual([]);
  await expect(foreign.manager.requestAction(readOnly.id, {
    observationId: looked.observationId,
    elementId: looked.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(other),
    windowId: 7,
  })).rejects.toBeInstanceOf(NativeComputerError);
  expect(foreign.calls.filter((call) => call.command === "press-button")).toHaveLength(0);

  // Eligible generic application (Target A) works
  const targetA = app("app.forgeorbit.native-cu-target-a", 5);
  const genericEnv = harness((command) => command === "validate" || command === "list-windows"
    ? { ...happy(command) as Record<string, unknown>, application: command === "validate" ? targetA : undefined }
    : command === "observe"
      ? { elements: [{ ...button({ identifier: "generic-press-button" }) }], truncated: false, omitted: 0, title: "Target A", titleRedacted: false }
      : happy(command));
  const eligibleSession = await genericEnv.manager.create(identityOf(targetA), 7);
  expect(eligibleSession.actionBoundary).toBe("eligible-button");
  expect(eligibleSession.supportedActions).toEqual([
    "press_accessible_button",
    "scroll_accessible_area",
    "select_accessible_tab",
    "set_accessible_text",
    "open_accessible_menu",
    "select_accessible_menu_item",
  ]);
  const obs = await genericEnv.manager.observe(eligibleSession.id);
  expect(obs.elements[0]!.actions).toEqual(["press_accessible_button"]);
  const claim = await genericEnv.manager.requestAction(eligibleSession.id, {
    observationId: obs.observationId,
    elementId: obs.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(targetA),
    windowId: 7,
  });
  const confirmed = await genericEnv.manager.confirmAction(eligibleSession.id, claim.id, { identity: identityOf(targetA), windowId: 7 });
  expect(confirmed.pressed).toBe(true);
  expect(genericEnv.calls.filter((call) => call.command === "press-button")).toHaveLength(1);
});

test("scroll_accessible_area and select_accessible_tab execute bounded actions and reject invalid targets", async () => {
  const targetApp = app("app.forgeorbit.native-cu-target-a", 11);
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
      identifier: "tab-group",
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
      identifier: "tab-1",
      label: "Tab 1",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 2,
      valueRedacted: false,
      supportsSelectTab: true,
    },
    {
      path: "2",
      role: "AXTextField",
      subrole: "",
      identifier: "name-input",
      label: "Name Field",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsSetText: true,
    },
    {
      path: "3",
      role: "AXTextArea",
      subrole: "",
      identifier: "notes-area",
      label: "Notes Area",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      supportsSetText: true,
      isMultiline: true,
    },
    button({ path: "4" }),
  ];

  const env = harness((command, req) => {
    if (command === "validate" || command === "list-windows") {
      return command === "validate"
        ? { application: targetApp, window: { windowId: 7, title: "Target A", titleRedacted: false, width: 420, height: 160 } }
        : { windows: [{ windowId: 7, title: "Target A", titleRedacted: false, width: 420, height: 160 }], truncated: false };
    }
    if (command === "observe") {
      return { elements, truncated: false, omitted: 0, title: "Target A", titleRedacted: false };
    }
    if (command === "scroll-area") {
      return { scrolled: true, direction: req.direction, increment: req.increment };
    }
    if (command === "select-tab") {
      return { selected: true, role: "AXRadioButton" };
    }
    if (command === "set-text") {
      return { textSet: true, characterCount: (req.text as string).length };
    }
    return happy(command);
  });

  const session = await env.manager.create(identityOf(targetApp), 7);
  const obs = await env.manager.observe(session.id);
  const scrollEl = obs.elements.find((e) => e.role === "AXScrollArea")!;
  const tabEl = obs.elements.find((e) => e.role === "AXRadioButton")!;
  const textEl = obs.elements.find((e) => e.role === "AXTextField")!;
  const areaEl = obs.elements.find((e) => e.role === "AXTextArea")!;
  const buttonEl = obs.elements.find((e) => e.role === "AXButton")!;

  expect(scrollEl.actions).toEqual(["scroll_accessible_area"]);
  expect(tabEl.actions).toEqual(["select_accessible_tab"]);
  expect(textEl.actions).toEqual(["set_accessible_text"]);
  expect(areaEl.actions).toEqual(["set_accessible_text"]);

  // Refusal: requesting scroll on a button
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: buttonEl.id,
    action: "scroll_accessible_area",
    direction: "down",
    increment: 1,
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  // Refusal: requesting tab selection on a button
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: buttonEl.id,
    action: "select_accessible_tab",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  // Refusal: invalid scroll parameters
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: scrollEl.id,
    action: "scroll_accessible_area",
    direction: "sideways" as any,
    increment: 1,
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "invalid_claim" });

  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: scrollEl.id,
    action: "scroll_accessible_area",
    direction: "down",
    increment: 0,
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "invalid_claim" });

  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: scrollEl.id,
    action: "scroll_accessible_area",
    direction: "down",
    increment: 6,
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "invalid_claim" });

  // Successful scroll action
  const scrollClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: scrollEl.id,
    action: "scroll_accessible_area",
    direction: "down",
    increment: 2,
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const scrollResult = await env.manager.confirmAction(session.id, scrollClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(scrollResult.scrolled).toBe(true);
  expect(scrollResult.direction).toBe("down");
  expect(scrollResult.increment).toBe(2);

  // Duplicate replay refusal
  await expect(env.manager.confirmAction(session.id, scrollClaim.id, { identity: identityOf(targetApp), windowId: 7 }))
    .rejects.toMatchObject({ code: "action_already_used" });

  // Successful tab selection action
  const tabClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: tabEl.id,
    action: "select_accessible_tab",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const tabResult = await env.manager.confirmAction(session.id, tabClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(tabResult.selected).toBe(true);

  // Duplicate replay refusal
  await expect(env.manager.confirmAction(session.id, tabClaim.id, { identity: identityOf(targetApp), windowId: 7 }))
    .rejects.toMatchObject({ code: "action_already_used" });

  // Refusal: newline in single-line AXTextField
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: textEl.id,
    action: "set_accessible_text",
    text: "Line 1\nLine 2",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "invalid_claim" });

  // Refusal: control characters in text (including U+000B..U+0010 and U+007F)
  for (const cc of ["\u0000", "\u0009", "\u000b", "\u000c", "\u000d", "\u000e", "\u000f", "\u0010", "\u001f", "\u007f"]) {
    await expect(env.manager.requestAction(session.id, {
      observationId: obs.observationId,
      elementId: textEl.id,
      action: "set_accessible_text",
      text: `hello${cc}world`,
      identity: identityOf(targetApp),
      windowId: 7,
    })).rejects.toMatchObject({ code: "invalid_claim" });
  }

  // Refusal: credential-shaped text
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: textEl.id,
    action: "set_accessible_text",
    text: "bearer my_secret_token_12345",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "invalid_claim" });

  // Successful text entry on AXTextField
  const textClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: textEl.id,
    action: "set_accessible_text",
    text: "Plain text entry",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const textResult = await env.manager.confirmAction(session.id, textClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(textResult.textSet).toBe(true);
  expect(textResult.textCharCount).toBe(16);

  // Replay refusal
  await expect(env.manager.confirmAction(session.id, textClaim.id, { identity: identityOf(targetApp), windowId: 7 }))
    .rejects.toMatchObject({ code: "action_already_used" });

  // Successful multiline text entry on AXTextArea with Unicode
  const areaClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: areaEl.id,
    action: "set_accessible_text",
    text: "Салом дунё\nSalom dunyo — Oʻzbekiston",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const areaResult = await env.manager.confirmAction(session.id, areaClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(areaResult.textSet).toBe(true);
  expect(areaResult.textCharCount).toBe("Салом дунё\nSalom dunyo — Oʻzbekiston".length);
});

test("open_accessible_menu and select_accessible_menu_item execute bounded actions and reject invalid targets", async () => {
  const targetApp = app("app.forgeorbit.native-cu-target-a", 15);
  const elements = [
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
      identifier: "harmless-item",
      label: "Harmless Action",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 3,
      valueRedacted: false,
      supportsSelectMenuItem: true,
    },
    {
      path: "menu/2/0/1",
      role: "AXMenuItem",
      subrole: "",
      identifier: "disabled-item",
      label: "Disabled Action",
      labelHash: "0123456789abcdef",
      enabled: false,
      depth: 3,
      valueRedacted: false,
      supportsSelectMenuItem: true,
    },
    {
      path: "menu/2/0/2",
      role: "AXMenuItem",
      subrole: "",
      identifier: "submenu-item",
      label: "Submenu",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 3,
      valueRedacted: false,
      isSubmenu: true,
      supportsSelectMenuItem: true,
    },
    {
      path: "menu/2/0/3",
      role: "AXMenuItem",
      subrole: "AXSeparator",
      identifier: "",
      label: "",
      labelHash: "0123456789abcdef",
      enabled: false,
      depth: 3,
      valueRedacted: false,
      supportsSelectMenuItem: false,
    },
    button({ path: "0" }),
  ];

  const env = harness((command, req) => {
    if (command === "validate" || command === "list-windows") {
      return command === "validate"
        ? { application: targetApp, window: { windowId: 7, title: "Target A", titleRedacted: false, width: 420, height: 160 } }
        : { windows: [{ windowId: 7, title: "Target A", titleRedacted: false, width: 420, height: 160 }], truncated: false };
    }
    if (command === "observe") {
      return { elements, truncated: false, omitted: 0, title: "Target A", titleRedacted: false };
    }
    if (command === "open-menu") {
      return { menuOpened: true, elementPath: req.elementPath };
    }
    if (command === "select-menu-item") {
      return { menuItemSelected: true, elementPath: req.elementPath };
    }
    return happy(command);
  });

  const session = await env.manager.create(identityOf(targetApp), 7);
  const obs = await env.manager.observe(session.id);
  const viewMenuEl = obs.elements.find((e) => e.role === "AXMenuBarItem")!;
  const harmlessItemEl = obs.elements.find((e) => e.label === "Harmless Action")!;
  const disabledItemEl = obs.elements.find((e) => e.label === "Disabled Action")!;
  const submenuItemEl = obs.elements.find((e) => e.label === "Submenu")!;
  const separatorItemEl = obs.elements.find((e) => e.id === "el_menu_2_0_3")!;
  const buttonEl = obs.elements.find((e) => e.role === "AXButton")!;

  expect(viewMenuEl.actions).toEqual(["open_accessible_menu"]);
  expect(harmlessItemEl.actions).toEqual(["select_accessible_menu_item"]);
  expect(disabledItemEl.actions).toEqual([]);
  expect(submenuItemEl.actions).toEqual([]);
  expect(separatorItemEl.actions).toEqual([]);

  // Refusal: open menu on AXMenuItem or AXButton
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: harmlessItemEl.id,
    action: "open_accessible_menu",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: buttonEl.id,
    action: "open_accessible_menu",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  // Refusal: select menu item on AXMenuBarItem or AXButton
  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: viewMenuEl.id,
    action: "select_accessible_menu_item",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: disabledItemEl.id,
    action: "select_accessible_menu_item",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  await expect(env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: submenuItemEl.id,
    action: "select_accessible_menu_item",
    identity: identityOf(targetApp),
    windowId: 7,
  })).rejects.toMatchObject({ code: "action_not_permitted" });

  // Successful open_accessible_menu claim & confirm
  const menuClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: viewMenuEl.id,
    action: "open_accessible_menu",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const menuResult = await env.manager.confirmAction(session.id, menuClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(menuResult.menuOpened).toBe(true);
  expect(env.calls.filter((call) => call.command === "open-menu")).toHaveLength(1);

  // Replay refusal
  await expect(env.manager.confirmAction(session.id, menuClaim.id, { identity: identityOf(targetApp), windowId: 7 }))
    .rejects.toMatchObject({ code: "action_already_used" });

  // Successful select_accessible_menu_item claim & confirm
  const itemClaim = await env.manager.requestAction(session.id, {
    observationId: obs.observationId,
    elementId: harmlessItemEl.id,
    action: "select_accessible_menu_item",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  const itemResult = await env.manager.confirmAction(session.id, itemClaim.id, { identity: identityOf(targetApp), windowId: 7 });
  expect(itemResult.menuItemSelected).toBe(true);
  expect(env.calls.filter((call) => call.command === "select-menu-item")).toHaveLength(1);

  // Replay refusal
  await expect(env.manager.confirmAction(session.id, itemClaim.id, { identity: identityOf(targetApp), windowId: 7 }))
    .rejects.toMatchObject({ code: "action_already_used" });

  // executeAgentAction works atomically for open_accessible_menu
  const agentMenuResult = await env.manager.executeAgentAction(session.id, {
    observationId: obs.observationId,
    elementId: viewMenuEl.id,
    action: "open_accessible_menu",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  expect(agentMenuResult.menuOpened).toBe(true);
  expect(env.calls.filter((call) => call.command === "open-menu")).toHaveLength(2);

  // executeAgentAction works atomically for select_accessible_menu_item
  const agentItemResult = await env.manager.executeAgentAction(session.id, {
    observationId: obs.observationId,
    elementId: harmlessItemEl.id,
    action: "select_accessible_menu_item",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  expect(agentItemResult.menuItemSelected).toBe(true);
  expect(env.calls.filter((call) => call.command === "select-menu-item")).toHaveLength(2);
});

test("restart does not replay an executing claim and close does not keep a helper", async () => {
  const directory = rootFor();
  writeFileSync(path.join(directory, "registry.json"), JSON.stringify({
    version: 1,
    sessions: [{ id: "ncu_" + "ab".repeat(16), state: "active", createdAt: 1, bundleId: FIXTURE_BUNDLE_ID, pid: 4, windowId: 9, executableHash: "0123456789abcdef", claims: [{ id: "nact_" + "cd".repeat(16), status: "executing" }] }],
  }));
  const events: NativeJournalEvent[] = [];
  const scripted = bridgeFor(() => happy("permissions"));
  const manager = new NativeComputerSessionManager({ root: directory, bridge: scripted.bridge, journal: (event) => events.push(event) });
  expect(events.map((event) => event.eventType)).toEqual(["native.session.interrupted", "native.action.interrupted"]);
  expect(scripted.calls).toHaveLength(0);
  expect(await manager.listActive()).toEqual([]);
  manager.closeSync();
  expect(scripted.cancelled()).toBe(1);
  await expect(manager.confirmAction("ncu_" + "ab".repeat(16), "nact_" + "cd".repeat(16), { identity: identityOf(app()), windowId: 9 })).rejects.toMatchObject({ code: "session_interrupted" });
  expect(scripted.calls.filter((call) => call.command === "press-button")).toHaveLength(0);
});

test("the helper bridge has no shell fallback and the journal accepts a native session", () => {
  const files = [
    "src/bun/native-computer-session.ts",
    "src/bun/native-computer-bridge.ts",
    "src/bun/native-computer-http.ts",
    "native/computer-use/helper.swift",
  ].map((file) => readFileSync(path.join(import.meta.dir, "../..", file), "utf8")).join("\n");
  for (const forbidden of ["osascript", "child_process", "CGEventPost", "tccutil", "TCC.db", "/bin/bash", "keystroke"]) {
    expect(files).not.toContain(forbidden);
  }
  expect(files).toContain("Bun.spawn([helperPath]");
  expect(files).toContain("kAXPressAction");

  const db = new Database(":memory:");
  db.run(`CREATE TABLE activity_events (
    sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    project_path TEXT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    target_type TEXT NOT NULL CHECK (target_type IN ('company', 'project', 'employee', 'task', 'proposal', 'execution', 'turn')),
    target_id TEXT NOT NULL,
    task_id TEXT,
    run_id TEXT,
    execution_id TEXT,
    turn_id TEXT,
    employee_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_event_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`);
  db.run("INSERT INTO activity_events (id, event_type, actor_type, target_type, target_id, idempotency_key, created_at) VALUES ('old', 'employee.hired', 'owner', 'employee', 'emp', 'old-key', 1)");
  nativeComputerJournalMigration.apply?.(db);
  const journal = new ActivityJournalCore(db);
  journal.record({
    eventType: "native.session.created",
    actorType: "owner",
    actorId: "owner",
    targetType: "native-session",
    targetId: "ncu_0123456789abcdef0123456789abcdef",
    idempotencyKey: "native.session.created:test",
    payload: { sessionId: "ncu_0123456789abcdef0123456789abcdef", bundleId: FIXTURE_BUNDLE_ID, pid: 4, windowId: 9, executableHash: "0123456789abcdef" },
  });
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM activity_events").get()?.n).toBe(2);
  const fresh = new Database(":memory:");
  migrate(fresh, migrations);
  expect(String(fresh.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'activity_events'").get()?.sql)).toContain("native-session");
});

test("owner routes require the bearer token and bind the session", async () => {
  const scripted = bridgeFor((command) => happy(command));
  const manager = new NativeComputerSessionManager({ root: rootFor(), bridge: scripted.bridge, journal: () => {} });
  const denied = await nativeComputerHttp(new Request("http://127.0.0.1/native-computer/permissions"), false, { manager });
  expect(denied.status).toBe(401);
  expect(scripted.calls).toHaveLength(0);
  const created = await nativeComputerHttp(new Request("http://127.0.0.1/native-computer/sessions", {
    method: "POST",
    body: JSON.stringify({ ...identityOf(app()), windowId: 7 }),
  }), true, { manager });
  expect(created.status).toBe(201);
  const bad = await nativeComputerHttp(new Request("http://127.0.0.1/native-computer/sessions", {
    method: "POST",
    body: JSON.stringify({ pid: 1, command: "osascript" }),
  }), true, { manager });
  expect(bad.status).toBe(400);
});

test("cached observation restores without rotating id and helper failures distinguish uncertain vs missing", async () => {
  let failMode: "none" | "helper_failed" | "helper_missing" = "none";
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString("base64");
  const events: NativeJournalEvent[] = [];
  const calls: string[] = [];
  const targetApp = app();
  const targetWindow = { windowId: 7, title: "Fixture", titleRedacted: false, width: 420, height: 160 };
  const bridge: NativeBridge = {
    cancel() {},
    async call(req) {
      const cmd = String(req.command);
      calls.push(cmd);
      if (cmd === "permissions") return { ok: true, result: { accessibility: "granted", screenRecording: "granted" } };
      if (cmd === "validate") return { ok: true, result: { application: targetApp, window: targetWindow } };
      if (cmd === "observe") {
        return {
          ok: true,
          result: { elements: [button()], truncated: false, omitted: 0, title: "Fixture", titleRedacted: false },
        };
      }
      if (cmd === "screenshot") {
        return { ok: true, result: { available: true, reason: "", pngBase64: fakePng, width: 420, height: 160, bytes: 10 } };
      }
      if (cmd === "press-button") {
        if (failMode === "helper_failed") return { ok: false, code: "helper_failed", message: "helper died" };
        if (failMode === "helper_missing") return { ok: false, code: "helper_missing", message: "helper absent" };
        return { ok: true, result: { pressed: true } };
      }
      return { ok: false, code: "invalid_request", message: "unknown" };
    },
  };
  const manager = new NativeComputerSessionManager({ root: rootFor(), bridge, journal: (event) => events.push(event) });
  const created = await manager.create(identityOf(targetApp), 7);
  const obs = await manager.observe(created.id);
  const callCountAfterObserve = calls.length;

  const cachedRes = await nativeComputerHttp(
    new Request(`http://127.0.0.1/native-computer/sessions/${created.id}/observation`),
    true,
    { manager },
  );
  expect(cachedRes.status).toBe(200);
  const cachedObs = await cachedRes.json() as { observationId: string };
  expect(cachedObs.observationId).toBe(obs.observationId);
  expect(calls).toHaveLength(callCountAfterObserve);

  const shot = await manager.captureScreenshot(created.id);
  expect(shot.info.state).toBe("available");
  expect(shot.bytes?.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

  const claimUncertain = await manager.requestAction(created.id, {
    observationId: obs.observationId,
    elementId: obs.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  failMode = "helper_failed";
  await expect(
    manager.confirmAction(created.id, claimUncertain.id, { identity: identityOf(targetApp), windowId: 7 }),
  ).rejects.toMatchObject({ code: "action_uncertain" });
  expect(events.at(-1)?.eventType).toBe("native.action.interrupted");

  const claimMissing = await manager.requestAction(created.id, {
    observationId: obs.observationId,
    elementId: obs.elements[0]!.id,
    action: "press_accessible_button",
    identity: identityOf(targetApp),
    windowId: 7,
  });
  failMode = "helper_missing";
  await expect(
    manager.confirmAction(created.id, claimMissing.id, { identity: identityOf(targetApp), windowId: 7 }),
  ).rejects.toMatchObject({ code: "helper_missing" });
  expect(events.at(-1)?.eventType).toBe("native.action.refused");
});

test("lastInterrupted distinguishes executing vs approved restart and clears after a clean session", async () => {
  const dirExec = rootFor();
  writeFileSync(path.join(dirExec, "registry.json"), JSON.stringify({
    version: 1,
    sessions: [{ id: "ncu_" + "cd".repeat(16), state: "active", createdAt: 1, bundleId: FIXTURE_BUNDLE_ID, pid: 4, windowId: 9, executableHash: "0123456789abcdef", claims: [{ id: "nact_" + "ef".repeat(16), status: "executing" }] }],
  }));
  const targetApp = app();
  const targetWindow = { windowId: 9, title: "Fixture", titleRedacted: false, width: 420, height: 160 };
  const bridge: NativeBridge = {
    cancel() {},
    async call(req) {
      if (req.command === "validate") return { ok: true, result: { application: targetApp, window: targetWindow } };
      return { ok: true, result: { accessibility: "granted", screenRecording: "denied" } };
    },
  };
  const manager = new NativeComputerSessionManager({ root: dirExec, bridge, journal: () => {} });
  const listed = await (await nativeComputerHttp(new Request("http://127.0.0.1/native-computer/sessions"), true, { manager })).json() as {
    sessions: unknown[];
    lastInterrupted: { status: string; lastError: { message: string } | null } | null;
  };
  expect(listed.sessions).toEqual([]);
  expect(listed.lastInterrupted?.status).toBe("interrupted");
  expect(listed.lastInterrupted?.lastError?.message).toContain("uncertain");

  const next = await manager.create(identityOf(targetApp), 9);
  await manager.close(next.id);
  expect(await manager.lastInterrupted()).toBeNull();
});
