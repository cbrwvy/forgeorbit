import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { blockerText } from "@/lib/handsoff";
import type { HandsoffAttentionRow } from "../../../shared/owner-actions.ts";

interface Props {
  rows: readonly HandsoffAttentionRow[];
  projectName: (path: string) => string;
  onOpenTask: (taskId: string) => void;
}

/** Hands-off work that stopped on one real decision. Work in progress is never listed here. */
export function HandsoffAttention({ rows, projectName, onOpenTask }: Props) {
  useUILocale();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="attention-handsoff-heading" className="space-y-2" data-testid="attention-handsoff">
      <div>
        <h2 id="attention-handsoff-heading" className="text-sm font-semibold">{tr("handsoff.attn.title")}</h2>
        <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("handsoff.attn.hint")}</p>
      </div>
      <ul className="surface-solid overflow-hidden rounded-xl border">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 border-b px-4 py-row last:border-b-0" data-testid="attention-handsoff-row" data-code={row.code} data-task-id={row.taskId}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={row.title}>{row.title}</p>
                <p className="truncate text-[length:var(--text-secondary)] text-muted-foreground" title={row.projectPath}>{projectName(row.projectPath)}</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => onOpenTask(row.taskId)} data-testid="attention-handsoff-open">{tr("handsoff.attn.open")}</Button>
            </div>
            <p className="text-xs">{blockerText({ code: row.code as never, message: row.message })}</p>
            <TechnicalDetails rows={[{ label: tr("handsoff.tech.code"), value: row.code }, { label: tr("handsoff.tech.message"), value: row.message }]} />
          </li>
        ))}
      </ul>
    </section>
  );
}
