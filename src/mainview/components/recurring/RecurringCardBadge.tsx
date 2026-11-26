import { Repeat } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { formatRecurrenceSummary, type TaskRecurringInfo } from "../../../shared/recurring-tasks.ts";
import { formatUtcTimestamp } from "../../../shared/task-availability.ts";

interface Props {
  recurring?: TaskRecurringInfo | null;
}

/**
 * Compact Kanban card indicator for recurring task occurrences.
 * Keeps card height minimal and separates the recurrence label from the
 * occurrence's own scheduled availability and the template's next planned slot.
 */
export function RecurringCardBadge({ recurring }: Props) {
  const { locale } = useUILocale();
  if (!recurring) return null;
  const uiLocale: "en" | "ru" = locale === "ru" ? "ru" : "en";
  const label = formatRecurrenceSummary(recurring.schedule, uiLocale);
  const tooltip = recurring.nominalUtc
    ? `${label} · ${tr("kanban.recurring.card_nominal_hint", { time: formatUtcTimestamp(recurring.nominalUtc, uiLocale) })}`
    : label;

  return (
    <div
      data-testid="task-card-recurring"
      data-recurring-template-id={recurring.templateId}
      title={tooltip}
      className="flex min-w-0 items-center gap-1 text-[11px] font-medium text-primary/90"
    >
      <Repeat className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
