import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Small trail above the title (e.g. a breadcrumb). */
  eyebrow?: ReactNode;
  /** Right side: tabs, at most one primary button, quiet secondary actions, a "More" menu. */
  children?: ReactNode;
  className?: string;
  titleTestId?: string;
  testId?: string;
  /** Sticky glass bar (Portfolio). Defaults to a plain header like every other page. */
  sticky?: boolean;
}

/**
 * The one page header of the app's global surfaces (FO-UX02-E): Overview, All tasks,
 * Needs you, Portfolio, Company, Clusters, Knowledge. Same padding, a single `h1`
 * at the same size, an optional one-line subtitle and an actions cluster on the
 * right that wraps under the title on narrow windows. The hierarchy rule for the
 * cluster: tabs first, then at most ONE primary button, then quiet secondary
 * actions; anything else goes into an `ActionsMenu`.
 */
export function PageHeader({ title, subtitle, eyebrow, children, className, titleTestId, testId, sticky = false }: Props) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pb-3 pt-5 sm:px-page",
        sticky && "glass-bar sticky top-0 z-10 border-b",
        className,
      )}
      data-testid={testId}
    >
      <div className="min-w-0 flex-1 basis-56">
        {eyebrow}
        <h1 className="ds-page-title break-words" data-testid={titleTestId}>{title}</h1>
        {subtitle && <p className="mt-0.5 text-[length:var(--text-secondary)] text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
