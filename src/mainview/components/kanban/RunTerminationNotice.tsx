import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import type { RunTermination } from "../../../shared/run-termination.ts";
import { terminationNotice, type TerminationRole } from "@/lib/run-termination-text";

/**
 * Says what a Stop or a time limit did to one run: requested, observed to exit, still alive, or not reported by the
 * harness. It states the evidence the core recorded and a next step through controls that already exist.
 */
export function RunTerminationNotice({ termination, runStatus, role, testId = "run-termination", className }: {
  termination: RunTermination | null | undefined;
  runStatus: string;
  role: TerminationRole;
  testId?: string;
  className?: string;
}) {
  useUILocale();
  const notice = terminationNotice(termination, runStatus, role);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid={testId}
      data-state={notice.state}
      data-reason={termination?.reason ?? ""}
      className={cn(
        "space-y-0.5 rounded-md border px-2 py-1.5 text-xs",
        notice.tone === "warning" ? "border-warning/40 bg-warning/10 text-foreground"
          : notice.tone === "success" ? "border-success/40 bg-success/10 text-foreground"
          : "border-border/60 bg-muted/30 text-muted-foreground",
        className,
      )}
    >
      <p>{tr(notice.headline.key, notice.headline.params)}</p>
      {notice.next && <p className="text-muted-foreground" data-testid={`${testId}-next`}>{tr(notice.next)}</p>}
    </div>
  );
}
