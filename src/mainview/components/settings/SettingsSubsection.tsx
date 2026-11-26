import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SubsectionId } from "@/lib/settings-dialog-view";

/**
 * One panel inside a Settings section (FO-UX-SIMPLIFY02-M4). The wrapper carries
 * the anchor the search and the legacy deep links scroll to. `titleHidden` keeps
 * the heading for assistive technology when the hosted component already draws
 * its own visible one.
 */
export function SettingsSubsection({
  id,
  title,
  hint,
  titleHidden = false,
  children,
  className,
}: {
  id: SubsectionId;
  title: string;
  hint?: string;
  titleHidden?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const headingId = `settings-sub-title-${id}`;
  return (
    <section
      data-settings-sub={id}
      data-testid={`settings-sub-${id}`}
      aria-labelledby={headingId}
      tabIndex={-1}
      className={cn("ds-panel scroll-mt-3 space-y-3 p-4 outline-none", className)}
    >
      <header className={cn("space-y-0.5", titleHidden && "sr-only")}>
        <h4 id={headingId} className="ds-section-title">{title}</h4>
        {hint && <p className="ds-meta">{hint}</p>}
      </header>
      <div className="[&>*:first-child]:pt-0">{children}</div>
    </section>
  );
}
