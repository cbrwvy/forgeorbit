import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { t as tr } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { Input } from "@/components/ui/input";
import { searchSettings, type SettingsIndexEntry, type SettingsSearchResult } from "@/lib/settings-index";

/**
 * Settings search / jump list (FO-UX-SIMPLIFY02-M4). It filters the static index of
 * setting labels and descriptions; it never reads a stored value. Choosing a result
 * calls `onSelect`, which opens the section and moves focus to the control.
 */
export function SettingsSearch({ onSelect }: { onSelect: (entry: SettingsIndexEntry) => void }) {
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo<SettingsSearchResult[]>(
    () => searchSettings(query, (key) => tr(key), locale),
    // `locale` re-derives labels when the language changes.
    [query, locale],
  );
  useEffect(() => { setActive(0); }, [query]);
  const hasQuery = query.trim().length > 0;

  const choose = (result: SettingsSearchResult | undefined) => {
    if (!result) return;
    onSelect(result.entry);
    setQuery("");
  };

  return (
    <div className="relative" data-testid="settings-search">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          ref={inputRef}
          type="search"
          role="combobox"
          // macOS WebKit autocorrect capitalised a typed query and swallowed the Return meant to pick a hit.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={tr("settings.search.label")}
          aria-expanded={hasQuery}
          aria-controls={listId}
          aria-activedescendant={hasQuery && results[active] ? `${listId}-${results[active].entry.id}` : undefined}
          placeholder={tr("settings.search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
            else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
            else if (e.key === "Enter" && results.length) { e.preventDefault(); choose(results[active]); }
            else if (e.key === "Escape" && hasQuery) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
          }}
          className="h-8 pl-8 pr-8 text-xs"
          data-testid="settings-search-input"
        />
        {hasQuery && (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tr("settings.search.clear")}
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            data-testid="settings-search-clear"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only" data-testid="settings-search-status">
        {hasQuery ? (results.length ? tr("settings.search.count", { count: results.length }) : tr("settings.search.none", { query: query.trim() })) : ""}
      </p>
      {hasQuery && (
        <ul id={listId} role="listbox" data-popover-open="" data-popover-keys="escape-only" aria-label={tr("settings.search.results")} className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-md" data-testid="settings-search-results">
          {results.length === 0 && (
            <li role="presentation" className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="settings-search-empty">
              {tr("settings.search.none", { query: query.trim() })}
            </li>
          )}
          {results.map((r, i) => (
            <li key={r.entry.id} role="presentation">
              <button
                type="button"
                role="option"
                id={`${listId}-${r.entry.id}`}
                aria-selected={i === active}
                tabIndex={-1}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${i === active ? "bg-muted" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
                data-testid={`settings-search-result-${r.entry.id}`}
              >
                <span className="block font-medium">{r.label}</span>
                <span className="block text-[11px] text-muted-foreground">{tr("settings.search.in", { section: r.sectionLabel, subsection: r.subsectionLabel })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
