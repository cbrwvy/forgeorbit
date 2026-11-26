import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { localeStore, t, type Locale, type Parameters, type TranslationKey } from "./core";

const LocaleContext = createContext<Locale | null>(null);
/** Subscribes without remounting children, dialogs, drafts, or approval state. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.getSnapshot, () => "en" as const);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.getElementById("splash")?.setAttribute("aria-label", t("settings.loadingApp"));
  }, [locale]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "KeyL" || !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey || event.repeat) return;
      event.preventDefault();
      void setLocale(localeStore.getSnapshot() === "en" ? "ru" : "en");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
/** UI components subscribe; pure presentation helpers use t() at render time. */
export function useLocale() {
  const locale = useContext(LocaleContext);
  if (locale === null) throw new Error("useLocale requires LocaleProvider");
  return { locale, setLocale };
}
export function setLocale(locale: Locale) {
  return localeStore.choose(locale, api.setPreference).catch(() => {
    toast.error(<I18nText id="errors.localeSave" />);
  });
}
export function I18nText({ id, parameters }: { id: TranslationKey; parameters?: Parameters }) {
  useLocale();
  return <>{t(id, parameters)}</>;
}

/** A known notice field, never arbitrary AI prose. Preserve the complete source for billing/security review. */
export function UsageNotice({ text }: { text: string }) {
  const { locale } = useLocale();
  return locale === "en" ? <>{text}</> : <>{t("execution.usageNotice")}<small className="mt-1 block break-words text-muted-foreground">{text}</small></>;
}
