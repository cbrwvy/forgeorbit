import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Input } from "./input";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";

export interface MultiSearchSelectItem<T extends string = string> {
  value: T;
  label: string;
  /** Secondary text shown under the label. */
  hint?: string;
  /** Render at the top of the list above non-pinned items. */
  pinned?: boolean;
  /** Optional glyph rendered on the left side of the option row. */
  icon?: ReactNode;
}

interface Props<T extends string> {
  values: T[];
  onChange: (next: T[]) => void;
  items: MultiSearchSelectItem<T>[];
  /** Search-box placeholder inside the popover. */
  placeholder?: string;
  /** Shown in the trigger when no value is selected. */
  emptyLabel: string;
  className?: string;
  /** Left-side icon in the trigger. */
  leadingIcon?: ReactNode;
  disabled?: boolean;
  /** Tooltip on the trigger. */
  title?: string;
  placement?: "top" | "bottom";
}

/**
 * Multi-select variant of SearchSelect: trigger button → popover with a search
 * box + a filtered list where clicking an item toggles it without closing.
 * Trigger label shows the single picked item's label, or "<n> selected", or
 * the empty-state label when nothing is picked. Clearing the selection is
 * done by the caller (e.g. an external "Clear" button) — keeping the trigger
 * single-purpose avoids nesting interactive elements inside the trigger
 * button and the keyboard/a11y issues that come with it.
 */
export function MultiSearchSelect<T extends string>({
  values,
  onChange,
  items,
  placeholder = "Search…",
  emptyLabel,
  className,
  leadingIcon,
  disabled,
  title,
  placement = "bottom",
}: Props<T>) {
  const { locale: uiLocale } = useUILocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !rootRef.current?.contains(e.target as Node)) return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      i.label.toLowerCase().includes(q)
      || i.value.toLowerCase().includes(q)
      || (i.hint?.toLowerCase().includes(q) ?? false));
  }, [items, query, uiLocale]);

  const ordered = useMemo(() => {
    const pinned = filtered.filter((i) => i.pinned);
    const rest = filtered.filter((i) => !i.pinned);
    return [...pinned, ...rest];
  }, [filtered, uiLocale]);

  useEffect(() => { setActive(0); }, [ordered]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const valueSet = useMemo(() => new Set(values), [values, uiLocale]);

  const selectedSingle = useMemo(
    () => (values.length === 1 ? items.find((i) => i.value === values[0]) : undefined),
    [values, items, uiLocale],
  );
  const triggerLabel = useMemo(() => {
    if (values.length === 0) return emptyLabel;
    if (values.length === 1) return selectedSingle?.label ?? values[0]!;
    return tr("common.selected", { p0: String(values.length) });
  }, [values, selectedSingle, emptyLabel, uiLocale]);
  const triggerIcon = selectedSingle?.icon ?? leadingIcon;

  const toggle = (value: T) => {
    if (valueSet.has(value)) onChange(values.filter((v) => v !== value));
    else onChange([...values, value]);
  };

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
          event.preventDefault(); setOpen(true);
        }}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-control w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-1 text-left text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {triggerIcon && <span className="shrink-0 text-muted-foreground">{triggerIcon}</span>}
        <span className={cn("min-w-0 flex-1 truncate", values.length === 0 && "text-muted-foreground")}>
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
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(index => ordered.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + ordered.length) % ordered.length : 0);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const item = ordered[active];
                  if (item) toggle(item.value);
                }
              }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="h-7 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div id={listId} role="listbox" aria-label={placeholder} aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
            {ordered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground"><I18nText id="common.no_matches" /></div>
            ) : (
              ordered.map((item, index) => {
                const selected = valueSet.has(item.value);
                return (
                  <button
                    key={item.value}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onClick={() => { toggle(item.value); searchRef.current?.focus(); }}
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
                    {item.icon && (
                      <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                        {item.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.label}</span>
                      {item.hint && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {item.hint}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
