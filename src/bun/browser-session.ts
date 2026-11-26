/**
 * FO-BROWSER01 session lifecycle.
 * One active browser at a time. Commands for a session run one at a time.
 * A restart marks leftover sessions interrupted and does not launch a browser.
 */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideDestination, previewLink, type BrowserPolicyMode, type DestinationDecision } from "../shared/browser/policy.ts";
import {
  BROWSER_LIMITS,
  type BrowserObservation,
  type BrowserSessionState,
  type BrowserSessionView,
} from "../shared/browser/types.ts";
import type { ActivityEventType } from "../shared/activity/types.ts";
import { createPlaywrightBrowserEngine, pidsForProfile, type BrowserController, type BrowserEngine } from "./browser-engine.ts";
import { workflowPage, type BrowserTaskAction, type TaskComputerOutcome, type TaskComputerScope, type TaskComputerStep } from "../shared/task-computer-workflow.ts";
import { redactSecrets } from "../shared/project-interview.ts";
import { BrowserSessionError } from "./browser-session-error.ts";
import { nativeQaRoot } from "./native-qa-state.ts";

export interface BrowserSessionSnapshot {
  id: string;
  state: BrowserSessionState;
  observationId: string | null;
  approvedOrigins: string[];
  mode: BrowserPolicyMode;
  history: string[];
  url: string | null;
  pageTitle: string | null;
}

export interface BrowserJournalEvent {
  eventType: Extract<ActivityEventType, `browser.${string}`>;
  sessionId: string;
  idempotencyKey: string;
  payload: Record<string, string | number | boolean>;
}

export interface BrowserSessionManagerOptions {
  root: string;
  mode?: BrowserPolicyMode;
  engine?: BrowserEngine;
  now?: () => number;
  journal?: (event: BrowserJournalEvent) => void;
  resolveHost?: (host: string) => Promise<string[]>;
}

interface RegistryRecord {
  id: string;
  createdAt: number;
  state: BrowserSessionState | "interrupted";
  profileDir: string;
  pid: number | null;
}

interface LiveSession {
  taskOwned?: boolean;
  id: string;
  createdAt: number;
  url: string | null;
  history: string[];
  state: BrowserSessionState | "interrupted";
  approvedOrigins: string[];
  lastActivityAt: number;
  pid: number | null;
  error: { code: string; message: string } | null;
  pageTitle: string | null;
  profileDir: string;
  controller: BrowserController | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  observation: { id: string; links: { id: string; href: string }[] } | null;
  screenshot: { bytes: Uint8Array; capturedAt: number } | null;
}

const SESSION_ID = /^brw_[0-9a-f]{32}$/;
const managers = new Set<BrowserSessionManager>();

export class BrowserSessionManager {
  private readonly mode: BrowserPolicyMode;
  private readonly now: () => number;
  private readonly journal?: (event: BrowserJournalEvent) => void;
  private readonly resolveHost?: (host: string) => Promise<string[]>;
  private engine: BrowserEngine | null;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sent = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserSessionManagerOptions) {
    this.mode = options.mode ?? "production";
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    this.resolveHost = options.resolveHost;
    this.engine = options.engine ?? null;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    managers.add(this);
  }

  create(origins: string[] = []): Promise<BrowserSessionView> {
    return this.exclusive(() => this.createLocked(origins));
  }

  inspect(id: string): Promise<BrowserSessionView> {
    return this.exclusive(async () => {
      const session = this.require(id);
      await this.expireIfDue(session);
      return this.view(session);
    });
  }

  listActive(): Promise<BrowserSessionView[]> {
    return this.exclusive(async () => {
      const views: BrowserSessionView[] = [];
      for (const session of this.sessions.values()) {
        await this.expireIfDue(session);
        if (session.state === "active" && !session.taskOwned) views.push(this.view(session));
      }
      return views;
    });
  }

  hostResolver(): ((host: string) => Promise<string[]>) | undefined {
    return this.resolveHost;
  }

  snapshot(id: string): Promise<BrowserSessionSnapshot | null> {
    return this.exclusive(async () => {
      if (!SESSION_ID.test(id)) return null;
      const session = this.sessions.get(id);
      if (!session || session.taskOwned) return null;
      await this.expireIfDue(session);
      const state: BrowserSessionState = session.state === "interrupted" ? "failed" : session.state;
      return {
        id: session.id,
        state,
        observationId: session.observation?.id ?? null,
        approvedOrigins: [...session.approvedOrigins],
        mode: this.mode,
        history: [...session.history],
        url: session.url,
        pageTitle: session.pageTitle,
      };
    });
  }

  navigate(id: string, url: string): Promise<BrowserSessionView> {
    return this.exclusive(() => this.navigateLocked(id, url, "explicit"));
  }

  openLink(id: string, observationId: string, linkId: string): Promise<BrowserSessionView> {
    return this.exclusive(async () => {
      const session = await this.requireUsable(id);
      const observation = session.observation;
      if (!observation || observation.id !== observationId) {
        throw new BrowserSessionError("That page observation is no longer current.", 409, "link_stale");
      }
      const link = observation.links.find((item) => item.id === linkId);
      if (!link) throw new BrowserSessionError("That link is not on the current page.", 400, "link_not_permitted");
      const fresh = await this.readLocked(session);
      if (!fresh.links.some((item) => item.href === link.href)) {
        throw new BrowserSessionError("That link is no longer on the page.", 409, "link_stale");
      }
      return this.navigateLocked(id, link.href, "link");
    });
  }

  back(id: string): Promise<BrowserSessionView> {
    return this.exclusive(() => this.backLocked(id));
  }

  observe(id: string): Promise<BrowserObservation> {
    return this.exclusive(async () => {
      const session = await this.requireUsable(id);
      const read = await this.readLocked(session);
      let bytes = new Uint8Array();
      try {
        bytes = session.controller ? new Uint8Array(await session.controller.screenshot()) : new Uint8Array();
      } catch {
        bytes = new Uint8Array();
      }
      const capturedAt = bytes.byteLength > 0 ? this.now() : null;
      session.screenshot = capturedAt === null ? null : { bytes, capturedAt };
      const links = read.links.map((link, index) => {
        const preview = previewLink(link.href, { mode: this.mode, approvedOrigins: session.approvedOrigins });
        return {
          id: `l${index + 1}`,
          href: link.href,
          text: link.text,
          permitted: preview.permitted,
        };
      });
      const observationId = `obs_${randomBytes(16).toString("hex")}`;
      session.observation = { id: observationId, links: links.map((link) => ({ id: link.id, href: link.href })) };
      session.pageTitle = read.title;
      this.touch(session);
      const contentBytes = Buffer.byteLength(read.text) + links.reduce((sum, link) => sum + Buffer.byteLength(link.href) + Buffer.byteLength(link.text), 0);
      return {
        sessionId: session.id,
        observationId,
        url: session.url,
        title: read.title,
        navigationState: session.url ? "complete" : "idle",
        visibleText: read.text,
        textChars: Array.from(read.text).length,
        textTruncated: read.textTruncated,
        links,
        linksTruncated: read.linksTruncated,
        screenshot: { available: bytes.byteLength > 0, bytes: bytes.byteLength, capturedAt },
        observedAt: this.now(),
        contentBytes,
        untrusted: true,
      };
    });
  }

  screenshot(id: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const session = await this.requireUsable(id);
      if (!session.screenshot || session.screenshot.bytes.byteLength === 0) {
        throw new BrowserSessionError("No screenshot is available for this session.", 404, "not_found");
      }
      this.touch(session);
      return session.screenshot.bytes;
    });
  }

  close(id: string): Promise<BrowserSessionView> {
    return this.exclusive(async () => {
      if (this.require(id).taskOwned) throw new BrowserSessionError("Stop this browser from its task.", 409, "session_closed");
      return this.closeLocked(id, "owner");
    });
  }

  checkTaskDestination(url: string): Promise<DestinationDecision> {
    return decideDestination(url, { mode: this.mode, approvedOrigins: [] }, this.resolveHost);
  }

  runTaskWorkflow(
    scope: Extract<TaskComputerScope, { kind: "browser" }>,
    actions: BrowserTaskAction[],
    signal: AbortSignal,
    admit: () => void,
    record: (step: TaskComputerStep) => void,
  ): Promise<{ outcome: TaskComputerOutcome; screenshot?: Uint8Array }> {
    return this.exclusive(async () => {
      admit();
      const origin = new URL(scope.url).origin;
      const guard = (url: string) => decideDestination(url, { mode: this.mode, approvedOrigins: [origin] }, this.resolveHost);
      if (!(await guard(scope.url)).ok) return { outcome: "scope" };
      const opened = await this.createLocked([origin], true);
      const session = this.require(opened.id);
      const browser = session.controller!;
      const stop = () => { void browser.close().catch(() => undefined); };
      signal.addEventListener("abort", stop, { once: true });
      // A step records only its selected label and limited observed evidence.
      // Values, cookies, query strings and hidden fields never enter the receipt.
      const values = scope.fields.map(field => field.value).filter(Boolean);
      const sanitize = (value: string) => values.reduce((text, field) => text.split(field).join("[test data]"), redactSecrets(value)).slice(0, 400);
      const note = (operation: TaskComputerStep["operation"], outcome: TaskComputerOutcome, label?: string, observed?: string) => {
        const page = workflowPage(browser.currentUrl());
        record({ operation, outcome, page: page ? sanitize(page) : undefined, label: label && sanitize(label), observed: observed && sanitize(observed) });
      };
      try {
        admit();
        if (!browser.useTaskScope || !browser.taskAction || !browser.taskObservation) return { outcome: "runtime" };
        await browser.useTaskScope(admit);
        const first = await browser.goto(scope.url, guard);
        note("open", first.ok ? "running" : "scope");
        if (!first.ok) return { outcome: "scope" };
        for (const action of actions) {
          admit();
          const issue = action.kind === "navigate"
            ? (await browser.goto(action.url, guard)).ok ? null : "scope"
            : await browser.taskAction(action, scope.fields.find(field => field.label === action.label)?.value,
              scope.submitLabel !== null && scope.submitLabel === action.label ? scope.expected : null, admit);
          note(action.kind, issue ?? "running", "label" in action ? action.label : undefined);
          if (issue) return { outcome: issue };
        }
        admit();
        const observed = await browser.taskObservation(scope.expected);
        admit();
        note("verify", observed.outcome, undefined, observed.observed);
        const screenshot = ["validation", "missing-confirmation"].includes(observed.outcome)
          ? await browser.taskScreenshot?.(values).catch(() => undefined) : undefined;
        return { outcome: observed.outcome, screenshot };
      } finally {
        signal.removeEventListener("abort", stop);
        await this.closeLocked(session.id, "owner");
      }
    });
  }

  async reconcileInterrupted(): Promise<void> {
    await this.exclusive(async () => {
      for (const record of this.readRegistry()) {
        if (record.state === "starting" || record.state === "active" || record.state === "closing" || record.state === "interrupted") {
          this.stopProcesses(record.profileDir, record.pid);
          this.removeProfile(record.profileDir);
          if (record.state !== "interrupted") {
            record.state = "interrupted";
            this.note("browser.session.interrupted", record.id, { sessionId: record.id, reasonCode: "restart" }, `browser.session.interrupted:${record.id}`);
          }
        }
        if (!this.sessions.has(record.id)) {
          this.sessions.set(record.id, {
            id: record.id,
            createdAt: record.createdAt,
            url: null,
            history: [],
            state: record.state,
            approvedOrigins: [],
            lastActivityAt: record.createdAt,
            pid: null,
            error: record.state === "interrupted" ? { code: "session_failed", message: "The browser session was interrupted by a restart." } : null,
            pageTitle: null,
            profileDir: record.profileDir,
            controller: null,
            timer: null,
            attempt: 0,
            observation: null,
            screenshot: null,
          });
        }
      }
      this.persist();
    });
  }

  closeSync(): void {
    for (const session of this.sessions.values()) {
      if (session.timer) clearTimeout(session.timer);
      this.stopProcessesAndWait(session.profileDir, session.pid);
      this.removeProfile(session.profileDir, true);
      session.state = "closed";
      session.controller = null;
      session.pid = null;
    }
    this.persist();
  }

  private async createLocked(origins: string[], taskOwned = false): Promise<BrowserSessionView> {
    if (origins.length > BROWSER_LIMITS.maxOrigins) {
      throw new BrowserSessionError("Too many approved origins.", 400, "invalid_request");
    }
    const approved: string[] = [];
    for (const origin of origins) {
      if (typeof origin !== "string") throw new BrowserSessionError("Approved origins must be URL origins.", 400, "invalid_request");
      const decision = await decideDestination(origin, { mode: this.mode, approvedOrigins: [] }, this.resolveHost);
      if (!decision.ok) throw new BrowserSessionError(decision.error, 400, decision.code);
      if (decision.origin !== origin) throw new BrowserSessionError("Approved origins must not include a path or query.", 400, "invalid_request");
      if (!approved.includes(origin)) approved.push(origin);
    }
    for (const existing of this.sessions.values()) await this.expireIfDue(existing);
    if ([...this.sessions.values()].some((session) => session.state === "starting" || session.state === "active" || session.state === "closing")) {
      throw new BrowserSessionError("Close the current browser session before starting another.", 409, "session_limit");
    }
    const id = `brw_${randomBytes(16).toString("hex")}`;
    const createdAt = this.now();
    const profileDir = path.join(this.options.root, id);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const session: LiveSession = {
      taskOwned,
      id,
      createdAt,
      url: null,
      history: [],
      state: "starting",
      approvedOrigins: approved,
      lastActivityAt: createdAt,
      pid: null,
      error: null,
      pageTitle: null,
      profileDir,
      controller: null,
      timer: null,
      attempt: 0,
      observation: null,
      screenshot: null,
    };
    this.sessions.set(id, session);
    this.persist();
    try {
      const engine = await this.engineFor();
      session.controller = await engine.launch(profileDir, this.mode);
      session.pid = session.controller.pid;
      session.state = "active";
      this.touch(session);
      this.note("browser.session.created", id, { sessionId: id, ownerId: "owner" }, `browser.session.created:${id}`);
      this.persist();
      return this.view(session);
    } catch (error) {
      const failure = error instanceof BrowserSessionError ? error : new BrowserSessionError("The browser process failed to start.", 500, "browser_crashed");
      session.state = "failed";
      session.error = { code: failure.code, message: failure.message };
      await session.controller?.close().catch(() => undefined);
      this.stopProcesses(profileDir, session.pid);
      this.removeProfile(profileDir);
      session.controller = null;
      session.pid = null;
      this.note("browser.session.failed", id, { sessionId: id, reasonCode: failure.code }, `browser.session.failed:${id}`);
      this.persist();
      throw failure;
    }
  }

  private async navigateLocked(id: string, raw: string, kind: "explicit" | "link" | "back"): Promise<BrowserSessionView> {
    const session = await this.requireUsable(id);
    const attempt = ++session.attempt;
    const audit = auditDestination(raw);
    this.note("browser.navigation.requested", id, { sessionId: id, destinationHost: audit.destinationHost, destinationOrigin: audit.destinationOrigin }, `browser.navigation.requested:${id}:${attempt}`);
    const decision = await decideDestination(raw, {
      mode: this.mode,
      approvedOrigins: session.approvedOrigins,
    }, this.resolveHost);
    if (!decision.ok) {
      this.note("browser.navigation.refused", id, { sessionId: id, destinationHost: audit.destinationHost, reasonCode: decision.code }, `browser.navigation.refused:${id}:${attempt}`);
      this.persist();
      throw new BrowserSessionError(decision.error, 400, decision.code);
    }
    if (!session.controller) throw new BrowserSessionError("The browser process is not running.", 409, "session_failed");
    let landed: DestinationDecision;
    try {
      landed = await session.controller.goto(decision.url, (hop) => decideDestination(hop, {
        mode: this.mode,
        approvedOrigins: session.approvedOrigins,
        requestedOrigin: decision.origin,
      }, this.resolveHost));
    } catch (error) {
      await this.fail(session, error);
      throw error instanceof BrowserSessionError ? error : new BrowserSessionError("The browser process failed.", 500, "browser_crashed");
    }
    if (!landed.ok) {
      const code = landed.code === "origin_not_approved" ? "redirect_forbidden" : landed.code;
      this.note("browser.navigation.refused", id, { sessionId: id, destinationHost: audit.destinationHost, reasonCode: code }, `browser.navigation.refused:${id}:${attempt}`);
      throw new BrowserSessionError(landed.error, 400, code);
    }
    if (session.approvedOrigins.length === 0) session.approvedOrigins = [landed.origin];
    session.url = landed.url;
    session.pageTitle = null;
    session.observation = null;
    session.screenshot = null;
    if (kind === "back") session.history = session.history.slice(0, -1);
    else session.history = [...session.history, landed.url].slice(-BROWSER_LIMITS.maxHistory);
    session.error = null;
    this.touch(session);
    this.note("browser.navigation.accepted", id, { sessionId: id, destinationHost: landed.host, destinationOrigin: landed.origin }, `browser.navigation.accepted:${id}:${attempt}`);
    this.persist();
    return this.view(session);
  }

  private async backLocked(id: string): Promise<BrowserSessionView> {
    const session = await this.requireUsable(id);
    const previous = session.history.length >= 2 ? session.history[session.history.length - 2] : undefined;
    if (!previous) throw new BrowserSessionError("There is no previous page in this session.", 409, "no_history");
    return this.navigateLocked(id, previous, "back");
  }

  private async readLocked(session: LiveSession) {
    if (!session.controller) throw new BrowserSessionError("The browser process is not running.", 409, "session_failed");
    try {
      return await session.controller.read();
    } catch (error) {
      await this.fail(session, error);
      throw new BrowserSessionError("The browser process failed.", 500, "browser_crashed");
    }
  }

  private async closeLocked(id: string, reasonCode: "owner" | "expired"): Promise<BrowserSessionView> {
    const session = this.require(id);
    if (session.state === "closed" || session.state === "interrupted") return this.view(session);
    session.state = "closing";
    this.persist();
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    await session.controller?.close().catch(() => undefined);
    this.stopProcesses(session.profileDir, session.pid);
    this.removeProfile(session.profileDir);
    session.controller = null;
    session.pid = null;
    session.screenshot = null;
    session.state = "closed";
    session.error = reasonCode === "expired" ? { code: "session_expired", message: "The browser session expired." } : null;
    this.note("browser.session.closed", id, { sessionId: id, reasonCode }, `browser.session.closed:${id}:${reasonCode}`);
    this.persist();
    return this.view(session);
  }

  private async fail(session: LiveSession, error: unknown): Promise<void> {
    const failure = error instanceof BrowserSessionError ? error : new BrowserSessionError("The browser process failed.", 500, "browser_crashed");
    session.state = "failed";
    session.error = { code: failure.code, message: failure.message };
    if (session.timer) clearTimeout(session.timer);
    await session.controller?.close().catch(() => undefined);
    this.stopProcesses(session.profileDir, session.pid);
    this.removeProfile(session.profileDir);
    session.controller = null;
    session.pid = null;
    this.note("browser.session.failed", session.id, { sessionId: session.id, reasonCode: failure.code }, `browser.session.failed:${session.id}`);
    this.persist();
  }

  private require(id: string): LiveSession {
    if (!SESSION_ID.test(id)) throw new BrowserSessionError("Unknown browser session.", 404, "not_found");
    const session = this.sessions.get(id);
    if (!session) throw new BrowserSessionError("Unknown browser session.", 404, "not_found");
    return session;
  }

  private async requireUsable(id: string): Promise<LiveSession> {
    const session = this.require(id);
    if (session.taskOwned) throw new BrowserSessionError("That session belongs to a task.", 404, "not_found");
    await this.expireIfDue(session);
    if (session.state === "closed") throw new BrowserSessionError(session.error?.message ?? "The browser session is closed.", 409, session.error?.code === "session_expired" ? "session_expired" : "session_closed");
    if (session.state === "failed" || session.state === "interrupted") {
      throw new BrowserSessionError(session.error?.message ?? "The browser session is not running.", 409, "session_failed");
    }
    if (session.state !== "active") throw new BrowserSessionError("The browser session is not running.", 409, "session_failed");
    return session;
  }

  private async expireIfDue(session: LiveSession): Promise<void> {
    if (session.state !== "active") return;
    const now = this.now();
    if (now < session.createdAt + BROWSER_LIMITS.maxLifetimeMs && now < session.lastActivityAt + BROWSER_LIMITS.idleTimeoutMs) return;
    await this.closeLocked(session.id, "expired");
  }

  private touch(session: LiveSession): void {
    session.lastActivityAt = this.now();
    if (session.timer) clearTimeout(session.timer);
    const due = Math.min(session.createdAt + BROWSER_LIMITS.maxLifetimeMs, session.lastActivityAt + BROWSER_LIMITS.idleTimeoutMs);
    const delay = Math.max(0, due - this.now());
    const timer = setTimeout(() => {
      void this.exclusive(() => this.expireIfDue(session));
    }, delay);
    timer.unref?.();
    session.timer = timer;
  }

  private async engineFor(): Promise<BrowserEngine> {
    if (this.engine) return this.engine;
    this.engine = await createPlaywrightBrowserEngine();
    return this.engine;
  }

  private view(session: LiveSession): BrowserSessionView {
    const state: BrowserSessionView["state"] = session.state === "interrupted" ? "failed" : session.state;
    return {
      id: session.id,
      createdAt: session.createdAt,
      url: session.url,
      history: [...session.history],
      state,
      ownerId: "owner",
      approvedOrigins: [...session.approvedOrigins],
      expiresAt: session.createdAt + BROWSER_LIMITS.maxLifetimeMs,
      idleTimeoutMs: BROWSER_LIMITS.idleTimeoutMs,
      lastActivityAt: session.lastActivityAt,
      pid: session.pid,
      pageTitle: session.pageTitle,
      error: session.error,
      storage: "ephemeral-session-profile",
      agentControl: "unavailable",
    };
  }

  private note(eventType: BrowserJournalEvent["eventType"], sessionId: string, payload: Record<string, string | number | boolean>, idempotencyKey: string): void {
    if (this.sent.has(idempotencyKey)) return;
    this.sent.add(idempotencyKey);
    try {
      this.journal?.({ eventType, sessionId, idempotencyKey, payload });
    } catch {
      // The session outcome stays authoritative if the journal rejects a write.
    }
  }

  private stopProcesses(profileDir: string, pid: number | null): void {
    const pids = new Set(pidsForProfile(profileDir));
    if (pid && pid > 1 && pid !== process.pid) pids.add(pid);
    for (const candidate of pids) {
      try { process.kill(candidate, "SIGTERM"); } catch { /* already exited */ }
    }
  }

  /**
   * Exit path. The process is signalled and then given a bounded moment to leave. Removing the
   * profile while Chromium is still writing into it left the folder behind (Direction 19).
   */
  private stopProcessesAndWait(profileDir: string, pid: number | null): void {
    const pids = () => {
      const found = new Set(pidsForProfile(profileDir));
      if (pid && pid > 1 && pid !== process.pid) found.add(pid);
      return [...found].filter((candidate) => { try { process.kill(candidate, 0); return true; } catch { return false; } });
    };
    const settle = (signal: NodeJS.Signals, budgetMs: number) => {
      const live = pids();
      for (const candidate of live) { try { process.kill(candidate, signal); } catch { /* already exited */ } }
      const end = Date.now() + budgetMs;
      while (Date.now() < end && pids().length > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    };
    settle("SIGTERM", 1_500);
    if (pids().length > 0) settle("SIGKILL", 500);
  }

  private removeProfile(profileDir: string, retry = false): void {
    if (!isOwnedProfile(this.options.root, profileDir)) return;
    for (let attempt = 0; attempt < (retry ? 4 : 1); attempt++) {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* retried on the next reconcile */ }
      if (!existsSync(profileDir)) return;
      if (retry) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  private persist(): void {
    const records: RegistryRecord[] = [...this.sessions.values()].slice(-30).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      state: session.state,
      profileDir: session.profileDir,
      pid: session.pid,
    }));
    const target = path.join(this.options.root, "registry.json");
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ sessions: records }), { mode: 0o600 });
    renameSync(temporary, target);
  }

  private readRegistry(): RegistryRecord[] {
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.options.root, "registry.json"), "utf8")) as { sessions?: unknown };
      if (!Array.isArray(parsed.sessions)) return [];
      return parsed.sessions.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Partial<RegistryRecord>;
        if (typeof record.id !== "string" || !SESSION_ID.test(record.id)) return [];
        if (typeof record.profileDir !== "string" || typeof record.createdAt !== "number") return [];
        if (record.state !== "starting" && record.state !== "active" && record.state !== "closing" && record.state !== "closed" && record.state !== "failed" && record.state !== "interrupted") return [];
        return [{
          id: record.id,
          createdAt: record.createdAt,
          state: record.state,
          profileDir: record.profileDir,
          pid: typeof record.pid === "number" ? record.pid : null,
        }];
      });
    } catch {
      return [];
    }
  }

  private exclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function isOwnedProfile(root: string, profileDir: string): boolean {
  const relative = path.relative(root, profileDir);
  if (!SESSION_ID.test(relative)) return false;
  try {
    const stat = lstatSync(profileDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const rootReal = realpathSync(root);
    const profileReal = realpathSync(profileDir);
    return path.relative(rootReal, profileReal) === relative;
  } catch {
    return false;
  }
}

export function closeLiveBrowserSessionsSync(): void {
  for (const manager of managers) {
    try { manager.closeSync(); } catch { /* exit cleanup is best-effort */ }
  }
}

process.on("exit", closeLiveBrowserSessionsSync);

let defaultManager: BrowserSessionManager | null = null;

/** Test seam. The first real use builds the default manager when this stays unset. */
export function useBrowserSessionManager(manager: BrowserSessionManager | null): void {
  defaultManager = manager;
}

export async function defaultBrowserSessionManager(): Promise<BrowserSessionManager> {
  if (defaultManager) return defaultManager;
  const { dataDir, db } = await import("./db.ts");
  const { ActivityJournalCore } = await import("./activity-journal-core.ts");
  const isQaOrTest = Boolean(nativeQaRoot()) || process.env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE === "1" || process.env.NODE_ENV === "test";
  const mode: BrowserPolicyMode = isQaOrTest && process.env.FORGEORBIT_BROWSER_ALLOW_LOOPBACK_FIXTURE === "1" ? "loopback-fixture" : "production";
  defaultManager = new BrowserSessionManager({
    root: path.join(dataDir, "browser-sessions"),
    mode,
    journal(event) {
      new ActivityJournalCore(db).record({
        eventType: event.eventType,
        actorType: "owner",
        actorId: "owner",
        targetType: "browser-session",
        targetId: event.sessionId,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload,
      });
    },
  });
  return defaultManager;
}

export async function reconcileBrowserSessionsOnBoot(): Promise<void> {
  try {
    const manager = await defaultBrowserSessionManager();
    await manager.reconcileInterrupted();
  } catch (error) {
    console.warn(`[browser] session reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function auditDestination(raw: string): { destinationHost: string; destinationOrigin: string } {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { destinationHost: "", destinationOrigin: "" };
    return { destinationHost: url.hostname, destinationOrigin: url.origin };
  } catch {
    return { destinationHost: "", destinationOrigin: "" };
  }
}
