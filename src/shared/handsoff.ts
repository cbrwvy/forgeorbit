/**
 * Hands-off project execution ("Work independently"). Pure model shared by the core and the webview.
 *
 * One Owner-activated policy per project covers the routine steps of an ordinary task: preparation,
 * Developer launch, the project's offline test, the independent Reviewer, bounded fix rounds, scoped local
 * application and the Done transition. A model's text is never authorization: the core reads this policy
 * from storage, intersects it with the live policy on every step, and records which revision acted.
 * This module has no runtime imports from either process side.
 */

export const HANDSOFF_LIMITS = {
  maxFixRounds: 3,
  maxParallel: 4,
  maxLaunchAttempts: 2,
  maxListed: 20,
  maxIdLength: 200,
  /** Backoff before a transient Developer launch failure is retried, per attempt already made. */
  retryBackoffMs: 30_000,
  /** The core re-evaluates waiting runs at least this often. */
  sweepMs: 10_000,
} as const;

export interface HandsoffPolicy {
  /** Off by default. A project without a stored policy is never driven. */
  enabled: boolean;
  /** Pick an eligible Developer from the project's team when the task has no assigned worker. */
  autoAssign: boolean;
  /** Run the project's fixed offline `bun test ./<file>` check inside the offline sandbox without asking. */
  runOfflineTests: boolean;
  /** A missing or unavailable test sends the work back (or stops it) instead of being reported as "not run". */
  requireTest: boolean;
  /** Apply the reviewed result to the project folder through the scoped publication operation. */
  autoApply: boolean;
  /** Mark the task Done once every applicable gate passed and the authorized delivery really happened. */
  autoDone: boolean;
  /** Review-requested corrections the core may start by itself (0..3). */
  maxFixRounds: number;
  /** Tasks of this project that may be developed or reviewed at the same time (1..4). */
  maxParallel: number;
  /**
   * The covered resources, each one a role + harness + account. This is what is enforced: a Developer on a harness
   * and account that is not listed here for the Developer is refused, even when the same pair is listed for the
   * Reviewer, and a profile that shares a login with a listed one is not covered by it. An empty list covers nothing.
   */
  resources: HandsoffResourceRef[];
  /** Derived from `resources` (the harnesses and accounts that appear in it); never an independent grant. */
  harnessIds: string[];
  accountIds: string[];
  /** The agent may bill per request. Without this the core stops with an explanation instead of acknowledging it. */
  acknowledgeUsageNotice: boolean;
}

export type HandsoffRoleName = "developer" | "reviewer";
export interface HandsoffResourceRef { role: HandsoffRoleName; harnessId: string; accountKey: string }

export const resourceKey = (r: HandsoffResourceRef): string => `${r.role}\u0000${r.harnessId}\u0000${r.accountKey}`;
export const hasResource = (resources: readonly HandsoffResourceRef[], role: HandsoffRoleName, harnessId: string, accountKey: string): boolean =>
  resources.some((r) => r.role === role && r.harnessId === harnessId && r.accountKey === accountKey);

function sortedResources(list: HandsoffResourceRef[]): HandsoffResourceRef[] {
  const seen = new Set<string>();
  return list.filter((r) => (seen.has(resourceKey(r)) ? false : (seen.add(resourceKey(r)), true))).sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)));
}
/** The harness and account lists a resource list implies. */
export function deriveResourceLists(resources: readonly HandsoffResourceRef[]): { harnessIds: string[]; accountIds: string[] } {
  return { harnessIds: [...new Set(resources.map((r) => r.harnessId))].sort(), accountIds: [...new Set(resources.map((r) => r.accountKey))].sort() };
}
/** Every pair of two lists for both roles: the meaning an older policy (two plain lists) always had. */
function crossResources(harnessIds: string[], accountIds: string[]): HandsoffResourceRef[] {
  return sortedResources((["developer", "reviewer"] as const).flatMap((role) => harnessIds.flatMap((harnessId) => accountIds.map((accountKey) => ({ role, harnessId, accountKey })))));
}

export const DEFAULT_HANDSOFF_POLICY: HandsoffPolicy = {
  enabled: false,
  autoAssign: true,
  runOfflineTests: true,
  requireTest: false,
  autoApply: false,
  autoDone: true,
  maxFixRounds: 2,
  maxParallel: 2,
  resources: [],
  harnessIds: [],
  accountIds: [],
  acknowledgeUsageNotice: false,
};

export interface StoredHandsoffPolicy {
  projectPath: string;
  policy: HandsoffPolicy;
  /** Grows on every change. A run is pinned to the revision it was submitted under. */
  revision: number;
  activatedAt: number | null;
  updatedAt: number;
}

const BOOLEAN_KEYS = ["enabled", "autoAssign", "runOfflineTests", "requireTest", "autoApply", "autoDone", "acknowledgeUsageNotice"] as const;

function idList(raw: unknown, label: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > HANDSOFF_LIMITS.maxListed) return { ok: false, error: `${label} must be a list of at most ${HANDSOFF_LIMITS.maxListed} ids.` };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim() || item.length > HANDSOFF_LIMITS.maxIdLength || /[\u0000-\u001f\u007f]/.test(item)) {
      return { ok: false, error: `${label} contains an invalid id.` };
    }
    if (!out.includes(item.trim())) out.push(item.trim());
  }
  return { ok: true, value: out.sort() };
}

/** Strict: unknown keys, wrong types and out-of-range numbers are refused, never clamped or ignored. */
export function parseHandsoffPolicy(raw: unknown, base: HandsoffPolicy = DEFAULT_HANDSOFF_POLICY): { ok: true; policy: HandsoffPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "The policy must be an object." };
  const record = raw as Record<string, unknown>;
  const known = new Set<string>([...BOOLEAN_KEYS, "maxFixRounds", "maxParallel", "harnessIds", "accountIds", "resources"]);
  for (const key of Object.keys(record)) if (!known.has(key)) return { ok: false, error: `Unknown policy field "${key}".` };
  const next: HandsoffPolicy = { ...base, resources: base.resources.map((r) => ({ ...r })), harnessIds: [...base.harnessIds], accountIds: [...base.accountIds] };
  for (const key of BOOLEAN_KEYS) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "boolean") return { ok: false, error: `${key} must be true or false.` };
    next[key] = record[key] as boolean;
  }
  for (const [key, max, min] of [["maxFixRounds", HANDSOFF_LIMITS.maxFixRounds, 0], ["maxParallel", HANDSOFF_LIMITS.maxParallel, 1]] as const) {
    if (record[key] === undefined) continue;
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${key} must be a whole number from ${min} to ${max}.` };
    next[key] = value;
  }
  if (record.resources !== undefined) {
    const raw = record.resources;
    if (!Array.isArray(raw) || raw.length > HANDSOFF_LIMITS.maxListed * 2) return { ok: false, error: "resources must be a short list." };
    const out: HandsoffResourceRef[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: "resources contains an invalid entry." };
      const entry = item as Record<string, unknown>;
      for (const key of Object.keys(entry)) if (!["role", "harnessId", "accountKey"].includes(key)) return { ok: false, error: `Unknown resource field "${key}".` };
      const ids = idList([entry.harnessId, entry.accountKey], "resources");
      if (!ids.ok || (entry.role !== "developer" && entry.role !== "reviewer") || typeof entry.harnessId !== "string" || typeof entry.accountKey !== "string") return { ok: false, error: "resources contains an invalid entry." };
      out.push({ role: entry.role, harnessId: entry.harnessId.trim(), accountKey: entry.accountKey.trim() });
    }
    next.resources = sortedResources(out);
    const derived = deriveResourceLists(next.resources);
    // The plain lists are only a summary of the pairs. When both are sent they must say the same thing.
    for (const key of ["harnessIds", "accountIds"] as const) {
      if (record[key] === undefined) continue;
      const list = idList(record[key], key);
      if (!list.ok) return list;
      if (JSON.stringify(list.value) !== JSON.stringify(derived[key])) return { ok: false, error: `${key} does not match the covered resources. Send the resources.` };
    }
    Object.assign(next, derived);
  } else if (record.harnessIds !== undefined || record.accountIds !== undefined) {
    for (const key of ["harnessIds", "accountIds"] as const) {
      if (record[key] === undefined) continue;
      const list = idList(record[key], key);
      if (!list.ok) return list;
      next[key] = list.value;
    }
    next.resources = crossResources(next.harnessIds, next.accountIds);
  } else if (next.resources.length === 0 && (next.harnessIds.length > 0 || next.accountIds.length > 0)) {
    // A stored policy from before pairs existed: its two lists meant every pair for both roles.
    next.resources = crossResources(next.harnessIds, next.accountIds);
  }
  return { ok: true, policy: next };
}

/**
 * The policy a step is actually held to: the one frozen when the work was submitted, narrowed by the live one.
 * Turning a switch off, lowering a limit or removing a harness or account takes effect on the next step; adding
 * to the live policy never widens work that was submitted earlier.
 */
export function effectiveHandsoffPolicy(frozen: HandsoffPolicy, live: HandsoffPolicy | null): HandsoffPolicy {
  if (!live || !live.enabled || !frozen.enabled) return { ...frozen, enabled: false };
  return {
    enabled: true,
    autoAssign: frozen.autoAssign && live.autoAssign,
    runOfflineTests: frozen.runOfflineTests && live.runOfflineTests,
    requireTest: frozen.requireTest || live.requireTest,
    autoApply: frozen.autoApply && live.autoApply,
    autoDone: frozen.autoDone && live.autoDone,
    maxFixRounds: Math.min(frozen.maxFixRounds, live.maxFixRounds),
    maxParallel: Math.min(frozen.maxParallel, live.maxParallel),
    ...(() => {
      const resources = frozen.resources.filter((r) => hasResource(live.resources, r.role, r.harnessId, r.accountKey));
      return { resources, ...deriveResourceLists(resources) };
    })(),
    acknowledgeUsageNotice: frozen.acknowledgeUsageNotice && live.acknowledgeUsageNotice,
  };
}

/** Which switches the change turns on or widens. Activation and any widening need the Owner's explicit save. */
export function handsoffPolicyWidens(before: HandsoffPolicy, after: HandsoffPolicy): string[] {
  const widened: string[] = [];
  for (const key of BOOLEAN_KEYS) if (!before[key] && after[key]) widened.push(key);
  if (after.maxFixRounds > before.maxFixRounds) widened.push("maxFixRounds");
  if (after.maxParallel > before.maxParallel) widened.push("maxParallel");
  if (after.resources.some((r) => !hasResource(before.resources, r.role, r.harnessId, r.accountKey))) widened.push("resources");
  return widened;
}

/* ------------------------------------------------------------------------------------------------ run model */

/** Where the work is. Order is the happy path; `fixing` loops back to `developing`. */
export const HANDSOFF_STAGES = ["queued", "developing", "testing", "reviewing", "fixing", "applying", "finished"] as const;
export type HandsoffStage = (typeof HANDSOFF_STAGES)[number];

/**
 * `active`: the core is working or waiting for a process. `waiting`: nothing is needed from the Owner (a free slot,
 * a known provider reset time, a stopped project). `needs-owner`: a real decision or action, with one blocker.
 * `stopped`: Emergency Stop or the Owner turned the work off; nothing restarts by itself.
 */
export const HANDSOFF_STATUSES = ["active", "waiting", "needs-owner", "stopped", "done", "ready-to-apply", "awaiting-accept", "failed", "cancelled"] as const;
export type HandsoffStatus = (typeof HANDSOFF_STATUSES)[number];

export const HANDSOFF_TERMINAL: readonly HandsoffStatus[] = ["done", "ready-to-apply", "awaiting-accept", "failed", "cancelled"];
export const isHandsoffTerminal = (status: HandsoffStatus): boolean => HANDSOFF_TERMINAL.includes(status);

export const HANDSOFF_BLOCKER_CODES = [
  "workspace-off", "no-worker", "no-resource", "account-limit", "usage-notice", "owner-device-proof", "launch-refused",
  "developer-failed", "unconfirmed-launch", "workspace-missing", "test-blocked", "test-failed-limit", "test-required",
  "review-failed", "review-limit", "review-blocked", "no-progress", "apply-conflict", "done-refused", "provider-refused", "internal",
  "authorization-missing", "authorization-expired", "authorization-exhausted", "authorization-renewal", "authorization-revoked",
] as const;
export type HandsoffBlockerCode = (typeof HANDSOFF_BLOCKER_CODES)[number];

export type HandsoffActionKind = "retry" | "open-settings" | "open-task" | "open-accounts";

export interface HandsoffBlocker {
  code: HandsoffBlockerCode;
  /** Canonical English sentence from the core. The webview words each code itself; this stays in technical details. */
  message: string;
  /** What the Owner's single action will affect. */
  action: HandsoffActionKind;
  at: number;
}

export type HandsoffTestState = "passed" | "failed" | "not-run" | "unavailable" | "skipped";

export interface HandsoffChange { path: string; kind: "created" | "modified" | "deleted" | "renamed" | string }

export interface HandsoffWorkerRef {
  employeeId: string | null;
  employeeName: string | null;
  harnessId: string | null;
  modelId: string | null;
  accountId: string | null;
}

export interface HandsoffResult {
  changedFiles: HandsoffChange[];
  /** applied: written to the project folder. prepared: ready in the working copy only. none: nothing to apply. */
  delivery: "applied" | "prepared" | "none";
  appliedPaths: string[];
  tests: { state: HandsoffTestState; command: string | null; summary: string | null };
  review: { verdict: "PASS" | "CHANGES_REQUESTED" | "BLOCKED" | null; summary: string | null; round: number };
  fixRounds: number;
  developer: HandsoffWorkerRef | null;
  reviewer: HandsoffWorkerRef | null;
}

/** Facts the step function keeps between ticks. Everything else is re-read from the real records. */
export interface HandsoffState {
  /** The Owner's optional choice at submit time. Respected exactly; never substituted. */
  requested: { harnessId: string | null; modelId: string | null; accountId: string | null };
  launchAttempts: number;
  /** Written just before a launch is attempted. If it is set and no run was recorded, the launch outcome is unknown. */
  launchIntent: { kind: "developer" | "review"; at: number } | null;
  developerRunId: string | null;
  testAuthorizationId: string | null;
  /** Source fingerprint the test and the review judged. The change that is applied must still equal it. */
  evidenceFingerprint: string | null;
  testDone: boolean;
  reviewId: string | null;
  lastFindingsHash: string | null;
  lastFingerprint: string | null;
  waitUntil: number | null;
  waitReason: string | null;
  /** Distinguishes specific non-error wait causes (scheduled time, dependency, worker, slot, provider limit, pause). */
  waitKind?: "scheduled" | "dependency" | "worker" | "slot" | "provider-limit" | "project-paused" | null;
  developer: HandsoffWorkerRef | null;
  reviewer: HandsoffWorkerRef | null;
  tests: HandsoffResult["tests"];
  review: HandsoffResult["review"];
}

export const EMPTY_HANDSOFF_STATE: HandsoffState = {
  requested: { harnessId: null, modelId: null, accountId: null },
  launchAttempts: 0,
  launchIntent: null,
  developerRunId: null,
  testAuthorizationId: null,
  evidenceFingerprint: null,
  testDone: false,
  reviewId: null,
  lastFindingsHash: null,
  lastFingerprint: null,
  waitUntil: null,
  waitReason: null,
  waitKind: null,
  developer: null,
  reviewer: null,
  tests: { state: "not-run", command: null, summary: null },
  review: { verdict: null, summary: null, round: 0 },
};

export interface HandsoffRun {
  id: string;
  taskId: string;
  projectPath: string;
  /** The revision of the policy this work was submitted under. */
  policyRevision: number;
  /** Frozen at submit. Steps use `effectiveHandsoffPolicy(frozen, live)`. */
  policy: HandsoffPolicy;
  stage: HandsoffStage;
  status: HandsoffStatus;
  /** Fix rounds started so far. */
  round: number;
  state: HandsoffState;
  blocker: HandsoffBlocker | null;
  result: HandsoffResult | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export const HANDSOFF_EVENT_KINDS = [
  "submitted", "assigned", "developer-started", "developer-finished", "test-started", "test-finished", "review-started",
  "review-finished", "fix-started", "applied", "done", "waiting", "needs-owner", "stopped", "resumed", "failed", "cancelled", "ready-to-apply", "note",
] as const;
export type HandsoffEventKind = (typeof HANDSOFF_EVENT_KINDS)[number];

export interface HandsoffEvent {
  id: number;
  runId: string;
  taskId: string;
  ts: number;
  kind: HandsoffEventKind;
  stage: HandsoffStage;
  /** Canonical English line. The webview words the kind itself. */
  message: string;
  /** Policy revision that authorized this step, plus the worker, account and model that acted. */
  detail: { policyRevision: number; employeeName?: string | null; harnessId?: string | null; accountId?: string | null; modelId?: string | null; [key: string]: unknown };
}

/** The one place that decides whether a run is waiting on the Owner. Waiting for a process or a clock is not. */
export function handsoffNeedsOwner(run: Pick<HandsoffRun, "status">): boolean {
  return run.status === "needs-owner";
}

/** Cheap stable hash for "the same findings came back again". Not a security primitive. */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * What makes two findings "the same": the words, without timings, digests, absolute paths or counters that change
 * on every run of an unchanged test.
 */
export function normalizeFindings(text: string): string {
  return text
    .replace(/Evidence [0-9a-f]{8,}/gi, "")
    .replace(/\[[0-9.]+ ?m?s\]/gi, "")
    .replace(/\(?[0-9.]+ ?ms\)?/gi, "")
    .replace(/(?:\/[\w.@~+-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Should a correction be started? Bounded by the policy, by the Reviewer round limit the QC service enforces, and by
 * progress: the same findings, or the same source, twice in a row is a loop, not progress.
 */
export function fixDecision(input: {
  round: number;
  maxFixRounds: number;
  qcRoundsUsed: number;
  qcMaxRounds: number;
  findingsHash: string | null;
  previousFindingsHash: string | null;
  sourceFingerprint: string | null;
  previousFingerprint: string | null;
}): { kind: "fix" } | { kind: "stop"; code: "review-limit" | "no-progress"; reason: string } {
  if (input.round >= input.maxFixRounds) return { kind: "stop", code: "review-limit", reason: `The correction limit of ${input.maxFixRounds} was reached.` };
  if (input.qcRoundsUsed >= input.qcMaxRounds) return { kind: "stop", code: "review-limit", reason: `All ${input.qcMaxRounds} review rounds are used.` };
  if (input.findingsHash && input.findingsHash === input.previousFindingsHash && input.sourceFingerprint && input.sourceFingerprint === input.previousFingerprint) {
    return { kind: "stop", code: "no-progress", reason: "The same findings came back for the same change. Another correction would repeat the last one." };
  }
  if (input.findingsHash && input.findingsHash === input.previousFindingsHash && input.round >= 1) {
    return { kind: "stop", code: "no-progress", reason: "The Reviewer asked for the same correction again after a correction round." };
  }
  return { kind: "fix" };
}

import type { SmartQueueProjectSummary } from "./smart-queue.ts";

/** GET /handsoff/overview: what the board and Home need to word a task, in one read. */
export interface HandsoffOverview {
  policies: { projectPath: string; enabled: boolean; revision: number; autoApply: boolean; autoDone: boolean }[];
  runs: HandsoffRun[];
  /** Canonical per-project smart execution queue summaries derived by the backend scheduler. */
  queues?: SmartQueueProjectSummary[];
}
