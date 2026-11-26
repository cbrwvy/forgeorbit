import { expect, test } from "bun:test";
import { launchTargetNote, publishablePaths } from "../../shared/execution/launch-target";
import { en } from "../i18n/en";
import { ru } from "../i18n/ru";

const text = (locale: "en" | "ru", id: string): string => (locale === "en" ? en : ru)[id as keyof typeof en] as string;

test("the review names the reviewed launch target, never the isolation field alone", () => {
  // An armed task-owned workspace is recorded with isolation none, yet must not read as the project folder.
  const staged = launchTargetNote({ workspaceKind: "task-staging" });
  expect(staged).toEqual({ noteId: "execution.target_task_staging", tone: "info", valueId: "execution.isolation_task_staging" });
  const worktree = launchTargetNote({ workspaceKind: "worktree" });
  expect(worktree).toEqual({ noteId: "execution.target_worktree", tone: "info", valueId: "execution.isolation_worktree" });
  const direct = launchTargetNote({ workspaceKind: "project-folder" });
  expect(direct).toEqual({ noteId: "execution.no_worktree_isolation", tone: "warning", valueId: null });
  // A review recorded before the field existed says nothing rather than guessing.
  expect(launchTargetNote({})).toBeNull();
});

test("only an armed staging workspace lists paths eligible for later publication", () => {
  expect(publishablePaths({ workspaceKind: "task-staging", stagedOutputPaths: ["src/is-odd.ts"] })).toEqual(["src/is-odd.ts"]);
  expect(publishablePaths({ workspaceKind: "task-staging" })).toEqual([]);
  expect(publishablePaths({ workspaceKind: "worktree", stagedOutputPaths: ["src/is-odd.ts"] })).toEqual([]);
  expect(publishablePaths({ workspaceKind: "project-folder", stagedOutputPaths: ["x"] })).toEqual([]);
});

test("the wording of each workspace mode is accurate in English and Russian", () => {
  for (const locale of ["en", "ru"] as const) {
    const staged = text(locale, "execution.target_task_staging");
    const worktree = text(locale, "execution.target_worktree");
    const direct = text(locale, "execution.no_worktree_isolation");
    const note = text(locale, "execution.publish_paths_note");
    const hint = text(locale, "tasks.isolation_staging_hint");
    // Staging and worktree sentences never say the agent works directly in the project folder; the direct one does.
    if (locale === "en") {
      expect(staged).toContain("prepared task workspace");
      expect(staged).toContain("does not run in the project folder");
      expect(worktree).toContain("Git worktree");
      expect(worktree).toContain("not directly in the project folder");
      expect(direct).toContain("directly in the project folder");
      expect(note).toContain("not a write restriction");
      expect(note).toContain("separate Owner approval");
      expect(hint).toContain("separate modes");
    } else {
      expect(staged).toContain("рабочем каталоге задачи");
      expect(staged).toContain("Он не работает ни в папке проекта");
      expect(worktree).toContain("Git worktree");
      expect(worktree).toContain("а не прямо в папке проекта");
      expect(direct).toContain("непосредственно в папке проекта");
      expect(note).toContain("не ограничение записи");
      expect(note).toContain("отдельное одобрение");
      expect(hint).toContain("разные режимы");
    }
    expect(staged).not.toContain(direct);
  }
});
