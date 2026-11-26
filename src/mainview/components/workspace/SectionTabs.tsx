import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SectionTabs as SectionTabsModel } from "@/lib/navigation";
import type { WorkspacePage } from "@/lib/workspace";

interface Props {
  model: SectionTabsModel;
  onSelect: (page: WorkspacePage) => void;
  /** Small trail on the left, e.g. "Settings / Tools". */
  lead?: ReactNode;
}

/**
 * In-page tabs of a merged destination (FO-UX-SIMPLIFY02-M3): Projects
 * (list / portfolio / groups), Knowledge (notes / memory) and the Settings
 * tools (browser / native computer). Each tab is a whole existing page with its
 * own data, so this is page navigation: links with `aria-current`, not a tablist.
 */
export function SectionTabs({ model, onSelect, lead }: Props) {
  useUILocale();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-section-tab]"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    items[(index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <nav
      aria-label={tr(`nav.group.${model.group}` as TranslationKey)}
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-1.5 sm:px-page"
      data-testid="section-tabs"
      data-group={model.group}
      onKeyDown={onKeyDown}
    >
      {lead}
      <div className="ds-tabs min-w-0">
        {model.tabs.map((tab) => (
          <button
            key={tab.page}
            type="button"
            data-section-tab=""
            data-testid={tab.testId}
            aria-current={model.current === tab.page ? "page" : undefined}
            className={cn("glass-nav-item ds-tab", model.current === tab.page && "glass-selected")}
            onClick={() => onSelect(tab.page)}
          >
            {tr(tab.labelKey as TranslationKey)}
          </button>
        ))}
      </div>
    </nav>
  );
}
