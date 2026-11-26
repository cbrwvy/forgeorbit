import { useState } from "react";
import { UsageTaskDialog } from "./UsageTaskDialog";
import { ForecastActualComparison } from "./ForecastActualComparison";

/**
 * Compact forecast-versus-actual section for the task result / review surface.
 * Read-only. "Open full comparison" opens the same task Analytics dialog the
 * Analytics task list opens.
 */
export function TaskForecastActual({ taskId, refreshKey }: { taskId: string; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  return <section className="rounded-md border bg-card p-3" data-testid="task-forecast-actual">
    <ForecastActualComparison taskId={taskId} compact refreshKey={refreshKey} onOpenAnalytics={() => setOpen(true)} />
    {open && <UsageTaskDialog taskId={taskId} onClose={() => setOpen(false)} />}
  </section>;
}
