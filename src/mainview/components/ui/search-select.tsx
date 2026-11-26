import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Input } from "./input";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";

export interface SearchSelectItem {
  value: string;
  label: string;
  /** Secondary text shown under the label. */
  hint?: string;
  /** Render at the top of the list above non-pinned items (e.g. current branch). */
  pinned?: boolean;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  items: SearchSelectItem[];
  placeholder?: string;
  /** Shown in the trigger when no value is selected. */
  emptyLabel?: string;
  /** Optional row rendered below the list (e.g. "Browse for folder"). */
  footer?: ReactNode;
  /** Override the trigger label for an arbitrary value (e.g. show basename for a path). */
  displayValue?: (value: string) => string;
  className?: string;
  /** Extra classes on the trigger button itself (className applies to the root wrapper). */
  triggerClassName?: string;
  /** Left-side icon in the trigger. */
  leadingIcon?: ReactNode;
  disabled?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  /**
   * Where the popover opens relative to the trigger. Default "top" suits the
   * always-anchored-at-the-bottom new-task form; dialogs that render the
   * picker near the top of a modal should pass "bottom".
   */
  placement?: "top" | "bottom";
  /** Show the search box and filter items as the user types. Default true;
   *  pass false for short enumerated lists where search adds no value. */
  searchable?: boolean;
  /** Let the item hint wrap across lines instead of truncating to one. */
  wrapHints?: boolean;
}

/**
 * Generic combobox: trigger button → popover with a search box + a filtered
 * list + an optional footer slot. Native `<select>` doesn't support search or
 * arbitrary trailing actions, hence the hand-rolled popover.
 */
export function SearchSelect({
  value,
  onChange,
  items,
  placeholder = "Select…",
  emptyLabel,
  footer,
  displayValue,
  className,
  triggerClassName,
  leadingIcon,
  disabled,
  title,
  placement = "top",
  searchable = true,
  wrapHints = false,
}: Props) {
  const { locale: uiLocale } = useUILocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !rootRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      closeAndFocus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Focus the search box once the panel is mounted.
    queueMicrotask(() => (searchable ? searchRef.current : listRef.current)?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, searchable]);

  // Reset the query each time the panel closes so the next open starts clean.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    if (!searchable) return items;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      i.label.toLowerCase().includes(q)
      || i.value.toLowerCase().includes(q)
      || (i.hint?.toLowerCase().includes(q) ?? false));
  }, [items, query, searchable, uiLocale]);

  // Show pinned matches at the top of the filtered view.
  const ordered = useMemo(() => {
    const pinned = filtered.filter((i) => i.pinned);
    const rest = filtered.filter((i) => !i.pinned);
    return [...pinned, ...rest];
  }, [filtered, uiLocale]);

  useEffect(() => {
    const selectedIndex = ordered.findIndex(item => item.value === value);
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }, [ordered, value, open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const pick = (next: string) => {
    onChange(next);
    closeAndFocus();
  };
  const onListKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(index => ordered.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + ordered.length) % ordered.length : 0);
    } else if (!searchable && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : Math.max(0, ordered.length - 1));
    } else if (event.key === "Enter" || (!searchable && event.key === " ")) {
      event.preventDefault();
      const item = ordered[active];
      if (item) pick(item.value);
    }
  };

  const selected = items.find((i) => i.value === value);
  const triggerLabel = value
    ? (displayValue ? displayValue(value) : selected?.label ?? value)
    : (emptyLabel ?? placeholder);

  return (
    <div ref={rootRef} className={cn("relative", className)} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-control w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-1 text-left text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          triggerClassName,
        )}
      >
        {leadingIcon && <span className="shrink-0 text-muted-foreground">{leadingIcon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
          {triggerLabel}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden />
      </button>

      {open && (
        <div
          // Marker for enclosing Esc handlers (RunPanel) to bail and let
          // this popover consume Escape first.
          data-popover-open=""
          className={cn(
            "glass-floating absolute left-0 right-0 z-50 overflow-hidden rounded-xl border text-card-foreground shadow-xl",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
              <Search className="size-3.5 shrink-0 opacity-60" aria-hidden />
              <Input
                ref={searchRef}
                {...IDENTIFIER_INPUT_PROPS}
                role="combobox"
                aria-label={placeholder}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={ordered[active] ? `${listId}-${active}` : undefined}
                onKeyDown={onListKey}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
              />
            </div>
          )}
          <div ref={listRef} id={listId} role="listbox" aria-label={placeholder}
            tabIndex={-1} onKeyDown={onListKey}
            aria-activedescendant={!searchable && ordered[active] ? `${listId}-${active}` : undefined}
            className="max-h-64 overflow-y-auto py-1">
            {ordered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground"><I18nText id="common.no_matches" /></div>
            ) : (
              ordered.map((item, index) => {
                const selected = item.value === value;
                return (
                  <button
                    key={item.value}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => pick(item.value)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/60",
                      index === active && "bg-accent/60",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      {item.hint && (
                        <span
                          className={cn(
                            "block text-[11px] text-muted-foreground",
                            wrapHints ? "whitespace-normal break-words" : "truncate",
                          )}
                        >
                          {item.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {footer && (
            <div className="border-t border-border/60">{footer}</div>
          )}
        </div>
      )}
    </div>
  );
}
