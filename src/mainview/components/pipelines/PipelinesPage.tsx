import { englishPluralSuffix, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState } from "react";
import { ArrowLeft, Copy, Download, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { usePipelines } from "@/lib/pipelines";
import { api, ApiError } from "@/lib/api";
import { BundleToolbar, useBundleList } from "@/components/bundle";
import { cn } from "@/lib/utils";
import { duplicateAgentName } from "../../../shared/duplicate-name.ts";
import { PIPELINE_LIMITS, type Pipeline } from "../../../shared/types.ts";

interface PipelinesPageProps {
  onOpenEditor: (id: string | null) => void;
  onBack: () => void;
  /** After a bundle import — App reloads its harness list when the import
   *  enabled a harness. */
  onImported?: (result: { enabledHarnesses: string[] }) => void;
}

/**
 * The pipelines list — one board-agnostic full-page view (D5,
 * `docs/plans/pipelines.md`) for creating, editing, duplicating, and
 * deleting {@link Pipeline}s. Editing itself happens in {@link
 * PipelineEditor}, opened via `onOpenEditor`. Export/import runs through
 * `useBundleList` (docs/plans/agents-pipelines-import-export.md C13); the
 * whole page is a drop zone for a .json bundle.
 */
export function PipelinesPage({ onOpenEditor, onBack, onImported }: PipelinesPageProps) {
  useUILocale();
  const { pipelines, loading, error, refresh } = usePipelines();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The page unmounts on an app-level navigation, so an edited import
  // asks before one drops it.
  const bundle = useBundleList({ ids: pipelines.map((p) => p.id), kind: "pipeline", onImported, guardsNavigation: true });

  const handleDuplicate = async (pipeline: Pipeline) => {
    setBusyId(pipeline.id);
    setActionError(null);
    try {
      const name = duplicateName(pipeline.name, pipelines);
      await api.createPipeline({
        name,
        description: pipeline.description,
        graph: pipeline.graph,
        maxSteps: pipeline.maxSteps,
      });
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : tr("common.failed_to_duplicate_pipeline"));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (pipeline: Pipeline) => {
    const ok = await confirm(() => ({
      title: tr("common.delete_988654", { p0: String(pipeline.name) }),
      description:
        (pipeline.taskCount ?? 0) > 0
          ? tr("common.used_by_task_s_deleting_it_never_affects", { p0: String(pipeline.taskCount) })
          : tr("common.this_can_t_be_undone"),
      confirmLabel: tr("common.delete_pipeline"),
      variant: "destructive",
    }));
    if (!ok) return;
    setBusyId(pipeline.id);
    setActionError(null);
    try {
      await api.deletePipeline(pipeline.id);
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : tr("common.failed_to_delete_pipeline"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      data-testid="pipelines-page"
      data-dragging={bundle.dragging ? "" : undefined}
      className={cn("flex h-full w-full flex-col", bundle.dragging && "ring-2 ring-inset ring-info")}
      {...bundle.dropProps}
    >
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" data-testid="pipelines-back" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="size-4" aria-hidden /><I18nText id="common.back" />{" "}</Button>
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          <Workflow className="size-4 shrink-0 text-muted-foreground" aria-hidden /><I18nText id="common.pipelines" />{" "}</h1>
        <Button type="button" size="sm" data-testid="pipelines-new" onClick={() => onOpenEditor(null)} className="gap-1.5">
          <Plus className="size-4" aria-hidden /><I18nText id="common.new_pipeline" />{" "}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {actionError && (
          <p data-testid="pipelines-error" className="mb-3 text-xs text-danger">
            {actionError}
          </p>
        )}
        {error && (
          <p data-testid="pipelines-load-error" className="mb-3 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mb-3">
          <BundleToolbar {...bundle.toolbarProps} />
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground"><I18nText id="common.loading_pipelines" /></p>
        ) : pipelines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
            <Workflow className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground"><I18nText id="common.no_pipelines_yet" /></p>
            <Button type="button" size="sm" onClick={() => onOpenEditor(null)} className="gap-1.5">
              <Plus className="size-4" aria-hidden /><I18nText id="pipelines.create_your_first_pipeline" />{" "}</Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pipelines.map((pipeline) => (
              <li
                key={pipeline.id}
                data-testid="pipelines-row"
                data-pipeline-id={pipeline.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
              >
                <input
                  type="checkbox"
                  data-testid="bundle-row-select"
                  className="mt-1 size-3.5 shrink-0 accent-primary"
                  checked={bundle.isSelected(pipeline.id)}
                  onChange={() => bundle.toggle(pipeline.id)}
                  aria-label={tr("common.select_8d2979", { p0: String(pipeline.name) })}
                />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onOpenEditor(pipeline.id)}
                    className="truncate text-left text-sm font-medium hover:underline"
                    title={pipeline.name}
                  >
                    {pipeline.name}
                  </button>
                  {pipeline.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{pipeline.description}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pipeline.graph.steps.length}{" "}<I18nText id="common.step" />{pipeline.graph.steps.length === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="common.used_by" />{" "}
                    {pipeline.taskCount ?? 0}{" "}<I18nText id="common.task" />{(pipeline.taskCount ?? 0) === 1 ? "" : englishPluralSuffix()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={tr("common.export")}
                    aria-label={tr("common.export_5edce4", { p0: String(pipeline.name) })}
                    data-testid="bundle-row-export"
                    onClick={() => bundle.exportOne(pipeline.id)}
                    className="size-8"
                  >
                    <Download className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={tr("common.edit")}
                    data-testid="pipelines-edit"
                    disabled={busyId === pipeline.id}
                    onClick={() => onOpenEditor(pipeline.id)}
                    className="size-8"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={tr("common.duplicate")}
                    data-testid="pipelines-duplicate"
                    disabled={busyId === pipeline.id}
                    onClick={() => void handleDuplicate(pipeline)}
                    className="size-8"
                  >
                    <Copy className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={tr("common.delete")}
                    data-testid="pipelines-delete"
                    disabled={busyId === pipeline.id}
                    onClick={() => void handleDelete(pipeline)}
                    className="size-8 text-danger hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {bundle.dialogs}
    </div>
  );
}

/** " (copy)" / " (copy 2)" / … suffix that avoids colliding with an existing
 *  pipeline name and keeps the suffix inside `PIPELINE_LIMITS.name`. */
function duplicateName(base: string, existing: Pipeline[]): string {
  return duplicateAgentName(base, existing.map((p) => p.name), PIPELINE_LIMITS.name);
}
