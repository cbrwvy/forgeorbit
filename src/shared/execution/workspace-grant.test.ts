import { expect, test } from "bun:test";
import { parseTaskStagingGrant, presentPermissionBlocks, TASK_STAGING_PERMISSION_BLOCK } from "./workspace-grant.ts";

test("a task-staging grant names one project, one operation, and output paths", () => {
  const parsed = parseTaskStagingGrant({
    operation: "developer-execution",
    projectPath: "/tmp/alpha",
    scope: "task-staging",
    outputPaths: ["./src/add.ts", "src/add.ts"],
  });
  expect(parsed).toEqual({
    ok: true,
    grant: {
      operation: "developer-execution",
      projectPath: "/tmp/alpha",
      scope: "task-staging",
      outputPaths: ["src/add.ts"],
    },
  });
});

test("a grant cannot ask for full access or another project shape", () => {
  expect(parseTaskStagingGrant({ operation: "full-access", projectPath: "/tmp/alpha", scope: "task-staging", outputPaths: ["README.md"] }).ok).toBe(false);
  expect(parseTaskStagingGrant({ operation: "developer-execution", projectPath: "/tmp/alpha", scope: "danger-full-access", outputPaths: ["README.md"] }).ok).toBe(false);
  expect(parseTaskStagingGrant({ operation: "developer-execution", projectPath: "relative", scope: "task-staging", outputPaths: ["README.md"] }).ok).toBe(false);
  expect(parseTaskStagingGrant({ operation: "developer-execution", projectPath: "/tmp/alpha", scope: "task-staging", outputPaths: ["../secret"] }).ok).toBe(false);
  expect(parseTaskStagingGrant({ operation: "developer-execution", projectPath: "/tmp/alpha", scope: "task-staging", outputPaths: [], sandbox: "danger-full-access" }).ok).toBe(false);
});

test("the external Git write block tells the Owner about the scoped workspace", () => {
  const [block] = presentPermissionBlocks([{
    code: "permission-owner-decision",
    message: "Owner decision required: sandboxed Auto cannot authorize Git writes outside this workspace.",
  }]);
  expect(block?.message).toBe(TASK_STAGING_PERMISSION_BLOCK);
  expect(block?.message).toContain("developer-execution");
  expect(block?.message).toContain("task-staging");
  expect(block?.message).not.toContain("explicitly select Full access");
});
