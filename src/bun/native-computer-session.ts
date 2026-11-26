/**
 * FO-NATIVE-CU01 session lifecycle.
 * One Owner session. One helper command at a time. A restart does not resume it
 * and does not replay a button press. Closing the session does not kill the target.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TaskComputerOutcome, TaskComputerScope, TaskComputerStep } from "../shared/task-computer-workflow.ts";
import type { ActivityEventType } from "../shared/activity/types.ts";
import {
  executableHash,
  isClaimId,
  isExcludedApplication,
  isExcludedWindow,
  isSessionId,
  parseApplication,
  parseRawElement,
  parseWindow,
  pngSizeWithinLimit,
  presentElements,
  sameIdentity,
  TOKEN,
  type StoredNativeElement,
} from "../shared/native-computer/policy.ts";
import {
  FIXTURE_BUNDLE_ID,
  NATIVE_COMPUTER_LIMITS,
  OPEN_MENU_ACTION,
  PRESS_ACTION,
  SCROLL_ACTION,
  SELECT_MENU_ITEM_ACTION,
  SELECT_TAB_ACTION,
  SET_TEXT_ACTION,
  type NativeAction,
  type NativeActionBoundary,
  type NativeActionClaim,
  type NativeActionStatus,
  type NativeApplicationRecord,
  type NativeObservation,
  type NativePermissionStatus,
  type NativeProcessIdentity,
  type NativeScreenshotInfo,
  type NativeSessionStatus,
  type NativeSessionView,
  type NativeWindowRecord,
} from "../shared/native-computer/types.ts";
import { spawnNativeBridge, type NativeBridge, type NativeBridgeFailure, type NativeBridgeResponse } from "./native-computer-bridge.ts";
import { NativeComputerError } from "./native-computer-error.ts";

export interface NativeJournalEvent {
  eventType: Extract<ActivityEventType, `native.${string}`>;
  sessionId: string;
  idempotencyKey: string;
  actorType: "owner" | "system";
  payload: Record<string, string | number | boolean>;
}

export interface NativeComputerSessionManagerOptions {
  root: string;
  bridge?: NativeBridge;
  now?: () => number;
  journal?: (event: NativeJournalEvent) => void;
}

interface LiveClaim {
  id: string;
  observationId: string;
  elementId: string;
  action: NativeAction;
  direction?: "up" | "down";
  increment?: number;
  text?: string;
  characterCount?: number;
  status: NativeActionStatus;
}

interface LiveSession {
  id: string;
  createdAt: number;
  status: NativeSessionStatus;
  lastActivityAt: number;
  application: NativeApplicationRecord;
  window: NativeWindowRecord;
  observation: { id: string; elements: StoredNativeElement[] } | null;
  lastObservation: NativeObservation | null;
  screenshot: { bytes: Uint8Array; width: number; height: number; capturedAt: number } | null;
  claims: Map<string, LiveClaim>;
  lastError: { code: string; message: string } | null;
  accessibilitySeen: boolean;
}

interface RegistryFile {
  version: 1;
  sessions: Array<{
    id: string;
    state: string;
    createdAt: number;
    bundleId: string;
    pid: number;
    windowId: number;
    executableHash: string;
    claims: Array<{ id: string; status: string }>;
  }>;
}

const INVALIDATING = new Set(["pid_reused", "identity_mismatch", "target_exited", "window_not_found", "window_mismatch"]);
const managers = new Set<NativeComputerSessionManager>();

export class NativeComputerSessionManager {
  private readonly now: () => number;
  private readonly journal?: (event: NativeJournalEvent) => void;
  private readonly bridge: NativeBridge;
  private readonly sessions = new Map<string, LiveSession>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeComputerSessionManagerOptions) {
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    this.bridge = options.bridge ?? spawnNativeBridge();
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.reconcileFromDisk();
    managers.add(this);
  }

  permissions(): Promise<NativePermissionStatus> {
    return this.exclusive(() => this.permissionsLocked());
  }

  openSettings(kind: "accessibility" | "screen-recording"): Promise<NativePermissionStatus> {
    return this.exclusive(async () => {
      const response = this.unwrap(await this.bridge.call({ command: "open-settings", kind }));
      return this.permissionStatus(response.result, true);
    });
  }

  listApplications(): Promise<{ applications: NativeApplicationRecord[]; truncated: boolean }> {
    return this.exclusive(async () => {
      const response = this.unwrap(await this.bridge.call({ command: "list-apps" }));
      const rows = Array.isArray(response.result.applications) ? response.result.applications : null;
      if (!rows) throw new NativeComputerError("The application list was not valid.", 500, "helper_failed");
      const applications = rows.flatMap((row) => {
        const parsed = parseApplication(row);
        return parsed ? [parsed] : [];
      }).slice(0, NATIVE_COMPUTER_LIMITS.maxApps);
      return { applications, truncated: response.result.truncated === true || rows.length > applications.length };
    });
  }

  listWindows(identity: NativeProcessIdentity): Promise<{ windows: NativeWindowRecord[]; truncated: boolean }> {
    return this.exclusive(async () => {
      const response = this.unwrap(await this.bridge.call({ command: "list-windows", target: identity }));
      const rows = Array.isArray(response.result.windows) ? response.result.windows : null;
      if (!rows) throw new NativeComputerError("The window list was not valid.", 500, "helper_failed");
      const windows = rows.flatMap((row) => {
        const parsed = parseWindow(row);
        return parsed ? [parsed] : [];
      }).slice(0, NATIVE_COMPUTER_LIMITS.maxWindows);
      return { windows, truncated: response.result.truncated === true || rows.length > windows.length };
    });
  }

  create(identity: NativeProcessIdentity, windowId: number): Promise<NativeSessionView> {
    return this.exclusive(() => this.createLocked(identity, windowId));
  }

  inspect(id: string): Promise<NativeSessionView> {
    return this.exclusive(async () => {
      const session = this.require(id);
      this.expireIfDue(session);
      return this.view(session);
    });
  }

  listActive(): Promise<NativeSessionView[]> {
    return this.exclusive(async () => {
      const views: NativeSessionView[] = [];
      for (const session of this.sessions.values()) {
        this.expireIfDue(session);
        if (session.status === "active") views.push(this.view(session));
      }
      return views;
    });
  }

  lastInterrupted(): Promise<NativeSessionView | null> {
    return this.exclusive(async () => {
      for (const session of this.sessions.values()) {
        this.expireIfDue(session);
      }
      const all = [...this.sessions.values()];
      const latest = all[all.length - 1];
      if (!latest || latest.status !== "interrupted") return null;
      return this.view(latest);
    });
  }

  currentObservation(id: string): Promise<NativeObservation | null> {
    return this.exclusive(async () => {
      const session = this.require(id);
      this.expireIfDue(session);
      if (session.status !== "active") return null;
      return session.lastObservation;
    });
  }

  observe(id: string): Promise<NativeObservation> {
    return this.exclusive(() => this.observeLocked(id));
  }

  captureScreenshot(id: string): Promise<{ info: NativeScreenshotInfo; bytes: Uint8Array | null }> {
    return this.exclusive(async () => {
      const info = await this.captureLocked(id);
      const session = this.sessions.get(id);
      return { info, bytes: session?.screenshot?.bytes ?? null };
    });
  }

  screenshotBytes(id: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const session = this.requireUsable(id);
      if (!session.screenshot) throw new NativeComputerError("Capture the selected window to see a preview.", 404, "screenshot_not_captured");
      return session.screenshot.bytes;
    });
  }

  requestAction(id: string, input: { observationId: string; elementId: string; action: NativeAction; direction?: "up" | "down"; increment?: number; text?: string; identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    return this.exclusive(() => this.requestLocked(id, input));
  }

  confirmAction(id: string, claimId: string, input: { identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    return this.exclusive(() => this.confirmLocked(id, claimId, input));
  }

  executeAgentAction(id: string, input: { observationId: string; elementId: string; action: NativeAction; direction?: "up" | "down"; increment?: number; text?: string; identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    return this.exclusive(() => this.executeAgentLocked(id, input));
  }

  runTaskDocument(
    scope: Extract<TaskComputerScope, { kind: "textedit" }>,
    workspace: string,
    expected: string,
    action: "read" | "edit",
    signal: AbortSignal,
    admit: () => void,
    record: (step: TaskComputerStep) => void,
  ): Promise<TaskComputerOutcome> {
    return this.exclusive(async () => {
      admit();
      if (action === "edit" && !scope.edit) {
        record({ operation: "edit", outcome: "read-only" });
        return "read-only";
      }
      const stop = () => this.bridge.cancel();
      signal.addEventListener("abort", stop, { once: true });
      const subject = { workspace, document: scope.document, expected };
      const call = async (operation: "open" | "read" | "edit" | "save", payload: Record<string, unknown>) => {
        admit();
        const response = await this.bridge.call({ command: `task-document-${operation}`, ...subject, ...payload });
        admit();
        if (!response.ok) {
          const outcome: TaskComputerOutcome =
            response.code === "accessibility_denied" || response.code === "permission_revoked" ? "permission"
              : /window|identity|pid|target/.test(response.code) ? "wrong-window"
              : response.code === "document_scope" ? "document"
              : response.code === "action_uncertain" ? "interrupted" : "runtime";
          record({ operation, outcome });
          return { outcome } as const;
        }
        return { result: response.result } as const;
      };
      try {
        const open = await call("open", {});
        if ("outcome" in open) return open.outcome!;
        const target = parseApplication(open.result.target);
        const windowId = open.result.windowId;
        if (!target || target.bundleId !== "com.apple.TextEdit" || typeof windowId !== "number" ||
          !Number.isInteger(windowId) || windowId < 1 || open.result.documentVerified !== true) return "wrong-window";
        const exact = { target, windowId };
        record({ operation: "open", outcome: "verified" });
        const read = await call("read", exact);
        if ("outcome" in read) return read.outcome!;
        if (read.result.verified !== true) return "document";
        record({ operation: "read", outcome: "verified" });
        if (action === "read" || !scope.edit) return "verified";
        const edit = await call("edit", { ...exact, writable: true, ...scope.edit });
        if ("outcome" in edit) return edit.outcome!;
        if (edit.result.edited !== true || typeof edit.result.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(edit.result.digest)) return "interrupted";
        record({ operation: "edit", outcome: "verified" });
        const save = await call("save", { ...exact, writable: true, edited: edit.result.digest });
        if ("outcome" in save) return save.outcome!;
        if (save.result.saved !== true) return "interrupted";
        record({ operation: "save", outcome: "verified" });
        return "verified";
      } finally {
        signal.removeEventListener("abort", stop);
      }
    });
  }

  close(id: string): Promise<NativeSessionView> {
    return this.exclusive(() => this.closeLocked(id, "owner"));
  }

  closeSync(): void {
    try { this.bridge.cancel(); } catch { /* exit cleanup is best-effort */ }
  }

  private async permissionsLocked(): Promise<NativePermissionStatus> {
    const response = await this.bridge.call({ command: "permissions" });
    if (!response.ok) {
      return {
        accessibility: "unavailable",
        screenRecording: "unavailable",
        helperAvailable: response.code !== "helper_missing",
        restartMayBeRequired: false,
        message: response.code === "helper_missing" ? "The native computer helper is not installed." : "The native helper could not report macOS permissions.",
      };
    }
    return this.permissionStatus(response.result, false);
  }

  private permissionStatus(result: Record<string, unknown>, opened: boolean): NativePermissionStatus {
    const accessibility = result.accessibility === "granted" ? "granted" : result.accessibility === "denied" ? "denied" : "unavailable";
    const screenRecording = result.screenRecording === "granted" ? "granted" : result.screenRecording === "denied" ? "denied" : "unavailable";
    const restartMayBeRequired = opened && (accessibility !== "granted" || screenRecording !== "granted" || result.restartMayBeRequired === true);
    return {
      accessibility,
      screenRecording,
      helperAvailable: true,
      restartMayBeRequired,
      message: restartMayBeRequired ? "If macOS just granted access, quit and reopen ForgeOrbit." : null,
    };
  }

  private async createLocked(identity: NativeProcessIdentity, windowId: number): Promise<NativeSessionView> {
    for (const session of this.sessions.values()) {
      this.expireIfDue(session);
      if (session.status === "active") throw new NativeComputerError("Close the current native session first.", 409, "session_limit");
    }
    const response = this.unwrap(await this.bridge.call({ command: "validate", target: identity, windowId }));
    const application = parseApplication(response.result.application);
    const window = parseWindow(response.result.window);
    if (!application || !window || !sameIdentity(application, identity) || window.windowId !== windowId) {
      throw new NativeComputerError("The application identity did not match.", 409, "identity_mismatch");
    }
    const session: LiveSession = {
      id: `ncu_${randomBytes(16).toString("hex")}`,
      createdAt: this.now(),
      status: "active",
      lastActivityAt: this.now(),
      application,
      window,
      observation: null,
      lastObservation: null,
      screenshot: null,
      claims: new Map(),
      lastError: null,
      accessibilitySeen: false,
    };
    this.sessions.set(session.id, session);
    this.persist();
    const hash = executableHash(application.executablePath);
    this.note("native.session.created", session, "owner", `native.session.created:${session.id}`, {
      sessionId: session.id, bundleId: application.bundleId, pid: application.pid, windowId: window.windowId, executableHash: hash,
    });
    this.note("native.target.selected", session, "owner", `native.target.selected:${session.id}`, {
      sessionId: session.id, bundleId: application.bundleId, pid: application.pid, windowId: window.windowId,
    });
    return this.view(session);
  }

  private async observeLocked(id: string): Promise<NativeObservation> {
    const session = this.requireUsable(id);
    const response = await this.bridge.call({ command: "observe", target: session.application, windowId: session.window.windowId });
    if (!response.ok) {
      this.invalidateFromHelper(session, response);
      throw this.failure(response, session) ?? new NativeComputerError("The native helper stopped without a result.", 500, "helper_failed");
    }
    const rows = Array.isArray(response.result.elements) ? response.result.elements : null;
    if (!rows) throw new NativeComputerError("The accessibility observation was not valid.", 500, "helper_failed");
    const raw = rows.flatMap((row) => {
      const parsed = parseRawElement(row);
      return parsed ? [parsed] : [];
    });
    const presented = presentElements(raw, session.application.bundleId, session.application.executablePath, session.window);
    const observationId = `nobs_${randomBytes(16).toString("hex")}`;
    session.observation = { id: observationId, elements: presented.stored };
    session.accessibilitySeen = true;
    session.screenshot = null;
    const title = typeof response.result.title === "string" ? response.result.title : session.window.title;
    const parsedTitle = parseWindow({ ...session.window, title, titleRedacted: response.result.titleRedacted === true });
    if (parsedTitle) session.window = { ...session.window, title: parsedTitle.title, titleRedacted: parsedTitle.titleRedacted };
    this.touch(session);
    this.note("native.observation.requested", session, "owner", `native.observation.requested:${observationId}`, {
      sessionId: session.id, observationId,
    });
    const observation: NativeObservation = {
      sessionId: session.id,
      observationId,
      application: session.application,
      window: session.window,
      elements: presented.views,
      truncated: presented.truncated || response.result.truncated === true,
      elementCount: presented.views.length,
      elementLimit: NATIVE_COMPUTER_LIMITS.maxElements,
      depthLimit: NATIVE_COMPUTER_LIMITS.maxDepth,
      omitted: presented.omitted + (typeof response.result.omitted === "number" ? response.result.omitted : 0),
      redactedFields: presented.redactedFields,
      observedAt: this.now(),
    };
    session.lastObservation = observation;
    return observation;
  }

  private async captureLocked(id: string): Promise<NativeScreenshotInfo> {
    const session = this.requireUsable(id);
    const response = await this.bridge.call({ command: "screenshot", target: session.application, windowId: session.window.windowId });
    if (!response.ok) {
      this.invalidateFromHelper(session, response);
      throw this.failure(response, session) ?? new NativeComputerError("The native helper stopped without a result.", 500, "helper_failed");
    }
    if (response.result.available !== true) {
      session.screenshot = null;
      const denied = response.result.reason === "screen_recording_denied";
      return { state: denied ? "permission_required" : "unavailable", bytes: 0, width: 0, height: 0, capturedAt: null };
    }
    const encoded = typeof response.result.pngBase64 === "string" ? response.result.pngBase64 : "";
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    const width = typeof response.result.width === "number" ? response.result.width : 0;
    const height = typeof response.result.height === "number" ? response.result.height : 0;
    if (!pngSizeWithinLimit(bytes) || width > NATIVE_COMPUTER_LIMITS.maxScreenshotEdge || height > NATIVE_COMPUTER_LIMITS.maxScreenshotEdge) {
      session.screenshot = null;
      return { state: "unavailable", bytes: 0, width: 0, height: 0, capturedAt: null };
    }
    const capturedAt = this.now();
    session.screenshot = { bytes, width, height, capturedAt };
    this.touch(session);
    return { state: "available", bytes: bytes.byteLength, width, height, capturedAt };
  }

  private async requestLocked(id: string, input: { observationId: string; elementId: string; action: NativeAction; direction?: "up" | "down"; increment?: number; text?: string; identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    const session = this.requireUsable(id);
    this.requireEcho(session, input.identity, input.windowId);
    if (
      input.action !== PRESS_ACTION &&
      input.action !== SCROLL_ACTION &&
      input.action !== SELECT_TAB_ACTION &&
      input.action !== SET_TEXT_ACTION &&
      input.action !== OPEN_MENU_ACTION &&
      input.action !== SELECT_MENU_ITEM_ACTION
    ) {
      return this.refuse(session, input.observationId, input.elementId, "action_not_permitted", "That action is not available.", PRESS_ACTION);
    }
    if (input.action === SCROLL_ACTION) {
      if (input.direction !== "up" && input.direction !== "down") {
        throw new NativeComputerError("Scroll direction must be up or down.", 400, "invalid_claim");
      }
      if (typeof input.increment !== "number" || !Number.isInteger(input.increment) || input.increment < 1 || input.increment > 5) {
        throw new NativeComputerError("Scroll increment must be an integer between 1 and 5.", 400, "invalid_claim");
      }
    }
    if (input.action === SET_TEXT_ACTION) {
      if (typeof input.text !== "string") {
        throw new NativeComputerError("Setting text requires a string text value.", 400, "invalid_claim");
      }
      if (Array.from(input.text).length > 1000) {
        throw new NativeComputerError("Text exceeds maximum character limit.", 400, "invalid_claim");
      }
      if (Buffer.byteLength(input.text, "utf8") > 4096) {
        throw new NativeComputerError("Text exceeds maximum byte limit.", 400, "invalid_claim");
      }
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(input.text)) {
        throw new NativeComputerError("Text contains disallowed control characters.", 400, "invalid_claim");
      }
      if (TOKEN.test(input.text) || /password\s*[:=]/i.test(input.text)) {
        throw new NativeComputerError("Text appears to contain credential or token material.", 400, "invalid_claim");
      }
    }
    if (!session.observation || session.observation.id !== input.observationId) {
      throw new NativeComputerError("That observation is no longer current.", 409, "stale_observation");
    }
    const element = session.observation.elements.find((item) => item.id === input.elementId);
    if (!element) throw new NativeComputerError("That control is not in the current observation.", 404, "element_not_found");
    if (input.action === SET_TEXT_ACTION && input.text?.includes("\n") && element.role !== "AXTextArea") {
      throw new NativeComputerError("Newline is only permitted in multiline text areas.", 400, "invalid_claim");
    }
    const appCheck = isExcludedApplication(session.application.bundleId, session.application.executablePath);
    const winCheck = isExcludedWindow(session.window);
    if (!element.actions.includes(input.action) || appCheck.excluded || winCheck.excluded) {
      return this.refuse(session, input.observationId, input.elementId, "action_not_permitted", appCheck.reason ?? winCheck.reason ?? "This control cannot be operated.", input.action);
    }
    const claim: LiveClaim = {
      id: `nact_${randomBytes(16).toString("hex")}`,
      observationId: input.observationId,
      elementId: input.elementId,
      action: input.action,
      direction: input.direction,
      increment: input.increment,
      text: input.text,
      characterCount: input.text != null ? Array.from(input.text).length : undefined,
      status: "approved",
    };
    session.claims.set(claim.id, claim);
    this.touch(session);
    this.persist();
    this.note("native.action.approved", session, "owner", `native.action.approved:${claim.id}`, {
      sessionId: session.id, claimId: claim.id, observationId: claim.observationId, elementId: claim.elementId, action: claim.action,
    });
    return this.claimView(session, claim, false);
  }

  private async confirmLocked(id: string, claimId: string, input: { identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    const session = this.requireUsable(id);
    this.requireEcho(session, input.identity, input.windowId);
    if (!isClaimId(claimId)) throw new NativeComputerError("That action confirmation was not found.", 404, "not_found");
    const claim = session.claims.get(claimId);
    if (!claim) throw new NativeComputerError("That action confirmation was not found.", 404, "not_found");
    if (claim.status !== "approved") {
      throw new NativeComputerError("That confirmation was already used.", 409, "action_already_used");
    }
    if (!session.observation || session.observation.id !== claim.observationId) {
      claim.status = "refused";
      this.persist();
      this.note("native.action.refused", session, "owner", `native.action.refused:${claim.id}`, {
        sessionId: session.id, claimId: claim.id, action: claim.action, reasonCode: "stale_observation",
      });
      throw new NativeComputerError("That observation is no longer current.", 409, "stale_observation");
    }
    const element = session.observation.elements.find((item) => item.id === claim.elementId);
    const appCheck = isExcludedApplication(session.application.bundleId, session.application.executablePath);
    const winCheck = isExcludedWindow(session.window);
    if (!element || !element.actions.includes(claim.action) || appCheck.excluded || winCheck.excluded) {
      claim.status = "refused";
      this.persist();
      this.note("native.action.refused", session, "owner", `native.action.refused:${claim.id}:boundary`, {
        sessionId: session.id, claimId: claim.id, action: claim.action, reasonCode: "action_not_permitted",
      });
      throw new NativeComputerError(appCheck.reason ?? winCheck.reason ?? "This control cannot be operated.", 403, "action_not_permitted");
    }
    claim.status = "executing";
    this.persist();
    let response: NativeBridgeResponse | NativeBridgeFailure;
    if (claim.action === PRESS_ACTION) {
      response = await this.bridge.call({
        command: "press-button",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SCROLL_ACTION) {
      response = await this.bridge.call({
        command: "scroll-area",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
        direction: claim.direction ?? "down",
        increment: claim.increment ?? 1,
      });
    } else if (claim.action === SELECT_TAB_ACTION) {
      response = await this.bridge.call({
        command: "select-tab",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SET_TEXT_ACTION) {
      response = await this.bridge.call({
        command: "set-text",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
        text: claim.text ?? "",
      });
    } else if (claim.action === OPEN_MENU_ACTION) {
      response = await this.bridge.call({
        command: "open-menu",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SELECT_MENU_ITEM_ACTION) {
      response = await this.bridge.call({
        command: "select-menu-item",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else {
      throw new NativeComputerError("That action is not available.", 403, "action_not_permitted");
    }
    claim.text = undefined;
    if (!response.ok) {
      return this.handleFailedExecution(session, claim, response, "owner");
    }
    const success = (claim.action === PRESS_ACTION && response.result.pressed === true)
      || (claim.action === SCROLL_ACTION && response.result.scrolled === true)
      || (claim.action === SELECT_TAB_ACTION && response.result.selected === true)
      || (claim.action === SET_TEXT_ACTION && response.result.textSet === true)
      || (claim.action === OPEN_MENU_ACTION && response.result.menuOpened === true)
      || (claim.action === SELECT_MENU_ITEM_ACTION && response.result.menuItemSelected === true);
    if (!success) {
      claim.status = "interrupted";
      session.lastError = {
        code: "action_uncertain",
        message: "The native action did not finish in a known state. It will not be repeated.",
      };
      this.persist();
      this.note("native.action.interrupted", session, "owner", `native.action.interrupted:${claim.id}:uncertain`, {
        sessionId: session.id, claimId: claim.id, reasonCode: "uncertain",
      });
      throw new NativeComputerError("The native action did not finish in a known state. It will not be repeated.", 409, "action_uncertain");
    }
    claim.status = "completed";
    session.screenshot = null;
    this.touch(session);
    this.persist();
    this.note("native.action.completed", session, "owner", `native.action.completed:${claim.id}`, {
      sessionId: session.id, claimId: claim.id, action: claim.action,
    });
    return this.claimView(session, claim, false);
  }

  private async executeAgentLocked(id: string, input: { observationId: string; elementId: string; action: NativeAction; direction?: "up" | "down"; increment?: number; text?: string; identity: NativeProcessIdentity; windowId: number }): Promise<NativeActionClaim> {
    const session = this.requireUsable(id);
    this.requireEcho(session, input.identity, input.windowId);
    if (
      input.action !== PRESS_ACTION &&
      input.action !== SCROLL_ACTION &&
      input.action !== SELECT_TAB_ACTION &&
      input.action !== SET_TEXT_ACTION &&
      input.action !== OPEN_MENU_ACTION &&
      input.action !== SELECT_MENU_ITEM_ACTION
    ) {
      throw new NativeComputerError("That action is not available.", 403, "action_not_permitted");
    }
    if (input.action === SCROLL_ACTION) {
      if (input.direction !== "up" && input.direction !== "down") {
        throw new NativeComputerError("Scroll direction must be up or down.", 400, "invalid_claim");
      }
      if (typeof input.increment !== "number" || !Number.isInteger(input.increment) || input.increment < 1 || input.increment > 5) {
        throw new NativeComputerError("Scroll increment must be an integer between 1 and 5.", 400, "invalid_claim");
      }
    }
    if (input.action === SET_TEXT_ACTION) {
      if (typeof input.text !== "string") {
        throw new NativeComputerError("Setting text requires a string text value.", 400, "invalid_claim");
      }
      if (Array.from(input.text).length > 1000) {
        throw new NativeComputerError("Text exceeds maximum character limit.", 400, "invalid_claim");
      }
      if (Buffer.byteLength(input.text, "utf8") > 4096) {
        throw new NativeComputerError("Text exceeds maximum byte limit.", 400, "invalid_claim");
      }
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(input.text)) {
        throw new NativeComputerError("Text contains disallowed control characters.", 400, "invalid_claim");
      }
      if (TOKEN.test(input.text) || /password\s*[:=]/i.test(input.text)) {
        throw new NativeComputerError("Text appears to contain credential or token material.", 400, "invalid_claim");
      }
    }
    if (!session.observation || session.observation.id !== input.observationId) {
      throw new NativeComputerError("That observation is no longer current.", 409, "stale_observation");
    }
    const element = session.observation.elements.find((item) => item.id === input.elementId);
    if (!element) throw new NativeComputerError("That control is not in the current observation.", 404, "element_not_found");
    if (input.action === SET_TEXT_ACTION && input.text?.includes("\n") && element.role !== "AXTextArea") {
      throw new NativeComputerError("Newline is only permitted in multiline text areas.", 400, "invalid_claim");
    }
    const appCheck = isExcludedApplication(session.application.bundleId, session.application.executablePath);
    const winCheck = isExcludedWindow(session.window);
    if (!element.actions.includes(input.action) || appCheck.excluded || winCheck.excluded) {
      throw new NativeComputerError(appCheck.reason ?? winCheck.reason ?? "This control cannot be operated.", 403, "action_not_permitted");
    }
    const claim: LiveClaim = {
      id: `nact_${randomBytes(16).toString("hex")}`,
      observationId: input.observationId,
      elementId: input.elementId,
      action: input.action,
      direction: input.direction,
      increment: input.increment,
      text: input.text,
      characterCount: input.text != null ? Array.from(input.text).length : undefined,
      status: "executing",
    };
    session.claims.set(claim.id, claim);
    this.touch(session);
    this.persist();
    let response: NativeBridgeResponse | NativeBridgeFailure;
    if (claim.action === PRESS_ACTION) {
      response = await this.bridge.call({
        command: "press-button",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SCROLL_ACTION) {
      response = await this.bridge.call({
        command: "scroll-area",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
        direction: claim.direction ?? "down",
        increment: claim.increment ?? 1,
      });
    } else if (claim.action === SELECT_TAB_ACTION) {
      response = await this.bridge.call({
        command: "select-tab",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SET_TEXT_ACTION) {
      response = await this.bridge.call({
        command: "set-text",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
        text: claim.text ?? "",
      });
    } else if (claim.action === OPEN_MENU_ACTION) {
      response = await this.bridge.call({
        command: "open-menu",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else if (claim.action === SELECT_MENU_ITEM_ACTION) {
      response = await this.bridge.call({
        command: "select-menu-item",
        target: session.application,
        windowId: session.window.windowId,
        elementPath: element.path,
        role: element.role,
        identifier: element.identifier,
        labelHash: element.labelHash,
      });
    } else {
      throw new NativeComputerError("That action is not available.", 403, "action_not_permitted");
    }
    claim.text = undefined;
    if (!response.ok) {
      return this.handleFailedExecution(session, claim, response, "system");
    }
    const success = (claim.action === PRESS_ACTION && response.result.pressed === true)
      || (claim.action === SCROLL_ACTION && response.result.scrolled === true)
      || (claim.action === SELECT_TAB_ACTION && response.result.selected === true)
      || (claim.action === SET_TEXT_ACTION && response.result.textSet === true)
      || (claim.action === OPEN_MENU_ACTION && response.result.menuOpened === true)
      || (claim.action === SELECT_MENU_ITEM_ACTION && response.result.menuItemSelected === true);
    if (!success) {
      claim.status = "interrupted";
      session.lastError = {
        code: "action_uncertain",
        message: "The native action did not finish in a known state. It will not be repeated.",
      };
      this.persist();
      this.note("native.action.interrupted", session, "system", `native.action.interrupted:${claim.id}:uncertain`, {
        sessionId: session.id, claimId: claim.id, reasonCode: "uncertain",
      });
      throw new NativeComputerError("The native action did not finish in a known state. It will not be repeated.", 409, "action_uncertain");
    }
    claim.status = "completed";
    session.screenshot = null;
    this.touch(session);
    this.persist();
    this.note("native.action.completed", session, "system", `native.action.completed:${claim.id}`, {
      sessionId: session.id, claimId: claim.id, action: claim.action,
    });
    return this.claimView(session, claim, false);
  }

  private closeLocked(id: string, reason: string): NativeSessionView {
    const session = this.require(id);
    if (session.status === "active") {
      for (const claim of session.claims.values()) {
        if (claim.status === "approved" || claim.status === "executing") {
          claim.status = "interrupted";
          this.note("native.action.interrupted", session, "owner", `native.action.interrupted:${claim.id}:close`, {
            sessionId: session.id, claimId: claim.id, reasonCode: "session_closed",
          });
        }
      }
      session.status = "closed";
      session.observation = null;
      session.lastObservation = null;
      session.screenshot = null;
      this.persist();
      this.note("native.session.closed", session, "owner", `native.session.closed:${session.id}`, {
        sessionId: session.id, reasonCode: reason,
      });
    }
    return this.view(session);
  }

  private refuse(session: LiveSession, observationId: string, elementId: string, reasonCode: string, message: string, action: NativeAction = PRESS_ACTION): never {
    const claim: LiveClaim = {
      id: `nact_${randomBytes(16).toString("hex")}`,
      observationId,
      elementId,
      action,
      status: "refused",
    };
    session.claims.set(claim.id, claim);
    this.note("native.action.refused", session, "owner", `native.action.refused:${claim.id}`, {
      sessionId: session.id, claimId: claim.id, action, reasonCode,
    });
    throw new NativeComputerError(message, 403, "action_not_permitted");
  }

  private requireEcho(session: LiveSession, identity: NativeProcessIdentity, windowId: number): void {
    if (!sameIdentity(session.application, identity) || session.window.windowId !== windowId) {
      throw new NativeComputerError("The application identity did not match this session.", 400, "identity_mismatch");
    }
  }

  private invalidateFromHelper(session: LiveSession, response: NativeBridgeFailure): void {
    const code = response.code === "accessibility_denied" && session.accessibilitySeen ? "permission_revoked" : response.code;
    if (INVALIDATING.has(code)) this.interrupt(session, code);
    session.lastError = { code, message: response.message };
  }

  private handleFailedExecution(
    session: LiveSession,
    claim: LiveClaim,
    response: NativeBridgeFailure,
    actorType: "owner" | "system",
  ): never {
    const uncertain = response.code === "helper_failed";
    claim.status = uncertain ? "interrupted" : "refused";
    if (INVALIDATING.has(response.code)) this.interrupt(session, response.code);
    if (uncertain) {
      session.lastError = {
        code: "action_uncertain",
        message: "The native action stopped before reporting an outcome. It will not be repeated.",
      };
    }
    this.persist();
    this.note(
      uncertain ? "native.action.interrupted" : "native.action.refused",
      session,
      actorType,
      `native.action.${claim.status}:${claim.id}`,
      {
        sessionId: session.id,
        claimId: claim.id,
        ...(uncertain
          ? { reasonCode: "action_uncertain" }
          : { action: claim.action, reasonCode: response.code }),
      },
    );
    if (uncertain) {
      throw new NativeComputerError(
        "The native action did not finish in a known state. It will not be repeated.",
        409,
        "action_uncertain",
      );
    }
    throw this.failure(response, session) ?? new NativeComputerError("The native helper stopped without a result.", 500, "helper_failed");
  }

  private interrupt(session: LiveSession, reasonCode: string): void {
    if (session.status !== "active") return;
    for (const claim of session.claims.values()) {
      if (claim.status === "approved" || claim.status === "executing") claim.status = "interrupted";
    }
    session.status = "interrupted";
    session.observation = null;
    session.lastObservation = null;
    session.screenshot = null;
    session.lastError = { code: reasonCode, message: "The native session is no longer valid." };
    this.persist();
    this.note("native.session.interrupted", session, "system", `native.session.interrupted:${session.id}:${reasonCode}`, {
      sessionId: session.id, reasonCode,
    });
  }

  private expireIfDue(session: LiveSession): void {
    if (session.status !== "active") return;
    const idle = this.now() - session.lastActivityAt >= NATIVE_COMPUTER_LIMITS.idleTimeoutMs;
    const lifetime = this.now() - session.createdAt >= NATIVE_COMPUTER_LIMITS.maxLifetimeMs;
    if (!idle && !lifetime) return;
    session.status = "expired";
    session.observation = null;
    session.lastObservation = null;
    session.screenshot = null;
    for (const claim of session.claims.values()) {
      if (claim.status === "approved" || claim.status === "executing") claim.status = "interrupted";
    }
    this.persist();
    this.note("native.session.interrupted", session, "system", `native.session.interrupted:${session.id}:${idle ? "idle" : "lifetime"}`, {
      sessionId: session.id, reasonCode: idle ? "idle" : "lifetime",
    });
  }

  private require(id: string): LiveSession {
    if (!isSessionId(id)) throw new NativeComputerError("That native session was not found.", 404, "not_found");
    const session = this.sessions.get(id);
    if (!session) throw new NativeComputerError("That native session was not found.", 404, "not_found");
    return session;
  }

  private requireUsable(id: string): LiveSession {
    const session = this.require(id);
    this.expireIfDue(session);
    if (session.status === "expired") throw new NativeComputerError("The native session expired.", 409, "session_expired");
    if (session.status === "interrupted") throw new NativeComputerError("The native session is no longer valid.", 409, "session_interrupted");
    if (session.status !== "active") throw new NativeComputerError("The native session is closed.", 409, "session_closed");
    return session;
  }

  private touch(session: LiveSession): void {
    session.lastActivityAt = this.now();
    this.persist();
  }

  private view(session: LiveSession): NativeSessionView {
    const appCheck = isExcludedApplication(session.application.bundleId, session.application.executablePath);
    const winCheck = isExcludedWindow(session.window);
    const isEligible = !appCheck.excluded && !winCheck.excluded;
    const fixture = session.application.bundleId === FIXTURE_BUNDLE_ID;
    const actionBoundary: NativeActionBoundary = isEligible
      ? (fixture ? "fixture-button" : "eligible-button")
      : "read-only";
    const readOnlyReason = appCheck.excluded ? appCheck.reason : (winCheck.excluded ? winCheck.reason : null);
    return {
      id: session.id,
      createdAt: session.createdAt,
      status: session.status,
      ownerId: "owner",
      idleTimeoutMs: NATIVE_COMPUTER_LIMITS.idleTimeoutMs,
      maxLifetimeMs: NATIVE_COMPUTER_LIMITS.maxLifetimeMs,
      expiresAt: session.createdAt + NATIVE_COMPUTER_LIMITS.maxLifetimeMs,
      lastActivityAt: session.lastActivityAt,
      application: session.application,
      window: session.window,
      observationId: session.observation?.id ?? null,
      supportedActions: isEligible && session.status === "active" ? [PRESS_ACTION, SCROLL_ACTION, SELECT_TAB_ACTION, SET_TEXT_ACTION, OPEN_MENU_ACTION, SELECT_MENU_ITEM_ACTION] : [],
      actionBoundary,
      readOnlyReason,
      agentControl: "unavailable",
      lastError: session.lastError,
    };
  }

  private claimView(session: LiveSession, claim: LiveClaim, replayed: boolean): NativeActionClaim {
    return {
      id: claim.id,
      sessionId: session.id,
      observationId: claim.observationId,
      elementId: claim.elementId,
      action: claim.action,
      status: claim.status,
      replayed,
      pressed: claim.status === "completed" && claim.action === PRESS_ACTION,
      scrolled: claim.status === "completed" && claim.action === SCROLL_ACTION,
      selected: claim.status === "completed" && claim.action === SELECT_TAB_ACTION,
      textSet: claim.status === "completed" && claim.action === SET_TEXT_ACTION,
      menuOpened: claim.status === "completed" && claim.action === OPEN_MENU_ACTION,
      menuItemSelected: claim.status === "completed" && claim.action === SELECT_MENU_ITEM_ACTION,
      direction: claim.direction,
      increment: claim.increment,
      textCharCount: claim.characterCount,
    };
  }

  private unwrap(response: NativeBridgeResponse | NativeBridgeFailure, session?: LiveSession): NativeBridgeResponse {
    if (!response.ok) {
      throw this.failure(response, session) ?? new NativeComputerError("The native helper stopped without a result.", 500, "helper_failed");
    }
    return response;
  }

  private failure(response: NativeBridgeResponse | NativeBridgeFailure, session?: LiveSession): NativeComputerError | null {
    if (response.ok) return null;
    let code = response.code;
    if (code === "accessibility_denied" && session?.accessibilitySeen) code = "permission_revoked";
    const known: Record<string, { status: number; code: NativeComputerError["code"] }> = {
      helper_missing: { status: 500, code: "helper_missing" },
      helper_failed: { status: 500, code: "helper_failed" },
      accessibility_denied: { status: 403, code: "accessibility_denied" },
      permission_revoked: { status: 403, code: "permission_revoked" },
      screen_recording_denied: { status: 403, code: "screen_recording_denied" },
      identity_mismatch: { status: 409, code: "identity_mismatch" },
      pid_reused: { status: 409, code: "pid_reused" },
      target_exited: { status: 409, code: "target_exited" },
      window_not_found: { status: 409, code: "window_not_found" },
      window_mismatch: { status: 409, code: "window_mismatch" },
      element_stale: { status: 409, code: "element_stale" },
      action_not_permitted: { status: 403, code: "action_not_permitted" },
      invalid_request: { status: 400, code: "invalid_request" },
    };
    const mapped = known[code] ?? { status: 500, code: "helper_failed" as const };
    return new NativeComputerError(response.message, mapped.status, mapped.code);
  }

  private note(eventType: NativeJournalEvent["eventType"], session: LiveSession, actorType: "owner" | "system", idempotencyKey: string, payload: Record<string, string | number | boolean>): void {
    try {
      this.journal?.({ eventType, sessionId: session.id, idempotencyKey, actorType, payload });
    } catch {
      /* A journal failure must not replay a native action. */
    }
  }

  private persist(): void {
    const body: RegistryFile = {
      version: 1,
      sessions: [...this.sessions.values()].filter((session) => session.status === "active").map((session) => ({
        id: session.id,
        state: "active",
        createdAt: session.createdAt,
        bundleId: session.application.bundleId,
        pid: session.application.pid,
        windowId: session.window.windowId,
        executableHash: executableHash(session.application.executablePath),
        claims: [...session.claims.values()]
          .filter((claim) => claim.status === "approved" || claim.status === "executing")
          .map((claim) => ({ id: claim.id, status: claim.status })),
      })),
    };
    const target = path.join(this.options.root, "registry.json");
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
    renameSync(temporary, target);
  }

  private reconcileFromDisk(): void {
    let prior: RegistryFile["sessions"] = [];
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.options.root, "registry.json"), "utf8")) as RegistryFile;
      if (Array.isArray(parsed.sessions)) prior = parsed.sessions;
    } catch {
      prior = [];
    }
    for (const record of prior) {
      if (record.state !== "active" || typeof record.id !== "string") continue;
      const hadExecuting = (record.claims ?? []).some((claim) => claim.status === "executing");
      const session = this.tombstone(record, hadExecuting);
      this.note("native.session.interrupted", session, "system", `native.session.interrupted:${record.id}:restart`, {
        sessionId: record.id, reasonCode: "restart",
      });
      for (const claim of record.claims ?? []) {
        if ((claim.status === "approved" || claim.status === "executing") && typeof claim.id === "string") {
          this.note("native.action.interrupted", session, "system", `native.action.interrupted:${claim.id}:restart`, {
            sessionId: record.id, claimId: claim.id, reasonCode: "restart", wasExecuting: claim.status === "executing",
          });
        }
      }
    }
    if (prior.some((record) => record.state === "active")) this.persist();
  }

  private tombstone(record: RegistryFile["sessions"][number], hadExecuting = false): LiveSession {
    const session: LiveSession = {
      id: record.id,
      createdAt: record.createdAt,
      status: "interrupted",
      lastActivityAt: record.createdAt,
      application: {
        bundleId: record.bundleId,
        executablePath: "/",
        pid: record.pid,
        startSec: 0,
        startUsec: 0,
        displayName: record.bundleId,
      },
      window: { windowId: record.windowId, title: "", titleRedacted: true, width: 0, height: 0 },
      observation: null,
      lastObservation: null,
      screenshot: null,
      claims: new Map(),
      lastError: {
        code: "restart",
        message: hadExecuting
          ? "The native session and an in-progress action were interrupted by a restart; its outcome is uncertain and it was not repeated."
          : "The native session was interrupted by a restart and was not resumed.",
      },
      accessibilitySeen: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private exclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function closeLiveNativeComputerSessionsSync(): void {
  for (const manager of managers) {
    try { manager.closeSync(); } catch { /* exit cleanup is best-effort */ }
  }
}

process.on("exit", closeLiveNativeComputerSessionsSync);

let defaultManager: NativeComputerSessionManager | null = null;

export function useNativeComputerSessionManager(manager: NativeComputerSessionManager | null): void {
  defaultManager = manager;
}

export async function defaultNativeComputerSessionManager(): Promise<NativeComputerSessionManager> {
  if (defaultManager) return defaultManager;
  const { dataDir, db } = await import("./db.ts");
  const { ActivityJournalCore } = await import("./activity-journal-core.ts");
  defaultManager = new NativeComputerSessionManager({
    root: path.join(dataDir, "native-computer-sessions"),
    journal(event) {
      new ActivityJournalCore(db).record({
        eventType: event.eventType,
        actorType: event.actorType,
        actorId: event.actorType,
        targetType: "native-session",
        targetId: event.sessionId,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload,
      });
    },
  });
  return defaultManager;
}

export async function reconcileNativeComputerOnBoot(): Promise<void> {
  try {
    await defaultNativeComputerSessionManager();
  } catch (error) {
    console.warn(`[native-computer] session reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
