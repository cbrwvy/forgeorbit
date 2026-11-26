import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { BarChart3, Bot, Calculator, Check, ChevronDown, Columns3, LayoutDashboard, Brain, BookOpen, Repeat, Server, Settings2, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMorePage, PROJECT_MORE_PAGES, PROJECT_PRIMARY_TABS, projectTabFor } from "@/lib/navigation";
import type { WorkspacePage } from "@/lib/workspace";

const PRIMARY_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  board: Columns3,
  usage: BarChart3,
  manager: Bot,
  team: Users,
};
const MORE_ICONS: Partial<Record<WorkspacePage, LucideIcon>> = {
  recurring: Repeat,
  estimates: Calculator,
  environment: Server,
  knowledge: BookOpen,
  brain: Brain,
  settings: Settings2,
};

const MENU_WIDTH_REM = 14;
const EDGE_MARGIN = 8;

interface Props {
  page: WorkspacePage;
  onPageChange: (page: WorkspacePage) => void;
}

/**
 * The project workspace's page switcher (FO-UX-SIMPLIFY02-M5): Overview, Tasks,
 * Plan and Execution and Team, then a More menu for Estimates, Environment,
 * Notes, Memory and Project rules. Every page keeps its pre-M5 id and test id;
 * a page that lives under More makes the More button the selected one and names
 * the page in it, so the active destination is never hidden.
 */
export function ProjectTabs({ page, onPageChange }: Props) {
  useUILocale();
  const activeTab = projectTabFor(page);
  const onMore = isMorePage(page);
  const activeMore = PROJECT_MORE_PAGES.find((item) => item.page === page);
  return (
    <div className="ds-tabs self-start !flex-wrap !overflow-visible" role="group" aria-label={tr("m5.tabs.aria")} data-testid="project-tabs">
      {PROJECT_PRIMARY_TABS.map((item) => {
        const Icon = PRIMARY_ICONS[item.tab] ?? LayoutDashboard;
        const current = activeTab === item.tab;
        return (
          <button
            key={item.tab}
            type="button"
            aria-pressed={current}
            data-testid={item.testId}
            onClick={() => onPageChange(item.page)}
            className={cn("glass-nav-item ds-tab", current && "glass-selected")}
          >
            <Icon className="size-4 max-[1100px]:hidden" aria-hidden />
            {tr(item.labelKey as TranslationKey)}
          </button>
        );
      })}
      <MoreMenu page={page} onMore={onMore} activeLabel={activeMore ? tr(activeMore.labelKey as TranslationKey) : null} onPageChange={onPageChange} />
    </div>
  );
}

function MoreMenu({ page, onMore, activeLabel, onPageChange }: { page: WorkspacePage; onMore: boolean; activeLabel: string | null; onPageChange: (page: WorkspacePage) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // Fixed position computed from the button: the tab strip scrolls horizontally
  // (`overflow-x: auto`), which would clip an absolutely positioned menu.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = MENU_WIDTH_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const left = Math.max(EDGE_MARGIN, Math.min(rect.left, window.innerWidth - width - EDGE_MARGIN));
    setPos({ left, top: rect.bottom + 4 });
  }, [open]);

  const shown = open && pos !== null;
  useEffect(() => {
    if (!shown) return;
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const current = items().find((el) => el.getAttribute("aria-current") === "page");
    (current ?? items()[0])?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onViewport = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onViewport);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onViewport);
    };
  }, [shown]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      // Closes the menu only — not a surrounding dialog or panel.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + items.length - 1) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="project-more"
        data-current={onMore ? "true" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={activeLabel ? `${tr("m5.more.aria")}: ${activeLabel}` : tr("m5.more.aria")}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onButtonKeyDown}
        className={cn("glass-nav-item ds-tab", onMore && "glass-selected")}
      >
        <span>{tr("m5.more")}</span>
        {activeLabel && <span className="max-w-[9rem] truncate text-muted-foreground" data-testid="project-more-current">· {activeLabel}</span>}
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={tr("m5.more.aria")}
          data-popover-open=""
          data-testid="project-more-menu"
          onKeyDown={onMenuKeyDown}
          style={{ position: "fixed", left: pos.left, top: pos.top, width: `${MENU_WIDTH_REM}rem`, maxWidth: `calc(100vw - ${EDGE_MARGIN * 2}px)` }}
          className="z-popover rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          {PROJECT_MORE_PAGES.map((item) => {
            const Icon = MORE_ICONS[item.page] ?? Settings2;
            const current = item.page === page;
            return (
              <button
                key={item.page}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid={item.testId}
                aria-current={current ? "page" : undefined}
                aria-label={item.accessibleLabelKey ? tr(item.accessibleLabelKey as TranslationKey) : undefined}
                onClick={() => {
                  setOpen(false);
                  onPageChange(item.page);
                }}
                className={cn("glass-nav-item flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[length:var(--text-base)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", current && "glass-selected font-medium")}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{tr(item.labelKey as TranslationKey)}</span>
                {current && <Check className="size-3.5 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
