import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OwnerActionRow } from "../../../../shared/owner-actions.ts";

interface Props {
  rows: readonly OwnerActionRow[];
  projectName: (path: string) => string;
  /** Opens the same proposal card the project's Plan and Execution page holds. Approves nothing. */
  onReview: (projectPath: string) => void;
}

/**
 * Plans waiting for approval (FO-UX-SIMPLIFY02-M6): the core's own pending task proposals
 * (the rows behind the "Needs you" count), listed wherever the Owner starts — Home and the
 * Head of PM panel — with one link to the card where they are reviewed. Listing changes nothing.
 */
export function PlansWaiting({ rows, projectName, onReview }: Props) {
  useUILocale();
  if (rows.length === 0) return null;
  return (
    <section className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs" data-testid="plans-waiting" aria-label={tr("m6.plans.title")}>
      <p className="font-medium text-warning">{tr("m6.plans.title")}</p>
      <p className="text-muted-foreground">{tr("m6.plans.note")}</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2" data-testid="plans-waiting-row" data-proposal-id={row.id} data-path={row.projectPath}>
            <span className="min-w-0 flex-1 basis-40">
              <span className="block truncate font-medium text-foreground" title={row.title}>{row.title}</span>
              <span className="block truncate text-muted-foreground">{projectName(row.projectPath)}</span>
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => onReview(row.projectPath)} data-testid="plans-waiting-review">
              <ListTree className="size-3.5" aria-hidden />{tr("m6.plans.review")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
