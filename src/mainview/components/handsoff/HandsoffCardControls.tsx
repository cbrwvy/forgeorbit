import { useState } from "react";
import { toast } from "sonner";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { canSubmitForWork, handsoffHeadline } from "@/lib/handsoff";
import { policyEnabledFor, refreshHandsoff, runForTask, useHandsoffOverview } from "@/lib/handsoff-events";
import { smartQueueItemForTask, type SmartQueueTaskItem } from "../../../shared/smart-queue.ts";
import { isTaskScheduledWaiting } from "../../../shared/task-availability.ts";
import type { Task } from "../../../shared/types.ts";

const toneClass = { info: "info", warning: "warning", success: "success", muted: "secondary", danger: "destructive" } as const;

function queueBadgeFor(item: SmartQueueTaskItem): { text: string; tone: keyof typeof toneClass; queueState: string } | null {
  if (item.category === "next") {
    return {
      text: tr(item.uncertainNext ? "kanban.queue.status.expected_next" : "kanban.queue.status.next"),
      tone: "info",
      queueState: "next",
    };
  }
  if (item.category === "queued") {
    return {
      text: item.queuePosition != null
        ? tr("kanban.queue.status.queued_pos", { pos: item.queuePosition })
        : tr("kanban.queue.status.queued"),
      tone: "muted",
      queueState: "queued",
    };
  }
  if (item.waitKind === "scheduled") {
    return { text: tr("kanban.queue.status.scheduled"), tone: "muted", queueState: "scheduled" };
  }
  if (item.waitKind === "dependency") {
    return { text: tr("kanban.queue.status.dependency"), tone: "muted", queueState: "dependency" };
  }
  if (item.waitKind === "worker") {
    return { text: tr("kanban.queue.status.worker"), tone: "muted", queueState: "worker" };
  }
  if (item.waitKind === "provider-limit") {
    return { text: tr("kanban.queue.status.provider_limit"), tone: "warning", queueState: "provider-limit" };
  }
  if (item.waitKind === "authorization") {
    return { text: tr("kanban.queue.status.authorization"), tone: "warning", queueState: "authorization" };
  }
  if (item.waitKind === "project-paused") {
    return { text: tr("kanban.queue.status.project_paused"), tone: "muted", queueState: "project-paused" };
  }
  return null;
}

/** One small status word on the board card while a task is being worked independently (or after). */
export function HandsoffChip({ task }: { task: Task }) {
  useUILocale();
  const overview = useHandsoffOverview();
  const run = runForTask(overview, task.id);
  if (!run || (run.finishedAt != null && task.column === "done")) return null;
  const queueItem = run.finishedAt == null ? smartQueueItemForTask(overview?.queues, task.id) : null;
  // Avoid duplicating "Waiting for scheduled time" when the card's schedule badge already displays it.
  if (
    ((run.status === "waiting" && run.state.waitKind === "scheduled") || queueItem?.waitKind === "scheduled") &&
    isTaskScheduledWaiting(task.availableFromUtc)
  ) {
    return null;
  }
  const queuedBadge = queueItem && run.stage === "queued" ? queueBadgeFor(queueItem) : null;
  if (queuedBadge) {
    return (
      <Badge
        variant={toneClass[queuedBadge.tone] as never}
        data-testid="task-card-handsoff"
        data-status={run.status}
        data-stage={run.stage}
        data-queue-state={queuedBadge.queueState}
        data-queue-position={queueItem?.queuePosition ?? undefined}
        title={queueItem?.reason ?? tr("handsoff.chip.title", { status: queuedBadge.text })}
      >
        {queuedBadge.text}
      </Badge>
    );
  }
  const headline = handsoffHeadline(run);
  return (
    <Badge
      variant={toneClass[headline.tone] as never}
      data-testid="task-card-handsoff"
      data-status={run.status}
      data-stage={run.stage}
      data-queue-state={queueItem?.category ?? undefined}
      title={tr("handsoff.chip.title", { status: headline.text })}
    >
      {headline.text}
    </Badge>
  );
}

/** The one direct action: "Submit for work". No second confirmation screen for the same intent. */
export function HandsoffSubmitButton({ task }: { task: Task }) {
  useUILocale();
  const overview = useHandsoffOverview();
  const [busy, setBusy] = useState(false);
  const run = runForTask(overview, task.id);
  if (!canSubmitForWork(task, policyEnabledFor(overview, task.workdir), run)) return null;
  return (
    <Button size="sm" variant="secondary" disabled={busy} data-testid="task-card-submit-handsoff" title={tr("handsoff.submit_title")}
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        try { await api.submitHandsoff(task.id); toast.success(tr("handsoff.submitted")); }
        catch (error) { toast.error(tr("handsoff.submit_failed", { message: error instanceof Error ? error.message : String(error) })); }
        finally { setBusy(false); refreshHandsoff(); }
      }}>
      {tr("handsoff.submit")}
    </Button>
  );
}
