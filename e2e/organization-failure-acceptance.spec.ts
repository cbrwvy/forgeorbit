import { test, expect, api, sql, registerProject } from "./organization-acceptance-fixture";

test("FO-012C a controlled fake failure persists as failed and records run.failed without retry or fabricated completion", async ({ request, companyBackend: b }, info) => {
  const dir = await registerProject(request, b, "Controlled failure");
  const worker = await api(request, b, "POST", "/employees", { name: "Failure worker", jobTitle: "Engineer", projectPath: dir }, 201);
  await api(request, b, "POST", `/employees/${worker.id}/professional-profile`, { catalogRoleSlug: "engineering-backend-architect", promptMarkdown: "# Immutable failure profile" });
  // Existing in-process fake driver contract, not a mocked HTTP result.
  const task = await api(request, b, "POST", "/tasks", { title: "Controlled runtime failure", prompt: "__agetor_fake_run_fail__", workdir: dir, isolation: "none", column: "ready", agent: "claude-code", model: "opus", mode: "auto" });
  await api(request, b, "POST", "/task-assignments", { taskId: task.id, employeeId: worker.id }, 201);
  const review = (await api(request, b, "POST", "/employee-execution/reviews", { taskId: task.id, harnessId: "claude-code" })).attempt;
  const body = { revision: review.revision, confirm: true, acknowledgeUsage: true };
  await api(request, b, "POST", `/employee-execution/attempts/${review.id}/start`, body);
  await expect.poll(async () => (await api(request, b, "GET", `/employee-execution/attempts/${review.id}`)).attempt.result).toBe("failed");
  const runs = await api(request, b, "GET", `/tasks/${task.id}/runs`);
  expect(runs).toHaveLength(1); expect(runs[0]).toMatchObject({ status: "failed", exitCode: 1 });
  const events = (await api(request, b, "GET", `/activity?taskId=${task.id}`)).events;
  expect(events.filter((e: any) => e.eventType === "run.failed")).toHaveLength(1);
  expect(events.filter((e: any) => e.eventType === "run.completed")).toHaveLength(0);
  await b.restart();
  expect((await api(request, b, "POST", `/employee-execution/attempts/${review.id}/start`, body)).replayed).toBe(true);
  expect(await api(request, b, "GET", `/tasks/${task.id}/runs`)).toEqual(runs);
  expect((await api(request, b, "GET", `/activity?taskId=${task.id}`)).events).toEqual(events);
  expect(sql(b, "PRAGMA foreign_key_check")).toEqual([]);
  await info.attach("controlled-failure-chain", { body: JSON.stringify({ task: task.id, attempt: review.id, runs, events }, null, 2), contentType: "application/json" });
});
