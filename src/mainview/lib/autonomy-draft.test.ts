import { expect, test } from "bun:test";
import { buildAutonomyDraft, parseMissionTaskLines } from "./autonomy-draft.ts";

const fields = {
  mode: "full-autonomy" as const,
  projects: "/tmp/alpha\n/tmp/beta",
  providers: "claude-code",
  models: "haiku-4.5",
  accounts: "",
  allowUnscopedAccount: false,
  workers: "2",
  launches: "12",
  minutes: "60",
  rework: "1",
  requireObservedTest: true,
  requireIndependentReviewer: true,
  autoComplete: true,
  permitSelfImprovement: true,
  testCommand: "bun test ./src/add.test.ts",
  outputPath: "src/add.ts",
};

test("a full autonomy draft names the observed test and does not activate itself", () => {
  const built = buildAutonomyDraft(fields, 1_000);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  expect(built.body.mode).toBe("full-autonomy");
  expect(built.body.scopeKind).toBe("workspace");
  expect(built.body.permittedActions).toContain("run_observed_test");
  expect(built.body.permittedActions).toContain("complete_task");
  expect(built.body.qc.requireObservedTest).toBe(true);
  expect(built.body.authorizedTests).toEqual([
    { projectPath: "/tmp/alpha", command: "bun test ./src/add.test.ts", outputPaths: ["src/add.ts"] },
    { projectPath: "/tmp/beta", command: "bun test ./src/add.test.ts", outputPaths: ["src/add.ts"] },
  ]);
  expect(built.body.allowUnscopedAccount).toBe(false);
  expect(built.body.selfImprovement).toEqual({ enabled: true, lowRiskActivation: false });
  expect("status" in built.body).toBe(false);
});

test("supervised mode stays a plan-only draft", () => {
  const built = buildAutonomyDraft({ ...fields, mode: "supervised", projects: "/tmp/alpha", requireObservedTest: false }, 1_000);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  expect(built.body.scopeKind).toBe("project");
  expect(built.body.permittedActions).toEqual(["plan_task"]);
  expect(built.body.authorizedTests).toBeUndefined();
  expect(built.body.completion.autoComplete).toBe(false);
});

test("an invented test command is refused before a policy exists", () => {
  const built = buildAutonomyDraft({ ...fields, testCommand: "bash -c echo" });
  expect(built.ok).toBe(false);
});

test("mission lines keep an existing task and a dependency", () => {
  const parsed = parseMissionTaskLines([
    "Alpha | /tmp/alpha | developer | - | task-1 | implement",
    "Beta | /tmp/beta | reviewer | Alpha | - | review the result",
  ].join("\n"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.tasks[0]).toMatchObject({ taskId: "task-1", prompt: "implement" });
  expect(parsed.tasks[0]?.dependsOnTitles).toBeUndefined();
  expect(parsed.tasks[1]?.dependsOnTitles).toEqual([{ title: "Alpha", condition: "qc_pass" }]);
  expect(parsed.tasks[1]?.taskId).toBeUndefined();
});
