import { expect, test } from "bun:test";
import { classifyWorkspaceChanges, normalizeWorkspacePaths, parseFakeTaskFiles } from "./task-workspace.ts";

test("output paths reject traversal, secrets, and an empty list of duplicates", () => {
  expect(normalizeWorkspacePaths(["../src/clamp.ts"], 8).ok).toBe(false);
  expect(normalizeWorkspacePaths([".env"], 8).ok).toBe(false);
  expect(normalizeWorkspacePaths([".git/config"], 8).ok).toBe(false);
  const named = normalizeWorkspacePaths(["./src/clamp.ts", "src/clamp.ts"], 8);
  expect(named).toEqual({ ok: true, paths: ["src/clamp.ts"] });
});

test("a pre-existing file is not an output, and an edit outside the output list is unauthorized", () => {
  const classified = classifyWorkspaceChanges({
    outputPaths: ["src/clamp.ts"],
    dependencyPaths: [],
    files: [
      { path: "src/shift.ts", sha256: "a".repeat(64), bytes: 10, provenance: "untracked" },
      { path: "src/clamp.ts", sha256: null, bytes: 0, provenance: "absent" },
      { path: "src/clamp.test.ts", sha256: "b".repeat(64), bytes: 10, provenance: "tracked" },
    ],
    after: [
      { path: "src/shift.ts", sha256: "c".repeat(64) },
      { path: "src/clamp.ts", sha256: "d".repeat(64) },
      { path: "src/clamp.test.ts", sha256: "b".repeat(64) },
    ],
  });
  expect(classified.violation).toBe(true);
  expect(classified.changes.find((entry) => entry.path === "src/clamp.ts")).toMatchObject({ kind: "created", scope: "output" });
  expect(classified.changes.find((entry) => entry.path === "src/shift.ts")).toMatchObject({ kind: "modified", scope: "unauthorized" });
  expect(classified.changes.find((entry) => entry.path === "src/clamp.test.ts")?.kind).toBe("unchanged");
});

test("the fake file marker parses only safe relative paths", () => {
  expect(parseFakeTaskFiles("no marker")).toBeNull();
  const parsed = parseFakeTaskFiles('prefix __agetor_fake_task_files__:{"writes":[{"path":"src/clamp.ts","contents":"export {}\\n"}]}');
  expect(parsed).toEqual({ ok: true, writes: [{ path: "src/clamp.ts", contents: "export {}\n" }] });
  expect(parseFakeTaskFiles('__agetor_fake_task_files__:{"writes":[{"path":"../x","contents":"a"}]}')?.ok).toBe(false);
});
