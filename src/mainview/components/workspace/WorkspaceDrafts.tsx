import { useLocale as useUILocale } from "@/i18n/react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type SetStateAction } from "react";

const Drafts = createContext<Map<string, unknown> | null>(null);

/** Unsent form state lives only in this app window's memory. Pages can
 * unmount (and release subscriptions) without losing project-scoped drafts. */
export function WorkspaceDraftProvider({ children }: { children: ReactNode }) {
  useUILocale();
  const drafts = useRef(new Map<string, unknown>());
  return <Drafts.Provider value={drafts.current}>{children}</Drafts.Provider>;
}

export function useWorkspaceDraft<T>(key: string, initial: T | (() => T)) {
  const drafts = useContext(Drafts);
  if (!drafts) throw new Error("WorkspaceDraftProvider is missing");
  const [value, setValue] = useState<T>(() => drafts.has(key)
    ? drafts.get(key) as T
    : typeof initial === "function" ? (initial as () => T)() : initial);
  const current = useRef(value);
  current.current = value;
  const update = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (value: T) => T)(current.current) : action;
    current.current = next;
    drafts.set(key, next);
    setValue(next);
  }, [drafts, key]);
  const discard = useCallback(() => { drafts.delete(key); }, [drafts, key]);
  return [value, update, discard] as const;
}
