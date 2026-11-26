/**
 * AI project interview runner (FO-003).
 *
 * An interview turn is one prompt → one reply. It goes through the same
 * `spawnAgent` adapters tasks use (binary resolution, harness env, auth,
 * model flags), but it is NOT a task: no task row, no run row, no worktree,
 * nothing on the board. Each turn:
 *
 * - runs only after the user clicks something in the wizard (the routes are
 *   the only callers — opening the wizard never starts one);
 * - runs in a fresh empty scratch folder under the data dir, never in the
 *   user's project, which may not even exist yet;
 * - uses the harness's most restricted non-interactive mode
 *   (`INTERVIEW_SUPPORT`); kinds without one are refused;
 * - gets its project context inline in the prompt — redacted excerpts the
 *   server read itself, never the folder;
 * - writes nothing anywhere except the driver's own per-run log files, which
 *   are deleted with the scratch folder when the turn settles.
 *
 * The reply is parsed here and handed back as data. Documents are written
 * by `project-docs-write.ts`, only after the user confirms the wizard.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { checkHarness } from "./agent-status.ts";
import { harnesses } from "./db.ts";
import { defaultEffortFor, minCliVersionError } from "./orchestrator.ts";
import { isInside, locateFile } from "./project-discovery.ts";
import { ownerProjectOf } from "./project-ownership.ts";
import { checkWorkdirLaunchAdmission, reconcileProjectDrain, registerProjectLifecycleInterviewProbe } from "./project-lifecycle.ts";
import { resolveInterviewIsolation } from "./interview-isolation.ts";
import {
  cancelIsolatedTurn,
  runIsolatedTurn,
  stopIsolatedTurnsSync,
  sweepIsolatedLeftovers,
  type IsolatedTurnControl,
} from "./isolated-agent-turn.ts";
import { README_CANDIDATES, SECRET_FILE_NAMES, isSafeProjectRelPath, type DocKind } from "../shared/project-discovery.ts";
import {
  INTERVIEW_LIMITS,
  buildInterviewPrompt,
  capText,
  contextExcerpt,
  interviewSupportFor,
  sanitizeInterviewMessages,
  validateDocTarget,
  parseDraftsReply,
  parseQuestionReply,
  parseSectionReply,
  type InterviewIsolation,
  type InterviewRequest,
  type TurnOutcome,
} from "../shared/project-interview.ts";
import { DEFAULT_MODEL, type Harness } from "../shared/types.ts";

/** A turn that runs longer than this is stopped and reported as failed. */
const TURN_TIMEOUT_MS = Number(process.env.AGETOR_INTERVIEW_TURN_TIMEOUT_MS ?? 0) || 5 * 60_000;
/** Settled turns are kept this long for the client's poll to read. */
const SETTLED_TTL_MS = 10 * 60_000;
const EXCERPT_READ_CAP = 64 * 1024;

export type TurnStatus = "running" | "succeeded" | "failed" | "cancelled";

export type TurnResult = TurnOutcome;

export interface TurnView {
  id: string;
  interviewId: string;
  status: TurnStatus;
  result: TurnResult | null;
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

interface TurnJob extends TurnView {
  projectPath: string | null;
  request: InterviewRequest;
  wanted: DocKind[];
  control: IsolatedTurnControl;
}

const jobs = new Map<string, TurnJob>();
/** interviewId → running turn id. One turn at a time per interview. */
const runningByInterview = new Map<string, string>();

registerProjectLifecycleInterviewProbe((projectPath) => {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "running" && job.projectPath && ownerProjectOf(job.projectPath, { fresh: true }) === projectPath) {
      count += 1;
    }
  }
  return count;
});

export type StartTurnResult =
  | { ok: true; turn: TurnView }
  | { ok: false; status: 400 | 404 | 409 | 422 | 428; error: string; isolation?: InterviewIsolation };

function view(job: TurnJob): TurnView {
  return {
    id: job.id,
    interviewId: job.interviewId,
    status: job.status,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    settledAt: job.settledAt,
  };
}

function pruneSettled(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.settledAt != null && now - job.settledAt > SETTLED_TTL_MS) jobs.delete(id);
  }
}

export function getInterviewTurn(id: string): TurnView | null {
  pruneSettled();
  const job = jobs.get(id);
  return job ? view(job) : null;
}

/** True when a turn was running and is now being stopped. */
export function cancelInterviewTurn(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  cancelIsolatedTurn(job.control);
  return true;
}

/**
 * Checks shared with `startTask`'s pre-flight: the harness exists, is
 * enabled, can run interviews, is installed, isn't logged out, and its CLI is
 * new enough for the model. Returns the harness and the mode to run in.
 */
export async function interviewPreflight(
  harnessId: string,
  model: string | null,
  effort: string | null = null,
  deps: { checkHarness?: typeof checkHarness; isolation?: typeof resolveInterviewIsolation } = {},
): Promise<
  | { ok: true; harness: Harness; mode: string; model: string; effort: string | null; isolation: InterviewIsolation }
  | { ok: false; status: 404 | 422; error: string }
> {
  const probeHarness = deps.checkHarness ?? checkHarness;
  const probeIsolation = deps.isolation ?? resolveInterviewIsolation;
  const harness = harnesses.getByIdOrKind(harnessId);
  if (!harness) return { ok: false, status: 404, error: `Harness "${harnessId}" was not found. Pick another agent.` };
  if (!harness.enabled) {
    return { ok: false, status: 422, error: `${harness.label} is disabled. Enable it in Settings or pick another agent.` };
  }
  const support = interviewSupportFor(harness.kind);
  if (!support.supported) return { ok: false, status: 422, error: `${harness.label}: ${support.reason}` };
  const status = await probeHarness(harness, { freshAuth: true });
  if (!status.available) {
    const hint = status.installHint ? ` Install it with: ${status.installHint}` : "";
    return { ok: false, status: 422, error: `${harness.label} is not available — ${status.reason}.${hint}` };
  }
  if (status.loggedIn === false) {
    return {
      ok: false,
      status: 422,
      error: `${harness.label} isn't logged in — ${status.authHelp ?? "run its login command"}. Pick another agent or log in and try again.`,
    };
  }
  const resolvedModel = model?.trim() || DEFAULT_MODEL[harness.kind];
  const floor = await minCliVersionError(harness, resolvedModel, status);
  if (floor) return { ok: false, status: 422, error: floor };
  const resolvedEffort = effort?.trim() || defaultEffortFor(harness.kind, resolvedModel, harness.id);
  const isolation = await probeIsolation(harness);
  if (!isolation.ok) return { ok: false, status: 422, error: isolation.error };
  return { ok: true, harness, mode: support.mode, model: resolvedModel, effort: resolvedEffort, isolation: isolation.isolation };
}

function wantedOf(request: InterviewRequest, targets: { idea: string | null; prd: string | null }): DocKind[] {
  if (request.kind !== "drafts") return [];
  return (["idea", "prd"] as const).filter((kind) => targets[kind] != null);
}

function parseResult(job: TurnJob, text: string): TurnResult {
  if (job.request.kind === "question") return { kind: "question", reply: parseQuestionReply(text) };
  if (job.request.kind === "drafts") return { kind: "drafts", reply: parseDraftsReply(text, job.wanted) };
  return { kind: "section", reply: parseSectionReply(text) };
}

function settle(job: TurnJob, status: TurnStatus, fields: { result?: TurnResult | null; error?: string | null }): void {
  if (job.status !== "running") return;
  job.status = status;
  job.result = fields.result ?? null;
  job.error = fields.error ?? null;
  job.settledAt = Date.now();
  if (runningByInterview.get(job.interviewId) === job.id) runningByInterview.delete(job.interviewId);
  if (job.projectPath) {
    const owner = ownerProjectOf(job.projectPath, { fresh: true });
    if (owner) reconcileProjectDrain(owner);
  }
}

/**
 * Start one turn. Resolves once the agent has been launched (or refused);
 * the reply arrives through `getInterviewTurn`. Never throws.
 */
export async function startInterviewTurn(input: {
  interviewId: string;
  projectPath?: string | null;
  harnessId: string;
  model: string | null;
  effort: string | null;
  fast?: boolean;
  maxMode?: boolean;
  prompt: string;
  request: InterviewRequest;
  targets: { idea: string | null; prd: string | null };
  /** `InterviewIsolation.consentKey` the user confirmed in the wizard. */
  consent: string | null;
}, deps: Parameters<typeof interviewPreflight>[3] = {}): Promise<StartTurnResult> {
  if (input.projectPath) {
    const lifecycle = checkWorkdirLaunchAdmission(input.projectPath);
    if (!lifecycle.allowed) {
      return { ok: false, status: 409, error: lifecycle.reason! };
    }
  }
  if (runningByInterview.has(input.interviewId)) {
    return { ok: false, status: 409, error: "The agent is still answering. Wait for it or cancel first." };
  }
  const turnId = crypto.randomUUID();
  // Claimed before the first await so a double click can't start two turns.
  runningByInterview.set(input.interviewId, turnId);
  const job: TurnJob = {
    id: turnId,
    interviewId: input.interviewId,
    projectPath: input.projectPath ?? null,
    status: "running",
    result: null,
    error: null,
    startedAt: Date.now(),
    settledAt: null,
    request: input.request,
    wanted: wantedOf(input.request, input.targets),
    control: { cancelRequested: false, handle: null },
  };

  const preflight = await interviewPreflight(input.harnessId, input.model, input.effort, deps);
  if (!preflight.ok) {
    runningByInterview.delete(input.interviewId);
    return { ok: false, status: preflight.status, error: preflight.error };
  }
  if (input.consent !== preflight.isolation.consentKey) {
    runningByInterview.delete(input.interviewId);
    return {
      ok: false,
      status: 428,
      error: "Confirm what this agent can and can't do before the interview starts.",
      isolation: preflight.isolation,
    };
  }
  pruneSettled();
  jobs.set(turnId, job);
  void runTurn(job, preflight.harness, {
    mode: preflight.mode,
    model: preflight.model,
    effort: preflight.effort,
    fast: input.fast === true,
    maxMode: input.maxMode === true,
    prompt: input.prompt,
    lockdownArgs: preflight.isolation.args,
  });
  return { ok: true, turn: view(job) };
}

async function runTurn(
  job: TurnJob,
  harness: Harness,
  opts: {
    mode: string;
    model: string;
    effort: string | null;
    fast: boolean;
    maxMode: boolean;
    prompt: string;
    lockdownArgs: string[];
  },
): Promise<void> {
  const outcome = await runIsolatedTurn({ turnId: job.id, harness, timeoutMs: TURN_TIMEOUT_MS, ...opts }, job.control);
  if (outcome.kind === "cancelled") {
    settle(job, "cancelled", { error: "Cancelled." });
    return;
  }
  if (outcome.kind === "failed") {
    settle(job, "failed", { error: outcome.error });
    return;
  }
  const result = parseResult(job, outcome.text);
  if (!result.reply.ok) {
    settle(job, "failed", { error: result.reply.error });
    return;
  }
  settle(job, "succeeded", { result });
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Context excerpts.
 * ────────────────────────────────────────────────────────────────────────── */

const SECRET_NAMES: ReadonlySet<string> = new Set(SECRET_FILE_NAMES.map((name) => name.toLowerCase()));

/**
 * A markdown file inside the (already realpath'd) project root, or null:
 * the path must be a safe relative path, end in .md/.markdown, not be a
 * secret file name, resolve inside `root` through symlinks, and fit the
 * read cap. Shared with the project manager's context reader.
 */
export function readSafeMarkdown(root: string, rel: string, readCap: number = EXCERPT_READ_CAP): string | null {
  if (!isSafeProjectRelPath(rel)) return null;
  const base = path.posix.basename(rel).toLowerCase();
  if (SECRET_NAMES.has(base) || base.startsWith(".env")) return null;
  if (!/\.(md|markdown)$/i.test(rel)) return null;
  const located = locateFile(root, rel);
  if (!located.ok || located.size > readCap) return null;
  try {
    return readFileSync(located.real, "utf8");
  } catch {
    return null;
  }
}

/**
 * Excerpts of the README and the existing IDEA/PRD the user selected, read
 * from inside `projectPath` only (realpath-checked, markdown only, secrets
 * never opened) and redacted. An absent folder yields no excerpts.
 */
export function readInterviewExcerpts(
  projectPath: string,
  paths: { readmePath: string | null; ideaPath: string | null; prdPath: string | null },
): { path: string; label: string; text: string }[] {
  if (!path.isAbsolute(projectPath)) return [];
  let root: string;
  try {
    if (!statSync(projectPath).isDirectory()) return [];
    root = realpathSync(projectPath);
  } catch {
    return [];
  }
  const out: { path: string; label: string; text: string }[] = [];
  const add = (rel: string | null, label: string) => {
    if (!rel || out.some((item) => item.path === rel)) return;
    const text = readSafeMarkdown(root, rel);
    if (text == null) return;
    const excerpt = contextExcerpt(text);
    if (excerpt) out.push({ path: rel, label, text: excerpt });
  };
  add(paths.ideaPath, "existing IDEA document");
  add(paths.prdPath, "existing PRD document");
  if (paths.readmePath && (README_CANDIDATES as readonly string[]).includes(paths.readmePath)) {
    add(paths.readmePath, "README");
  }
  return out.filter((item) => isInside(root, path.join(root, item.path)));
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Request body → prompt.
 * ────────────────────────────────────────────────────────────────────────── */

export interface PreparedTurn {
  interviewId: string;
  projectPath: string;
  harnessId: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  maxMode: boolean;
  prompt: string;
  request: InterviewRequest;
  targets: { idea: string | null; prd: string | null };
  consent: string | null;
}

function optString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? capText(trimmed, max) : null;
}

function relOrNull(value: unknown): string | null {
  return typeof value === "string" && isSafeProjectRelPath(value) ? value : null;
}

function parseRequest(value: unknown): InterviewRequest | string {
  if (!value || typeof value !== "object") return "request required";
  const record = value as Record<string, unknown>;
  if (record.kind === "question" || record.kind === "drafts") return { kind: record.kind };
  if (record.kind === "section") {
    const doc = record.doc === "idea" || record.doc === "prd" ? record.doc : null;
    const heading = optString(record.heading, 200);
    if (!doc || !heading) return "section requests need doc and heading";
    const instruction = typeof record.instruction === "string"
      ? capText(record.instruction.trim(), INTERVIEW_LIMITS.instructionChars)
      : "";
    return { kind: "section", doc, heading, instruction };
  }
  return "unknown request kind";
}

/**
 * Validate a turn body from the wizard and build its prompt. The context
 * the client sends is display data from discovery; file excerpts are read
 * here, server-side, from the project folder.
 */
export function prepareInterviewTurn(body: unknown):
  | { ok: true; turn: PreparedTurn }
  | { ok: false; status: 400; error: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body required" };
  const record = body as Record<string, unknown>;
  const interviewId = typeof record.interviewId === "string" && /^[A-Za-z0-9-]{8,100}$/.test(record.interviewId)
    ? record.interviewId
    : null;
  if (!interviewId) return { ok: false, status: 400, error: "interviewId required" };
  const harnessId = optString(record.harness, 200);
  if (!harnessId) return { ok: false, status: 400, error: "Choose an agent first." };
  const request = parseRequest(record.request);
  if (typeof request === "string") return { ok: false, status: 400, error: request };

  const project = (record.project && typeof record.project === "object" ? record.project : {}) as Record<string, unknown>;
  const projectPath = typeof project.path === "string" && path.isAbsolute(project.path) ? project.path : null;
  if (!projectPath) return { ok: false, status: 400, error: "project.path must be absolute" };
  const rawTargets = (project.targets && typeof project.targets === "object" ? project.targets : {}) as Record<string, unknown>;
  const target = (value: unknown): string | null =>
    typeof value === "string" && validateDocTarget(value) == null ? value.trim() : null;
  const targets = { idea: target(rawTargets.idea), prd: target(rawTargets.prd) };
  if (!targets.idea && !targets.prd) return { ok: false, status: 400, error: "Nothing to draft: both documents exist." };
  const ideaPath = relOrNull(project.ideaPath);
  const prdPath = relOrNull(project.prdPath);

  const rawDrafts = (record.drafts && typeof record.drafts === "object" ? record.drafts : {}) as Record<string, unknown>;
  const drafts = {
    idea: typeof rawDrafts.idea === "string" ? capText(rawDrafts.idea, INTERVIEW_LIMITS.draftChars) : null,
    prd: typeof rawDrafts.prd === "string" ? capText(rawDrafts.prd, INTERVIEW_LIMITS.draftChars) : null,
  };
  if (request.kind === "section" && !drafts[request.doc]?.trim()) {
    return { ok: false, status: 400, error: "There is no draft to revise yet." };
  }
  if (request.kind === "section" && !targets[request.doc]) {
    return { ok: false, status: 400, error: "That document already exists and isn't being drafted." };
  }

  const signals = Array.isArray(project.signals)
    ? project.signals
      .filter((item): item is string => typeof item === "string")
      .slice(0, INTERVIEW_LIMITS.signals)
      .map((item) => capText(item, INTERVIEW_LIMITS.signalChars))
    : [];
  const excerpts = readInterviewExcerpts(projectPath, {
    readmePath: relOrNull(project.readmePath),
    ideaPath,
    prdPath,
  });
  const prompt = buildInterviewPrompt({
    request,
    context: {
      name: optString(project.name, INTERVIEW_LIMITS.projectNameChars) ?? "",
      description: optString(project.description, INTERVIEW_LIMITS.descriptionChars) ?? "",
      mode: project.mode === "create" ? "create" : "import",
      empty: project.empty === true,
      stack: optString(project.stack, 300) ?? "No stack detected",
      signals,
      gitBranch: optString(project.gitBranch, 200),
      excerpts,
    },
    plan: {
      idea: { existing: ideaPath, target: targets.idea },
      prd: { existing: prdPath, target: targets.prd },
    },
    messages: sanitizeInterviewMessages(record.messages),
    drafts,
  });
  return {
    ok: true,
    turn: {
      interviewId,
      projectPath,
      harnessId,
      model: optString(record.model, 200),
      effort: optString(record.effort, 100),
      fast: record.fast === true,
      maxMode: record.maxMode === true,
      prompt,
      request,
      targets,
      consent: typeof record.consent === "string" && /^[0-9a-f]{16}$/.test(record.consent) ? record.consent : null,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Process lifecycle: nothing an interview starts outlives its owner.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Kill every running turn's tmux session, synchronously, for exit handlers
 * where an async kill would never finish. Covers every isolated turn this
 * process started (interviews and project-manager turns), by name.
 */
export function stopInterviewTurnsSync(): number {
  for (const job of jobs.values()) {
    if (job.status === "running") job.control.cancelRequested = true;
  }
  return stopIsolatedTurnsSync();
}

/**
 * Boot backstop for a turn whose process died (crash, force quit). See
 * `sweepIsolatedLeftovers`: it never enumerates sessions.
 */
export async function sweepInterviewLeftovers(deps: { kill?: (name: string) => Promise<void> } = {}): Promise<number> {
  return sweepIsolatedLeftovers(deps);
}

export const __testing = {
  jobs,
  runningByInterview,
  reset(): void {
    jobs.clear();
    runningByInterview.clear();
  },
};
