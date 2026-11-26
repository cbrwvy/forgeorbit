import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executableHash,
  isExcludedApplication,
  isExcludedElement,
  isExcludedWindow,
  isFixtureBundle,
  parseIdentity,
  presentElements,
  safeActions,
  sameIdentity,
  sanitizeLabel,
} from "./policy.ts";
import { FIXTURE_BUNDLE_ID, FIXTURE_BUTTON_ID, NATIVE_COMPUTER_LIMITS, type NativeRawElement } from "./types.ts";

test("labels redact secrets and secure controls never keep a value", () => {
  expect(sanitizeLabel("Harmless press").text).toBe("Harmless press");
  expect(sanitizeLabel("Bearer abcdefghijklmnop").redacted).toBe(true);
  expect(sanitizeLabel("password: hunter2").text).toBe("");
  const secure: NativeRawElement = {
    path: "1",
    role: "AXSecureTextField",
    subrole: "",
    identifier: "",
    label: "hunter2",
    labelHash: "0123456789abcdef",
    enabled: true,
    depth: 1,
    valueRedacted: false,
    leakedSensitive: true,
  };
  const presented = presentElements([secure], FIXTURE_BUNDLE_ID);
  expect(presented.views[0]?.label).toBe("");
  expect(presented.views[0]?.valueRedacted).toBe(true);
  expect(JSON.stringify(presented)).not.toContain("hunter2");
  expect(presented.redactedFields).toBe(1);
});

test("observation size and action boundaries are explicit across generic and excluded targets", () => {
  const rows: NativeRawElement[] = Array.from({ length: 100 }, (_, index) => ({
    path: String(index),
    role: index === 0 ? "AXButton" : "AXStaticText",
    subrole: "",
    identifier: index === 0 ? FIXTURE_BUTTON_ID : "",
    label: "row",
    labelHash: "0123456789abcdef",
    enabled: true,
    depth: index === 90 ? 7 : 1,
    valueRedacted: false,
    leakedSensitive: false,
  }));
  const presented = presentElements(rows, FIXTURE_BUNDLE_ID);
  expect(presented.views).toHaveLength(NATIVE_COMPUTER_LIMITS.maxElements);
  expect(presented.truncated).toBe(true);
  expect(presented.views[0]?.actions).toEqual(["press_accessible_button"]);

  // Eligible generic application works
  const genericRows: NativeRawElement[] = [
    {
      path: "0",
      role: "AXButton",
      subrole: "",
      identifier: "generic-press-button",
      label: "Generic press",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      leakedSensitive: false,
    },
  ];
  const genericPresented = presentElements(genericRows, "app.forgeorbit.native-cu-target-a");
  expect(genericPresented.views[0]?.actions).toEqual(["press_accessible_button"]);

  // Excluded applications refused
  expect(isExcludedApplication("com.apple.Terminal").excluded).toBe(true);
  expect(isExcludedApplication("com.1password.1password").excluded).toBe(true);
  expect(isExcludedApplication("com.apple.SecurityAgent").excluded).toBe(true);
  expect(isExcludedApplication("app.forgeorbit").excluded).toBe(true);
  expect(isExcludedApplication("app.forgeorbit.native-cu-excluded").excluded).toBe(true);
  expect(isExcludedApplication("com.example.app", "/bin/sh").excluded).toBe(true);

  // Excluded app elements receive empty actions
  expect(presentElements(genericRows, "com.apple.Terminal").views[0]?.actions).toEqual([]);
  expect(presentElements(genericRows, "app.forgeorbit.native-cu-excluded").views[0]?.actions).toEqual([]);

  // Excluded controls refused
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextField", enabled: true, identifier: "name" })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXButton", enabled: false, identifier: "generic-press" })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXButton", enabled: true, identifier: "login-password-submit" })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXButton", enabled: true, identifier: "erase-all-data" })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXButton", enabled: true, identifier: "excluded-button" })).toEqual([]);

  // Text field eligibility and refusal
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextField", enabled: true, identifier: "plain-name", supportsSetText: true })).toEqual(["set_accessible_text"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextArea", enabled: true, identifier: "multi-body", supportsSetText: true })).toEqual(["set_accessible_text"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextField", enabled: true, identifier: "read-only-name", supportsSetText: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextField", enabled: false, identifier: "disabled-name", supportsSetText: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXSecureTextField", enabled: true, identifier: "secure-field", supportsSetText: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXTextField", enabled: true, identifier: "auth-otp-code", supportsSetText: true })).toEqual([]);
  expect(safeActions({ bundleId: "com.apple.Terminal", role: "AXTextField", enabled: true, identifier: "term-input", supportsSetText: true })).toEqual([]);

  // Scroll area eligibility and refusal
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXScrollArea", enabled: true, identifier: "content-scroll", supportsScroll: true })).toEqual(["scroll_accessible_area"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXScrollArea", enabled: true, identifier: "content-scroll", supportsScroll: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXScrollArea", enabled: false, identifier: "content-scroll", supportsScroll: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXScrollArea", enabled: true, identifier: "password-scroll", supportsScroll: true })).toEqual([]);
  expect(safeActions({ bundleId: "com.apple.Terminal", role: "AXScrollArea", enabled: true, identifier: "term-scroll", supportsScroll: true })).toEqual([]);

  // Tab group and tab selection eligibility and refusal
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXRadioButton", parentRole: "AXTabGroup", enabled: true, identifier: "tab-settings", supportsSelectTab: true })).toEqual(["select_accessible_tab"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXRadioButton", parentRole: "AXTabGroup", enabled: true, identifier: "tab-settings", supportsSelectTab: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXRadioButton", parentRole: "AXRadioGroup", enabled: true, identifier: "radio-option-1", supportsSelectTab: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXButton", parentRole: "AXTabGroup", enabled: true, identifier: "wrong-role-tab", supportsSelectTab: true })).toEqual(["press_accessible_button"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXRadioButton", parentRole: "AXTabGroup", enabled: false, identifier: "disabled-tab", supportsSelectTab: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXRadioButton", parentRole: "AXTabGroup", enabled: true, identifier: "login-tab", supportsSelectTab: true })).toEqual([]);
  expect(safeActions({ bundleId: "com.apple.Terminal", role: "AXRadioButton", parentRole: "AXTabGroup", enabled: true, identifier: "term-tab", supportsSelectTab: true })).toEqual([]);

  // Menu bar and menu item eligibility and refusal
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuBarItem", enabled: true, identifier: "view-menu", label: "View", supportsOpenMenu: true })).toEqual(["open_accessible_menu"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuBarItem", enabled: false, identifier: "view-menu", label: "View", supportsOpenMenu: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuBarItem", enabled: true, identifier: "view-menu", label: "View", supportsOpenMenu: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuBarItem", enabled: true, identifier: "apple-menu", label: "Apple", supportsOpenMenu: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuBarItem", enabled: true, identifier: "apple", label: "", supportsOpenMenu: true })).toEqual([]);
  expect(safeActions({ bundleId: "com.apple.Terminal", role: "AXMenuBarItem", enabled: true, identifier: "view-menu", label: "View", supportsOpenMenu: true })).toEqual([]);

  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: true, identifier: "harmless-action", label: "Harmless Action", supportsSelectMenuItem: true })).toEqual(["select_accessible_menu_item"]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: false, identifier: "harmless-action", label: "Harmless Action", supportsSelectMenuItem: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: true, identifier: "harmless-action", label: "Harmless Action", supportsSelectMenuItem: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: true, identifier: "submenu-action", label: "Submenu Action", isSubmenu: true, supportsSelectMenuItem: true })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: false, identifier: "separator", label: "", subrole: "AXSeparator", supportsSelectMenuItem: false })).toEqual([]);
  expect(safeActions({ bundleId: "app.forgeorbit.native-cu-target-a", role: "AXMenuItem", enabled: true, identifier: "login-action", label: "Change Password", supportsSelectMenuItem: true })).toEqual([]);
  expect(safeActions({ bundleId: "com.apple.Terminal", role: "AXMenuItem", enabled: true, identifier: "harmless-action", label: "Harmless Action", supportsSelectMenuItem: true })).toEqual([]);

  // Excluded window refused
  expect(safeActions({
    bundleId: "app.forgeorbit.native-cu-target-a",
    role: "AXButton",
    enabled: true,
    identifier: "button",
    windowTitle: "Keychain Access",
  })).toEqual([]);
  expect(safeActions({
    bundleId: "app.forgeorbit.native-cu-target-a",
    role: "AXButton",
    enabled: true,
    identifier: "button",
    windowTitleRedacted: true,
  })).toEqual([]);

  // Eligible scroll and tab elements in presentElements
  const complexRows: NativeRawElement[] = [
    {
      path: "0",
      role: "AXScrollArea",
      subrole: "",
      identifier: "content-scroll",
      label: "Main content",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      leakedSensitive: false,
      supportsScroll: true,
    },
    {
      path: "1",
      role: "AXTabGroup",
      subrole: "",
      identifier: "main-tabs",
      label: "Tabs",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      leakedSensitive: false,
    },
    {
      path: "1/0",
      role: "AXRadioButton",
      subrole: "AXTabButton",
      parentRole: "AXTabGroup",
      identifier: "tab-overview",
      label: "Overview",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 2,
      valueRedacted: false,
      leakedSensitive: false,
      supportsSelectTab: true,
    },
    {
      path: "1/1",
      role: "AXRadioButton",
      subrole: "",
      parentRole: "AXRadioGroup",
      identifier: "radio-option",
      label: "Option",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 2,
      valueRedacted: false,
      leakedSensitive: false,
      supportsSelectTab: true,
    },
  ];
  const complexPresented = presentElements(complexRows, "app.forgeorbit.native-cu-target-a");
  expect(complexPresented.views[0]?.actions).toEqual(["scroll_accessible_area"]);
  expect(complexPresented.views[1]?.actions).toEqual([]);
  expect(complexPresented.views[2]?.actions).toEqual(["select_accessible_tab"]);
  expect(complexPresented.views[3]?.actions).toEqual([]); // not in tab group, refused

  expect(isFixtureBundle("com.apple.Terminal")).toBe(false);
  expect(isFixtureBundle(FIXTURE_BUNDLE_ID)).toBe(true);
});

test("process identity rejects traversal and pid-only records", () => {
  expect(parseIdentity({ bundleId: FIXTURE_BUNDLE_ID, executablePath: "/tmp/../etc/passwd", pid: 1, startSec: 1, startUsec: 0 })).toBeNull();
  expect(parseIdentity({ pid: 1 })).toBeNull();
  const identity = parseIdentity({ bundleId: FIXTURE_BUNDLE_ID, executablePath: "/tmp/fixture", pid: 4, startSec: 9, startUsec: 1 });
  expect(identity && sameIdentity(identity, { ...identity })).toBe(true);
  expect(executableHash("/tmp/fixture")).toHaveLength(16);
});

test("protected field identifiers redact canary text even when valueRedacted was false", () => {
  const presented = presentElements([
    {
      path: "0",
      role: "AXStaticText",
      subrole: "",
      parentRole: "AXWindow",
      identifier: "cu07-secret-canary",
      label: "CANARY_PROTECTED_STATIC_7341",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      leakedSensitive: false,
    },
    {
      path: "1",
      role: "AXTextField",
      subrole: "",
      parentRole: "AXWindow",
      identifier: "otp-code-field",
      label: "CANARY_OTP_8812",
      labelHash: "0123456789abcdef",
      enabled: true,
      depth: 1,
      valueRedacted: false,
      leakedSensitive: false,
      supportsSetText: true,
    },
  ], FIXTURE_BUNDLE_ID);
  expect(presented.redactedFields).toBe(2);
  expect(presented.views[0]?.label).toBe("");
  expect(presented.views[0]?.valueRedacted).toBe(true);
  expect(presented.views[0]?.actions).toEqual([]);
  expect(presented.views[1]?.label).toBe("");
  expect(presented.views[1]?.valueRedacted).toBe(true);
  expect(presented.views[1]?.actions).toEqual([]);
});
