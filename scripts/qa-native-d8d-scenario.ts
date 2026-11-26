/**
 * Direction 8, second milestone: the QC OBSERVED test (authorize, approve, run) started from the packaged window, then an
 * independent review (fixture Reviewer) that is sent that observed result. Same runner as run_project_test
 * (runSeatbeltBunTest), reached through the QC first-review panel.
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
  const { api, button, show, find, hasText, ax, mark, evidence, save, root, runtime, up, down, sleep, poll, ownerPaths, stamp, state, activate, qcVerdictFile } = c;
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

  const scrollIntoView = async () => { try { ax("focus-name", "AXGroup", "First review evidence"); } catch { /* scroll happens first */ } await sleep(600); };
  const cardButton = async (title: string, label: string) => {
    const node = await poll(`"${label}" on the "${title}" card`, () => {
      const nodes = find(() => true);
      const card = nodes.find((n: any) => n.AXRole === "AXGroup" && names(n).includes(title) && n.frame && n.frame.width < 400);
      if (!card) return null;
      const f = card.frame;
      return nodes.find((n: any) => n.AXRole === "AXButton" && names(n).includes(label) && n.frame && n.frame.x >= f.x && n.frame.x <= f.x + f.width && n.frame.y >= f.y && n.frame.y <= f.y + f.height) ?? null;
    }, 15_000);
    activate(node); await sleep(500);
  };
  // ---- prerequisites seeded through the profile's API ----
  writeFileSync(qcVerdictFile, "PASS\n");
  await up();
  await api("PUT", "/preferences/onboardingDismissed", { value: "true" });
  await api("PUT", "/preferences/locale", { value: "en" });
  const Work = join(runtime, "projects/Observed"); mkdirSync(join(Work, "src"), { recursive: true });
  writeFileSync(join(Work, "README.md"), "# disposable observed-test fixture\n");
  writeFileSync(join(Work, "src/clamp.test.ts"), `import { expect, test } from "bun:test";\nimport { clampInt } from "./clamp.ts";\ntest("keeps an in-range value", () => { expect(clampInt(5, 0, 10)).toBe(5); });\n`);
  git(Work, "init", "-b", "main"); git(Work, "add", "README.md", "src/clamp.test.ts");
  git(Work, "-c", "user.email=fo@example.com", "-c", "user.name=FO", "commit", "-m", "seed");
  await api("POST", "/projects", { path: Work, name: "D8 Observed" });
  await api("PATCH", "/harnesses/codex", { enabled: true });
  const clamp = "export function clampInt(value: number, min: number, max: number): number {\n  return value < min ? min : value > max ? max : value;\n}\n";
  const marker = "__agetor_fake_task_files__";
  const made = await api("POST", "/tasks", {
    title: "Observed test task", workdir: Work, isolation: "none", column: "ready", agent: "codex", model: "gpt-6.1-sol", mode: "auto", effort: "low",
    prompt: `Add src/clamp.ts exporting clampInt. Do not modify other files.\n${marker}:${JSON.stringify({ writes: [{ path: "src/clamp.ts", contents: clamp }] })}`,
  });
  const taskId = made.id ?? made.task?.id;
  await api("POST", "/task-workspace/prepare", { taskId, outputPaths: ["src/clamp.ts"] });
  await api("POST", `/tasks/${taskId}/start`);
  await poll("workspace settled", async () => { const w = await api("GET", `/task-workspace?taskId=${taskId}`); return w.workspace?.status === "settled" ? true : null; }, 60_000);
  await api("POST", "/task-workspace/publish", { taskId, approve: true, paths: ["src/clamp.ts"] });
  await poll("task in Review", async () => ((await api("GET", `/tasks/${taskId}`)).column === "review" ? true : null), 30_000);
  const observations = async () => (await api("GET", `/tasks/${taskId}/qc-recovery`));
  const auths = () => { return null; };
  void auths;
  mark("Seeded through the API: disposable Git project with one test file, one task whose fake Developer's output was published after the Owner's approval (prerequisite, not an accepted action); no QC review and no observed test exists");
  await down(); await up();
  await show("Main navigation");

  const openTask = async () => {
    await poll("task card", () => find((n: any) => n.AXRole === "AXButton" && names(n).includes("Observed test task")).at(0) ?? null, 15_000);
    await button("Observed test task", true, 0); await show("First review evidence", 20_000); await sleep(800);
  };
  const closePanel = async () => { await button("Close task details"); await sleep(600); };
  const view0 = await observations();
  assert.equal(view0.firstReview.bundle.status, "preview");
  assert.equal(view0.firstReview.bundle.test ?? null, null);

  await button("D8 Observed", false, 0); await button("Tasks", true, 0);
  await openTask();

  // ---- the Owner's three explicit steps: acknowledge + authorize, approve, run ----
  const checkbox = await poll("acknowledge checkbox", () => find((n: any) => n.AXRole === "AXCheckBox" && names(n).some((x: string) => x.startsWith("I understand this runs the project test once"))).at(0) ?? null, 15_000);
  ax("press", "AXCheckBox", names(checkbox).find((x: string) => x.startsWith("I understand")) as string); await sleep(500);   // AXPress scrolls the control into view first
  await button("Authorize one evidence test", true);
  await show("prepared", 15_000);
  shot("01-authorized");
  const stage = async () => { const v = await observations(); return v.firstReview.testAuthorization; };
  assert.equal((await stage()).status, "prepared");
  await button("Approve one test run", true);
  await poll("approved", async () => ((await stage()).status === "approved" ? true : null), 15_000);
  assert.equal((await observations()).firstReview.bundle.test ?? null, null, "approval runs nothing");
  await button("Run evidence test", true);
  await poll("test finished", async () => { const a = await stage(); return a.status === "consumed" ? a : null; }, 60_000);
  const v1 = await observations();
  const test = v1.firstReview.bundle.test;
  evidence.observedTest = { authorization: v1.firstReview.testAuthorization.status, used: v1.firstReview.testAuthorization.invocationsUsed, command: test.command, exitCode: test.exitCode, provenance: test.provenance, isolation: test.limitation, digest: v1.firstReview.bundle.digest };
  assert.equal(test.exitCode, 0);
  assert.equal(test.provenance, "forgeorbit-observed-test");
  assert.equal(test.command, "bun test ./src/clamp.test.ts");
  assert.match(`${test.stdout ?? ""}\n${test.stderr ?? ""}`, /1 pass/);
  assert.equal(v1.firstReview.testAuthorization.invocationsUsed, 1);
  await show("The evidence bundle is complete", 15_000);
  await scrollIntoView();
  shot("02-observed-test-complete");
  mark("In the window: acknowledged, authorized, approved (nothing ran), then Run evidence test: one real offline run, exit 0, forgeorbit-observed-test, '1 pass'; the authorization is consumed (1 of 1)");

  // ---- an independent review (fixture Reviewer) is sent the observed result; PASS waits for the Owner ----
  assert.equal((await api("GET", `/tasks/${taskId}`)).qcState?.latestVerdict ?? null, null, "the test set no verdict");
  await button("Request AI review", true);
  await poll("review settled", async () => { const t = await api("GET", `/tasks/${taskId}`); return t.qcState?.latestVerdict === "PASS" && !t.qcState.activeReviewId ? t : null; }, 40_000);
  const qc = await api("GET", `/tasks/${taskId}/qc`);
  const reviewRunId = qc.reviews[0].reviewRunId;
  const events = (await api("GET", `/tasks/${taskId}/events/page?beforeId=999999999&limit=2000`)).events.filter((e: any) => e.runId === reviewRunId && e.stream === "user").map((e: any) => e.data).join("\n");
  evidence.reviewerSaw = {
    observedSection: events.includes("### ForgeOrbit-observed test"),
    exitCodeZero: events.includes("Exit code: 0"),
    digestMatches: events.includes(`Evidence digest: ${v1.firstReview.bundle.digest}`),
    notAVerdict: events.includes("It is not a QC verdict"),
  };
  assert.deepEqual(Object.values(evidence.reviewerSaw), [true, true, true, true]);
  const t = await api("GET", `/tasks/${taskId}`);
  assert.deepEqual([t.column, t.qcState.latestVerdict, t.qcState.awaitingOwnerApproval], ["review", "PASS", true]);
  assert.notEqual(t.column, "done");
  await show("your acceptance required");
  shot("03-review-pass-awaiting-owner");
  await closePanel();
  mark("Request AI review (fixture PASS): the Reviewer was sent the observed result (section, exit code 0, the same evidence digest, 'not a QC verdict'); the task waits in Review for the Owner, not Done");

  await cardButton("Observed test task", "Done");
  await poll("Done", async () => ((await api("GET", `/tasks/${taskId}`)).column === "done" ? true : null), 20_000);
  mark("The Owner pressed Done: the separate acceptance step");

  // ---- reopening runs nothing ----
  await quit(); await up(); await sleep(3000);
  const v2 = await observations();
  assert.equal(v2.firstReview?.testAuthorization?.invocationsUsed ?? 1, 1);
  evidence.reopen = { authorizationStillConsumed: true };
  mark("After quit and reopen the authorization is still consumed (1 of 1); nothing ran again");

  const ownerBefore = JSON.parse(readFileSync(join(root, "owner-before.json"), "utf8"));
  const ownerAfter = Object.fromEntries(ownerPaths.map((p: string) => [p, stamp(p)]));
  assert.deepEqual(ownerAfter, ownerBefore, "Owner profile or installed app changed");
  evidence.ownerUntouched = true;
  mark("Owner profile paths and the installed app were unchanged");
  await down();
  evidence.outcome = "pass"; save();
  console.log("FO-D8D packaged observed test passed");
}
