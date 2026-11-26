/**
 * Supervised task execution from the project manager (FO-005B). Pure,
 * shared by the Manager tab, the Bun runner and the tests: the persisted
 * execution proposal, the checks shown before approval, how a live run is
 * summarized, and the parser for the `<execution_proposal>` block the
 * manager may suggest in a reply.
 *
 * Nothing here starts an agent. The runner (`src/bun/project-execution.ts`)
 * starts a task only when the owner approves a proposal, and then only
 * through the board's own `startTask` — the same call the Run button makes.
 * Run state is never stored here as its own truth: `ExecutionLive` is read
 * from the task and run rows each time a view is built.
 */

import { capText, lastTagBody } from "./project-interview.ts";
import { AGENT_OPTIONS, type AgentKind, type ColumnId, type RunStatus, type Task } from "./types.ts";

export const EXECUTION_LIMITS = {
  reasonChars: 600,
  checkChars: 400,
  historyEntries: 40,
  historyTextChars: 400,
  /** One "Request fix" message. */
  fixChars: 4000,
  /** Raw JSON inside one `<execution_proposal>` tag. */
  jsonChars: 8000,
  /** Executions returned for one project, newest first. */
  listed: 40,
  /** Final agent message excerpt shown in the result. */
  finalMessageChars: 4000,
  errorLines: 8,
  errorLineChars: 400,
  changedFiles: 200,
  /** Agents, profiles and pipelines listed in the manager prompt. */
  catalogEntries: 30,
} as const;

/** Columns a task can be executed from. Running, blocked and review tasks
 *  already have a run to look at; done tasks are finished. Backlog and inbox
 *  are pre-run intake stages. */
export const EXECUTABLE_COLUMNS: readonly ColumnId[] = ["ready"];

export function isExecutableColumn(column: ColumnId): boolean {
  return EXECUTABLE_COLUMNS.includes(column);
}

/** Why a column can't be executed from, in the owner's words. */
export function columnBlockReason(column: ColumnId): string | null {
  switch (column) {
    case "backlog":
      return "This task is still in Backlog. Admit it to the project inbox, then move it to Ready to run.";
    case "inbox":
      return "This task is in the project inbox for PM triage. Move it to Ready when you want to run it.";
    case "ready":
      return null;
    case "running":
      return "This task is already running. Open its run to follow it.";
    case "blocked":
      return "This task is blocked waiting for you. Open its run to answer or retry it.";
    case "review":
      return "This task is waiting for review. Open its run, request a fix, or accept the result.";
    case "done":
      return "This task is done. Move it back to the backlog to run it again.";
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Configuration.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What the task will run with. `pipelineId` and `profileId` win over the
 * manual fields (a pipeline runs its own steps; a profile owns harness,
 * model, effort and mode), exactly like the New Task form's "one
 * selection". The manual fields are still filled so the card can show them.
 */
export interface ExecutionConfig {
  pipelineId: string | null;
  profileId: string | null;
  harness: string;
  model: string;
  effort: string | null;
  /** Always a concrete mode id, never null. */
  mode: string;
  fast: boolean;
  maxMode: boolean;
}

export function sameConfig(a: ExecutionConfig, b: ExecutionConfig): boolean {
  return a.pipelineId === b.pipelineId && a.profileId === b.profileId && a.harness === b.harness
    && a.model === b.model && a.effort === b.effort && a.mode === b.mode && a.fast === b.fast
    && a.maxMode === b.maxMode;
}

/**
 * How much a mode lets the agent do without asking: 0 read-only or plan,
 * 1 asks first, 2 accepts edits, 3 hands-off, 4 no checks at all. Unknown
 * ids count as hands-off so they are never shown as safer than they are.
 */
export function modeAccessLevel(kind: AgentKind, mode: string): number {
  const table: Record<AgentKind, Record<string, number>> = {
    "claude-code": { plan: 0, ask: 1, acceptEdits: 2, "bounded-print": 2, auto: 3, bypass: 4 },
    codex: { ask: 0, auto: 3, "full-access": 4 },
    cursor: { ask: 0, auto: 3 },
    gemini: { ask: 0, auto: 3 },
    fx: { ask: 1, auto: 3, yolo: 4 },
    antigravity: { plan: 0, ask: 2, auto: 3 },
  };
  return table[kind]?.[mode] ?? 3;
}

export function modeLabel(kind: AgentKind, mode: string): string {
  return AGENT_OPTIONS[kind]?.modes.find((item) => item.id === mode)?.label ?? mode;
}

/**
 * A short fingerprint of the task fields a launch depends on. An approval
 * names the fingerprint it was reviewed against, so an edit made from the
 * board in between (prompt, agent, column, a run started elsewhere) makes
 * the owner review again instead of launching something they didn't see.
 */
export function taskFingerprint(task: Pick<Task,
  "title" | "prompt" | "agent" | "model" | "effort" | "mode" | "fast" | "maxMode" | "agentProfileId"
  | "pipelineId" | "column" | "runId" | "workdir" | "isolation" | "archivedAt"> & Partial<Pick<Task, "accessMode" | "computerWorkflowRevision">>): string {
  const parts = [
    task.title, task.prompt, task.agent, task.model ?? "", task.effort ?? "", task.mode ?? "",
    task.fast ? "1" : "0", task.maxMode ? "1" : "0", task.agentProfileId ?? "", task.pipelineId ?? "",
    task.column, task.runId ?? "", task.workdir, task.isolation, task.archivedAt == null ? "" : "a",
    ...(task.accessMode && task.accessMode !== "workspace" ? [task.accessMode] : []),
    ...(task.computerWorkflowRevision ? [task.computerWorkflowRevision] : []),
  ];
  return stableHash(parts.join("\u0000"));
}

/** cyrb53: small, stable, not cryptographic. */
export function stableHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Proposal.
 * ────────────────────────────────────────────────────────────────────────── */

export type ExecutionCheckLevel = "error" | "warning" | "info";

export interface ExecutionCheck {
  level: ExecutionCheckLevel;
  /** Stable id for tests and the UI (`harness-unavailable`, `mode-change`…). */
  code: string;
  message: string;
}

/** What the card shows next to each config field, resolved at check time. */
export interface ExecutionResolved {
  permissionIdentity?: string | null;
  permission?: import("./execution/permissions.ts").PermissionDisclosure | null;
  accessDiagnostics?: import("./execution/access-mode.ts").AccessDiagnostics | null;
  harnessLabel: string;
  harnessKind: AgentKind | null;
  modelLabel: string;
  modeLabel: string;
  /** 0–4, see `modeAccessLevel`. */
  accessLevel: number;
  profileName: string | null;
  pipelineName: string | null;
  /** Pipeline steps with the agent each one runs as. */
  pipelineSteps: { name: string; agent: string }[];
  workdir: string;
  isolation: Task["isolation"];
  /** Where the agent will actually work. */
  workspace: string;
  /**
   * What `workspace` is, decided with it from the reviewed launch target (never from the task's
   * isolation field alone): an armed task-owned staging folder, a Git worktree, or the project
   * folder itself. Absent on records written before this field.
   */
  workspaceKind?: "task-staging" | "worktree" | "project-folder";
  /** Paths the Owner prepared as outputs of an armed staging workspace (eligible for later publication). */
  stagedOutputPaths?: string[];
  /** True when the project's "Development in a working copy" setting governs this launch. */
  workingCopyDevelopment?: boolean;
  /** Private sandbox scratch folder paired with a working-copy workspace. */
  workingCopyScratchPath?: string | null;
  /** Mode the task had before this proposal (to show a change). */
  previousMode: string | null;
  /**
   * What the launch will run (Direction 9): the executable resolved by the same function the launch
   * uses, the version a probe read, the model's version floor if one exists, and the mode. Absent
   * on records written before this field and for a pipeline (each step has its own harness).
   */
  launchTarget?: import("./provider-launch-target.ts").LaunchTargetFacts;
}

/**
 * Proposed / starting / started are the only live states. `start-failed`
 * can be approved again after a fresh check; `dismissed` is final.
 */
export type ExecutionStatus = "proposed" | "starting" | "started" | "start-failed" | "dismissed";

/** `batch`: started by an approved execution batch (FO-005C), which owns
 *  its retries; the owner still reviews the result here. */
export type ExecutionSource = "owner" | "manager" | "batch" | "employee";

export type ExecutionEventKind =
  | "proposed"
  | "edited"
  | "approved"
  | "started"
  | "start-failed"
  | "start-refused"
  | "dismissed"
  | "fix-requested"
  | "accepted"
  | "returned"
  | "stopped";

export interface ExecutionEvent {
  at: number;
  kind: ExecutionEventKind;
  text: string;
}

export interface ExecutionProposal {
  id: string;
  projectPath: string;
  taskId: string;
  /** Title when the proposal was made (the task can be renamed later). */
  taskTitle: string;
  /** Manager message the proposal belongs to, for the chat timeline. */
  messageId: string | null;
  source: ExecutionSource;
  /** The execution batch that started it, when `source` is `batch`. */
  batchId: string | null;
  /** The employee execution attempt (FO-010E2) that started it, when `source` is `employee`. */
  employeeRunId?: string | null;
  /** Why this configuration — written by the app, or by the manager. */
  reason: string;
  config: ExecutionConfig;
  resolved: ExecutionResolved;
  checks: ExecutionCheck[];
  checkedAt: number;
  /** `taskFingerprint` the checks and the owner's review are based on. */
  reviewedFingerprint: string;
  /** Approval needs `acknowledgeUsage` when the agent may bill per request. */
  usageNotice: string | null;
  status: ExecutionStatus;
  error: string | null;
  /** The run this approval started. Later turns of the same task are read
   *  live from the task. */
  runId: string | null;
  startingAt: number | null;
  startedAt: number | null;
  /** Bumped by every edit and check; approve must name it. */
  revision: number;
  history: ExecutionEvent[];
  createdAt: number;
  updatedAt: number;
}

export function hasBlockingCheck(checks: readonly ExecutionCheck[]): boolean {
  return checks.some((check) => check.level === "error");
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Live state (read from the board each time; never stored).
 * ────────────────────────────────────────────────────────────────────────── */

export interface ExecutionRunSummary {
  id: string;
  status: RunStatus;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
}

export interface ExecutionLive {
  taskExists: boolean;
  title: string | null;
  column: ColumnId | null;
  archived: boolean;
  /** The latest run of the task since this execution started it. */
  run: ExecutionRunSummary | null;
  /** Runs of the task since this execution (follow-ups, fixes). */
  runCount: number;
  /** The task is genuinely busy right now (spawning, running, or held). */
  live: boolean;
  pendingQuestions: number;
  pipeline: {
    status: string;
    activeSteps: string[];
    completed: number;
    total: number;
  } | null;
  /** A proposed execution whose task got a run from somewhere else. */
  otherRun: ExecutionRunSummary | null;
  model: string | null;
  harness: string | null;
}

export type ExecutionPhase =
  | "proposed"
  | "starting"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "stopped"
  | "accepted"
  | "returned"
  | "start-failed"
  | "dismissed"
  | "missing";

export interface ExecutionView extends ExecutionProposal {
  live: ExecutionLive;
  phase: ExecutionPhase;
}

/**
 * What the owner should read off an execution right now. Derived only from
 * the stored proposal status and the live task/run rows; never a guess.
 */
export function executionPhase(proposal: Pick<ExecutionProposal, "status">, live: ExecutionLive): ExecutionPhase {
  if (proposal.status === "dismissed") return "dismissed";
  if (proposal.status === "start-failed") return "start-failed";
  if (proposal.status === "proposed") return live.taskExists ? "proposed" : "missing";
  if (proposal.status === "starting") return "starting";
  if (!live.taskExists) return "missing";
  if (live.pendingQuestions > 0 || live.column === "blocked") return "waiting";
  if (live.live || live.column === "running") return "running";
  if (live.column === "done") return "accepted";
  if (live.pipeline) {
    // A pipeline task has no run of its own; its run state is the truth.
    switch (live.pipeline.status) {
      case "running":
        return "running";
      case "blocked":
        return "waiting";
      case "done":
        return live.column === "backlog" ? "returned" : "review";
      case "cancelled":
        return "stopped";
      default:
        return live.column === "backlog" ? "returned" : "failed";
    }
  }
  const status = live.run?.status;
  if (live.column === "review") return "review";
  if (status === "failed" || status === "orphaned") return "failed";
  if (status === "cancelled") return "stopped";
  if (status === "succeeded") return live.column === "backlog" ? "returned" : "review";
  if (status === "running") return "running";
  return live.column === "backlog" ? "returned" : "failed";
}

export const PHASE_TEXT: Record<ExecutionPhase, string> = {
  proposed: "Ready to execute",
  starting: "Starting…",
  running: "Running",
  waiting: "Waiting for you",
  review: "Needs your review",
  failed: "Run failed",
  stopped: "Stopped",
  accepted: "Accepted",
  returned: "Returned to backlog",
  "start-failed": "Couldn't start",
  dismissed: "Cancelled",
  missing: "Task no longer exists",
};

/** Phases where the owner can still act on the result. */
export function isSettledPhase(phase: ExecutionPhase): boolean {
  return phase === "review" || phase === "failed" || phase === "stopped" || phase === "accepted" || phase === "returned";
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Result.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ExecutionResult {
  runStatus: RunStatus | null;
  exitCode: number | null;
  endedAt: number | null;
  /** Changed files in the task's worktree (or folder) against its base. */
  changes: {
    base: string | null;
    files: { path: string; status: string; additions: number; deletions: number }[];
    truncated: boolean;
    note: string | null;
  };
  /** Excerpt of the agent's last message in the latest run. */
  finalMessage: string | null;
  /** Error and warning status lines from the latest run. */
  errors: string[];
  pipeline: {
    status: string;
    steps: { name: string; outcome: string | null; responseKind: string | null; summary: string | null; openQuestions: string[] }[];
    blocked: string[];
  } | null;
  /** No test runner is configured for supervised execution; say so plainly. */
  tests: { note: string };
  pendingQuestions: number;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The manager's suggestion (`<execution_proposal>`).
 * ────────────────────────────────────────────────────────────────────────── */

/** What the agent may suggest. Never the permission mode: the mode comes
 *  from the task (or a chosen profile) and only the owner changes it. */
export interface ExecutionSuggestion {
  /** 8-char task ref, without `#`. */
  taskRef: string;
  profile: string | null;
  pipeline: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  reason: string;
}

function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? capText(text, max) : null;
}

export function hasExecutionTag(text: string): boolean {
  return text.includes("<execution_proposal>") || text.includes("<execution_proposal ");
}

/**
 * Read an `<execution_proposal>` block. Returns null when there is none,
 * an error when there is one that can't be used. The values are only names:
 * the runner checks each against what really exists before showing it.
 */
export function parseExecutionSuggestion(
  text: string,
): { ok: true; suggestion: ExecutionSuggestion | null } | { ok: false; error: string } {
  if (!hasExecutionTag(text)) return { ok: true, suggestion: null };
  const body = lastTagBody(text.replace(/\r\n?/g, "\n"), "execution_proposal");
  if (body == null) return { ok: false, error: "The run suggestion was cut off." };
  if (body.length > EXECUTION_LIMITS.jsonChars) return { ok: false, error: "The run suggestion is too large." };
  let cleaned = body.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(cleaned);
  if (fence) cleaned = fence[1]!.trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    try {
      value = first >= 0 && last > first ? JSON.parse(cleaned.slice(first, last + 1)) : undefined;
    } catch {
      value = undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "The run suggestion is not valid JSON." };
  }
  const rec = value as Record<string, unknown>;
  const rawTask = oneLine(rec.task ?? rec.task_id ?? rec.taskId, 60);
  const taskRef = rawTask?.replace(/^#/, "").toLowerCase().slice(0, 8) ?? "";
  if (!/^[0-9a-f]{8}$/.test(taskRef)) return { ok: false, error: "The run suggestion doesn't name a task id like #1a2b3c4d." };
  return {
    ok: true,
    suggestion: {
      taskRef,
      profile: oneLine(rec.profile ?? rec.agent_profile, 100),
      pipeline: oneLine(rec.pipeline, 100),
      harness: oneLine(rec.harness, 100),
      model: oneLine(rec.model, 200),
      effort: oneLine(rec.effort, 100),
      reason: oneLine(rec.reason, EXECUTION_LIMITS.reasonChars) ?? "",
    },
  };
}

/** One line per available agent, profile and pipeline for the prompt. */
export interface ExecutionCatalog {
  harnesses: { id: string; label: string; kind: AgentKind; defaultModel: string }[];
  profiles: { name: string; harness: string; model: string }[];
  pipelines: { name: string; steps: number }[];
}

export function catalogBlock(catalog: ExecutionCatalog): string {
  const lines = ["### Agents that can run tasks"];
  if (catalog.harnesses.length === 0) lines.push("(No harness is enabled.)");
  for (const h of catalog.harnesses.slice(0, EXECUTION_LIMITS.catalogEntries)) {
    lines.push(`- harness "${h.id}" (${h.label}, ${h.kind}), default model ${h.defaultModel}`);
  }
  if (catalog.profiles.length > 0) {
    lines.push("Agent profiles:");
    for (const p of catalog.profiles.slice(0, EXECUTION_LIMITS.catalogEntries)) {
      lines.push(`- profile "${p.name}" (harness ${p.harness}, model ${p.model})`);
    }
  }
  if (catalog.pipelines.length > 0) {
    lines.push("Pipelines:");
    for (const p of catalog.pipelines.slice(0, EXECUTION_LIMITS.catalogEntries)) {
      lines.push(`- pipeline "${p.name}" (${p.steps} step${p.steps === 1 ? "" : "s"})`);
    }
  }
  lines.push("Availability, login state and limits are checked by the application when the owner reviews a run; you don't know them.");
  return lines.join("\n");
}

/** Recent supervised runs for the prompt, so the manager can explain them. */
export function executionsBlock(rows: { taskRef: string; title: string; phase: ExecutionPhase; startedAt: number | null }[]): string {
  const lines = ["### Supervised runs"];
  if (rows.length === 0) lines.push("(No task was run from this chat yet.)");
  for (const row of rows.slice(0, 15)) {
    const when = row.startedAt ? `, started ${new Date(row.startedAt).toISOString()}` : "";
    lines.push(`- #${row.taskRef} ${row.title}: ${PHASE_TEXT[row.phase]}${when}`);
  }
  return lines.join("\n");
}

export const EXECUTION_REPLY_FORMAT = [
  "When the owner asks to run, start, or execute an existing task, you can suggest how to run it. You cannot start it: the application shows your suggestion and the owner approves it. Name the task by its id and only use harness, profile, and pipeline names listed above; leave a field out to keep the task's own setting. You cannot change the permission mode.",
  "<execution_proposal>",
  '{"task": "#1a2b3c4d", "harness": "…", "model": "…", "effort": "…", "profile": null, "pipeline": null, "reason": "…"}',
  "</execution_proposal>",
].join("\n");

/* ────────────────────────────────────────────────────────────────────────── *
 * Stored-row sanitizer.
 * ────────────────────────────────────────────────────────────────────────── */

const STATUSES: ExecutionStatus[] = ["proposed", "starting", "started", "start-failed", "dismissed"];

export function sanitizeStoredExecution(value: unknown): ExecutionProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.projectPath !== "string" || typeof rec.taskId !== "string") return null;
  const config = rec.config as Record<string, unknown> | undefined;
  if (!config || typeof config !== "object" || typeof config.harness !== "string" || typeof config.model !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: rec.id,
    projectPath: rec.projectPath,
    taskId: rec.taskId,
    taskTitle: str(rec.taskTitle) ?? "",
    messageId: str(rec.messageId),
    source: rec.source === "manager" || rec.source === "batch" || rec.source === "employee" ? rec.source : "owner",
    batchId: str(rec.batchId),
    employeeRunId: str(rec.employeeRunId),
    reason: str(rec.reason) ?? "",
    config: {
      pipelineId: str(config.pipelineId),
      profileId: str(config.profileId),
      harness: config.harness,
      model: config.model,
      effort: str(config.effort),
      mode: str(config.mode) ?? "auto",
      fast: config.fast === true,
      maxMode: config.maxMode === true,
    },
    resolved: (rec.resolved && typeof rec.resolved === "object" ? rec.resolved : {
      harnessLabel: config.harness,
      harnessKind: null,
      modelLabel: config.model,
      modeLabel: str(config.mode) ?? "auto",
      accessLevel: 3,
      profileName: null,
      pipelineName: null,
      pipelineSteps: [],
      workdir: rec.projectPath,
      isolation: "worktree",
      workspace: rec.projectPath,
      previousMode: null,
    }) as ExecutionResolved,
    checks: Array.isArray(rec.checks)
      ? (rec.checks as ExecutionCheck[]).filter((c) => c && typeof c.message === "string" && typeof c.code === "string")
      : [],
    checkedAt: num(rec.checkedAt) ?? 0,
    reviewedFingerprint: str(rec.reviewedFingerprint) ?? "",
    usageNotice: str(rec.usageNotice),
    status: STATUSES.includes(rec.status as ExecutionStatus) ? (rec.status as ExecutionStatus) : "proposed",
    error: str(rec.error),
    runId: str(rec.runId),
    startingAt: num(rec.startingAt),
    startedAt: num(rec.startedAt),
    revision: num(rec.revision) ?? 1,
    history: Array.isArray(rec.history)
      ? (rec.history as ExecutionEvent[]).filter((e) => e && typeof e.text === "string" && typeof e.at === "number")
      : [],
    createdAt: num(rec.createdAt) ?? 0,
    updatedAt: num(rec.updatedAt) ?? 0,
  };
}

export function appendEvent(history: ExecutionEvent[], kind: ExecutionEventKind, text: string, at = Date.now()): ExecutionEvent[] {
  const next = [...history, { at, kind, text: capText(text, EXECUTION_LIMITS.historyTextChars) }];
  return next.length > EXECUTION_LIMITS.historyEntries ? next.slice(next.length - EXECUTION_LIMITS.historyEntries) : next;
}

/** Environment variables that make a CLI bill per request instead of using
 *  a subscription. Only the names are ever reported, never the values. */
export const PAID_API_ENV: Record<AgentKind, string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"],
  fx: ["AI_GATEWAY_API_KEY"],
  antigravity: [],
};

/**
 * A notice the owner must acknowledge before approving, or null. fx always
 * bills each request to the owner's AI Gateway account; any other CLI does
 * when an API-key variable is set for it. Without reliable data the notice
 * never claims a price or remaining limit.
 */
export function usageNoticeFor(kind: AgentKind, label: string, envNames: readonly string[]): string | null {
  if (kind === "fx") {
    return `${label} sends every request through your Vercel AI Gateway account, which bills per token. ForgeOrbit doesn't know the price or your balance.`;
  }
  const found = PAID_API_ENV[kind].filter((name) => envNames.includes(name));
  if (found.length === 0) return null;
  return `${label} has ${found.join(", ")} set, so it may bill this run to that API account instead of a subscription. ForgeOrbit doesn't know the price or your remaining limits.`;
}
