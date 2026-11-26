/**
 * Direction 8, second milestone: a REAL offline test started from the packaged window (run_project_test).
 * Packaged ForgeOrbitQA driven by scripts/qa-native-d2.ts: positive-allowlist environment, isolated HOME/data/TMP,
 * non-persistent WebKit partition, fake drivers, NO outer sandbox-exec (same as the Direction 2-8 campaigns, which is
 * why the runner's own offline Seatbelt can apply; the outer-sandboxed campaign of FO-PERMISSIONS-02/03 cannot).
 * Seeded through the isolated profile's API (prerequisites, not accepted actions): a disposable Git project with one
 * test file, one task whose fake Developer stages one source file in a task-owned workspace. In the window: open the
 * task, review the derived request, submit it (Ask: nothing starts), Allow once in Needs you. The result is read from
 * the same request. A fake verdict, a seeded observation or an unsandboxed test would not count; none is used.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Ctx = any;
export async function run(c: Ctx) {
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state } = c;
  const shots = join(root, "shots"); mkdirSync(shots, { recursive: true });
  const shot = (name: string) => { spawnSync("/usr/sbin/screencapture", ["-x", "-R120,120,1280,860", join(shots, `${name}.png`)]); };
  evidence.build = JSON.parse(readFileSync(join(root, "qa-native-build.json"), "utf8"));
  const names = (n: any) => [n.AXTitle, n.AXDescription].filter((x: any) => typeof x === "string" && x);
  const has = (part: string) => find(hasText(part)).length > 0;
  const quit = async () => {
    ax("key", "12", "1048576");
    await poll("app exited", () => { try { process.kill(state.launcherPid, 0); return null; } catch { return true; } }, 15_000).catch(async () => { await down(); });
    await sleep(1500);
  };
  const git = (cwd: string, ...args: string[]) => { const r = spawnSync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };

  // ---- prerequisites seeded through the profile's API ----
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  const Work = join(runtime, "projects/Native"); mkdirSync(join(Work, "src"), { recursive: true });
  writeFileSync(join(Work, "README.md"), "# disposable native test fixture\n");
  writeFileSync(join(Work, "src/clamp.test.ts"), `import { expect, test } from "bun:test";\nimport { clampInt } from "./clamp.ts";\ntest("keeps an in-range value", () => { expect(clampInt(5, 0, 10)).toBe(5); });\n`);
  git(Work, "init", "-b", "main"); git(Work, "add", "README.md", "src/clamp.test.ts");
  git(Work, "-c", "user.email=fo@example.com", "-c", "user.name=FO", "commit", "-m", "seed");
  await api("POST", "/projects", { path: Work, name: "D8 Native" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const clamp = "export function clampInt(value: number, min: number, max: number): number {\n  return value < min ? min : value > max ? max : value;\n}\n";
  const marker = "__agetor_fake_task_files__";
  const made = await api("POST", "/tasks", {
    title: "Native test task", workdir: Work, isolation: "none", column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", effort: "low",
    prompt: `Add src/clamp.ts.\n${marker}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clamp }] })}`,
  });
  const taskId = made.id ?? made.task?.id;
  await api("POST", "/task-workspace/prepare", { taskId, outputPaths: ["src/clamp.ts"] });
  await api("POST", `/tasks/${taskId}/start`);
  await poll("workspace settled", async () => { const w = await api("GET", `/task-workspace?taskId=${taskId}`); return w.workspace?.status === "settled" ? true : null; }, 60_000);
  await poll("task in Review", async () => ((await api("GET", `/tasks/${taskId}`)).column === "review" ? true : null), 30_000);
  const perm = async () => (await api("GET", "/project-permissions")).requests.filter((r: any) => r.taskId === taskId);
  assert.equal((await perm()).length, 0, "no request exists before the Owner acts");
  mark("Seeded through the API: disposable Git project with one test file, one task whose fake Developer staged src/clamp.ts in a task-owned workspace (settled); no permission request exists");
  await down(); await up();
  await show("Main navigation");

  const openTask = async () => {
    await poll("task card", () => find((n: any) => n.AXRole === "AXButton" && names(n).includes("Native test task")).at(0) ?? null, 15_000);
    await button("Native test task", true, 0); await show("Project test", 15_000); await sleep(800);
  };
  /** Bring the "Project test" section into the visible window (AXScrollToVisible), so the screenshot shows it. */
  const scrollInto = async (_part: string) => {
    try { ax("focus-name", "AXGroup", "Project test"); } catch { /* the scroll happens before the focus attempt; a focus refusal is harmless */ }
    await sleep(600);
  };
  const closePanel = async () => { await button("Close task details"); await sleep(600); };

  // ---- 1. Review and submit under Ask: nothing starts ----
  await button("D8 Native", false, 0); await button("Tasks", true, 0);
  await openTask();
  await button("Review request…", true);
  await show("Review before you submit");
  await show("bun test ./src/clamp.test.ts");
  await scrollInto("Review before you submit");
  shot("01-review-before-submit");
  await button("Submit request", true);
  await poll("request pending", async () => ((await perm()).some((r: any) => r.status === "pending") ? true : null), 15_000);
  let [request] = await perm();
  assert.equal(request.status, "pending");
  assert.equal(request.startedAt ?? null, null, "Ask starts nothing");
  evidence.pending = { id: request.id, command: request.command, status: request.status };
  await show("Waiting for your decision", 10_000).catch(() => undefined);
  await scrollInto("Latest request");
  shot("02-submitted-pending");
  await closePanel();
  mark("Review request: the derived command is shown, Submit created one pending request; nothing started (startedAt null)");

  // ---- 2. Allow once in Needs you: a real offline run ----
  await button("Needs you", false, 0);
  await show("Allow once", 15_000);
  shot("03-needs-you-allow-once");
  await button("Allow once", true, 0);
  await poll("request finished", async () => { const [r] = await perm(); return r && !["pending", "running"].includes(r.status) ? r : null; }, 60_000);
  [request] = await perm();
  evidence.result = undefined;
  evidence.nativeRun = { status: request.status, exitCode: request.exitCode, isolation: request.isolation, authority: request.authority, summary: request.summary, command: request.command, reason: request.reason };
  assert.equal(request.status, "completed", `the offline run must complete; got ${request.status}: ${request.reason ?? ""} ${request.summary ?? ""}`);
  assert.equal(request.exitCode, 0);
  assert.equal(request.isolation, "macos-offline-seatbelt");
  assert.equal(request.authority, "owner-once");
  assert.match(request.summary ?? "", /1 pass/);
  const afterRun = await perm();
  assert.equal(afterRun.length, 1, "one request, one process");
  mark("Allow once in the window: the request finished with exit 0 under macos-offline-seatbelt, authority owner-once, '1 pass' in the bounded summary");

  // ---- 3. The same request is the task's status; reopening starts nothing ----
  await button("Tasks", true, 0).catch(() => undefined);
  await openTask();
  await show("Finished", 15_000);
  await scrollInto("Latest request");
  shot("04-task-shows-result");
  const taskAfter = await api("GET", `/tasks/${taskId}`);
  assert.notEqual(taskAfter.column, "done", "a passing project test is evidence only");
  assert.equal(taskAfter.qcState?.latestVerdict ?? null, null, "and sets no QC verdict");
  await closePanel();
  await quit(); await up(); await sleep(3000);
  const reopened = await perm();
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].finishedAt, request.finishedAt, "reopening ran nothing");
  evidence.reopen = { requests: reopened.length, finishedAtUnchanged: true };
  mark("The task shows the result of that same request; the test is evidence only (task not Done, no QC verdict); after quit and reopen there is still one request with an unchanged finish time");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.outcome = "pass"; save();
  console.log("FO-D8C packaged native test passed");
}
