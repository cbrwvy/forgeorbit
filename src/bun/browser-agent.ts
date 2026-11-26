/**
 * FO-BROWSER02 grant store and one-action execution.
 * BrowserSessionManager remains the only browser. This module does not launch
 * a browser, start a model, or replay a navigation after a restart.
 */

import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { decideDestination } from "../shared/browser/policy.ts";
import {
  BROWSER_AGENT_ALLOWED_ACTIONS,
  BROWSER_AGENT_LIMITS,
  boundBrowserObservation,
  isBrowserGrantId,
  isBrowserSessionId,
  observationLooksBound,
  parseBrowserAction,
  type BrowserActionView,
  type BrowserAgentAction,
  type BrowserAgentGrantView,
  type BrowserAgentManager,
  type BrowserAgentObservation,
  type BrowserAgentTarget,
} from "../shared/browser/agent.ts";
import type { BrowserObservation } from "../shared/browser/types.ts";
import type { ActivityEventType } from "../shared/activity/types.ts";
import { BrowserSessionError } from "./browser-session-error.ts";
import type { BrowserSessionManager, BrowserSessionSnapshot } from "./browser-session.ts";

export interface BrowserAgentJournalEvent {
  eventType: Extract<ActivityEventType, `browser.agent.${string}`>;
  grantId: string;
  sessionId: string;
  idempotencyKey: string;
  payload: Record<string, string>;
}

interface GrantRow {
  id: string;
  manager_kind: BrowserAgentManager;
  project_path: string | null;
  session_id: string;
  observation_id: string;
  observed_at: number;
  observation_json: string;
  approved_origins_json: string;
  status: BrowserAgentGrantView["status"];
  action_status: "none" | "claimed" | "completed" | "refused" | "interrupted";
  action_json: string | null;
  outcome_json: string | null;
  claim_token: string | null;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
  message_id: string | null;
  turn_id: string | null;
  detail: string | null;
}

export type AgentResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface ClaimedBrowserAction {
  view: BrowserActionView;
  execute: BrowserAgentAction | null;
  claimToken: string | null;
}

function fail<T>(status: number, error: string): AgentResult<T> {
  return { ok: false, status, error };
}

function targetKey(target: BrowserAgentTarget): { kind: BrowserAgentManager; path: string } {
  return { kind: target.managerKind, path: target.projectPath ?? "" };
}

export class BrowserAgentGrantService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly journal?: (event: BrowserAgentJournalEvent) => void,
  ) {}

  recover(): { expired: number; interrupted: number } {
    const now = this.now();
    const expired = this.db.run(
      `UPDATE browser_agent_grants SET status = 'expired', settled_at = ?, detail = 'app restarted before the message was sent'
        WHERE status = 'approved'`,
      [now],
    ).changes;
    const claimed = this.db.query<GrantRow, []>(
      `SELECT * FROM browser_agent_grants WHERE status = 'consumed' AND action_status = 'claimed'`,
    ).all();
    let interrupted = 0;
    for (const row of claimed) {
      const changed = this.db.run(
        `UPDATE browser_agent_grants SET action_status = 'interrupted', settled_at = ?, detail = 'restart before the browser action finished',
          outcome_json = ?
          WHERE id = ? AND action_status = 'claimed'`,
        [now, JSON.stringify({ reasonCode: "restart" }), row.id],
      ).changes;
      if (changed === 1) {
        interrupted += 1;
        this.note("browser.agent.action.interrupted", row, `browser.agent.action.interrupted:${row.id}`, {
          grantId: row.id,
          sessionId: row.session_id,
          managerKind: row.manager_kind,
          reasonCode: "restart",
        });
      }
    }
    return { expired, interrupted };
  }

  approve(
    target: BrowserAgentTarget,
    sessionId: string,
    origins: string[],
    observation: BrowserObservation,
  ): AgentResult<BrowserAgentGrantView> {
    if (!isBrowserSessionId(sessionId)) return fail(400, "Unknown browser session.");
    if (observation.sessionId !== sessionId) return fail(409, "The page observation is not from that session.");
    const bound = boundBrowserObservation(observation);
    const storedOrigins = [...new Set(origins)].slice(0, 4);
    const id = randomBytes(32).toString("hex");
    const now = this.now();
    const key = targetKey(target);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE browser_agent_grants SET status = 'revoked', settled_at = ?, detail = 'replaced by a newer permission'
          WHERE status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
        [now, key.kind, key.path],
      );
      this.db.run(
        `INSERT INTO browser_agent_grants (
          id, manager_kind, project_path, session_id, observation_id, observed_at, observation_json,
          approved_origins_json, allowed_actions_json, max_actions, status, action_status, approved_by,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 'none', 'owner', ?, ?)`,
        [
          id,
          key.kind,
          target.projectPath,
          sessionId,
          bound.observationId,
          bound.observedAt,
          JSON.stringify(bound),
          JSON.stringify(storedOrigins),
          JSON.stringify(BROWSER_AGENT_ALLOWED_ACTIONS),
          now,
          now + BROWSER_AGENT_LIMITS.grantTtlMs,
        ],
      );
    }).immediate();
    const row = this.row(id)!;
    this.note("browser.agent.granted", row, `browser.agent.granted:${id}`, {
      grantId: id,
      sessionId,
      managerKind: key.kind,
    });
    return { ok: true, value: this.view(row) };
  }

  revoke(target: BrowserAgentTarget, grantId: string): AgentResult<{ revoked: boolean }> {
    if (!isBrowserGrantId(grantId)) return fail(400, "Unknown browser permission.");
    const key = targetKey(target);
    const row = this.row(grantId);
    const changed = this.db.run(
      `UPDATE browser_agent_grants SET status = 'revoked', settled_at = ?, detail = 'cancelled by the owner'
        WHERE id = ? AND status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [this.now(), grantId, key.kind, key.path],
    ).changes;
    if (changed === 1 && row) {
      this.note("browser.agent.revoked", row, `browser.agent.revoked:${grantId}`, {
        grantId,
        sessionId: row.session_id,
        managerKind: key.kind,
      });
    }
    return { ok: true, value: { revoked: changed === 1 } };
  }

  get(target: BrowserAgentTarget, grantId: string): AgentResult<BrowserAgentGrantView> {
    if (!isBrowserGrantId(grantId)) return fail(400, "Unknown browser permission.");
    const row = this.matching(target, grantId);
    if (!row) return fail(404, "That browser permission was not found.");
    return { ok: true, value: this.view(this.expireIfDue(row)) };
  }

  consume(
    target: BrowserAgentTarget,
    grantId: string,
    messageId: string,
    turnId: string,
    live: BrowserSessionSnapshot | null,
  ): AgentResult<BrowserAgentObservation> {
    if (!isBrowserGrantId(grantId)) return fail(400, "Unknown browser permission.");
    const key = targetKey(target);
    const now = this.now();
    const existing = this.row(grantId);
    if (!existing || existing.manager_kind !== key.kind || (existing.project_path ?? "") !== key.path) {
      return fail(409, "The browser permission is not valid for this manager.");
    }
    if (existing.status === "approved" && existing.expires_at <= now) {
      this.db.run(
        `UPDATE browser_agent_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent'
          WHERE id = ? AND status = 'approved'`,
        [now, grantId],
      );
      return fail(409, "The browser permission expired. Allow the page again if you still want the manager to see it.");
    }
    const origins = parseOrigins(existing.approved_origins_json);
    if (!live || live.id !== existing.session_id || live.state !== "active" || live.observationId !== existing.observation_id || !sameOrigins(live.approvedOrigins, origins)) {
      this.db.run(
        `UPDATE browser_agent_grants SET status = 'rejected', settled_at = ?, detail = 'session or observation changed before the message was sent'
          WHERE id = ? AND status = 'approved'`,
        [now, grantId],
      );
      return fail(409, "That page is no longer the current page in the selected session. Allow browser access again.");
    }
    const spent = this.db.run(
      `UPDATE browser_agent_grants SET status = 'consumed', settled_at = ?, message_id = ?, turn_id = ?
        WHERE id = ? AND status = 'approved' AND expires_at > ? AND manager_kind = ? AND IFNULL(project_path, '') = ?
          AND session_id = ? AND observation_id = ?`,
      [now, messageId, turnId, grantId, now, key.kind, key.path, live.id, live.observationId],
    ).changes;
    if (spent !== 1) return fail(409, "The browser permission is not valid any more. Allow the page again.");
    const observation = parseObservation(this.row(grantId)?.observation_json);
    if (!observation) {
      this.db.run(`UPDATE browser_agent_grants SET status = 'rejected', detail = 'unreadable observation' WHERE id = ?`, [grantId]);
      return fail(409, "The saved page observation is not usable. Allow browser access again.");
    }
    return { ok: true, value: observation };
  }

  async claim(
    target: BrowserAgentTarget,
    grantId: string,
    messageId: string,
    turnId: string,
    replyText: string,
    live: BrowserSessionSnapshot | null,
    resolveHost?: (host: string) => Promise<string[]>,
  ): Promise<AgentResult<ClaimedBrowserAction>> {
    const key = targetKey(target);
    const row = this.row(grantId);
    if (!row || row.manager_kind !== key.kind || (row.project_path ?? "") !== key.path || row.message_id !== messageId || row.turn_id !== turnId) {
      return fail(409, "The browser permission does not belong to this message.");
    }
    if (row.action_status !== "none" || row.status !== "consumed") {
      return { ok: true, value: { view: viewFromRow(row), execute: null, claimToken: null } };
    }
    const parsed = parseBrowserAction(replyText);
    if (!parsed.present || (parsed.ok && parsed.action.kind === "none")) {
      return { ok: true, value: { view: this.settleNone(row), execute: null, claimToken: null } };
    }
    if (!parsed.ok) {
      return { ok: true, value: { view: this.refuse(row, null, "malformed", parsed.reason), execute: null, claimToken: null } };
    }
    const observation = parseObservation(row.observation_json);
    if (!observation || !live || live.id !== row.session_id || live.state !== "active" || live.observationId !== row.observation_id) {
      return { ok: true, value: { view: this.refuse(row, parsed.action, "link_stale", "The page changed before the action could run."), execute: null, claimToken: null } };
    }
    if (!sameOrigins(live.approvedOrigins, parseOrigins(row.approved_origins_json))) {
      return { ok: true, value: { view: this.refuse(row, parsed.action, "origin_not_approved", "The session origins changed."), execute: null, claimToken: null } };
    }
    const decision = await this.destinationFor(parsed.action, observation, live, resolveHost);
    if (!decision.ok) {
      return { ok: true, value: { view: this.refuse(row, parsed.action, decision.code, decision.error), execute: null, claimToken: null } };
    }
    const token = randomBytes(16).toString("hex");
    const claimed = this.db.run(
      `UPDATE browser_agent_grants SET action_status = 'claimed', claim_token = ?, action_json = ?, settled_at = ?
        WHERE id = ? AND status = 'consumed' AND action_status = 'none' AND message_id = ? AND turn_id = ?`,
      [token, JSON.stringify(parsed.action), this.now(), row.id, messageId, turnId],
    ).changes;
    if (claimed !== 1) {
      return { ok: true, value: { view: viewFromRow(this.row(row.id)!), execute: null, claimToken: null } };
    }
    return {
      ok: true,
      value: {
        view: actionView(row, parsed.action.kind, "accepted", null, decision.host),
        execute: parsed.action,
        claimToken: token,
      },
    };
  }

  finish(grantId: string, claimToken: string, outcome: { ok: true; host: string | null } | { ok: false; reasonCode: string }): BrowserActionView | null {
    const row = this.row(grantId);
    if (!row || row.claim_token !== claimToken || row.action_status !== "claimed") return row ? viewFromRow(row) : null;
    const action = parseStoredAction(row.action_json);
    if (outcome.ok) {
      this.db.run(
        `UPDATE browser_agent_grants SET action_status = 'completed', outcome_json = ?, settled_at = ? WHERE id = ? AND claim_token = ? AND action_status = 'claimed'`,
        [JSON.stringify({ host: outcome.host }), this.now(), grantId, claimToken],
      );
      const next = this.row(grantId)!;
      this.note("browser.agent.action.accepted", next, `browser.agent.action.accepted:${grantId}`, {
        grantId,
        sessionId: next.session_id,
        managerKind: next.manager_kind,
        actionKind: action?.kind ?? "none",
      });
      return viewFromRow(next);
    }
    this.db.run(
      `UPDATE browser_agent_grants SET action_status = 'refused', outcome_json = ?, detail = ?, settled_at = ? WHERE id = ? AND claim_token = ? AND action_status = 'claimed'`,
      [JSON.stringify({ reasonCode: outcome.reasonCode }), outcome.reasonCode, this.now(), grantId, claimToken],
    );
    const next = this.row(grantId)!;
    this.note("browser.agent.action.refused", next, `browser.agent.action.refused:${grantId}`, {
      grantId,
      sessionId: next.session_id,
      managerKind: next.manager_kind,
      actionKind: action?.kind ?? "none",
      reasonCode: outcome.reasonCode,
    });
    return viewFromRow(next);
  }

  private settleNone(row: GrantRow): BrowserActionView {
    this.db.run(
      `UPDATE browser_agent_grants SET action_status = 'completed', action_json = ?, outcome_json = ?, settled_at = ?
        WHERE id = ? AND action_status = 'none'`,
      [JSON.stringify({ kind: "none" }), JSON.stringify({ host: null }), this.now(), row.id],
    );
    const next = this.row(row.id)!;
    this.note("browser.agent.action.accepted", next, `browser.agent.action.accepted:${row.id}`, {
      grantId: row.id,
      sessionId: row.session_id,
      managerKind: row.manager_kind,
      actionKind: "none",
    });
    return viewFromRow(next);
  }

  private refuse(row: GrantRow, action: BrowserAgentAction | null, reasonCode: string, detail: string): BrowserActionView {
    this.db.run(
      `UPDATE browser_agent_grants SET action_status = 'refused', action_json = ?, outcome_json = ?, detail = ?, settled_at = ?
        WHERE id = ? AND action_status = 'none'`,
      [action ? JSON.stringify(action) : null, JSON.stringify({ reasonCode }), detail, this.now(), row.id],
    );
    const next = this.row(row.id)!;
    this.note("browser.agent.action.refused", next, `browser.agent.action.refused:${row.id}`, {
      grantId: row.id,
      sessionId: row.session_id,
      managerKind: row.manager_kind,
      actionKind: action?.kind ?? "none",
      reasonCode,
    });
    return viewFromRow(next);
  }

  private async destinationFor(
    action: BrowserAgentAction,
    observation: BrowserAgentObservation,
    live: BrowserSessionSnapshot,
    resolveHost?: (host: string) => Promise<string[]>,
  ): Promise<{ ok: true; host: string | null } | { ok: false; code: string; error: string }> {
    if (action.kind === "none") return { ok: true, host: null };
    if (action.kind === "open_link") {
      const link = observation.links.find((item) => item.id === action.linkId);
      if (!link || !link.permitted) return { ok: false, code: "link_not_permitted", error: "That link is not permitted." };
      const decision = await decideDestination(link.href, { mode: live.mode, approvedOrigins: live.approvedOrigins }, resolveHost);
      if (!decision.ok) return decision;
      return { ok: true, host: decision.host };
    }
    if (action.kind === "back") {
      const previous = live.history.length >= 2 ? live.history[live.history.length - 2] : undefined;
      if (!previous) return { ok: false, code: "no_history", error: "There is no previous page in this session." };
      const decision = await decideDestination(previous, { mode: live.mode, approvedOrigins: live.approvedOrigins }, resolveHost);
      if (!decision.ok) return decision;
      return { ok: true, host: decision.host };
    }
    const decision = await decideDestination(action.url, { mode: live.mode, approvedOrigins: live.approvedOrigins }, resolveHost);
    if (!decision.ok) return decision;
    return { ok: true, host: decision.host };
  }

  private row(id: string): GrantRow | null {
    return this.db.query<GrantRow, [string]>("SELECT * FROM browser_agent_grants WHERE id = ?").get(id) ?? null;
  }

  private matching(target: BrowserAgentTarget, id: string): GrantRow | null {
    const key = targetKey(target);
    const row = this.row(id);
    if (!row || row.manager_kind !== key.kind || (row.project_path ?? "") !== key.path) return null;
    return row;
  }

  private expireIfDue(row: GrantRow): GrantRow {
    if (row.status === "approved" && row.expires_at <= this.now()) {
      this.db.run(
        `UPDATE browser_agent_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent' WHERE id = ? AND status = 'approved'`,
        [this.now(), row.id],
      );
      return this.row(row.id) ?? row;
    }
    return row;
  }

  private view(row: GrantRow): BrowserAgentGrantView {
    const observation = parseObservation(row.observation_json) ?? emptyObservation(row);
    return {
      grantId: row.id,
      managerKind: row.manager_kind,
      projectPath: row.project_path,
      sessionId: row.session_id,
      observationId: row.observation_id,
      observedAt: row.observed_at,
      approvedOrigins: parseOrigins(row.approved_origins_json),
      allowedActions: BROWSER_AGENT_ALLOWED_ACTIONS,
      maxActions: 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      status: row.status,
      observation,
      pageTitle: observation.title,
      pageUrl: observation.url,
    };
  }

  private note(eventType: BrowserAgentJournalEvent["eventType"], row: GrantRow, idempotencyKey: string, payload: Record<string, string>): void {
    try {
      this.journal?.({ eventType, grantId: row.id, sessionId: row.session_id, idempotencyKey, payload });
    } catch {
      // The grant row stays authoritative if the journal rejects a write.
    }
  }
}

function viewFromRow(row: GrantRow): BrowserActionView {
  const action = parseStoredAction(row.action_json);
  const outcome = parseOutcome(row.outcome_json);
  if (row.action_status === "interrupted") {
    return actionView(row, action?.kind ?? null, "interrupted", outcome.reasonCode ?? "restart", outcome.host);
  }
  if (row.action_status === "refused") {
    return actionView(row, action?.kind ?? null, outcome.reasonCode === "malformed" ? "ignored" : "refused", outcome.reasonCode, outcome.host);
  }
  if (row.action_status === "completed") {
    return actionView(row, action?.kind ?? "none", "accepted", null, outcome.host);
  }
  return actionView(row, action?.kind ?? null, "refused", "duplicate", outcome.host);
}

function actionView(
  row: GrantRow,
  kind: BrowserActionView["kind"],
  status: BrowserActionView["status"],
  reasonCode: string | null,
  destinationHost: string | null,
): BrowserActionView {
  return { grantId: row.id, sessionId: row.session_id, kind, status, reasonCode, destinationHost };
}

function parseObservation(json: string | null | undefined): BrowserAgentObservation | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (!observationLooksBound(value)) return null;
    if (typeof value.visibleText !== "string" || typeof value.title !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function parseOrigins(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseStoredAction(json: string | null): BrowserAgentAction | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as BrowserAgentAction;
    if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function parseOutcome(json: string | null): { reasonCode: string | null; host: string | null } {
  if (!json) return { reasonCode: null, host: null };
  try {
    const value = JSON.parse(json) as { reasonCode?: unknown; host?: unknown };
    return {
      reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
      host: typeof value.host === "string" ? value.host : null,
    };
  } catch {
    return { reasonCode: null, host: null };
  }
}

function sameOrigins(live: readonly string[], stored: readonly string[]): boolean {
  if (live.length !== stored.length) return false;
  return live.every((origin, index) => origin === stored[index]);
}

function emptyObservation(row: GrantRow): BrowserAgentObservation {
  return {
    sessionId: row.session_id,
    observationId: row.observation_id,
    url: null,
    title: "",
    visibleText: "",
    textChars: 0,
    textTruncated: false,
    links: [],
    linksTruncated: false,
    observedAt: row.observed_at,
    untrusted: true,
  };
}

export interface BrowserActionSettlement {
  record: BrowserActionView | null;
  note: string | null;
}

export async function settleBrowserAgentAction(
  grants: BrowserAgentGrantService,
  manager: BrowserSessionManager,
  input: {
    target: BrowserAgentTarget;
    grantId: string | null;
    messageId: string;
    turnId: string;
    replyText: string;
  },
): Promise<BrowserActionSettlement> {
  const parsed = parseBrowserAction(input.replyText);
  if (!input.grantId) {
    if (!parsed.present) return { record: null, note: null };
    return {
      record: {
        grantId: null,
        sessionId: null,
        kind: parsed.ok ? parsed.action.kind : null,
        status: "ignored",
        reasonCode: "not_authorized",
        destinationHost: null,
      },
      note: "A browser action was ignored because this message was not allowed to use the browser.",
    };
  }
  const known = grants.get(input.target, input.grantId);
  const live = known.ok ? await manager.snapshot(known.value.sessionId) : null;
  const claimed = await grants.claim(input.target, input.grantId, input.messageId, input.turnId, input.replyText, live, manager.hostResolver());
  if (!claimed.ok) return { record: null, note: claimed.error };
  if (!claimed.value.execute || !claimed.value.claimToken) {
    const view = claimed.value.view;
    const note = view.status === "ignored"
      ? "The browser action could not be read, so the page was left unchanged."
      : view.status === "refused"
        ? "The browser action was refused, so the page was left unchanged."
        : view.status === "interrupted"
          ? "The browser action was interrupted and was not run again."
          : null;
    return { record: view, note };
  }
  const sessionId = claimed.value.view.sessionId;
  if (!sessionId) return { record: claimed.value.view, note: "The browser session was not available." };
  try {
    const action = claimed.value.execute;
    if (action.kind === "navigate") await manager.navigate(sessionId, action.url);
    else if (action.kind === "open_link") {
      const observationId = live?.observationId;
      if (!observationId) throw new BrowserSessionError("That page observation is no longer current.", 409, "link_stale");
      await manager.openLink(sessionId, observationId, action.linkId);
    } else if (action.kind === "back") await manager.back(sessionId);
    const record = grants.finish(input.grantId, claimed.value.claimToken, { ok: true, host: claimed.value.view.destinationHost });
    return { record, note: null };
  } catch (error) {
    const reasonCode = error instanceof BrowserSessionError ? error.code : "browser_crashed";
    const record = grants.finish(input.grantId, claimed.value.claimToken, { ok: false, reasonCode });
    return { record, note: "The browser action failed and was not retried." };
  }
}

let defaultService: BrowserAgentGrantService | null = null;

export async function loadBrowserAgentGrants(): Promise<BrowserAgentGrantService> {
  if (defaultService) return defaultService;
  const { db } = await import("./db.ts");
  const { ActivityJournalCore } = await import("./activity-journal-core.ts");
  defaultService = new BrowserAgentGrantService(db, () => Date.now(), (event) => {
    new ActivityJournalCore(db).record({
      eventType: event.eventType,
      actorType: event.eventType === "browser.agent.granted" || event.eventType === "browser.agent.revoked" ? "owner" : "system",
      actorId: event.payload.managerKind ?? "owner",
      targetType: "browser-session",
      targetId: event.sessionId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    });
  });
  return defaultService;
}

export async function recoverBrowserAgentGrants(): Promise<{ expired: number; interrupted: number }> {
  return (await loadBrowserAgentGrants()).recover();
}

export function useBrowserAgentGrants(service: BrowserAgentGrantService | null): void {
  defaultService = service;
}
