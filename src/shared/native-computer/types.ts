/**
 * FO-NATIVE-CU01. Owner-controlled native macOS session.
 * Observations are bounded. One action exists, and only for the disposable fixture.
 * No AI agent receives a native grant.
 */

export const NATIVE_COMPUTER_LIMITS = {
  maxActiveSessions: 1,
  idleTimeoutMs: 15 * 60 * 1000,
  maxLifetimeMs: 60 * 60 * 1000,
  maxElements: 80,
  maxDepth: 6,
  maxLabelChars: 120,
  maxApps: 40,
  maxWindows: 12,
  maxScreenshotBytes: 1_500_000,
  maxScreenshotEdge: 1280,
  maxTitleChars: 80,
  maxNameChars: 80,
} as const;

export const FIXTURE_BUNDLE_ID = "app.forgeorbit.native-cu-fixture";
export const FIXTURE_BUTTON_ID = "forgeorbit-native-cu-press";
export const PRESS_ACTION = "press_accessible_button" as const;
export const SCROLL_ACTION = "scroll_accessible_area" as const;
export const SELECT_TAB_ACTION = "select_accessible_tab" as const;
export const SET_TEXT_ACTION = "set_accessible_text" as const;
export const OPEN_MENU_ACTION = "open_accessible_menu" as const;
export const SELECT_MENU_ITEM_ACTION = "select_accessible_menu_item" as const;

export type NativeAction =
  | typeof PRESS_ACTION
  | typeof SCROLL_ACTION
  | typeof SELECT_TAB_ACTION
  | typeof SET_TEXT_ACTION
  | typeof OPEN_MENU_ACTION
  | typeof SELECT_MENU_ITEM_ACTION;
export type NativePermissionState = "granted" | "denied" | "unavailable";
export type NativeSessionStatus = "active" | "closed" | "interrupted" | "expired";
export type NativeActionStatus = "approved" | "executing" | "completed" | "refused" | "interrupted";
export type NativeActionBoundary = "eligible-button" | "fixture-button" | "read-only";

export type NativeRefusalCode =
  | "invalid_request"
  | "invalid_claim"
  | "not_found"
  | "helper_missing"
  | "helper_failed"
  | "accessibility_denied"
  | "screen_recording_denied"
  | "permission_revoked"
  | "identity_mismatch"
  | "pid_reused"
  | "window_not_found"
  | "window_mismatch"
  | "session_limit"
  | "session_closed"
  | "session_expired"
  | "session_interrupted"
  | "stale_observation"
  | "element_not_found"
  | "element_stale"
  | "action_not_permitted"
  | "action_already_used"
  | "action_uncertain"
  | "target_exited"
  | "screenshot_unavailable"
  | "screenshot_not_captured";

export interface NativeProcessIdentity {
  bundleId: string;
  executablePath: string;
  pid: number;
  startSec: number;
  startUsec: number;
}

export interface NativeApplicationRecord extends NativeProcessIdentity {
  displayName: string;
}

export interface NativeWindowRecord {
  windowId: number;
  title: string;
  titleRedacted: boolean;
  width: number;
  height: number;
}

export interface NativePermissionStatus {
  accessibility: NativePermissionState;
  screenRecording: NativePermissionState;
  helperAvailable: boolean;
  restartMayBeRequired: boolean;
  message: string | null;
}

export interface NativeSessionView {
  id: string;
  createdAt: number;
  status: NativeSessionStatus;
  ownerId: "owner";
  idleTimeoutMs: number;
  maxLifetimeMs: number;
  expiresAt: number;
  lastActivityAt: number;
  application: NativeApplicationRecord;
  window: NativeWindowRecord;
  observationId: string | null;
  supportedActions: NativeAction[];
  actionBoundary: NativeActionBoundary;
  readOnlyReason?: string | null;
  agentControl: "unavailable";
  lastError: { code: string; message: string } | null;
}

export interface NativeElementView {
  id: string;
  role: string;
  label: string;
  enabled: boolean;
  actions: NativeAction[];
  depth: number;
  valueRedacted: boolean;
}

export interface NativeObservation {
  sessionId: string;
  observationId: string;
  application: NativeProcessIdentity;
  window: NativeWindowRecord;
  elements: NativeElementView[];
  truncated: boolean;
  elementCount: number;
  elementLimit: number;
  depthLimit: number;
  omitted: number;
  redactedFields: number;
  observedAt: number;
}

export interface NativeScreenshotInfo {
  state: "available" | "permission_required" | "unavailable" | "not_captured";
  bytes: number;
  width: number;
  height: number;
  capturedAt: number | null;
}

export interface NativeActionClaim {
  id: string;
  sessionId: string;
  observationId: string;
  elementId: string;
  action: NativeAction;
  status: NativeActionStatus;
  replayed: boolean;
  pressed: boolean;
  scrolled?: boolean;
  selected?: boolean;
  textSet?: boolean;
  menuOpened?: boolean;
  menuItemSelected?: boolean;
  direction?: "up" | "down";
  increment?: number;
  textCharCount?: number;
}

export interface NativeRawElement {
  path: string;
  role: string;
  subrole: string;
  parentRole?: string;
  identifier: string;
  label: string;
  labelHash: string;
  enabled: boolean;
  depth: number;
  valueRedacted: boolean;
  leakedSensitive: boolean;
  supportsPress?: boolean;
  supportsScroll?: boolean;
  supportsSelectTab?: boolean;
  supportsSetText?: boolean;
  supportsOpenMenu?: boolean;
  supportsSelectMenuItem?: boolean;
  isMultiline?: boolean;
  inTabGroup?: boolean;
  isSubmenu?: boolean;
}
