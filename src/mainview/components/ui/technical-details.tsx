import { useRef, useState, type ReactNode } from "react";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";
import { useShowTechnicalDetails } from "@/lib/technical-details-pref";

export interface TechnicalRow {
  label: string;
  /** Exact canonical value. Shown verbatim, copyable. */
  value: string | null | undefined;
  /** Kept on the value element so existing tests and e2e selectors survive the move into details. */
  testId?: string;
  /** Hide the copy button (e.g. for a value that is not worth copying). */
  noCopy?: boolean;
}

/**
 * Progressive-disclosure block for ids, hashes, raw state codes and other diagnostics.
 * Collapsed by default; the content stays in the DOM, so nothing the screen used to expose is lost.
 * It never gates a security decision: it only controls how much detail is shown.
 *
 * The global "Show technical details" preference decides only whether the block starts open.
 * With the preference off it is still one click (or Enter/Space on the summary) away.
 */
/** Free-form body variant of the disclosure (long explanations, raw JSON). Same open/closed rule. */
export function TechnicalDisclosure({ summary, children, testId, className }: {
  summary: string;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  useUILocale();
  const showAll = useShowTechnicalDetails();
  return (
    <details key={showAll ? "open" : "closed"} open={showAll || undefined} className={cn("rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-[11px]", className)} data-testid={testId}>
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{summary}</summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}

export function TechnicalDetails({ rows, testId, className, summary }: {
  rows: readonly TechnicalRow[];
  testId?: string;
  className?: string;
  summary?: string;
}) {
  useUILocale();
  const showAll = useShowTechnicalDetails();
  return (
    // `key` remounts on a preference change so the new default applies; in between the person's own toggle wins.
    <details key={showAll ? "open" : "closed"} open={showAll || undefined} className={cn("group rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-[11px]", className)} data-testid={testId}>
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {summary ?? tr("tech.summary")}
      </summary>
      <TechnicalDetailRows rows={rows} />
    </details>
  );
}

/** The label/value grid on its own, for use inside a `TechnicalDisclosure`. */
export function TechnicalDetailRows({ rows }: { rows: readonly TechnicalRow[] }) {
  return (
    <dl className="mt-1 grid grid-cols-[minmax(7rem,max-content)_1fr] gap-x-3 gap-y-1">
      {rows.map((row, index) => (
        <TechnicalRowView key={`${row.label}:${index}`} row={row} />
      ))}
    </dl>
  );
}

function TechnicalRowView({ row }: { row: TechnicalRow }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = row.value == null || row.value === "" ? null : row.value;
  async function copy() {
    if (value == null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); the value stays selectable.
    }
  }
  return (
    <>
      <dt className="text-muted-foreground">{row.label}</dt>
      <dd className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 break-all font-mono" data-testid={row.testId}>{value ?? tr("tech.empty")}</span>
        {value != null && !row.noCopy && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={tr("tech.copyValue", { label: row.label })}
            className="shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? tr("tech.copied") : tr("tech.copy")}
          </button>
        )}
      </dd>
    </>
  );
}
