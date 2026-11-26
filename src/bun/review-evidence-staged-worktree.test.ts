import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A worktree-isolated task (what the Head creates on a Git project) that ran in
// a task-owned staging directory and was published must still get a first-review
// evidence bundle and a proposed observed test. Before the fix the evidence had
// no workspace ("The implementation workspace was not recorded.").
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-staged-wt-"));
const STUB = path.join(DATA_DIR, "codex-stub.sh");
writeFileSync(STUB, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  cat > /dev/null
  mkdir -p src
  printf 'export function isOdd(n: number): boolean { return Math.abs(n %% 2) === 1; }\\n' > src/is-odd.ts
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
fi
exit 0
`);
chmodSync(STUB, 0o755);
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CODEX_BIN = STUB;
process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await new Promise((r) => setTimeout(r, 50));
}

test("a published, task-staged worktree-isolated task gets first-review evidence", async () => {
  const store = await import("./db.ts");
  const orchestrator = await import("./orchestrator.ts");
  const workspace = await import("./task-workspace.ts");
  const recovery = await import("./qc-recovery.ts");
  const { workspaceForTask } = await import("./review-evidence.ts");

  const repo = mkdtempSync(path.join(tmpdir(), "fo-staged-wt-proj-"));
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "package.json"), "{\"name\":\"fixture\",\"private\":true,\"type\":\"module\"}\n");
  writeFileSync(path.join(repo, "src/is-odd.test.ts"), [
    "import { expect, test } from \"bun:test\";",
    "import { isOdd } from \"./is-odd.ts\";",
    "test(\"odd\", () => { expect(isOdd(3)).toBe(true); expect(isOdd(4)).toBe(false); });",
    "",
  ].join("\n"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  store.projects.upsert(repo, "Staged worktree fixture");
  store.harnesses.setEnabled("codex", true);

  const created = await orchestrator.createTask({
    title: "Add isOdd", prompt: "Add src/is-odd.ts exporting isOdd", workdir: repo, column: "ready",
    agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "worktree",
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;
  expect(created.task.isolation).toBe("worktree");
  // Without staging there is no workspace to review.
  expect(workspaceForTask(store.tasks.get(id)!)).toBeNull();

  await workspace.prepareTaskWorkspace(id, { outputPaths: ["src/is-odd.ts"] }, { approvedProjectPath: repo });
  const started = await orchestrator.startTask(id);
  if ("error" in started) throw new Error(started.error);
  await until(() => store.tasks.get(id)?.column === "review");
  expect(store.tasks.get(id)?.column).toBe("review");
  await workspace.publishTaskWorkspace(id, { approve: true, paths: ["src/is-odd.ts"] });

  expect(workspaceForTask(store.tasks.get(id)!)).toBe(repo);
  const view = await recovery.getQcRecoveryView(id);
  expect(view.firstReview?.blockers).toEqual([]);
  expect(view.firstReview?.eligible).toBe(true);
  expect(view.firstReview?.bundle?.status).toBe("preview");
  expect(view.firstReview?.bundle?.proposedTest?.command).toBe("bun test ./src/is-odd.test.ts");
}, 60_000);
