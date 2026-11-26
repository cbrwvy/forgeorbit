import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";

export type BoardEmptyKind = "empty" | "no-project" | "filtered";

/**
 * What an empty Tasks board says (FO-UX-SIMPLIFY02-M7). Three different situations, three different texts:
 * nothing exists yet (create a task), nothing exists and there is no project to put one in (add a project),
 * and tasks exist but the search or filters hide them (clear the filters). It sits over the still-mounted columns.
 */
export function BoardEmptyNotice({ kind, onCreateTask, onAddProject, onClearFilters }: {
  kind: BoardEmptyKind;
  onCreateTask: () => void;
  onAddProject: () => void;
  onClearFilters: () => void;
}) {
  useUILocale();
  const content =
    kind === "filtered"
      ? { title: tr("m7.empty.tasks.filtered_title"), description: tr("m7.empty.tasks.filtered_description"), label: tr("m7.empty.tasks.clear"), onClick: onClearFilters, testId: "board-empty-clear-filters" }
      : kind === "no-project"
        ? { title: tr("m7.empty.tasks.title"), description: tr("m7.empty.tasks.no_project"), label: tr("m7.empty.tasks.add_project"), onClick: onAddProject, testId: "board-empty-add-project" }
        : { title: tr("m7.empty.tasks.title"), description: tr("m7.empty.tasks.description"), label: tr("m7.empty.tasks.create"), onClick: onCreateTask, testId: "board-empty-create-task" };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-20 z-10 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md" data-testid="board-empty" data-kind={kind}>
        <EmptyState
          className="surface-solid rounded-xl border"
          title={content.title}
          description={content.description}
          action={<Button type="button" size="sm" onClick={content.onClick} data-testid={content.testId}>{content.label}</Button>}
        />
      </div>
    </div>
  );
}
