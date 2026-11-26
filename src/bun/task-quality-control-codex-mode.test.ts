import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A stub `codex` records the argv of every `exec` turn and answers with a
// PASS verdict, so the REAL codex driver and the real startTask/QC code run.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "fo-qc-codex-mode-"));
const STUB = path.join(DATA_DIR, "codex-stub.sh");
const LOG = path.join(DATA_DIR, "argv.log");
writeFileSync(STUB, `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.200.0"; exit 0;;
  --help) echo "codex stub"; exit 0;;
esac
if [ "$1" = "exec" ]; then
  echo "$@" >> "${LOG}"
  cat > /dev/null
  echo '{"type":"thread.started","thread_id":"stub-thread"}'
  echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"<qc_verdict>PASS</qc_verdict><qc_summary>ok</qc_summary><qc_findings>[]</qc_findings><qc_feedback>none</qc_feedback>"}}'
  echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
fi
exit 0
`);
chmodSync(STUB, 0o755);
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_CODEX_BIN = STUB;
process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await new Promise((r) => setTimeout(r, 50));
}

test("an ordinary Codex quality review runs read-only and restores the Developer mode", async () => {
  const store = await import("./db.ts");
  const orchestrator = await import("./orchestrator.ts");
  const qc = await import("./task-quality-control.ts");
  const workdir = mkdtempSync(path.join(tmpdir(), "fo-qc-codex-mode-proj-"));
  store.projects.upsert(workdir, "QC codex mode");
  store.harnesses.setEnabled("codex", true);

  const created = await orchestrator.createTask({
    title: "Add isOdd", prompt: "Add src/is-odd.ts", workdir, column: "ready",
    agent: "codex", model: "gpt-6.1-sol", mode: "auto", isolation: "none",
  });
  if ("error" in created) throw new Error(created.error);
  const id = created.task.id;

  const started = await orchestrator.startTask(id);
  if ("error" in started) throw new Error(started.error);
  await until(() => store.tasks.get(id)?.column === "review");
  expect(store.tasks.get(id)?.column).toBe("review");

  const prepared = qc.prepareQcReview({ taskId: id, reviewerHarness: "codex", reviewerModel: "gpt-6.1-sol" });
  const review = await qc.startQcReview(prepared.review.id);
  if ("error" in review) throw new Error(review.error);
  await until(() => store.taskQualityReviews.get(prepared.review.id)?.status === "complete");
  expect(store.taskQualityReviews.get(prepared.review.id)?.status).toBe("complete");

  const turns = (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter((line) => line.startsWith("exec "));
  expect(turns).toHaveLength(2);
  expect(turns[0]).toContain("--sandbox workspace-write");
  expect(turns[1]).toContain("--sandbox read-only");
  expect(turns[1]).not.toContain("workspace-write");
  // The review borrowed the task row only for its run; the Developer mode is back.
  expect(store.tasks.get(id)?.mode).toBe("auto");
}, 60_000);
