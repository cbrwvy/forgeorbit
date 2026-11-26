/**
 * Baseline-versus-candidate evaluation through the existing specialist harness.
 * Synthetic driver results stay labeled synthetic. A production driver is not
 * started unless AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE=1.
 * Evaluation workspaces stay under the ForgeOrbit data directory.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDriverIsFake, spawnAgent } from "../agents.ts";
import { runSeatbeltBunTest, withPracticalTestLock } from "../autonomy/observed-test.ts";
import { dataDir, harnesses } from "../db.ts";
import { FAKE_PRACTICAL_DRAFT_MARKER, FAKE_PRACTICAL_IMPL_MARKER, parseProviderImprovementDraft } from "../../shared/practical-cycle.ts";
import { approvedTestCommand } from "../../shared/review-evidence.ts";
import {
  composeImprovementGuidance,
  contentSha,
  deterministicImprovementDraft,
  snapshotSha,
  type FixtureScore,
  type FrozenImprovementVersion,
} from "../../shared/self-improve/logic.ts";

const REAL_INFERENCE_FLAG = "AGETOR_ALLOW_REAL_IMPROVEMENT_INFERENCE";
const AGENT_TIMEOUT_MS = 60_000;

export function realImprovementInferenceAllowed(): boolean {
  return process.env[REAL_INFERENCE_FLAG] === "1";
}

function blockedProvider(provider: string): boolean {
  const value = provider.toLowerCase();
  return value === "cursor" || value.includes("deepseek");
}

function fileHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out.set(path.relative(root, abs), createHash("sha256").update(readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

function frozenChanged(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const [rel, hash] of before) {
    if (after.get(rel) !== hash) return true;
  }
  return false;
}

function guidance(content: string, requirements: string, outputPath: string): string {
  const version: FrozenImprovementVersion = {
    artifactKey: "eval",
    version: 1,
    sha256: contentSha(content),
    scope: "project",
    projectPath: null,
    role: "developer",
    targetKind: "skill",
    content,
  };
  const task = [
    requirements,
    FAKE_PRACTICAL_IMPL_MARKER,
    `FO_PRACTICAL_OUTPUT ${outputPath}`,
  ].join("\n");
  return composeImprovementGuidance({ versions: [version], sha256: snapshotSha([version]) }, task);
}

async function boundedSpawn(input: {
  harnessId: string;
  prompt: string;
  cwd: string;
  model: string;
  real: boolean;
}): Promise<{ code: number; assistant: string }> {
  const harness = harnesses.getByIdOrKind(input.harnessId);
  if (!harness) throw new Error(`No harness is available for ${input.harnessId}.`);
  let assistant = "";
  const agent = await spawnAgent({
    taskId: `improve-${randomUUID()}`,
    runId: randomUUID(),
    harness,
    prompt: input.prompt,
    cwd: input.cwd,
    opts: { model: input.model },
    authorize: () => input.real ? realImprovementInferenceAllowed() : agentDriverIsFake(harness.kind),
    onChunk: (stream, text) => {
      if (stream === "assistant") assistant += text;
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      agent.kill();
      resolve(-1);
    }, AGENT_TIMEOUT_MS);
  });
  const code = await Promise.race([agent.done, timeout]);
  if (timer) clearTimeout(timer);
  return { code, assistant };
}

export async function requestImprovementDraft(input: {
  currentContent: string;
  weakness: string;
  provider: string;
  model: string;
  accountId: string | null;
}): Promise<{
  proposedContent: string;
  hypothesis: string;
  expectedResult: string;
  generation: "synthetic-driver" | "provider" | "deterministic-fallback";
  inferenceCompleted: boolean;
} | { error: string }> {
  if (blockedProvider(input.provider)) {
    return { error: "Cursor and DeepSeek stay execution-blocked. No improvement draft was requested." };
  }
  const harness = harnesses.getByIdOrKind(input.provider);
  const fake = harness ? agentDriverIsFake(harness.kind) : false;
  if (!fake && !realImprovementInferenceAllowed()) {
    const draft = deterministicImprovementDraft({ currentContent: input.currentContent, weakness: input.weakness });
    if ("error" in draft) return draft;
    return { ...draft, generation: "deterministic-fallback", inferenceCompleted: false };
  }
  if (!harness) return { error: "No harness is available for this improvement draft. No provider request was sent." };
  const prompt = [
    FAKE_PRACTICAL_DRAFT_MARKER,
    "FO_CURRENT_INSTRUCTIONS_BEGIN",
    input.currentContent,
    "FO_CURRENT_INSTRUCTIONS_END",
    "FO_WEAKNESS_BEGIN",
    input.weakness,
    "FO_WEAKNESS_END",
  ].join("\n");
  let result: { code: number; assistant: string };
  try {
    result = await boundedSpawn({
      harnessId: harness.id,
      prompt,
      cwd: dataDir,
      model: input.model,
      real: !fake,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The improvement draft did not complete." };
  }
  if (result.code !== 0) return { error: "The improvement draft did not complete. No skill text was applied." };
  const parsed = parseProviderImprovementDraft(result.assistant);
  if ("error" in parsed) return parsed;
  return {
    ...parsed,
    generation: fake ? "synthetic-driver" : "provider",
    inferenceCompleted: !fake,
  };
}

function scoreFromObservation(input: {
  exitCode: number | null;
  durationMs: number;
  securityViolations: number;
}): FixtureScore {
  const passed = input.exitCode === 0 && input.securityViolations === 0;
  return {
    errors: passed ? 0 : 1,
    rework: passed ? 0 : 1,
    qcPass: passed,
    durationMs: input.durationMs,
    tokens: null,
    costUsd: null,
    securityViolations: input.securityViolations,
  };
}

export async function executeHarnessComparison(input: {
  candidateId: string;
  projectPath: string | null;
  baselineContent: string;
  candidateContent: string;
  provider: string;
  model: string;
  accountId: string | null;
  tasks: Array<{ name: string; requirements: string; files: Record<string, string>; outputPath: string; testPath: string; heldOut?: boolean }>;
}): Promise<{
  execution: "synthetic-driver" | "provider" | "refused-real";
  inferenceCompleted: boolean;
  note?: string;
  fixtures?: Array<{ heldOut: boolean; baseline: FixtureScore; candidate: FixtureScore }>;
}> {
  if (blockedProvider(input.provider)) {
    return { execution: "refused-real", inferenceCompleted: false, note: "Cursor and DeepSeek stay execution-blocked. No evaluation was started." };
  }
  if (!input.candidateContent.trim() || input.tasks.length === 0) {
    return { execution: "refused-real", inferenceCompleted: false, note: "The comparison has no candidate text or held evaluation tasks." };
  }
  const harness = harnesses.getByIdOrKind(input.provider);
  const fake = harness ? agentDriverIsFake(harness.kind) : false;
  if (!fake && !realImprovementInferenceAllowed()) {
    return {
      execution: "refused-real",
      inferenceCompleted: false,
      note: "Real inference was not authorized. No provider request was sent.",
    };
  }
  if (!harness) {
    return { execution: "refused-real", inferenceCompleted: false, note: "No harness is available. No provider request was sent." };
  }
  const root = path.join(dataDir, "improvement-evals", input.candidateId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || randomUUID());
  mkdirSync(root, { recursive: true });
  const resolvedRoot = realpathSync(root);
  if (input.projectPath) {
    let project = input.projectPath;
    try { project = realpathSync(input.projectPath); } catch { /* the recorded path is enough for the containment check */ }
    const inside = resolvedRoot === project || resolvedRoot.startsWith(project + path.sep) || project.startsWith(resolvedRoot + path.sep);
    if (inside) {
      return { execution: "refused-real", inferenceCompleted: false, note: "The evaluation workspace is not disjoint from the Owner project. Nothing was written there." };
    }
  }
  const fixtures: Array<{ heldOut: boolean; baseline: FixtureScore; candidate: FixtureScore }> = [];
  let inferenceCompleted = !fake;
  for (const task of input.tasks) {
    const pair: { baseline?: FixtureScore; candidate?: FixtureScore } = {};
    for (const side of ["baseline", "candidate"] as const) {
      const workspace = path.join(resolvedRoot, side, task.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "task");
      mkdirSync(workspace, { recursive: true });
      for (const [rel, text] of Object.entries(task.files)) {
        if (rel === task.outputPath || rel.startsWith("/") || rel.split("/").includes("..")) continue;
        const file = path.join(workspace, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      const before = fileHashes(workspace);
      const started = Date.now();
      const content = side === "baseline" ? input.baselineContent : input.candidateContent;
      let code = 1;
      try {
        const spawned = await boundedSpawn({
          harnessId: harness.id,
          prompt: guidance(content, task.requirements, task.outputPath),
          cwd: workspace,
          model: input.model,
          real: !fake,
        });
        code = spawned.code;
      } catch {
        inferenceCompleted = false;
        pair[side] = scoreFromObservation({ exitCode: null, durationMs: Date.now() - started, securityViolations: 0 });
        continue;
      }
      if (code !== 0) inferenceCompleted = false;
      const securityViolations = frozenChanged(before, fileHashes(workspace)) ? 1 : 0;
      const command = approvedTestCommand(task.testPath);
      if (!command) {
        pair[side] = scoreFromObservation({ exitCode: null, durationMs: Date.now() - started, securityViolations: securityViolations + 1 });
        continue;
      }
      const observed = await withPracticalTestLock(() => runSeatbeltBunTest({
        workspacePath: workspace,
        testPath: task.testPath,
        command,
        executable: process.execPath,
        argv: ["test", `./${task.testPath}`],
      }));
      const exitCode = observed.isolation === "macos-offline-seatbelt" && !observed.timedOut && !observed.outputExceeded && !observed.interrupted
        ? observed.exitCode
        : null;
      pair[side] = scoreFromObservation({
        exitCode,
        durationMs: Date.now() - started,
        securityViolations,
      });
    }
    if (!pair.baseline || !pair.candidate) {
      return { execution: fake ? "synthetic-driver" : "provider", inferenceCompleted: false, note: "One side of the comparison did not produce a score. The result stays inconclusive." };
    }
    fixtures.push({ heldOut: task.heldOut === true, baseline: pair.baseline, candidate: pair.candidate });
  }
  return {
    execution: fake ? "synthetic-driver" : "provider",
    inferenceCompleted,
    fixtures,
  };
}
