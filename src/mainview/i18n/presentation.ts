import { en } from "./en";
import { ru } from "./ru";
import { getLocale, t, type TranslationKey } from "./core";

const sourceKeys = new Map<string, TranslationKey>();
for (const key of Object.keys(en) as TranslationKey[]) {
  if (!sourceKeys.has(en[key])) sourceKeys.set(en[key], key);
  if (!sourceKeys.has(ru[key])) sourceKeys.set(ru[key], key);
}
/** Adapter for existing, explicitly selected shared UI metadata; never apply to user content or error prose. */
export function staticLabel(source: string): string {
  const key = sourceKeys.get(source);
  return key ? t(key) : source;
}
export function codeLabel(code: string | null | undefined): string {
  if (code == null) return t("common.unknown");
  const key = `status.${code}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : code;
}
export function evidenceLabel(state: "verified" | "conditional" | "unknown" | "blocked" | "conflicting"): string {
  return t(`evidence.${state}`);
}
export function issueText(issue: { code: string; message: string }): string {
  if (getLocale() === "en") return issue.message;
  const key = `errors.${issue.code}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : t("errors.request");
}
/** Stable server code first; status is the compatible fallback for APIs without codes. No English parsing. */
export function apiErrorText(status: number, body: unknown, diagnostic: string): string {
  if (getLocale() === "en") return diagnostic;
  const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : null;
  const key = code ? `errors.${code}` : "";
  const message = Object.hasOwn(en, key) ? t(key as TranslationKey)
    : t(status === 401 || status === 403 ? "errors.authorization"
      : status === 404 ? "errors.notFound" : status === 409 ? "errors.conflict"
      : status === 400 || status === 422 ? "errors.validation" : "errors.server");
  // Keep unstructured diagnostics visible. They are evidence, not translation keys.
  return `${message} [${code ?? status}] ${diagnostic}`;
}
export function preflightLabel(kind: "account" | "quota" | "model", state: string, diagnostic: string): string {
  if (getLocale() === "en") return diagnostic;
  const key = `execution.${kind}.${state}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : codeLabel(state);
}

/** Recommendation reasons carry stable codes; the English message stays as the fallback and the diagnostic. */
export function routingReasonText(reason: { code: string; message: string }): string {
  if (getLocale() === "en") return reason.message;
  const key = `routing.reason.${reason.code}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : reason.message;
}
/** Permission disclosure codes (FO-ORCH01) rendered in the current language. */
export function permissionCodeText(code: string): string {
  const key = `permission.${code}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : code;
}
