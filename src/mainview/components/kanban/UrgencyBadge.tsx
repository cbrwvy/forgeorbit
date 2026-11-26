import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { normalizeUrgency, urgencyLabelKey, URGENCY_LEVELS, type Urgency } from "../../../shared/board-order.ts";

/** Restrained tones: only Critical and High carry a semantic colour; Normal, Low and Minimal stay quiet. The number
 *  and the word are always shown, so colour is never the only signal. */
const TONE: Record<Urgency, string> = {
  5: "border-danger/40 bg-danger/10 text-danger",
  4: "border-warning/40 bg-warning/10 text-warning",
  3: "border-border/70 bg-transparent text-muted-foreground",
  2: "border-border/60 bg-transparent text-muted-foreground/90",
  1: "border-border/50 bg-transparent text-muted-foreground/70",
};

export const urgencyText = (urgency: unknown): string => {
  const u = normalizeUrgency(urgency);
  return tr("kanban.urgency.badge", { n: u, label: tr(urgencyLabelKey(u)) });
};

/** `4/5 · High`, compact, on every Kanban card. */
export function UrgencyBadge({ urgency, className }: { urgency: unknown; className?: string }) {
  useUILocale();
  const u = normalizeUrgency(urgency);
  return (
    <span
      data-testid="task-card-urgency"
      data-urgency={u}
      title={`${tr("kanban.urgency.title")}: ${urgencyText(u)}`}
      className={cn("inline-flex max-w-full items-center whitespace-nowrap rounded-md border px-1.5 py-0 text-[11px] font-medium leading-5", TONE[u], className)}
    >
      <span className="truncate">{urgencyText(u)}</span>
    </span>
  );
}

/** The five levels, most urgent first, for a select. */
export function UrgencySelect({ value, onChange, id, disabled, className, testId }: {
  value: unknown;
  onChange: (urgency: Urgency) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  useUILocale();
  return (
    <select
      id={id}
      data-testid={testId ?? "urgency-select"}
      className={cn("h-9 w-full rounded-md border border-input bg-background px-2 text-sm", className)}
      value={normalizeUrgency(value)}
      disabled={disabled}
      onChange={(event) => onChange(normalizeUrgency(Number(event.target.value)))}
    >
      {URGENCY_LEVELS.map((u) => <option key={u} value={u}>{tr("kanban.urgency.option", { n: u, label: tr(urgencyLabelKey(u)) })}</option>)}
    </select>
  );
}
