/**
 * Focused automated verification for project-scoped Developer permissions
 * ("Development in a working copy").
 *
 * Uses disposable Git fixtures, the fake Codex/Claude drivers (no real provider
 * calls, no changes to real projects), and real macOS Seatbelt child processes
 * for local check & boundary enforcement.
 */
import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FAKE_TASK_CHECKS_MARKER, FAKE_TASK_FILES_MARKER } from "../shared/task-workspace.ts";
import { readOnlyReviewerContract } from "../shared/qc-recovery.ts";
import { evaluateWorkingCopyCommandPolicy } from "../shared/working-copy-checks.ts";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fo-wc-dev-")));
const dataDir = path.join(root, "data");
process.env.AGETOR_DATA_DIR = dataDir;
process.env.HOME = root;
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_USAGE_OFFLINE = "1";
process.env.AGETOR_DISABLE_UPDATES = "1";
process.env.FORGEORBIT_EMBEDDING_MODEL_ROOT = "/nonexistent/no-model-fixture";

const store = await import("./db.ts");
const orchestrator = await import("./orchestrator.ts");
const permissions = await import("./project-permissions.ts");
const workspace = await import("./task-workspace.ts");
const checks = await import("./working-copy-checks.ts");
const employeeExec = await import("./employee-execution.ts");
const employeeRun = await import("./employee-run.ts");
const diagnostics = await import("./launch-diagnostics.ts");
const qc = await import("./task-quality-control.ts");
const { EmployeeCore } = await import("./employee-core.ts");
const { AssignmentCore } = await import("./assignment-core.ts");

store.harnesses.setEnabled("codex", true);
store.harnesses.setEnabled("claude-code", true);
employeeRun.initEmployeeExecutionTracking();

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* ignore cleanup error */ }
});

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function makeGitProject(name: string): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(
    path.join(dir, "src/controller.ts"),
    `export function submitForm(name: string): { ok: boolean; error?: string } {\n  return { ok: true };\n}\n`,
  );
  writeFileSync(
    path.join(dir, "src/view.ts"),
    `export function renderError(error?: string): string {\n  return error ?? "";\n}\n`,
  );
  writeFileSync(
    path.join(dir, "src/old-helper.ts"),
    `export function trimName(value: string): string {\n  return value.trim();\n}\n`,
  );
  writeFileSync(
    path.join(dir, "src/obsolete.ts"),
    `export const LEGACY_FLAG = true;\n`,
  );
  writeFileSync(
    path.join(dir, "src/form.test.ts"),
    `import { expect, test } from "bun:test";\n`
      + `import { mkdirSync, writeFileSync, readFileSync } from "node:fs";\n`
      + `import path from "node:path";\n`
      + `import { submitForm } from "./controller.ts";\n`
      + `test("rejects empty name and writes temp + cache artifacts", () => {\n`
      + `  const res = submitForm("   ");\n`
      + `  expect(res.ok).toBe(false);\n`
      + `  const tmpFile = path.join(process.env.TMPDIR ?? "/tmp", "form-check-tmp.txt");\n`
      + `  writeFileSync(tmpFile, "scratch-ok");\n`
      + `  expect(readFileSync(tmpFile, "utf8")).toBe("scratch-ok");\n`
      + `  mkdirSync(".cache", { recursive: true });\n`
      + `  writeFileSync(".cache/test-artifact.txt", "ephemeral-cache");\n`
      + `});\n`,
  );
  writeFileSync(
    path.join(dir, "src/failing.test.ts"),
    `import { expect, test } from "bun:test";\n`
      + `test("intentional failure", () => {\n`
      + `  expect(1 + 1).toBe(3);\n`
      + `});\n`,
  );
  writeFileSync(path.join(dir, ".env"), "SECRET_TOKEN=do-not-copy\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["add", "README.md", "src/controller.ts", "src/view.ts", "src/old-helper.ts", "src/obsolete.ts", "src/form.test.ts", "src/failing.test.ts"]);
  await git(dir, ["-c", "user.email=fo-wc@example.com", "-c", "user.name=FO WC", "commit", "-m", "seed"]);
  store.projects.upsert(dir, name);
  return realpathSync(dir);
}

async function createAssignedTask(
  projectPath: string,
  title: string,
  prompt: string,
  opts?: { agent?: string; mode?: string; isolation?: "worktree" | "none" },
): Promise<{ taskId: string; employeeId: string }> {
  const employee = new EmployeeCore(store.db).createWorker({
    name: `Dev ${title}`,
    jobTitle: "Developer",
    projectPath,
  });
  const created = await orchestrator.createTask({
    title,
    prompt,
    workdir: projectPath,
    column: "ready",
    agent: opts?.agent ?? "codex",
    mode: opts?.mode ?? "auto",
    model: opts?.agent === "claude-code" ? "sonnet-4.6" : "gpt-6.1-sol",
    effort: "low",
    isolation: opts?.isolation ?? "worktree",
    accessMode: "workspace",
  });
  if ("error" in created) throw new Error(created.error);
  new AssignmentCore(store.db).assign(created.task.id, employee.id);
  return { taskId: created.task.id, employeeId: employee.id };
}

async function waitForSettledWorkspace(taskId: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = workspace.getTaskWorkspace(taskId);
    const t = store.tasks.get(taskId);
    if (ws && (ws.status === "settled" || ws.status === "published") && t?.column !== "running") {
      return ws;
    }
    await Bun.sleep(25);
  }
  return workspace.getTaskWorkspace(taskId);
}

test("Case 1: disabled by default, isolated per project, and toggling never silently expands active runs or stale reviews", async () => {
  const projectA = await makeGitProject("case1-proj-a");
  const projectB = await makeGitProject("case1-proj-b");

  // Default OFF for both projects.
  expect(store.projects.get(projectA)?.workspaceDevelopment).toBe(false);
  expect(store.projects.get(projectB)?.workspaceDevelopment).toBe(false);
  expect(permissions.readProjectPermissions({ projectPath: projectA }).workspaceDevelopment).toBe(false);
  expect(permissions.readProjectPermissions({ projectPath: projectB }).workspaceDevelopment).toBe(false);

  // With setting disabled, existing behavior is unchanged:
  // 1) working-copy preparation is rejected;
  // 2) explicit-outputs still requires at least one output path;
  // 3) default worktree + Codex auto preflight still blocks with permission-owner-decision.
  const { taskId: taskA } = await createAssignedTask(projectA, "Disabled baseline", "Fix the form");
  await expect(workspace.prepareTaskWorkspace(taskA, { writeScope: "working-copy" })).rejects.toThrow(/disabled/i);
  await expect(workspace.prepareTaskWorkspace(taskA, { outputPaths: [] })).rejects.toThrow(/output path|worktree/i);

  const preflightDisabled = employeeExec.prepareEmployeeExecution({ taskId: taskA, harnessId: "codex" });
  expect(preflightDisabled.outcome).toBe("blocked");
  expect(preflightDisabled.blockingErrors.some((e) => e.code === "permission-owner-decision")).toBe(true);

  // Enabling for Project A persists for A and does NOT enable Project B.
  const updatedA = permissions.setProjectWorkspaceDevelopment(projectA, true);
  expect(updatedA.workspaceDevelopment).toBe(true);
  expect(store.projects.get(projectA)?.workspaceDevelopment).toBe(true);
  expect(store.projects.get(projectB)?.workspaceDevelopment).toBe(false);
  expect(permissions.isWorkspaceDevelopmentEnabled(projectA)).toBe(true);
  expect(permissions.isWorkspaceDevelopmentEnabled(projectB)).toBe(false);

  const { taskId: taskB } = await createAssignedTask(projectB, "Project B stays disabled", "Fix B");
  const preflightB = employeeExec.prepareEmployeeExecution({ taskId: taskB, harnessId: "codex" });
  expect(preflightB.outcome).toBe("blocked");
  expect(preflightB.blockingErrors.some((e) => e.code === "permission-owner-decision")).toBe(true);

  // Changing the setting after a pending review invalidates that review (no silent policy drift).
  const reviewedA = await employeeRun.reviewEmployeeExecution({ taskId: taskA, harnessId: "codex" });
  expect(reviewedA.attempt).not.toBeNull();
  expect(reviewedA.attempt!.review.workspaceDevelopment).toBe(true);
  permissions.setProjectWorkspaceDevelopment(projectA, false);
  await expect(
    employeeRun.startEmployeeExecution(reviewedA.attempt!.id, { revision: reviewedA.attempt!.revision, confirm: true }),
  ).rejects.toThrow(/changed|review/i);
  // The auto-prepared armed working copy is cleanly abandoned when the stale review is rejected.
  expect(workspace.getTaskWorkspace(taskA)?.status).toBe("abandoned");

  // An already-active run started under explicit-outputs does NOT expand when the setting is turned ON mid-run.
  const { taskId: activeTask } = await createAssignedTask(
    projectB,
    "Active run stays scoped",
    `Edit unlisted file\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({
      writes: [
        { path: "src/controller.ts", contents: "export const ok = 1;\n" },
        { path: "src/unlisted.ts", contents: "export const extra = 2;\n" },
      ],
    })}`,
    { isolation: "none" },
  );
  const explicitWs = await workspace.prepareTaskWorkspace(activeTask, { outputPaths: ["src/controller.ts"] });
  expect(explicitWs.writeScope).toBe("explicit-outputs");
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "150";
  try {
    const started = await orchestrator.startTask(activeTask);
    expect("error" in started).toBe(false);
    // Flip setting ON while the explicit-outputs run is active.
    permissions.setProjectWorkspaceDevelopment(projectB, true);
    const settled = await waitForSettledWorkspace(activeTask);
    expect(settled?.writeScope).toBe("explicit-outputs");
    expect(settled?.violation).toBe(true);
    expect(settled?.changes.some((c) => c.path === "src/unlisted.ts" && c.scope === "unauthorized")).toBe(true);
  } finally {
    delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
    permissions.setProjectWorkspaceDevelopment(projectB, false);
  }
});

test("Case 2: enabled Developer edits unlisted files (modify/create/rename/delete), runs local check with temp artifact, returns reviewable diff, original stays unchanged; exit 0 with no checks reports not-run", async () => {
  const projectDir = await makeGitProject("case2-proj");
  permissions.setProjectWorkspaceDevelopment(projectDir, true);

  const origControllerHash = sha(path.join(projectDir, "src/controller.ts"));
  const origViewHash = sha(path.join(projectDir, "src/view.ts"));
  const origHelperHash = sha(path.join(projectDir, "src/old-helper.ts"));
  const origObsoleteHash = sha(path.join(projectDir, "src/obsolete.ts"));

  const payloadFiles = {
    writes: [
      {
        path: "src/controller.ts",
        contents:
          `import { validateName } from "./validator.ts";\n`
          + `export function submitForm(name: string): { ok: boolean; error?: string } {\n`
          + `  const error = validateName(name);\n`
          + `  return error ? { ok: false, error } : { ok: true };\n`
          + `}\n`,
      },
      {
        path: "src/view.ts",
        contents:
          `export function renderError(error?: string): string {\n`
          + `  return error ? \`Error: \${error}\` : "";\n`
          + `}\n`,
      },
      {
        path: "src/validator.ts",
        contents:
          `export function validateName(name: string): string | null {\n`
          + `  return name.trim().length === 0 ? "Name is required" : null;\n`
          + `}\n`,
      },
    ],
    renames: [{ from: "src/old-helper.ts", to: "src/new-helper.ts" }],
    deletes: ["src/obsolete.ts"],
  };
  const promptText =
    `Fix the form validation and run tests.\n`
    + `${FAKE_TASK_FILES_MARKER}:${JSON.stringify(payloadFiles)}\n`
    + `${FAKE_TASK_CHECKS_MARKER}:${JSON.stringify({ commands: ["bun test ./src/form.test.ts"] })}`;

  const { taskId } = await createAssignedTask(projectDir, "Fix form flow", promptText);

  // Manager-first preflight & review succeed WITHOUT pre-listing any outputPaths.
  const pre = employeeExec.prepareEmployeeExecution({ taskId, harnessId: "codex" });
  expect(pre.outcome).toBe("prepared");
  expect(pre.accessDiagnostics?.workingCopyDevelopment).toBe(true);
  expect(pre.permission?.codes).toContain("working-copy-development");

  const rev = await employeeRun.reviewEmployeeExecution({ taskId, harnessId: "codex" });
  expect(rev.blockingErrors).toEqual([]);
  expect(rev.attempt).not.toBeNull();
  expect(rev.attempt!.review.workspaceDevelopment).toBe(true);
  expect(rev.attempt!.review.workingCopyWriteScope).toBe("working-copy");
  expect(rev.attempt!.review.workingCopyScratchPath).toBeTruthy();

  const started = await employeeRun.startEmployeeExecution(rev.attempt!.id, {
    revision: rev.attempt!.revision,
    confirm: true,
  });
  expect(started.attempt.status).toBe("started");

  const settled = await waitForSettledWorkspace(taskId, 15_000);
  expect(settled).not.toBeNull();
  expect(settled!.status).toBe("settled");
  expect(settled!.writeScope).toBe("working-copy");
  expect(settled!.violation).toBe(false);
  expect(settled!.scanComplete).toBe(true);

  const outputChanges = settled!.changes.filter((c) => c.scope === "output" && c.kind !== "unchanged");
  const byPath = new Map(outputChanges.map((c) => [c.path, c]));
  expect(byPath.get("src/controller.ts")?.kind).toBe("modified");
  expect(byPath.get("src/view.ts")?.kind).toBe("modified");
  expect(byPath.get("src/validator.ts")?.kind).toBe("created");
  expect(byPath.get("src/new-helper.ts")?.kind).toBe("created");
  expect(byPath.get("src/new-helper.ts")?.renamedFrom).toBe("src/old-helper.ts");
  expect(byPath.get("src/old-helper.ts")?.kind).toBe("deleted");
  expect(byPath.get("src/obsolete.ts")?.kind).toBe("deleted");

  // Ephemeral test artifact inside .cache/ is classified as artifact and does NOT block publication.
  expect(settled!.changes.some((c) => c.path === ".cache/test-artifact.txt" && c.scope === "artifact")).toBe(true);

  // Reviewable unified diff contains the real hunks.
  expect(settled!.diff).toContain("diff --git a/src/controller.ts b/src/controller.ts");
  expect(settled!.diff).toContain("validateName");
  expect(settled!.diff).toContain("rename from src/old-helper.ts");

  // Observed local check ran under macOS Seatbelt and passed (on macOS with Seatbelt available).
  expect(settled!.checks?.length).toBe(1);
  const checkRec = settled!.checks![0]!;
  expect(checkRec.command).toBe("bun test ./src/form.test.ts");
  if (diagnostics.probeSeatbeltCapability() === "available") {
    expect(checkRec.status).toBe("passed");
    expect(checkRec.exitCode).toBe(0);
    expect(checkRec.isolation).toBe("macos-offline-seatbelt");
    expect(settled!.checkSummary?.status).toBe("passed");
    expect(settled!.checkSummary?.passed).toBe(1);
  } else {
    // Inside an enclosing sandbox, Seatbelt fails closed cleanly as blocked (never weak pass).
    expect(checkRec.status).toBe("blocked");
    expect(checkRec.exitCode).toBeNull();
  }

  // Original project is 100% unchanged before explicit publication!
  expect(sha(path.join(projectDir, "src/controller.ts"))).toBe(origControllerHash);
  expect(sha(path.join(projectDir, "src/view.ts"))).toBe(origViewHash);
  expect(sha(path.join(projectDir, "src/old-helper.ts"))).toBe(origHelperHash);
  expect(sha(path.join(projectDir, "src/obsolete.ts"))).toBe(origObsoleteHash);
  expect(existsSync(path.join(projectDir, "src/validator.ts"))).toBe(false);
  expect(existsSync(path.join(projectDir, "src/new-helper.ts"))).toBe(false);

  // Separate check: Developer exiting 0 with NO check commands NEVER reports checks passed!
  const { taskId: noCheckTask } = await createAssignedTask(
    projectDir,
    "No checks run",
    `Touch README only.\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({
      writes: [{ path: "README.md", contents: "# updated without running tests\n" }],
    })}`,
  );
  const revNoCheck = await employeeRun.reviewEmployeeExecution({ taskId: noCheckTask, harnessId: "codex" });
  expect(revNoCheck.attempt).not.toBeNull();
  await employeeRun.startEmployeeExecution(revNoCheck.attempt!.id, {
    revision: revNoCheck.attempt!.revision,
    confirm: true,
  });
  const settledNoCheck = await waitForSettledWorkspace(noCheckTask);
  expect(settledNoCheck?.exitCode).toBe(0);
  expect(settledNoCheck?.checks ?? []).toEqual([]);
  expect(settledNoCheck?.checkSummary?.status).toBe("not-run");
  expect(settledNoCheck?.checkSummary?.passed).toBe(0);
});

test("Case 3: blocked commands, failed tests, fail-closed harness/full-access, and real Seatbelt child-process confinement (symlink & outside-write denied)", async () => {
  const projectA = await makeGitProject("case3-proj-a");
  const projectB = await makeGitProject("case3-proj-b");
  const sentinelB = path.join(projectB, "SENTINEL.txt");
  writeFileSync(sentinelB, "project-b-untouched\n");
  const sentinelBHash = sha(sentinelB);
  const outsideFile = path.join(root, "outside-working-copy.txt");

  permissions.setProjectWorkspaceDevelopment(projectA, true);

  // Non-Codex harness and Codex full-access must fail closed when working-copy development is enabled.
  const { taskId: claudeTask } = await createAssignedTask(projectA, "Claude unsupported", "Fix", { agent: "claude-code", mode: "ask" });
  const diagClaude = await diagnostics.diagnoseTaskLaunch(store.tasks.get(claudeTask)!, { driverIsFake: false, seatbeltStatus: "available" });
  expect(diagClaude.launchAllowed).toBe(false);
  expect(diagClaude.blockCodes).toContain("block-working-copy-unsupported-harness");

  const { taskId: fullAccessTask } = await createAssignedTask(projectA, "Full access blocked", "Fix", { agent: "codex", mode: "full-access" });
  const diagFull = await diagnostics.diagnoseTaskLaunch(store.tasks.get(fullAccessTask)!, { driverIsFake: false, seatbeltStatus: "available" });
  expect(diagFull.launchAllowed).toBe(false);
  expect(diagFull.blockCodes).toContain("block-working-copy-full-access");

  // Prepare & settle a working-copy task on Project A so we can test checks directly.
  const { taskId } = await createAssignedTask(
    projectA,
    "Boundary & check verification",
    `Seed working copy\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({
      writes: [{ path: "README.md", contents: "# ready for checks\n" }],
    })}`,
  );
  const rev = await employeeRun.reviewEmployeeExecution({ taskId, harnessId: "codex" });
  expect(rev.attempt).not.toBeNull();
  await employeeRun.startEmployeeExecution(rev.attempt!.id, { revision: rev.attempt!.revision, confirm: true });
  const settled = await waitForSettledWorkspace(taskId);
  expect(settled?.status).toBe("settled");

  // Policy blocks git push, dependency installation, network tools, path traversal, and missing tools BEFORE spawning.
  for (const cmd of [
    "git push origin main",
    "npm install lodash",
    "bun add left-pad",
    "curl https://example.com",
    "bun test ../escape.test.ts",
    "definitely-not-an-installed-tool-9999 --version",
  ]) {
    const rec = await checks.runWorkingCopyCheck({ taskId, command: cmd });
    expect(rec.status).toBe("blocked");
    expect(rec.exitCode).toBeNull();
    expect(rec.isolation).toBe("blocked");
  }
  expect(evaluateWorkingCopyCommandPolicy("vercel deploy").ok).toBe(false);

  // Real macOS Seatbelt child-process tests (failed test + escape attempts via outside path & symlink to Project B).
  const seatbelt = diagnostics.probeSeatbeltCapability();
  if (seatbelt === "available") {
    // 1) Failing test reports accurate failed status and non-zero exit code.
    const failed = await checks.runWorkingCopyCheck({ taskId, command: "bun test ./src/failing.test.ts" });
    expect(failed.status).toBe("failed");
    expect(failed.exitCode).not.toBe(0);
    expect(failed.exitCode).not.toBeNull();
    expect(failed.isolation).toBe("macos-offline-seatbelt");

    // 2) Child process attempting to write outside working copy (original project A, parent dir, and Project B via symlink).
    const wcDir = settled!.stagingPath;
    symlinkSync(sentinelB, path.join(wcDir, "link-to-proj-b.txt"));
    const escapeScript = path.join(wcDir, "scripts/try-escape.ts");
    mkdirSync(path.dirname(escapeScript), { recursive: true });
    writeFileSync(
      escapeScript,
      `import { writeFileSync } from "node:fs";\n`
        + `const targets = [\n`
        + `  ${JSON.stringify(path.join(projectA, "escaped-to-original.txt"))},\n`
        + `  ${JSON.stringify(outsideFile)},\n`
        + `  "./link-to-proj-b.txt",\n`
        + `];\n`
        + `const results: string[] = [];\n`
        + `for (const target of targets) {\n`
        + `  try {\n`
        + `    writeFileSync(target, "PWNED");\n`
        + `    results.push(\`ALLOWED:\${target}\`);\n`
        + `  } catch (err: any) {\n`
        + `    results.push(\`DENIED:\${err?.code ?? "ERR"}\`);\n`
        + `  }\n`
        + `}\n`
        + `console.log(results.join("|"));\n`
        + `if (results.some((r) => r.startsWith("ALLOWED:"))) process.exit(99);\n`,
    );
    const escapeCheck = await checks.runWorkingCopyCheck({ taskId, command: "bun ./scripts/try-escape.ts" });
    expect(escapeCheck.isolation).toBe("macos-offline-seatbelt");
    expect(escapeCheck.status).toBe("passed"); // script exits 0 ONLY when ALL 3 escape writes threw EPERM!
    expect(escapeCheck.summary).toContain("DENIED:");
    expect(escapeCheck.summary).not.toContain("ALLOWED:");
    expect(existsSync(path.join(projectA, "escaped-to-original.txt"))).toBe(false);
    expect(existsSync(outsideFile)).toBe(false);
    expect(sha(sentinelB)).toBe(sentinelBHash);

    // Also verify rescan flagged the symlink as unauthorized!
    const rescanned = workspace.getTaskWorkspace(taskId);
    expect(rescanned?.violation).toBe(true);
    expect(rescanned?.changes.some((c) => c.path === "link-to-proj-b.txt" && c.scope === "unauthorized")).toBe(true);
  }
});

test("Case 4: Reviewer stays read-only, publication requires explicit approval, and cancelled runs cannot publish", async () => {
  const projectDir = await makeGitProject("case4-proj");
  permissions.setProjectWorkspaceDevelopment(projectDir, true);

  // Reviewer stays read-only:
  // 1) Launch diagnostics with isReviewer: true ignores workspaceDevelopment and keeps Codex Ask read-only.
  const { taskId: devTask } = await createAssignedTask(
    projectDir,
    "Publish and reviewer check",
    `Update controller\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({
      writes: [
        { path: "src/controller.ts", contents: "export function submitForm() { return { ok: true, v: 2 }; }\n" },
        { path: "src/added.ts", contents: "export const added = true;\n" },
      ],
      deletes: ["src/obsolete.ts"],
    })}`,
  );
  const rev = await employeeRun.reviewEmployeeExecution({ taskId: devTask, harnessId: "codex" });
  expect(rev.attempt).not.toBeNull();
  await employeeRun.startEmployeeExecution(rev.attempt!.id, { revision: rev.attempt!.revision, confirm: true });
  const settled = await waitForSettledWorkspace(devTask);
  expect(settled?.status).toBe("settled");

  const reviewerDiag = await diagnostics.diagnoseTaskLaunch(store.tasks.get(devTask)!, {
    harnessId: "codex",
    mode: "ask",
    isReviewer: true,
    ignoreStagingRequirement: true,
  });
  expect(reviewerDiag.workingCopyDevelopment).toBeUndefined();
  expect(reviewerDiag.osEnforcement.filesystemWrites).toBe("read-only");

  // 2) Seatbelt reviewer role cannot write even inside the working copy.
  if (diagnostics.probeSeatbeltCapability() === "available") {
    const wcDir = settled!.stagingPath;
    const probeScript = path.join(wcDir, "scripts/reviewer-write-probe.ts");
    mkdirSync(path.dirname(probeScript), { recursive: true });
    writeFileSync(
      probeScript,
      `import { writeFileSync } from "node:fs";\n`
        + `try { writeFileSync("./reviewer-mutated.txt", "bad"); process.exit(99); } catch { process.exit(0); }\n`,
    );
    chmodSync(probeScript, 0o644);
    const revCheck = await checks.runWorkingCopyCheck({
      taskId: devTask,
      command: "bun ./scripts/reviewer-write-probe.ts",
      role: "reviewer",
      persist: false,
    });
    expect(revCheck.status).toBe("passed"); // exits 0 only because write threw EPERM
    expect(existsSync(path.join(wcDir, "reviewer-mutated.txt"))).toBe(false);
    // Clean up our probe script so workspace matches settled changes cleanly.
    rmSync(probeScript, { force: true });
  }

  // Publication still requires explicit approve: true.
  await expect(
    workspace.publishTaskWorkspace(devTask, { approve: false, paths: ["src/controller.ts"] }),
  ).rejects.toThrow(/approve: true/i);
  expect(existsSync(path.join(projectDir, "src/added.ts"))).toBe(false);
  expect(existsSync(path.join(projectDir, "src/obsolete.ts"))).toBe(true);

  // Explicit approval publishes modified, created, and deleted files cleanly.
  const published = await workspace.publishTaskWorkspace(devTask, {
    approve: true,
    paths: ["src/controller.ts", "src/added.ts", "src/obsolete.ts"],
  });
  expect(published.status).toBe("published");
  expect(readFileSync(path.join(projectDir, "src/controller.ts"), "utf8")).toContain("v: 2");
  expect(readFileSync(path.join(projectDir, "src/added.ts"), "utf8")).toContain("added = true");
  expect(existsSync(path.join(projectDir, "src/obsolete.ts"))).toBe(false);

  // QC review preparation & launch still enforces read-only reviewer mode and restores Developer mode after finishing.
  const qcPrepared = qc.prepareQcReview({ taskId: devTask, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  expect(qcPrepared.blockedReason).toBeNull();
  expect(readOnlyReviewerContract("codex")).toMatchObject({ mode: "ask", sandbox: "read-only" });
  const qcStarted = await qc.startQcReview(qcPrepared.review.id);
  expect("error" in qcStarted).toBe(false);
  const qcDeadline = Date.now() + 5000;
  while (Date.now() < qcDeadline) {
    const st = store.taskQualityReviews.get(qcPrepared.review.id)?.status;
    if (st && st !== "pending" && st !== "running") break;
    await Bun.sleep(25);
  }
  const qcFinalStatus = store.taskQualityReviews.get(qcPrepared.review.id)?.status;
  expect(qcFinalStatus === "complete" || qcFinalStatus === "cancelled").toBe(true);
  expect(store.tasks.get(devTask)?.mode).toBe("auto");

  // Cancelled run settles as interrupted and CANNOT publish its unfinished workspace.
  const { taskId: cancelTask } = await createAssignedTask(
    projectDir,
    "Cancelled run cannot publish",
    `Slow run\n${FAKE_TASK_FILES_MARKER}:${JSON.stringify({
      writes: [{ path: "src/view.ts", contents: "export const unfinished = true;\n" }],
    })}`,
  );
  const viewHashBefore = sha(path.join(projectDir, "src/view.ts"));
  const revCancel = await employeeRun.reviewEmployeeExecution({ taskId: cancelTask, harnessId: "codex" });
  expect(revCancel.attempt).not.toBeNull();
  process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS = "4000";
  try {
    const startCancel = await employeeRun.startEmployeeExecution(revCancel.attempt!.id, {
      revision: revCancel.attempt!.revision,
      confirm: true,
    });
    expect(startCancel.attempt.status).toBe("started");
    const cancelRunId = startCancel.attempt.runId!;
    expect(cancelRunId).toBeTruthy();
    await Bun.sleep(40);
    expect(await orchestrator.cancelRun(cancelRunId)).toBe(true);
    const settledCancelled = await waitForSettledWorkspace(cancelTask);
    expect(settledCancelled?.status).toBe("settled");
    expect(settledCancelled?.interruption).not.toBeNull();
    expect(settledCancelled?.interruption?.reason).toBe("manual");

    await expect(
      workspace.publishTaskWorkspace(cancelTask, { approve: true, paths: ["src/view.ts"] }),
    ).rejects.toThrow(/stopped|incomplete|nothing was published/i);
    expect(sha(path.join(projectDir, "src/view.ts"))).toBe(viewHashBefore);
  } finally {
    delete process.env.AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS;
  }
}, 20_000);
