/**
 * FO-NATIVE-CU01 identity, redaction and size rules.
 * Labels never authorize an action. A stale path is refused, not searched.
 */

import * as crypto from "node:crypto";
import {
  FIXTURE_BUNDLE_ID,
  FIXTURE_BUTTON_ID,
  NATIVE_COMPUTER_LIMITS,
  OPEN_MENU_ACTION,
  PRESS_ACTION,
  SCROLL_ACTION,
  SELECT_MENU_ITEM_ACTION,
  SELECT_TAB_ACTION,
  SET_TEXT_ACTION,
  type NativeAction,
  type NativeApplicationRecord,
  type NativeElementView,
  type NativeProcessIdentity,
  type NativeRawElement,
  type NativeWindowRecord,
} from "./types.ts";

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,220}$/;
const ELEMENT_PATH = /^(?:menu\/[0-9]+(?:\/[0-9]+){0,4}|[0-9]+(?:\/[0-9]+){0,5})$/;
const LABEL_HASH = /^[0-9a-f]{16}$/;
export const TOKEN = /bearer\s+\S{8,}|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{8,}|xox[baprs]-[a-z0-9-]{8,}|AKIA[0-9A-Z]{8,}|eyJ[a-zA-Z0-9_-]{12,}|[0-9a-f]{32,}/i;
const SENSITIVE_KEY = /^(value|password|token|secret|cookie|authorization|clipboard|axvalue)$/i;

export interface StoredNativeElement {
  id: string;
  path: string;
  role: string;
  subrole?: string;
  parentRole?: string;
  identifier: string;
  label: string;
  labelHash: string;
  enabled: boolean;
  depth: number;
  valueRedacted: boolean;
  actions: NativeAction[];
  inTabGroup?: boolean;
  supportsScroll?: boolean;
  supportsSelectTab?: boolean;
  supportsSetText?: boolean;
  supportsOpenMenu?: boolean;
  supportsSelectMenuItem?: boolean;
  isMultiline?: boolean;
  isSubmenu?: boolean;
}

export function executableHash(executablePath: string): string {
  if (crypto && typeof crypto.createHash === "function") {
    return crypto.createHash("sha256").update(executablePath).digest("hex").slice(0, 16);
  }
  return "";
}

export function isSessionId(value: string): boolean {
  return /^ncu_[0-9a-f]{32}$/.test(value);
}

export function isObservationId(value: string): boolean {
  return /^nobs_[0-9a-f]{32}$/.test(value);
}

export function isClaimId(value: string): boolean {
  return /^nact_[0-9a-f]{32}$/.test(value);
}

export function isElementPath(value: string): boolean {
  return ELEMENT_PATH.test(value);
}

export function parseIdentity(value: unknown): NativeProcessIdentity | null {
  if (!isRecord(value)) return null;
  if (typeof value.bundleId !== "string" || !BUNDLE_ID.test(value.bundleId)) return null;
  if (!isExecutablePath(value.executablePath)) return null;
  const pid = finiteInt(value.pid, 1, 2_147_483_647);
  const startSec = finiteInt(value.startSec, 0, Number.MAX_SAFE_INTEGER);
  const startUsec = finiteInt(value.startUsec, 0, 999_999);
  if (pid === null || startSec === null || startUsec === null) return null;
  return { bundleId: value.bundleId, executablePath: value.executablePath, pid, startSec, startUsec };
}

export function sameIdentity(left: NativeProcessIdentity, right: NativeProcessIdentity): boolean {
  return left.bundleId === right.bundleId
    && left.executablePath === right.executablePath
    && left.pid === right.pid
    && left.startSec === right.startSec
    && left.startUsec === right.startUsec;
}

export function isFixtureBundle(bundleId: string): boolean {
  return bundleId === FIXTURE_BUNDLE_ID;
}

export const EXCLUDED_BUNDLE_PATTERNS = [
  // ForgeOrbit itself
  /^app\.forgeorbit(\.(qa|desktop|local))?$/,
  // Disposable excluded test fixtures (Target B)
  /^app\.forgeorbit\.native-cu-excluded$/,
  /\.native-cu-excluded$/,
  // macOS security, auth, keychain, preferences
  /^com\.apple\.(SecurityAgent|CoreAuthUI|UserNotificationCenter|systempreferences|systemsettings|preference\.security|keychainaccess|authorizationhost)($|\.)/i,
  /^com\.apple\.(LocalAuthentication|AuthenticationServices|tcc|ctk)($|\.)/i,
  // Password managers
  /^com\.(1password|agilebits|bitwarden|lastpass|enpass|dashlane|nordpass)($|\.)/i,
  /^org\.keepassxc\.keepassxc$/i,
  // Terminals and shells
  /^com\.apple\.Terminal$/i,
  /^com\.googlecode\.iterm2$/i,
  /^dev\.warp\.Warp(-Stable)?$/i,
  /^net\.kovidgoyal\.kitty$/i,
  /^com\.mitchellh\.ghostty$/i,
  /^io\.alacritty$/i,
];

export const EXCLUDED_PATH_PREFIXES = [
  "/bin/",
  "/sbin/",
  "/usr/bin/",
  "/usr/sbin/",
];

export const EXCLUDED_PATH_SUBSTRINGS = [
  "Terminal.app",
  "iTerm.app",
  "Ghostty.app",
  "Alacritty.app",
  "kitty.app",
  "Warp.app",
  "ForgeOrbit.app",
];

export function isExcludedApplication(
  bundleId: string,
  executablePath?: string,
): { excluded: boolean; reason?: string } {
  for (const pattern of EXCLUDED_BUNDLE_PATTERNS) {
    if (pattern.test(bundleId)) {
      if (/forgeorbit/i.test(bundleId) && !/excluded/i.test(bundleId)) {
        return { excluded: true, reason: "ForgeOrbit authorization and application controls are excluded." };
      }
      if (/terminal|iterm|warp|kitty|ghostty|alacritty/i.test(bundleId)) {
        return { excluded: true, reason: "Terminal and shell execution interfaces are excluded." };
      }
      if (/password|keychain|1password|bitwarden|lastpass|enpass|dashlane|nordpass|keepass/i.test(bundleId)) {
        return { excluded: true, reason: "Password managers and credential stores are excluded." };
      }
      if (/security|coreauth|tcc|systempreferences|systemsettings/i.test(bundleId)) {
        return { excluded: true, reason: "macOS security and permission dialogs are excluded." };
      }
      return { excluded: true, reason: "This application is excluded by security policy." };
    }
  }

  if (executablePath) {
    for (const prefix of EXCLUDED_PATH_PREFIXES) {
      if (executablePath.startsWith(prefix)) {
        return { excluded: true, reason: "System command-line shells and binaries are excluded." };
      }
    }
    for (const substr of EXCLUDED_PATH_SUBSTRINGS) {
      if (executablePath.includes(substr)) {
        return { excluded: true, reason: "Excluded application binary identity." };
      }
    }
  }

  return { excluded: false };
}

export const SENSITIVE_WINDOW_TITLE = /(password|keychain|security|authentication|credential|authorization|grant permission)/i;

export function isExcludedWindow(window: NativeWindowRecord): { excluded: boolean; reason?: string } {
  if (window.titleRedacted) {
    return { excluded: true, reason: "Windows with redacted credentials or secrets cannot be targeted." };
  }
  if (SENSITIVE_WINDOW_TITLE.test(window.title)) {
    return { excluded: true, reason: "Security and credential management windows are excluded." };
  }
  return { excluded: false };
}

export const SENSITIVE_CONTROL_IDENTIFIER = /(password|passcode|token|secret|credential|keychain|login|signin|sign-in|auth|tcc|permission|grant-access|erase-all|format-disk|delete-account|factory-reset|excluded|prohibited|verification|otp|mfa|2fa|pin|terminal|shell|sudo|admin|wipe)/i;

export const PROTECTED_FIELD_IDENTIFIER = /(password|passcode|token|secret|credential|keychain|otp|mfa|2fa|pin)/i;

export function isExcludedElement(element: {
  role: string;
  subrole?: string;
  identifier?: string;
  label?: string;
  valueRedacted?: boolean;
  leakedSensitive?: boolean;
  inTabGroup?: boolean;
  isSubmenu?: boolean;
}): { excluded: boolean; reason?: string } {
  if (
    element.role !== "AXButton" &&
    element.role !== "AXScrollArea" &&
    element.role !== "AXRadioButton" &&
    element.role !== "AXTab" &&
    element.role !== "AXTextField" &&
    element.role !== "AXTextArea" &&
    element.role !== "AXMenuBarItem" &&
    element.role !== "AXMenuItem"
  ) {
    return { excluded: true, reason: "Only accessible buttons, scroll areas, tabs, text fields, and menus are supported." };
  }
  if (isSecureRole(element.role, element.subrole ?? "") || element.valueRedacted || element.leakedSensitive) {
    return { excluded: true, reason: "Secure and password controls are excluded." };
  }
  if (element.role === "AXMenuBarItem" && (element.label?.toLowerCase() === "apple" || element.label === "" || element.identifier?.toLowerCase() === "apple")) {
    return { excluded: true, reason: "System Apple menu is excluded." };
  }
  const hay = `${element.identifier ?? ""} ${element.label ?? ""}`;
  if (SENSITIVE_CONTROL_IDENTIFIER.test(hay)) {
    return { excluded: true, reason: "Security-sensitive, authentication, or prohibited controls are excluded." };
  }
  if (element.role === "AXRadioButton" && element.inTabGroup === false && element.subrole !== "AXTabButton") {
    return { excluded: true, reason: "Radio buttons outside tab groups cannot be selected." };
  }
  if (element.role === "AXMenuItem" && element.isSubmenu === true) {
    return { excluded: true, reason: "Submenus cannot be directly selected." };
  }
  if (element.role === "AXMenuItem" && (element.subrole === "AXSeparator" || element.label === "")) {
    return { excluded: true, reason: "Menu separators cannot be selected." };
  }
  return { excluded: false };
}

export function sanitizeLabel(raw: string): { text: string; redacted: boolean } {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const cut = Array.from(cleaned).slice(0, NATIVE_COMPUTER_LIMITS.maxLabelChars).join("");
  if (!cut) return { text: "", redacted: false };
  if (TOKEN.test(cut) || /password\s*[:=]/i.test(cut)) return { text: "", redacted: true };
  return { text: cut, redacted: false };
}

export function sanitizeTitle(raw: string): { text: string; redacted: boolean } {
  const cleaned = sanitizeLabel(raw);
  if (cleaned.redacted) return cleaned;
  if (/password|secret|token|cookie|keychain/i.test(cleaned.text)) return { text: "", redacted: true };
  return { text: Array.from(cleaned.text).slice(0, NATIVE_COMPUTER_LIMITS.maxTitleChars).join(""), redacted: false };
}

export function safeActions(input: {
  bundleId: string;
  executablePath?: string;
  role: string;
  subrole?: string;
  identifier?: string;
  label?: string;
  enabled: boolean;
  supportsPress?: boolean;
  supportsScroll?: boolean;
  supportsSelectTab?: boolean;
  supportsSetText?: boolean;
  supportsOpenMenu?: boolean;
  supportsSelectMenuItem?: boolean;
  parentRole?: string;
  inTabGroup?: boolean;
  isSubmenu?: boolean;
  windowTitle?: string;
  windowTitleRedacted?: boolean;
}): NativeAction[] {
  if (isExcludedApplication(input.bundleId, input.executablePath).excluded) return [];
  if (input.windowTitleRedacted || (input.windowTitle && SENSITIVE_WINDOW_TITLE.test(input.windowTitle))) return [];
  if (isExcludedElement(input).excluded) return [];

  if (input.role === "AXButton") {
    if (!input.enabled || input.supportsPress === false) return [];
    return [PRESS_ACTION];
  }
  if (input.role === "AXScrollArea") {
    if (!input.enabled || input.supportsScroll !== true) return [];
    return [SCROLL_ACTION];
  }
  if (input.role === "AXRadioButton" || input.role === "AXTab") {
    if (!input.enabled) return [];
    const isInTabGroup = input.inTabGroup || input.parentRole === "AXTabGroup" || input.subrole === "AXTabButton";
    if (isInTabGroup) {
      if (input.supportsSelectTab !== true) return [];
      return [SELECT_TAB_ACTION];
    }
    return [];
  }
  if (input.role === "AXTextField" || input.role === "AXTextArea") {
    if (!input.enabled || input.supportsSetText !== true) return [];
    return [SET_TEXT_ACTION];
  }
  if (input.role === "AXMenuBarItem") {
    if (!input.enabled || input.supportsOpenMenu !== true) return [];
    return [OPEN_MENU_ACTION];
  }
  if (input.role === "AXMenuItem") {
    if (!input.enabled || input.supportsSelectMenuItem !== true || input.isSubmenu === true) return [];
    return [SELECT_MENU_ITEM_ACTION];
  }
  return [];
}

export function isSecureRole(role: string, subrole: string): boolean {
  const hay = `${role} ${subrole}`.toLowerCase();
  return hay.includes("secure") || hay.includes("password");
}

export function parseRawElement(value: unknown): NativeRawElement | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || !isElementPath(value.path)) return null;
  if (typeof value.role !== "string" || value.role.length === 0 || value.role.length > 80) return null;
  if (typeof value.labelHash !== "string" || !LABEL_HASH.test(value.labelHash)) return null;
  const depth = finiteInt(value.depth, 0, NATIVE_COMPUTER_LIMITS.maxDepth);
  if (depth === null) return null;
  const leakedSensitive = Object.keys(value).some((key) => SENSITIVE_KEY.test(key));
  return {
    path: value.path,
    role: value.role,
    subrole: typeof value.subrole === "string" ? value.subrole.slice(0, 80) : "",
    parentRole: typeof value.parentRole === "string" ? value.parentRole.slice(0, 80) : undefined,
    identifier: typeof value.identifier === "string" ? value.identifier.slice(0, 120) : "",
    label: typeof value.label === "string" ? value.label : "",
    labelHash: value.labelHash,
    enabled: value.enabled === true,
    depth,
    valueRedacted: value.valueRedacted === true,
    leakedSensitive,
    supportsPress: typeof value.supportsPress === "boolean" ? value.supportsPress : undefined,
    supportsScroll: typeof value.supportsScroll === "boolean" ? value.supportsScroll : undefined,
    supportsSelectTab: typeof value.supportsSelectTab === "boolean" ? value.supportsSelectTab : undefined,
    supportsSetText: typeof value.supportsSetText === "boolean" ? value.supportsSetText : undefined,
    supportsOpenMenu: typeof value.supportsOpenMenu === "boolean" ? value.supportsOpenMenu : undefined,
    supportsSelectMenuItem: typeof value.supportsSelectMenuItem === "boolean" ? value.supportsSelectMenuItem : undefined,
    isMultiline: typeof value.isMultiline === "boolean" ? value.isMultiline : undefined,
    inTabGroup: typeof value.inTabGroup === "boolean" ? value.inTabGroup : undefined,
    isSubmenu: typeof value.isSubmenu === "boolean" ? value.isSubmenu : undefined,
  };
}

export function presentElements(
  raw: NativeRawElement[],
  bundleId: string,
  executablePath?: string,
  window?: NativeWindowRecord,
): {
  views: NativeElementView[];
  stored: StoredNativeElement[];
  truncated: boolean;
  omitted: number;
  redactedFields: number;
} {
  const views: NativeElementView[] = [];
  const stored: StoredNativeElement[] = [];
  let omitted = 0;
  let redactedFields = 0;
  let truncated = false;
  for (const element of raw) {
    if (element.depth > NATIVE_COMPUTER_LIMITS.maxDepth) {
      truncated = true;
      omitted += 1;
      continue;
    }
    if (views.length >= NATIVE_COMPUTER_LIMITS.maxElements) {
      truncated = true;
      omitted += 1;
      continue;
    }
    const protectedField = (element.role === "AXTextField" || element.role === "AXTextArea" || element.role === "AXStaticText") && PROTECTED_FIELD_IDENTIFIER.test(element.identifier);
    const secure = isSecureRole(element.role, element.subrole) || element.valueRedacted || element.leakedSensitive || protectedField;
    const label = secure ? { text: "", redacted: true } : sanitizeLabel(element.label);
    if (secure || label.redacted || element.leakedSensitive) redactedFields += 1;
    const actions = safeActions({
      bundleId,
      executablePath,
      role: element.role,
      subrole: element.subrole,
      identifier: element.identifier,
      label: element.label,
      enabled: element.enabled,
      supportsPress: element.supportsPress,
      supportsScroll: element.supportsScroll,
      supportsSelectTab: element.supportsSelectTab,
      supportsSetText: element.supportsSetText,
      supportsOpenMenu: element.supportsOpenMenu,
      supportsSelectMenuItem: element.supportsSelectMenuItem,
      parentRole: element.parentRole,
      inTabGroup: element.inTabGroup,
      isSubmenu: element.isSubmenu,
      windowTitle: window?.title,
      windowTitleRedacted: window?.titleRedacted,
    });
    const view: NativeElementView = {
      id: `el_${element.path.replaceAll("/", "_")}`,
      role: element.role,
      label: label.text,
      enabled: element.enabled,
      actions,
      depth: element.depth,
      valueRedacted: secure || label.redacted,
    };
    views.push(view);
    stored.push({
      id: view.id,
      path: element.path,
      role: element.role,
      subrole: element.subrole,
      parentRole: element.parentRole,
      identifier: element.identifier,
      label: view.label,
      labelHash: element.labelHash,
      enabled: element.enabled,
      depth: element.depth,
      valueRedacted: view.valueRedacted,
      actions,
      inTabGroup: element.inTabGroup,
      supportsScroll: element.supportsScroll,
      supportsSelectTab: element.supportsSelectTab,
      supportsSetText: element.supportsSetText,
      supportsOpenMenu: element.supportsOpenMenu,
      supportsSelectMenuItem: element.supportsSelectMenuItem,
      isMultiline: element.isMultiline,
      isSubmenu: element.isSubmenu,
    });
  }
  return { views, stored, truncated, omitted, redactedFields };
}

export function parseApplication(value: unknown): NativeApplicationRecord | null {
  const identity = parseIdentity(value);
  if (!identity || !isRecord(value) || typeof value.displayName !== "string") return null;
  const name = sanitizeLabel(value.displayName).text;
  return { ...identity, displayName: Array.from(name).slice(0, NATIVE_COMPUTER_LIMITS.maxNameChars).join("") || identity.bundleId };
}

export function parseWindow(value: unknown): NativeWindowRecord | null {
  if (!isRecord(value)) return null;
  const windowId = finiteInt(value.windowId, 1, 4_294_967_295);
  const width = finiteInt(value.width, 0, 20_000);
  const height = finiteInt(value.height, 0, 20_000);
  if (windowId === null || width === null || height === null) return null;
  const title = sanitizeTitle(typeof value.title === "string" ? value.title : "");
  return {
    windowId,
    title: title.text,
    titleRedacted: title.redacted || value.titleRedacted === true,
    width,
    height,
  };
}

export function pngSizeWithinLimit(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8
    && bytes.byteLength <= NATIVE_COMPUTER_LIMITS.maxScreenshotBytes
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47;
}

function isExecutablePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1024) return false;
  if (!value.startsWith("/") || value.includes("\u0000") || /[\r\n]/.test(value)) return false;
  return !value.split("/").includes("..");
}

function finiteInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
