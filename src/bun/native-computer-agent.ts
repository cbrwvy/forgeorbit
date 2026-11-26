/**
 * FO-NATIVE-CU02 grant store and one-action execution.
 * NativeComputerSessionManager remains the only native computer controller.
 * This module does not launch applications, start a model, or replay an action after restart.
 */

import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  NATIVE_AGENT_ALLOWED_ACTIONS,
  NATIVE_AGENT_LIMITS,
  boundNativeObservation,
  isNativeGrantId,
  isNativeSessionId,
  nativeObservationLooksBound,
  parseNativeAction,
  type NativeActionStatus,
  type NativeActionView,
  type NativeAgentAction,
  type NativeAgentGrantView,
  type NativeAgentManager,
  type NativeAgentObservation,
  type NativeAgentTarget,
} from "../shared/native-computer/agent.ts";
import { isExcludedApplication, isExcludedWindow } from "../shared/native-computer/policy.ts";
import { FIXTURE_BUNDLE_ID, OPEN_MENU_ACTION, PRESS_ACTION, SCROLL_ACTION, SELECT_MENU_ITEM_ACTION, SELECT_TAB_ACTION, SET_TEXT_ACTION, type NativeAction, type NativeObservation, type NativeSessionView } from "../shared/native-computer/types.ts";
import type { ActivityEventType } from "../shared/activity/types.ts";
import { NativeComputerError } from "./native-computer-error.ts";
import type { NativeComputerSessionManager } from "./native-computer-session.ts";

export interface NativeAgentJournalEvent {
  eventType: Extract<ActivityEventType, `native.agent.${string}`>;
  grantId: string;
  sessionId: string;
  idempotencyKey: string;
  payload: Record<string, string>;
}

interface GrantRow {
  id: string;
  manager_kind: NativeAgentManager;
  project_path: string | null;
  session_id: string;
  observation_id: string;
  bundle_id: string;
  pid: number;
  start_sec: number;
  start_usec: number;
  window_id: number;
  observed_at: number;
  observation_json: string;
  allowed_actions_json: string;
  status: NativeAgentGrantView["status"];
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

export interface ClaimedNativeAction {
  view: NativeActionView;
  execute: NativeAgentAction | null;
  claimToken: string | null;
}

function fail<T>(status: number, error: string): AgentResult<T> {
  return { ok: false, status, error };
}

function targetKey(target: NativeAgentTarget): { kind: NativeAgentManager; path: string } {
  return { kind: target.managerKind, path: target.projectPath ?? "" };
}

export class NativeAgentGrantService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly journal?: (event: NativeAgentJournalEvent) => void,
  ) {}

  recover(): { expired: number; interrupted: number } {
    const now = this.now();
    const expired = this.db.run(
      `UPDATE native_computer_agent_grants SET status = 'expired', settled_at = ?, detail = 'app restarted before the message was sent'
        WHERE status = 'approved'`,
      [now],
    ).changes;
    const claimed = this.db.query<GrantRow, []>(
      `SELECT * FROM native_computer_agent_grants WHERE status = 'consumed' AND action_status = 'claimed'`,
    ).all();
    let interrupted = 0;
    for (const row of claimed) {
      const changed = this.db.run(
        `UPDATE native_computer_agent_grants SET action_status = 'interrupted', settled_at = ?, detail = 'restart before the native action finished',
          outcome_json = ?
          WHERE id = ? AND action_status = 'claimed'`,
        [now, JSON.stringify({ reasonCode: "restart" }), row.id],
      ).changes;
      if (changed === 1) {
        interrupted += 1;
        this.note("native.agent.action.interrupted", row, `native.agent.action.interrupted:${row.id}`, {
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
    target: NativeAgentTarget,
    sessionId: string,
    observation: NativeObservation,
  ): AgentResult<NativeAgentGrantView> {
    if (!isNativeSessionId(sessionId)) return fail(400, "Unknown native session.");
    if (observation.sessionId !== sessionId) return fail(409, "The window observation is not from that session.");
    const bound = boundNativeObservation(observation);
    const id = randomBytes(32).toString("hex");
    const now = this.now();
    const key = targetKey(target);
    const appCheck = isExcludedApplication(observation.application.bundleId, observation.application.executablePath);
    const winCheck = isExcludedWindow(observation.window);
    const allowedActions = (!appCheck.excluded && !winCheck.excluded) ? NATIVE_AGENT_ALLOWED_ACTIONS : [];
    this.db.transaction(() => {
      this.db.run(
        `UPDATE native_computer_agent_grants SET status = 'revoked', settled_at = ?, detail = 'replaced by a newer permission'
          WHERE status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
        [now, key.kind, key.path],
      );
      this.db.run(
        `INSERT INTO native_computer_agent_grants (
          id, manager_kind, project_path, session_id, observation_id, bundle_id, pid, start_sec, start_usec,
          window_id, observed_at, observation_json, allowed_actions_json, max_actions, status, action_status, approved_by,
          created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', 'none', 'owner', ?, ?)`,
        [
          id,
          key.kind,
          target.projectPath,
          sessionId,
          bound.observationId,
          bound.application.bundleId,
          bound.application.pid,
          bound.application.startSec,
          bound.application.startUsec,
          bound.window.windowId,
          bound.observedAt,
          JSON.stringify(bound),
          JSON.stringify(allowedActions),
          now,
          now + NATIVE_AGENT_LIMITS.grantTtlMs,
        ],
      );
    }).immediate();
    const row = this.row(id)!;
    this.note("native.agent.granted", row, `native.agent.granted:${id}`, {
      grantId: id,
      sessionId,
      managerKind: key.kind,
    });
    return { ok: true, value: this.view(row) };
  }

  revoke(target: NativeAgentTarget, grantId: string): AgentResult<{ revoked: boolean }> {
    if (!isNativeGrantId(grantId)) return fail(400, "Unknown native permission.");
    const key = targetKey(target);
    const row = this.row(grantId);
    const changed = this.db.run(
      `UPDATE native_computer_agent_grants SET status = 'revoked', settled_at = ?, detail = 'cancelled by the owner'
        WHERE id = ? AND status = 'approved' AND manager_kind = ? AND IFNULL(project_path, '') = ?`,
      [this.now(), grantId, key.kind, key.path],
    ).changes;
    if (changed === 1 && row) {
      this.note("native.agent.revoked", row, `native.agent.revoked:${grantId}`, {
        grantId,
        sessionId: row.session_id,
        managerKind: key.kind,
      });
    }
    return { ok: true, value: { revoked: changed === 1 } };
  }

  get(target: NativeAgentTarget, grantId: string): AgentResult<NativeAgentGrantView> {
    if (!isNativeGrantId(grantId)) return fail(400, "Unknown native permission.");
    const row = this.matching(target, grantId);
    if (!row) return fail(404, "That native permission was not found.");
    return { ok: true, value: this.view(this.expireIfDue(row)) };
  }

  consume(
    target: NativeAgentTarget,
    grantId: string,
    messageId: string,
    turnId: string,
    live: NativeSessionView | null,
  ): AgentResult<NativeAgentObservation> {
    if (!isNativeGrantId(grantId)) return fail(400, "Unknown native permission.");
    const key = targetKey(target);
    const now = this.now();
    const existing = this.row(grantId);
    if (!existing || existing.manager_kind !== key.kind || (existing.project_path ?? "") !== key.path) {
      return fail(409, "The native permission is not valid for this manager.");
    }
    if (existing.status === "approved" && existing.expires_at <= now) {
      this.db.run(
        `UPDATE native_computer_agent_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent'
          WHERE id = ? AND status = 'approved'`,
        [now, grantId],
      );
      return fail(409, "The native permission expired. Allow the application again if you still want the manager to see it.");
    }
    if (
      !live
      || live.id !== existing.session_id
      || live.status !== "active"
      || live.observationId !== existing.observation_id
      || live.application.bundleId !== existing.bundle_id
      || live.application.pid !== existing.pid
      || live.application.startSec !== existing.start_sec
      || live.application.startUsec !== existing.start_usec
      || live.window.windowId !== existing.window_id
    ) {
      this.db.run(
        `UPDATE native_computer_agent_grants SET status = 'rejected', settled_at = ?, detail = 'session or window changed before the message was sent'
          WHERE id = ? AND status = 'approved'`,
        [now, grantId],
      );
      return fail(409, "That window is no longer current in the selected native session. Allow native access again.");
    }
    const spent = this.db.run(
      `UPDATE native_computer_agent_grants SET status = 'consumed', settled_at = ?, message_id = ?, turn_id = ?
        WHERE id = ? AND status = 'approved' AND expires_at > ? AND manager_kind = ? AND IFNULL(project_path, '') = ?
          AND session_id = ? AND observation_id = ? AND bundle_id = ? AND pid = ? AND start_sec = ? AND start_usec = ? AND window_id = ?`,
      [now, messageId, turnId, grantId, now, key.kind, key.path, live.id, live.observationId, live.application.bundleId, live.application.pid, live.application.startSec, live.application.startUsec, live.window.windowId],
    ).changes;
    if (spent !== 1) return fail(409, "The native permission is not valid any more. Allow native access again.");
    const observation = parseObservation(this.row(grantId)?.observation_json);
    if (!observation) {
      this.db.run(`UPDATE native_computer_agent_grants SET status = 'rejected', detail = 'unreadable observation' WHERE id = ?`, [grantId]);
      return fail(409, "The saved window observation is not usable. Allow native access again.");
    }
    return { ok: true, value: observation };
  }

  async claim(
    target: NativeAgentTarget,
    grantId: string,
    messageId: string,
    turnId: string,
    replyText: string,
    live: NativeSessionView | null,
  ): Promise<AgentResult<ClaimedNativeAction>> {
    const key = targetKey(target);
    const row = this.row(grantId);
    if (!row || row.manager_kind !== key.kind || (row.project_path ?? "") !== key.path || row.message_id !== messageId || row.turn_id !== turnId) {
      return fail(409, "The native permission does not belong to this message.");
    }
    if (row.action_status !== "none" || row.status !== "consumed") {
      return { ok: true, value: { view: viewFromRow(row), execute: null, claimToken: null } };
    }
    const parsed = parseNativeAction(replyText);
    if (!parsed.present || (parsed.ok && parsed.action.kind === "none")) {
      return { ok: true, value: { view: this.settleNone(row), execute: null, claimToken: null } };
    }
    if (!parsed.ok) {
      return { ok: true, value: { view: this.refuse(row, null, "malformed", parsed.reason), execute: null, claimToken: null } };
    }
    const action = parsed.action;
    let requiredAction: NativeAction;
    if (action.kind === "press_accessible_button") requiredAction = PRESS_ACTION;
    else if (action.kind === "scroll_accessible_area") requiredAction = SCROLL_ACTION;
    else if (action.kind === "select_accessible_tab") requiredAction = SELECT_TAB_ACTION;
    else if (action.kind === "set_accessible_text") requiredAction = SET_TEXT_ACTION;
    else if (action.kind === "open_accessible_menu") requiredAction = OPEN_MENU_ACTION;
    else if (action.kind === "select_accessible_menu_item") requiredAction = SELECT_MENU_ITEM_ACTION;
    else {
      return { ok: true, value: { view: this.refuse(row, action, "action_not_permitted", "Unsupported action."), execute: null, claimToken: null } };
    }
    const observation = parseObservation(row.observation_json);
    if (!observation || !live || live.id !== row.session_id || live.status !== "active") {
      return { ok: true, value: { view: this.refuse(row, action, "session_closed", "The native session is closed."), execute: null, claimToken: null } };
    }
    if (live.observationId !== row.observation_id) {
      return { ok: true, value: { view: this.refuse(row, action, "stale_observation", "The window observation changed before the action could run."), execute: null, claimToken: null } };
    }
    if (
      live.application.bundleId !== row.bundle_id
      || live.application.pid !== row.pid
      || live.application.startSec !== row.start_sec
      || live.application.startUsec !== row.start_usec
    ) {
      return { ok: true, value: { view: this.refuse(row, action, "identity_mismatch", "The application identity or pid changed."), execute: null, claimToken: null } };
    }
    if (live.window.windowId !== row.window_id) {
      return { ok: true, value: { view: this.refuse(row, action, "window_mismatch", "The window identity changed."), execute: null, claimToken: null } };
    }
    const element = observation.elements.find((el) => el.id === action.elementId);
    if (!element) {
      return { ok: true, value: { view: this.refuse(row, action, "element_not_found", "The control is not in the observation."), execute: null, claimToken: null } };
    }
    if (action.kind === "set_accessible_text" && action.text.includes("\n") && element.role !== "AXTextArea") {
      return { ok: true, value: { view: this.refuse(row, action, "action_not_permitted", "Newline is only permitted in multiline text areas."), execute: null, claimToken: null } };
    }
    const allowedActions = parseAllowedActions(row.allowed_actions_json);
    const appCheck = isExcludedApplication(row.bundle_id, live.application.executablePath);
    const obsWinCheck = isExcludedWindow({ ...observation.window, width: live.window.width, height: live.window.height });
    const liveWinCheck = isExcludedWindow(live.window);
    if (!allowedActions.includes(requiredAction) || !element.actions.includes(requiredAction) || appCheck.excluded || obsWinCheck.excluded || liveWinCheck.excluded) {
      return {
        ok: true,
        value: {
          view: this.refuse(
            row,
            action,
            "action_not_permitted",
            appCheck.reason ?? obsWinCheck.reason ?? liveWinCheck.reason ?? "That action is not available for this control.",
          ),
          execute: null,
          claimToken: null,
        },
      };
    }
    if (requiredAction !== SCROLL_ACTION && !element.enabled) {
      return { ok: true, value: { view: this.refuse(row, action, "action_not_permitted", "That control is disabled."), execute: null, claimToken: null } };
    }
    const token = randomBytes(16).toString("hex");
    const persistedAction = action.kind === "set_accessible_text"
      ? { kind: "set_accessible_text", elementId: action.elementId, characterCount: Array.from(action.text).length }
      : action;
    const claimed = this.db.run(
      `UPDATE native_computer_agent_grants SET action_status = 'claimed', claim_token = ?, action_json = ?, settled_at = ?
        WHERE id = ? AND status = 'consumed' AND action_status = 'none' AND message_id = ? AND turn_id = ?`,
      [token, JSON.stringify(persistedAction), this.now(), row.id, messageId, turnId],
    ).changes;
    if (claimed !== 1) {
      return { ok: true, value: { view: viewFromRow(this.row(row.id)!), execute: null, claimToken: null } };
    }
    return {
      ok: true,
      value: {
        view: actionView(row, action.kind, "accepted", null, action.elementId),
        execute: action,
        claimToken: token,
      },
    };
  }

  finish(grantId: string, claimToken: string, outcome: { ok: true } | { ok: false; reasonCode: string; interrupted?: boolean }): NativeActionView | null {
    const row = this.row(grantId);
    if (!row || row.claim_token !== claimToken || row.action_status !== "claimed") return row ? viewFromRow(row) : null;
    const action = parseStoredAction(row.action_json);
    if (outcome.ok) {
      this.db.run(
        `UPDATE native_computer_agent_grants SET action_status = 'completed', outcome_json = '{}', settled_at = ? WHERE id = ? AND claim_token = ? AND action_status = 'claimed'`,
        [this.now(), grantId, claimToken],
      );
      const next = this.row(grantId)!;
      this.note("native.agent.action.accepted", next, `native.agent.action.accepted:${grantId}`, {
        grantId,
        sessionId: next.session_id,
        managerKind: next.manager_kind,
        actionKind: action?.kind ?? "none",
        ...(action && "characterCount" in action && typeof (action as any).characterCount === "number" ? { characterCount: String((action as any).characterCount) } : {}),
      });
      return viewFromRow(next);
    }
    const status = outcome.interrupted ? "interrupted" : "refused";
    this.db.run(
      `UPDATE native_computer_agent_grants SET action_status = ?, outcome_json = ?, detail = ?, settled_at = ? WHERE id = ? AND claim_token = ? AND action_status = 'claimed'`,
      [status, JSON.stringify({ reasonCode: outcome.reasonCode }), outcome.reasonCode, this.now(), grantId, claimToken],
    );
    const next = this.row(grantId)!;
    this.note(outcome.interrupted ? "native.agent.action.interrupted" : "native.agent.action.refused", next, `native.agent.action.${status}:${grantId}`, {
      grantId,
      sessionId: next.session_id,
      managerKind: next.manager_kind,
      actionKind: action?.kind ?? "none",
      reasonCode: outcome.reasonCode,
    });
    return viewFromRow(next);
  }

  actionOutcomeByGrantId(grantId: string): { actionStatus: GrantRow["action_status"]; view: NativeActionView | null } | null {
    return readNativeGrantOutcome(this.db, grantId);
  }

  private settleNone(row: GrantRow): NativeActionView {
    this.db.run(
      `UPDATE native_computer_agent_grants SET action_status = 'completed', action_json = ?, outcome_json = '{}', settled_at = ?
        WHERE id = ? AND action_status = 'none'`,
      [JSON.stringify({ kind: "none" }), this.now(), row.id],
    );
    const next = this.row(row.id)!;
    this.note("native.agent.action.accepted", next, `native.agent.action.accepted:${row.id}`, {
      grantId: row.id,
      sessionId: row.session_id,
      managerKind: row.manager_kind,
      actionKind: "none",
    });
    return viewFromRow(next);
  }

  private refuse(row: GrantRow, action: NativeAgentAction | null, reasonCode: string, detail: string): NativeActionView {
    this.db.run(
      `UPDATE native_computer_agent_grants SET action_status = 'refused', action_json = ?, outcome_json = ?, detail = ?, settled_at = ?
        WHERE id = ? AND action_status = 'none'`,
      [action ? JSON.stringify(action) : null, JSON.stringify({ reasonCode }), detail, this.now(), row.id],
    );
    const next = this.row(row.id)!;
    this.note("native.agent.action.refused", next, `native.agent.action.refused:${row.id}`, {
      grantId: row.id,
      sessionId: row.session_id,
      managerKind: row.manager_kind,
      actionKind: action?.kind ?? "none",
      reasonCode,
    });
    return viewFromRow(next);
  }

  private row(id: string): GrantRow | null {
    return this.db.query<GrantRow, [string]>("SELECT * FROM native_computer_agent_grants WHERE id = ?").get(id) ?? null;
  }

  private matching(target: NativeAgentTarget, id: string): GrantRow | null {
    const key = targetKey(target);
    const row = this.row(id);
    if (!row || row.manager_kind !== key.kind || (row.project_path ?? "") !== key.path) return null;
    return row;
  }

  private expireIfDue(row: GrantRow): GrantRow {
    if (row.status === "approved" && row.expires_at <= this.now()) {
      this.db.run(
        `UPDATE native_computer_agent_grants SET status = 'expired', settled_at = ?, detail = 'expired before the message was sent' WHERE id = ? AND status = 'approved'`,
        [this.now(), row.id],
      );
      return this.row(row.id) ?? row;
    }
    return row;
  }

  private view(row: GrantRow): NativeAgentGrantView {
    const observation = parseObservation(row.observation_json) ?? emptyObservation(row);
    return {
      grantId: row.id,
      managerKind: row.manager_kind,
      projectPath: row.project_path,
      sessionId: row.session_id,
      observationId: row.observation_id,
      application: {
        bundleId: row.bundle_id,
        displayName: observation.application.displayName || row.bundle_id,
        pid: row.pid,
        startSec: row.start_sec,
        startUsec: row.start_usec,
      },
      window: {
        windowId: row.window_id,
        title: observation.window.title,
      },
      observedAt: row.observed_at,
      allowedActions: parseAllowedActions(row.allowed_actions_json),
      maxActions: 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      status: row.status,
      observation,
    };
  }

  private note(eventType: NativeAgentJournalEvent["eventType"], row: GrantRow, idempotencyKey: string, payload: Record<string, string>): void {
    try {
      this.journal?.({ eventType, grantId: row.id, sessionId: row.session_id, idempotencyKey, payload });
    } catch {
      // The grant row stays authoritative if the journal rejects a write.
    }
  }
}

function viewFromRow(row: GrantRow): NativeActionView {
  const action = parseStoredAction(row.action_json);
  const outcome = parseOutcome(row.outcome_json);
  const elementId = action && "elementId" in action ? action.elementId : null;
  if (row.action_status === "interrupted") {
    return actionView(row, action?.kind ?? null, "interrupted", outcome.reasonCode ?? "restart", elementId);
  }
  if (row.action_status === "refused") {
    return actionView(row, action?.kind ?? null, outcome.reasonCode === "malformed" ? "ignored" : "refused", outcome.reasonCode, elementId);
  }
  if (row.action_status === "completed") {
    return actionView(row, action?.kind ?? "none", "accepted", null, elementId);
  }
  return actionView(row, action?.kind ?? null, "refused", "duplicate", elementId);
}

function actionView(
  row: GrantRow,
  kind: NativeActionView["kind"],
  status: NativeActionView["status"],
  reasonCode: string | null,
  elementId: string | null,
): NativeActionView {
  return { grantId: row.id, sessionId: row.session_id, kind, status, reasonCode, elementId };
}

function parseObservation(json: string | null | undefined): NativeAgentObservation | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (!nativeObservationLooksBound(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function parseStoredAction(json: string | null): NativeAgentAction | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as NativeAgentAction;
    if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function parseOutcome(json: string | null): { reasonCode: string | null } {
  if (!json) return { reasonCode: null };
  try {
    const value = JSON.parse(json) as { reasonCode?: unknown };
    return {
      reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
    };
  } catch {
    return { reasonCode: null };
  }
}

function parseAllowedActions(json: string | null | undefined): NativeAction[] {
  if (!json) return [...NATIVE_AGENT_ALLOWED_ACTIONS];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [...NATIVE_AGENT_ALLOWED_ACTIONS];
    return parsed.filter((item): item is NativeAction => typeof item === "string" && (NATIVE_AGENT_ALLOWED_ACTIONS as readonly string[]).includes(item));
  } catch {
    return [...NATIVE_AGENT_ALLOWED_ACTIONS];
  }
}

function emptyObservation(row: GrantRow): NativeAgentObservation {
  return {
    sessionId: row.session_id,
    observationId: row.observation_id,
    application: {
      bundleId: row.bundle_id,
      displayName: row.bundle_id,
      pid: row.pid,
      startSec: row.start_sec,
      startUsec: row.start_usec,
    },
    window: {
      windowId: row.window_id,
      title: "",
      titleRedacted: false,
    },
    elements: [],
    elementCount: 0,
    truncated: false,
    observedAt: row.observed_at,
    untrusted: true,
  };
}

export interface NativeActionSettlement {
  record: NativeActionView | null;
  note: string | null;
}

export async function settleNativeAgentAction(
  grants: NativeAgentGrantService,
  manager: NativeComputerSessionManager,
  input: {
    target: NativeAgentTarget;
    grantId: string | null;
    messageId: string;
    turnId: string;
    replyText: string;
  },
): Promise<NativeActionSettlement> {
  const parsed = parseNativeAction(input.replyText);
  if (!input.grantId) {
    if (!parsed.present) return { record: null, note: null };
    return {
      record: {
        grantId: null,
        sessionId: null,
        kind: parsed.ok ? parsed.action.kind : null,
        elementId: parsed.ok && "elementId" in parsed.action ? parsed.action.elementId : null,
        status: "ignored",
        reasonCode: "not_authorized",
      },
      note: "A native action was ignored because this message was not allowed to use the computer.",
    };
  }
  const known = grants.get(input.target, input.grantId);
  if (!known.ok) return { record: null, note: known.error };
  const live = await manager.inspect(known.value.sessionId).catch(() => null);
  const claimed = await grants.claim(input.target, input.grantId, input.messageId, input.turnId, input.replyText, live);
  if (!claimed.ok) return { record: null, note: claimed.error };
  if (!claimed.value.execute || !claimed.value.claimToken) {
    const view = claimed.value.view;
    const note = view.status === "ignored"
      ? "The native action could not be read, so the window was left unchanged."
      : view.status === "refused"
        ? "The native action was refused, so the window was left unchanged."
        : view.status === "interrupted"
          ? "The native action was interrupted and was not run again."
          : null;
    return { record: view, note };
  }
  const sessionId = claimed.value.view.sessionId;
  if (!sessionId) return { record: claimed.value.view, note: "The native session was not available." };
  try {
    const action = claimed.value.execute;
    if (action.kind === "press_accessible_button") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: PRESS_ACTION,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    } else if (action.kind === "scroll_accessible_area") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: SCROLL_ACTION,
        direction: action.direction,
        increment: action.increment,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    } else if (action.kind === "select_accessible_tab") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: SELECT_TAB_ACTION,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    } else if (action.kind === "set_accessible_text") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: SET_TEXT_ACTION,
        text: action.text,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    } else if (action.kind === "open_accessible_menu") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: OPEN_MENU_ACTION,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    } else if (action.kind === "select_accessible_menu_item") {
      await manager.executeAgentAction(sessionId, {
        observationId: known.value.observationId,
        elementId: action.elementId,
        action: SELECT_MENU_ITEM_ACTION,
        identity: {
          bundleId: known.value.application.bundleId,
          executablePath: live?.application.executablePath ?? "",
          pid: known.value.application.pid,
          startSec: known.value.application.startSec,
          startUsec: known.value.application.startUsec,
        },
        windowId: known.value.window.windowId,
      });
    }
    const record = grants.finish(input.grantId, claimed.value.claimToken, { ok: true });
    return { record, note: null };
  } catch (error) {
    const reasonCode = error instanceof NativeComputerError ? error.code : "helper_failed";
    const interrupted = reasonCode === "action_uncertain" || reasonCode === "helper_failed";
    const record = grants.finish(input.grantId, claimed.value.claimToken, { ok: false, reasonCode, interrupted });
    return {
      record,
      note: interrupted
        ? "The native action stopped before reporting an outcome and was not repeated."
        : "The native action failed and was not retried.",
    };
  }
}

export function readNativeGrantOutcome(
  db: Database,
  grantId: string,
): { actionStatus: GrantRow["action_status"]; view: NativeActionView | null } | null {
  if (!isNativeGrantId(grantId)) return null;
  const row = db.query<GrantRow, [string]>(`SELECT * FROM native_computer_agent_grants WHERE id = ?`).get(grantId);
  if (!row) return null;
  if (row.action_status === "none") {
    return { actionStatus: "none", view: null };
  }
  return { actionStatus: row.action_status, view: viewFromRow(row) };
}

export function reconcileInterruptedNativeMessage(
  message: { nativeGrantId?: string; nativeAction?: NativeActionView },
  db: Database,
): { nativeAction?: NativeActionView; error: string } {
  const grantId = message.nativeGrantId;
  if (!grantId) {
    return { error: "The app closed before the manager answered. Retry to ask again." };
  }
  const outcome = defaultService?.actionOutcomeByGrantId(grantId) ?? readNativeGrantOutcome(db, grantId);
  if (!outcome || outcome.actionStatus === "none") {
    return {
      error: "The app closed before the manager answered. No native action ran, and retry sends without repeating the grant.",
    };
  }
  if (outcome.actionStatus === "interrupted" || outcome.actionStatus === "claimed") {
    return {
      ...(outcome.view ? { nativeAction: outcome.view } : {}),
      error: "The app closed while a native action was in progress. Its outcome is uncertain and it was not repeated. Retry to ask again.",
    };
  }
  if (outcome.actionStatus === "completed") {
    return {
      ...(outcome.view ? { nativeAction: outcome.view } : {}),
      error: "The native action already finished before the app closed, and it was not repeated. Retry to ask again.",
    };
  }
  return {
    ...(outcome.view ? { nativeAction: outcome.view } : {}),
    error: "The native action was refused before the app closed. Retry to ask again.",
  };
}

let defaultService: NativeAgentGrantService | null = null;

export async function loadNativeAgentGrants(): Promise<NativeAgentGrantService> {
  if (defaultService) return defaultService;
  const { db } = await import("./db.ts");
  const { ActivityJournalCore } = await import("./activity-journal-core.ts");
  defaultService = new NativeAgentGrantService(db, () => Date.now(), (event) => {
    new ActivityJournalCore(db).record({
      eventType: event.eventType,
      actorType: event.eventType === "native.agent.granted" || event.eventType === "native.agent.revoked" ? "owner" : "system",
      actorId: event.payload.managerKind ?? "owner",
      targetType: "native-session",
      targetId: event.sessionId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    });
  });
  return defaultService;
}

export async function recoverNativeAgentGrants(): Promise<{ expired: number; interrupted: number }> {
  return (await loadNativeAgentGrants()).recover();
}

export function useNativeAgentGrants(service: NativeAgentGrantService | null): void {
  defaultService = service;
}
