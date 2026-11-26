/**
 * Turns the Mission Control form into the existing policy and mission bodies.
 * Saving this object does not activate a policy.
 */
import type { AutonomyAction, AutonomyMode, AutonomyPolicyBody } from "../../shared/autonomy-policy.ts";

function fixedTestCommand(testPath: string): string | null {
  const base = testPath.split("/").at(-1) ?? "";
  if (!testPath || testPath.startsWith("/") || testPath.split("/").includes("..") || testPath.includes("\\")) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(testPath) || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return null;
  return `bun test ./${testPath}`;
}

export interface AutonomyDraftFields {
  mode: AutonomyMode;
  projects: string;
  providers: string;
  models: string;
  accounts: string;
  allowUnscopedAccount: boolean;
  workers: string;
  launches: string;
  minutes: string;
  expectedMinutes?: string;
  apiBudget?: string;
  hardSpendCap?: boolean;
  requireVerifiedQuota?: boolean;
  rework: string;
  requireObservedTest: boolean;
  requireIndependentReviewer: boolean;
  autoComplete: boolean;
  permitSelfImprovement: boolean;
  testCommand: string;
  outputPath: string;
}

export interface MissionTaskDraft {
  title: string;
  projectPath: string;
  specialistRole: string;
  prompt?: string;
  taskId?: string;
  dependsOnTitles?: Array<{ title: string; condition: "qc_pass" }>;
}

const FULL_ACTIONS: AutonomyAction[] = [
  "create_task",
  "assign_specialist",
  "plan_task",
  "launch_task",
  "run_qc",
  "request_rework",
  "select_model",
  "retrieve_brain",
  "save_observation",
  "update_mission_status",
  "coordinate_projects",
];

function lines(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function integer(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function buildAutonomyDraft(fields: AutonomyDraftFields, now = Date.now()): { ok: true; body: AutonomyPolicyBody } | { ok: false; error: string } {
  const projects = lines(fields.projects);
  if (projects.length === 0) return { ok: false, error: "Name at least one project path." };
  const providers = lines(fields.providers).map((item) => item.toLowerCase());
  const models = lines(fields.models);
  if (providers.length === 0 || models.length === 0) return { ok: false, error: "Name the providers and models this policy allows." };
  const accounts = lines(fields.accounts);
  const minutes = integer(fields.minutes, 60);
  const duration = minutes * 60 * 1000;
  const expected = fields.expectedMinutes?.trim() ? Number(fields.expectedMinutes) : null;
  const budget = fields.apiBudget?.trim() ? Number(fields.apiBudget) : null;
  if (expected !== null && (!Number.isInteger(expected) || expected < 1 || expected > minutes)) {
    return { ok: false, error: "Expected minutes must be between one and the execution limit." };
  }
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) return { ok: false, error: "Enter a non-negative API budget." };
  const actions: AutonomyAction[] = fields.mode === "supervised" ? ["plan_task"] : [...FULL_ACTIONS];
  if (fields.mode !== "supervised" && fields.autoComplete) actions.push("complete_task");
  if (fields.mode === "full-autonomy" && fields.requireObservedTest) actions.push("run_observed_test");
  let authorizedTests: AutonomyPolicyBody["authorizedTests"];
  if (fields.requireObservedTest) {
    const command = fields.testCommand.trim();
    const testPath = command.startsWith("bun test ./") ? command.slice("bun test ./".length) : "";
    if (!testPath || fixedTestCommand(testPath) !== command) {
      return { ok: false, error: "The observed test must be the fixed command bun test ./<relative test path>." };
    }
    const outputPath = fields.outputPath.trim();
    if (!/^[A-Za-z0-9_./-]+$/.test(outputPath) || outputPath.startsWith("/") || outputPath.split("/").includes("..") || outputPath === testPath) {
      return { ok: false, error: "The output path must be a safe relative implementation path." };
    }
    authorizedTests = projects.map((projectPath) => ({ projectPath, command, outputPaths: [outputPath] }));
  }
  const body: AutonomyPolicyBody = {
    mode: fields.mode,
    scopeKind: projects.length > 1 ? "workspace" : "project",
    scopeRef: projects.length > 1 ? "workspace" : projects[0]!,
    missionId: null,
    projects,
    clusters: [],
    taskIds: [],
    permittedActions: actions,
    deniedOperations: [],
    specialistRoles: ["developer", "reviewer", "head"],
    providers,
    models,
    accounts,
    allowUnscopedAccount: fields.allowUnscopedAccount,
    maxConcurrentWorkers: integer(fields.workers, 2),
    maxLaunches: integer(fields.launches, 12),
    maxDurationMs: duration,
    ...(expected === null ? {} : { expectedDurationMs: expected * 60_000 }),
    ...(fields.requireVerifiedQuota ? { requireVerifiedQuota: true as const } : {}),
    spending: { limitUsd: budget, requireEnforceableCap: fields.hardSpendCap === true, enforceable: false, measured: false },
    qc: {
      required: true,
      requireIndependentReviewer: fields.requireIndependentReviewer,
      requireObservedTest: fields.requireObservedTest,
    },
    maxReworkAttempts: integer(fields.rework, 1),
    completion: {
      autoComplete: fields.mode !== "supervised" && fields.autoComplete,
      conditions: fields.requireObservedTest ? ["qc_pass", "observed_test"] : ["qc_pass"],
    },
    memory: { approval: "owner" },
    routerPreset: "balanced",
    selfImprovement: { enabled: fields.permitSelfImprovement, lowRiskActivation: false },
    expiresAt: now + duration,
  };
  if (authorizedTests) body.authorizedTests = authorizedTests;
  return { ok: true, body };
}

/** `title | project | role | depends | taskId | prompt`. A dash leaves depends or taskId empty. */
export function parseMissionTaskLines(text: string): { ok: true; tasks: MissionTaskDraft[] } | { ok: false; error: string } {
  const tasks: MissionTaskDraft[] = [];
  const rows = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (rows.length === 0) return { ok: false, error: "Add at least one mission task." };
  for (const row of rows) {
    const parts = row.split("|").map((part) => part.trim());
    if (parts.length < 6) return { ok: false, error: "Each task needs title, project, role, depends, task id, and prompt." };
    const [title, projectPath, role, depends, taskId, ...promptParts] = parts;
    if (!title || !projectPath || !role) return { ok: false, error: "A task needs a title, project path, and role." };
    const prompt = promptParts.join(" | ").trim();
    const draft: MissionTaskDraft = { title, projectPath, specialistRole: role.toLowerCase() };
    if (depends && depends !== "-") draft.dependsOnTitles = [{ title: depends, condition: "qc_pass" }];
    if (taskId && taskId !== "-") draft.taskId = taskId;
    if (prompt) draft.prompt = prompt;
    if (!draft.taskId && !draft.prompt) return { ok: false, error: `Task “${title}” needs a prompt or an existing task id.` };
    tasks.push(draft);
  }
  return { ok: true, tasks };
}
