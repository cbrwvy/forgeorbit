/**
 * Collects a bounded review evidence bundle from one task workspace.
 * Reading this bundle never runs project tests. The only spawn is
 * `executeApprovedTest`, and only an Owner authorization calls it.
 * Does not follow symlinks and does not run a shell. A directory name is not
 * an allow or deny rule. The test child is not an OS sandbox.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { runs, tasks } from "./db.ts";
import { getTaskWorkspace, publishedSourceTrust, readChangeSetForRun } from "./task-workspace.ts";
import { QC_RECOVERY_LIMITS } from "../shared/qc-recovery.ts";
import {
  REVIEW_EVIDENCE_LIMITS,
  approvedTestCommand,
  blockedBundle,
  chooseApprovedTestPath,
  completeBundle,
  describeApprovedTest,
  evidenceDigest,
  isSecretRelPath,
  isSecretText,
  isUnsafeRelPath,
  previewBundle,
  reviewFileRole,
  sha256Text,
  sourceFingerprint,
  TEST_OBSERVATION_LIMITATION,
  type DeveloperSourceSnapshot,
  type ReviewEvidenceBundle,
  type ReviewEvidenceFile,
  type ReviewEvidenceTest,
  type ReviewFileProvenance,
  type ReviewSourceBasis,
} from "../shared/review-evidence.ts";

const HISTORICAL_LIMITATION =
  "No source snapshot was stored when the Developer run finished. These contents were read from the current workspace after path and freshness checks. They are not a retrospective proof of the historical file bytes.";

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

export function parseSourceSnapshot(raw: string | null): DeveloperSourceSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DeveloperSourceSnapshot;
    if (!value || value.version !== 1 || !Array.isArray(value.files)) return null;
    return value;
  } catch {
    return null;
  }
}

export function readRunSourceSnapshot(runId: string): DeveloperSourceSnapshot | null {
  return parseSourceSnapshot(runs.readSourceEvidence(runId));
}

function emptyBundleBase(input: {
  taskId: string;
  requirements: string;
  developerRunId: string;
  projectPath: string;
  workspacePath: string;
  sourceBasis: ReviewSourceBasis;
  historicalLimitation: string | null;
  resourceFingerprint: string | null;
}) {
  return {
    blocker: null as string | null,
    taskId: input.taskId,
    requirements: input.requirements,
    requirementsHash: sha256Text(input.requirements),
    developerRunId: input.developerRunId,
    projectPath: input.projectPath,
    workspacePath: input.workspacePath,
    gitHead: null as string | null,
    sourceBasis: input.sourceBasis,
    historicalLimitation: input.historicalLimitation,
    files: [] as ReviewEvidenceFile[],
    omitted: [] as { path: string; reason: string }[],
    diff: null as string | null,
    diffOmission: null as string | null,
    proposedTest: null,
    test: null as ReviewEvidenceTest | null,
    rulesText: null as string | null,
    knowledgeRefs: [] as { id: string; title: string }[],
    resourceFingerprint: input.resourceFingerprint,
  };
}

export async function collectReviewEvidence(input: {
  taskId: string;
  requirements: string;
  workspacePath: string;
  projectPath: string;
  developerRunId: string;
  developerEndedAt: number;
  snapshot: DeveloperSourceSnapshot | null;
  rulesText: string | null;
  knowledgeRefs: { id: string; title: string }[];
  resourceFingerprint: string | null;
  reuseTest?: ReviewEvidenceTest | null;
}): Promise<ReviewEvidenceBundle> {
  let workspacePath: string;
  let projectPath: string;
  try {
    workspacePath = realpathSync(input.workspacePath);
    projectPath = realpathSync(input.projectPath);
  } catch {
    return blockedBundle({
      ...emptyBundleBase({ ...input, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      blocker: "The implementation workspace is missing.",
    });
  }
  if (workspacePath !== projectPath && !workspacePath.startsWith(projectPath + path.sep)) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: null }),
      blocker: "The workspace is outside the task project.",
    });
  }
  const inside = await git(workspacePath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      blocker: "This workspace is not a Git repository, so the implementation files cannot be bounded.",
    });
  }
  const head = await git(workspacePath, ["rev-parse", "HEAD"]);
  const gitHead = head.code === 0 && /^[0-9a-f]{40}$/i.test(head.out.trim()) ? head.out.trim() : null;
  if (!gitHead) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      blocker: "The workspace has no commit to identify.",
    });
  }
  const trust = publishedSourceTrust({
    developerRunId: input.developerRunId,
    taskId: input.taskId,
    projectPath,
    gitHead,
  });
  if (trust.mode === "rejected") {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      gitHead,
      blocker: trust.reason ?? "Task-owned publication provenance is not valid.",
    });
  }
  const publishedHash = new Map(trust.accepted.map((item) => [item.path, item.sha256]));

  const changeSet = readChangeSetForRun(input.developerRunId);
  const omitted: { path: string; reason: string }[] = [];
  let listed: { ok: true; paths: string[] } | { ok: false; reason: string };
  if (changeSet) {
    listed = {
      ok: true,
      paths: changeSet.entries
        .filter((entry) => (entry.kind === "created" || entry.kind === "modified") && entry.scope === "output")
        .map((entry) => entry.path),
    };
    for (const entry of changeSet.entries) {
      if (entry.scope === "unauthorized") {
        omitted.push({ path: entry.path, reason: "Unauthorized change. Not included as this task's implementation." });
      } else if (entry.kind === "unchanged" && entry.beforeProvenance === "untracked") {
        omitted.push({ path: entry.path, reason: "Pre-existing untracked file from earlier work. Not a change from this Developer run." });
      } else if (entry.scope === "dependency" && entry.kind === "unchanged") {
        omitted.push({ path: entry.path, reason: "Labeled dependency. Not a modification from this Developer run." });
      }
    }
  } else {
    const changed = await changedPaths(workspacePath);
    listed = changed;
  }
  if (!listed.ok) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      gitHead,
      blocker: listed.reason,
    });
  }
  const selected = new Set<string>();
  for (const rel of listed.paths) {
    if (isUnsafeRelPath(rel)) {
      return blockedBundle({
        ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
        gitHead,
        blocker: `Git listed an unsafe path (${rel}). Evidence collection stopped.`,
      });
    }
    if (isSecretRelPath(rel)) {
      omitted.push({ path: rel, reason: "Secret or credential path. Contents were not read." });
      continue;
    }
    const role = reviewFileRole(rel);
    if (!role) {
      omitted.push({ path: rel, reason: "Not a review source, test, or project instruction." });
      continue;
    }
    selected.add(rel);
  }
  for (const rel of [...selected]) {
    if (reviewFileRole(rel) !== "implementation") continue;
    const sibling = siblingTestPath(rel);
    if (!sibling || selected.has(sibling)) continue;
    const abs = path.join(workspacePath, sibling);
    try {
      const st = lstatSync(abs);
      if (st.isFile() && !st.isSymbolicLink()) selected.add(sibling);
    } catch {
      // A missing sibling test is reported later if no test file remains.
    }
  }
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    if (selected.has(name)) continue;
    try {
      const st = lstatSync(path.join(workspacePath, name));
      if (st.isFile() && !st.isSymbolicLink() && st.size <= REVIEW_EVIDENCE_LIMITS.maxInstructionBytes) selected.add(name);
      else if (st.isFile() && st.size > REVIEW_EVIDENCE_LIMITS.maxInstructionBytes) {
        omitted.push({ path: name, reason: "Project instructions exceed the evidence bound and were not truncated." });
      }
    } catch {
      // No instruction file at the workspace root.
    }
  }
  if (selected.size > REVIEW_EVIDENCE_LIMITS.maxFiles) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
      gitHead,
      omitted,
      blocker: `This review would need ${selected.size} files. The limit is ${REVIEW_EVIDENCE_LIMITS.maxFiles}. No partial file set was sent.`,
    });
  }

  const snapshotByPath = new Map((input.snapshot?.files ?? []).map((file) => [file.path, file]));
  const files: ReviewEvidenceFile[] = [];
  let total = 0;
  let sawCurrentWorkspace = input.snapshot == null;
  const newestAllowed = input.developerEndedAt + QC_RECOVERY_LIMITS.clockSkewMs;
  for (const rel of [...selected].sort()) {
    const abs = path.join(workspacePath, rel);
    const role = reviewFileRole(rel);
    if (!role) continue;
    const stored = changeSet?.entries.find((entry) => entry.path === rel && entry.text != null);
    const snap = snapshotByPath.get(rel);
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(abs);
    } catch {
      st = null;
    }
    let text: string;
    let provenance: ReviewFileProvenance;
    if (!st) {
      const fallback = stored?.text ?? snap?.text ?? null;
      if (fallback == null) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `Selected file ${rel} is missing.`,
        });
      }
      if (isSecretText(fallback) || Buffer.byteLength(fallback) > REVIEW_EVIDENCE_LIMITS.maxFileBytes) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "run-snapshot", historicalLimitation: null }),
          gitHead,
          omitted,
          blocker: `File ${rel} is not a bounded plain-text snapshot.`,
        });
      }
      const expected = stored?.afterSha256 ?? snap?.sha256 ?? null;
      if (expected && sha256Text(fallback) !== expected) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "run-snapshot", historicalLimitation: null }),
          gitHead,
          omitted,
          blocker: `File ${rel} no longer matches the source captured when Developer run ${input.developerRunId} finished.`,
        });
      }
      text = fallback;
      provenance = "forgeorbit-run-snapshot";
    } else {
      if (st.isSymbolicLink()) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `Selected path ${rel} is a symlink. It was not followed.`,
        });
      }
      if (!st.isFile()) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `Selected path ${rel} is not a file.`,
        });
      }
      let real = abs;
      try {
        real = realpathSync(abs);
      } catch {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `Selected file ${rel} could not be resolved.`,
        });
      }
      if (real !== abs || (real !== workspacePath && !real.startsWith(workspacePath + path.sep))) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `Selected file ${rel} escapes the workspace.`,
        });
      }
      if (st.size > REVIEW_EVIDENCE_LIMITS.maxFileBytes || (role === "instructions" && st.size > REVIEW_EVIDENCE_LIMITS.maxInstructionBytes)) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `File ${rel} exceeds the evidence bound. It was not truncated.`,
        });
      }
      const disk = readFileSync(abs);
      if (disk.includes(0)) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `File ${rel} is not plain text. Its bytes were not sent.`,
        });
      }
      const diskText = disk.toString("utf8");
      if (isSecretText(diskText)) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
          gitHead,
          omitted,
          blocker: `File ${rel} contains key material. Its contents were not sent.`,
        });
      }
      const diskHash = sha256Text(diskText);
      const expectedPublication = publishedHash.get(rel);
      if (expectedPublication && diskHash !== expectedPublication) {
        return blockedBundle({
          ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "run-snapshot", historicalLimitation: null }),
          gitHead,
          omitted,
          blocker: `${rel} no longer matches the bytes published for this Developer run.`,
        });
      }
      if (snap) {
        if (snap.sha256 !== diskHash) {
          return blockedBundle({
            ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "run-snapshot", historicalLimitation: null }),
            gitHead,
            omitted,
            blocker: `File ${rel} no longer matches the source captured when Developer run ${input.developerRunId} finished.`,
          });
        }
        text = snap.text;
        provenance = "forgeorbit-run-snapshot";
      } else if (stored?.text && stored.afterSha256 === diskHash) {
        text = stored.text;
        provenance = "forgeorbit-run-snapshot";
      } else if (expectedPublication && diskHash === expectedPublication) {
        text = diskText;
        provenance = "forgeorbit-run-snapshot";
      } else {
        sawCurrentWorkspace = true;
        if (st.mtimeMs > newestAllowed) {
          return blockedBundle({
            ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: HISTORICAL_LIMITATION }),
            gitHead,
            omitted,
            blocker: `File ${rel} changed after the Developer run. No matching source snapshot was captured, so it was not included.`,
          });
        }
        text = diskText;
        provenance = "forgeorbit-captured-source";
      }
    }
    total += Buffer.byteLength(text);
    if (total > REVIEW_EVIDENCE_LIMITS.maxTotalBytes) {
      return blockedBundle({
        ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: sawCurrentWorkspace ? "current-workspace" : "run-snapshot", historicalLimitation: sawCurrentWorkspace ? HISTORICAL_LIMITATION : null }),
        gitHead,
        omitted,
        blocker: "The selected files exceed the total evidence bound. No partial bundle was sent.",
      });
    }
    files.push({ path: rel, role, sha256: sha256Text(text), bytes: Buffer.byteLength(text), text, provenance });
  }

  if (!files.some((file) => file.role === "implementation")) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: "current-workspace", historicalLimitation: sawCurrentWorkspace ? HISTORICAL_LIMITATION : null }),
      gitHead,
      files,
      omitted,
      blocker: "No implementation source file was selected, so the review was not given a partial tree.",
    });
  }
  const testPath = chooseApprovedTestPath(files);
  if (!testPath) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: sawCurrentWorkspace ? "current-workspace" : "run-snapshot", historicalLimitation: sawCurrentWorkspace ? HISTORICAL_LIMITATION : null }),
      gitHead,
      files,
      omitted,
      blocker: "No single approved test file was selected, so ForgeOrbit did not invent test results.",
    });
  }
  const rulesText = input.rulesText?.trim() ? input.rulesText : null;
  if (rulesText && Buffer.byteLength(rulesText) > REVIEW_EVIDENCE_LIMITS.maxInstructionBytes) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: sawCurrentWorkspace ? "current-workspace" : "run-snapshot", historicalLimitation: sawCurrentWorkspace ? HISTORICAL_LIMITATION : null }),
      gitHead,
      files,
      omitted,
      rulesText: null,
      blocker: "Project rules exceed the evidence bound. They were not truncated.",
    });
  }
  const fingerprint = sourceFingerprint(files);
  const command = approvedTestCommand(testPath)!;
  const proposedTest = describeApprovedTest(testPath, process.execPath);
  if (!proposedTest || proposedTest.command !== command) {
    return blockedBundle({
      ...emptyBundleBase({ ...input, workspacePath, projectPath, sourceBasis: sawCurrentWorkspace ? "current-workspace" : "run-snapshot", historicalLimitation: sawCurrentWorkspace ? HISTORICAL_LIMITATION : null }),
      gitHead,
      files,
      omitted,
      rulesText,
      knowledgeRefs: input.knowledgeRefs,
      blocker: "The approved test command could not be formed. No test was run.",
    });
  }
  const reuse = input.reuseTest
    && input.reuseTest.provenance === "forgeorbit-observed-test"
    && input.reuseTest.command === command
    && input.reuseTest.workspacePath === workspacePath
    && input.reuseTest.sourceFingerprint === fingerprint
    ? input.reuseTest
    : null;
  const diff = await boundedDiff(workspacePath, files.map((file) => file.path));
  const sourceBasis: ReviewSourceBasis = sawCurrentWorkspace ? "current-workspace" : "run-snapshot";
  const partial = {
    taskId: input.taskId,
    requirements: input.requirements,
    requirementsHash: sha256Text(input.requirements),
    developerRunId: input.developerRunId,
    projectPath,
    workspacePath,
    gitHead,
    sourceBasis,
    historicalLimitation: sourceBasis === "current-workspace" ? HISTORICAL_LIMITATION : null,
    files,
    omitted,
    diff: diff.text,
    diffOmission: diff.omission,
    proposedTest,
    rulesText,
    knowledgeRefs: input.knowledgeRefs,
    resourceFingerprint: input.resourceFingerprint,
  };
  return reuse ? completeBundle({ ...partial, test: reuse }) : previewBundle({ ...partial, test: null });
}

function siblingTestPath(rel: string): string | null {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const stem = base.replace(/\.[^.]+$/, "");
  const ext = base.slice(stem.length);
  if (!ext) return null;
  const name = `${stem}.test${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

async function changedPaths(workspace: string): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const tracked = await git(workspace, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = await git(workspace, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (tracked.code !== 0 || untracked.code !== 0) {
    return { ok: false, reason: "The changed-file list could not be read." };
  }
  const names = [...tracked.out.split("\0"), ...untracked.out.split("\0")].filter((name) => name.length > 0);
  return { ok: true, paths: [...new Set(names)].sort() };
}

async function boundedDiff(workspace: string, paths: string[]): Promise<{ text: string | null; omission: string | null }> {
  const tracked = paths.filter((rel) => !isUnsafeRelPath(rel));
  if (tracked.length === 0) return { text: null, omission: "No paths were available for a diff." };
  const diff = await git(workspace, ["diff", "--no-ext-diff", "--no-color", "-U3", "HEAD", "--", ...tracked]);
  if (diff.code !== 0) return { text: null, omission: "The diff could not be read. File contents are included separately." };
  const text = diff.out;
  if (!text.trim()) return { text: null, omission: "No committed diff. Untracked files are included by their full contents." };
  if (Buffer.byteLength(text) > REVIEW_EVIDENCE_LIMITS.maxDiffBytes) {
    return { text: null, omission: "The diff exceeds the evidence bound and was not truncated. Full file contents are included separately." };
  }
  return { text, omission: null };
}

function stabilizeTestOutput(text: string): string {
  return text.replace(/[ \t]*\[[0-9]+(?:\.[0-9]+)?(?:ms|s)\]/g, "");
}

/**
 * Spawn the one fixed Bun test command. Callers must already hold a matching
 * Owner authorization. This function does not approve anything and does not
 * start a Reviewer. A non-zero exit is a real observation.
 */
export async function executeApprovedTest(input: {
  workspacePath: string;
  projectPath: string;
  testPath: string;
  command: string;
  executable: string;
  argv: string[];
  sourceFingerprint: string;
}): Promise<{ ok: true; test: ReviewEvidenceTest } | { ok: false; reason: string }> {
  const command = approvedTestCommand(input.testPath);
  const proposed = describeApprovedTest(input.testPath, input.executable);
  if (!command || !proposed || input.command !== command || input.argv.length !== proposed.argv.length || input.argv.some((part, index) => part !== proposed.argv[index])) {
    return { ok: false, reason: "The test command does not match the fixed Bun test contract. No process was started." };
  }
  if (input.executable !== process.execPath) {
    return { ok: false, reason: "The Bun executable changed after authorization. No test was run." };
  }
  let workspace: string;
  let project: string;
  try {
    workspace = realpathSync(input.workspacePath);
    project = realpathSync(input.projectPath);
  } catch {
    return { ok: false, reason: "The implementation workspace is missing. No test was run." };
  }
  if (workspace !== project && !workspace.startsWith(project + path.sep)) {
    return { ok: false, reason: "The workspace is outside the task project. No test was run." };
  }
  if (isUnsafeRelPath(input.testPath)) {
    return { ok: false, reason: "The test path is unsafe. No test was run." };
  }
  const abs = path.join(workspace, input.testPath);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    return { ok: false, reason: "The approved test file is missing. No test was run." };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: "The approved test path is not a regular file. It was not followed." };
  }
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: "The approved test file could not be resolved. No test was run." };
  }
  if (real !== abs || (real !== workspace && !real.startsWith(workspace + path.sep))) {
    return { ok: false, reason: "The approved test file escapes the workspace. No test was run." };
  }
  // The only execution path is the existing offline macOS Seatbelt boundary,
  // with the project mounted read-only. If it cannot be built, nothing runs:
  // there is no unsandboxed fallback and no invented result.
  const { runSeatbeltBunTest, withPracticalTestLock } = await import("./autonomy/observed-test.ts");
  const observed = await withPracticalTestLock(() => runSeatbeltBunTest({
    workspacePath: workspace,
    testPath: input.testPath,
    command,
    executable: input.executable,
    argv: input.argv,
    role: "reviewer",
  }));
  if (observed.isolation !== "macos-offline-seatbelt") {
    return { ok: false, reason: observed.reason ?? "The offline Seatbelt boundary could not be built. No test was run." };
  }
  if (observed.timedOut || observed.outputExceeded || observed.interrupted || observed.exitCode == null) {
    return { ok: false, reason: observed.reason ?? "The test did not finish. No test result was invented." };
  }
  if (Buffer.byteLength(observed.stdout) > REVIEW_EVIDENCE_LIMITS.maxTestOutputBytes || Buffer.byteLength(observed.stderr) > REVIEW_EVIDENCE_LIMITS.maxTestOutputBytes) {
    return { ok: false, reason: "Test output exceeds the evidence bound. It was not truncated." };
  }
  return {
    ok: true,
    test: {
      command,
      exitCode: observed.exitCode,
      stdout: stabilizeTestOutput(observed.stdout),
      stderr: stabilizeTestOutput(observed.stderr),
      startedAt: observed.startedAt,
      executedAt: observed.finishedAt,
      workspacePath: workspace,
      sourceFingerprint: input.sourceFingerprint,
      provenance: "forgeorbit-observed-test",
      limitation: TEST_OBSERVATION_LIMITATION,
      isolation: "macos-offline-seatbelt",
    },
  };
}

export async function recheckReviewEvidence(bundle: ReviewEvidenceBundle, workspacePath: string): Promise<string | null> {
  let workspace: string;
  try {
    workspace = realpathSync(workspacePath);
  } catch {
    return "The implementation workspace is missing.";
  }
  if (workspace !== bundle.workspacePath) return "The workspace path changed after approval.";
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  const gitHead = head.code === 0 ? head.out.trim() : "";
  if (gitHead !== (bundle.gitHead ?? "")) return "Git HEAD changed after approval.";
  const files = [];
  for (const file of bundle.files) {
    if (isUnsafeRelPath(file.path)) return `Approved evidence path ${file.path} is unsafe.`;
    const abs = path.join(workspace, file.path);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return `Approved evidence file ${file.path} is missing.`;
    }
    if (st.isSymbolicLink() || !st.isFile()) return `Approved evidence file ${file.path} is no longer a regular file.`;
    const real = realpathSync(abs);
    if (real !== abs) return `Approved evidence file ${file.path} escapes the workspace.`;
    const text = readFileSync(abs).toString("utf8");
    if (sha256Text(text) !== file.sha256) return `File ${file.path} changed after approval.`;
    files.push({ path: file.path, sha256: file.sha256, role: file.role });
  }
  const digest = evidenceDigest({
    requirementsHash: bundle.requirementsHash,
    developerRunId: bundle.developerRunId,
    gitHead: bundle.gitHead,
    workspacePath: bundle.workspacePath,
    sourceBasis: bundle.sourceBasis,
    files,
    test: bundle.test,
    rulesText: bundle.rulesText,
    knowledgeRefs: bundle.knowledgeRefs,
  });
  if (digest !== bundle.digest) return "Evidence identity changed after approval.";
  return null;
}

export function workspaceForTask(task: { id?: string; workdir: string; isolation: string; worktreePath: string | null }): string | null {
  if (task.isolation !== "worktree") return task.workdir;
  if (task.worktreePath) return task.worktreePath;
  // A worktree-isolated task that ran in a task-owned staging directory never
  // materializes a Git worktree. Its approved output is published into the
  // project folder, which is where an isolation "none" task is reviewed too.
  // Without this the first review had no workspace, no evidence bundle and no
  // way to authorize the observed test.
  const staged = task.id ? getTaskWorkspace(task.id) : null;
  return staged && staged.status !== "abandoned" ? task.workdir : null;
}

/**
 * The change set is the task-owned source of truth when one exists.
 * Output bytes must match the recorded hash, and a sibling test must match
 * the hash recorded for that path. Unrelated untracked files are not required
 * to appear in the bundle.
 */
export function recordedSourceAlignment(runId: string, bundle: ReviewEvidenceBundle): string | null {
  const changeSet = readChangeSetForRun(runId);
  if (!changeSet || bundle.status === "blocked") return null;
  for (const file of bundle.files) {
    if (file.role === "instructions") continue;
    const entry = changeSet.entries.find((item) => item.path === file.path);
    const baseline = changeSet.files.find((item) => item.path === file.path);
    const recorded = entry?.afterSha256 ?? (file.role === "test" ? baseline?.sha256 ?? null : null);
    if (recorded && recorded !== file.sha256) {
      return `Recorded hash for ${file.path} does not match the current source.`;
    }
  }
  for (const entry of changeSet.entries) {
    if ((entry.kind !== "created" && entry.kind !== "modified") || entry.scope !== "output") continue;
    if (!bundle.files.some((file) => file.path === entry.path)) {
      return `Task-owned output ${entry.path} is missing from the evidence bundle.`;
    }
  }
  return null;
}

export async function captureDeveloperSourceEvidence(runId: string): Promise<void> {
  const run = runs.get(runId);
  const task = run ? tasks.get(run.taskId) : null;
  if (!run || !task || run.qcReviewId) return;
  const workspace = workspaceForTask(task);
  if (!workspace) return;
  let workspacePath: string;
  try {
    workspacePath = realpathSync(workspace);
  } catch {
    return;
  }
  const head = await git(workspacePath, ["rev-parse", "HEAD"]);
  const gitHead = head.code === 0 && /^[0-9a-f]{40}$/i.test(head.out.trim()) ? head.out.trim() : null;
  const files: DeveloperSourceSnapshot["files"] = [];
  const omitted: DeveloperSourceSnapshot["omitted"] = [];
  const changeSet = readChangeSetForRun(runId);
  if (changeSet) {
    for (const entry of changeSet.entries) {
      if (entry.scope === "unauthorized") {
        omitted.push({ path: entry.path, reason: "Unauthorized change. Contents were not captured as this task's implementation." });
        continue;
      }
      if ((entry.kind !== "created" && entry.kind !== "modified") || entry.scope !== "output" || entry.text == null) continue;
      if (isSecretText(entry.text)) {
        omitted.push({ path: entry.path, reason: "Key material. Contents were not captured." });
        continue;
      }
      files.push({ path: entry.path, sha256: sha256Text(entry.text), bytes: Buffer.byteLength(entry.text), text: entry.text });
    }
  } else {
  const changed = gitHead ? await changedPaths(workspacePath) : { ok: false as const, reason: "no commit" };
  if (changed.ok) {
    for (const rel of changed.paths) {
      if (isUnsafeRelPath(rel) || isSecretRelPath(rel)) {
        omitted.push({ path: rel, reason: "Unsafe or secret path. Contents were not captured." });
        continue;
      }
      const role = reviewFileRole(rel);
      if (!role || role === "instructions") continue;
      const abs = path.join(workspacePath, rel);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        omitted.push({ path: rel, reason: "Missing while the Developer run was being recorded." });
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile() || st.size > REVIEW_EVIDENCE_LIMITS.maxFileBytes) {
        omitted.push({ path: rel, reason: "Not a bounded regular text file at Developer settlement." });
        continue;
      }
      const disk = readFileSync(abs);
      if (disk.includes(0)) {
        omitted.push({ path: rel, reason: "Not plain text." });
        continue;
      }
      const text = disk.toString("utf8");
      if (isSecretText(text)) {
        omitted.push({ path: rel, reason: "Key material. Contents were not captured." });
        continue;
      }
      if (files.length >= REVIEW_EVIDENCE_LIMITS.maxFiles) {
        omitted.push({ path: rel, reason: "Source snapshot file limit reached. This path was not captured." });
        continue;
      }
      files.push({ path: rel, sha256: sha256Text(text), bytes: Buffer.byteLength(text), text });
    }
  }
  }
  const snapshot: DeveloperSourceSnapshot = {
    version: 1,
    capturedAt: Date.now(),
    gitHead,
    developerRunId: runId,
    files,
    omitted,
    note: "Captured when the Developer run succeeded. This is not a review verdict and does not describe files written later.",
  };
  runs.writeSourceEvidence(runId, JSON.stringify(snapshot));
}
