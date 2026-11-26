import { en } from "./en";
import { ru } from "./ru";

export type Locale = "en" | "ru";
export type TranslationKey = keyof typeof en;
export type Parameters = Readonly<Record<string, string | number>>;
export const LOCALE_PREFERENCE = "locale";
export const INTL_LOCALES = { en: "en-US", ru: "ru-RU" } as const;
export const dictionaries: Record<Locale, Partial<Record<TranslationKey, string>>> = { en, ru };

export function parseLocale(value: unknown): Locale | null {
  return value === "en" || value === "ru" ? value : null;
}
export function detectLocale(languages: readonly string[]): Locale {
  return /^ru(?:-|$)/i.test(languages[0] ?? "") ? "ru" : "en";
}
export function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  return detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** Pure, injectable store: no settings, storage, DB, or network reads on import. */
export function createLocaleStore(initial: Locale) {
  let locale = initial;
  let version = 0;
  let confirmed = initial;
  let adjusted = false;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: Locale) => {
    if (locale === next) return;
    locale = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => locale,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconcile: (preference: unknown) => { if (!adjusted) { confirmed = parseLocale(preference) ?? initial; publish(confirmed); } },
    async choose(next: Locale, persist: (key: string, value: string) => Promise<unknown>) {
      adjusted = true;
      const request = ++version;
      publish(next);
      // Serialize writes so a slow earlier request cannot overwrite a newer choice.
      const write = writes.catch(() => {}).then(() => persist(LOCALE_PREFERENCE, next)).then(() => { confirmed = next; });
      writes = write;
      try { await write; }
      catch (error) { if (request === version) publish(confirmed); throw error; }
    },
  };
}
export const localeStore = createLocaleStore(systemLocale());
export const getLocale = localeStore.getSnapshot;
export const intlLocale = () => INTL_LOCALES[getLocale()];
const missing = new Set<string>();

export function translate(
  locale: Locale,
  key: TranslationKey,
  parameters: Parameters = {},
  dictionary: Partial<Record<TranslationKey, string>> = dictionaries[locale],
): string {
  const translated = dictionary[key];
  if (translated === undefined && import.meta.env?.DEV && !missing.has(`${locale}:${key}`)) {
    missing.add(`${locale}:${key}`);
    console.warn(`[i18n] Missing ${locale} translation: ${key}`);
  }
  const template = translated ?? en[key] ?? key;
  // Text only. React escapes the result. No HTML, eval, or recursively interpreted parameters.
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : token);
}
export function t(key: TranslationKey, parameters?: Parameters): string {
  return translate(getLocale(), key, parameters);
}
export function plural(locale: Locale, count: number, forms: { one: string; few?: string; many?: string; other: string }): string {
  const category = new Intl.PluralRules(INTL_LOCALES[locale]).select(count);
  return forms[category as keyof typeof forms] ?? forms.other;
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(value);
}
export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(intlLocale(), options).format(value);
}
export function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" }).format(value, unit);
}
export type CountNoun = "item" | "employee" | "project" | "note" | "task" | "run" | "step" | "day" | "agent" | "file" | "retry" | "character" | "pipeline" | "commit";
export function countLabel(count: number, noun: CountNoun): string {
  const form = new Intl.PluralRules(intlLocale()).select(count);
  const category = form === "one" || form === "few" || form === "many" ? form : "other";
  return t(`count.${noun}.${category}`, { count: formatNumber(count) });
}
/** Only for legacy split English nouns. New copy must use countLabel or whole-message plural keys. */
export const englishPluralSuffix = () => getLocale() === "en" ? "s" : "";
