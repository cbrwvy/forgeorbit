/**
 * Display text for the manager's "project context" rows. The server builds these sentences in English
 * (they also go into the model prompt and stored messages, so they stay canonical); the page renders
 * the known ones in the current language and shows anything unrecognised verbatim.
 */
import { getLocale, t, type TranslationKey } from "@/i18n/core";
import { en } from "@/i18n/en";

interface SourceLike { label: string; detail: string }

export function contextSourceLabel(source: SourceLike): string {
  if (getLocale() === "en") return source.label;
  const key = `mgr.src.label.${source.label}`;
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : source.label;
}

const EXACT: Record<string, TranslationKey> = {
  "Not found in the project.": "mgr.src.detail.notFound",
  "Not readable: missing, outside the project, not Markdown, or larger than 512 KB.": "mgr.src.detail.notReadable",
  "The file is empty.": "mgr.src.detail.empty",
  "Included (secrets redacted).": "mgr.src.detail.included",
  "Name and folder only: the folder could not be scanned.": "mgr.src.detail.nameFolderOnly",
  "No tasks on the board for this project.": "mgr.src.detail.noTasks",
  "The environment manager is not running.": "mgr.src.detail.envNotRunning",
  "no launch profile is configured": "mgr.src.detail.noLaunchProfile",
  "None confirmed yet.": "mgr.src.detail.noneConfirmed",
};

export function contextSourceDetail(source: SourceLike): string {
  const detail = source.detail;
  if (getLocale() === "en") return detail;
  const exact = EXACT[detail];
  if (exact) return t(exact);
  let match = /^First ([\d,]+) characters \(secrets redacted\)\.$/.exec(detail);
  if (match) return t("mgr.src.detail.firstChars", { count: match[1]! });
  match = /^Name, folder, (.*?)(, description)?\.$/.exec(detail);
  if (match) {
    const stack = match[1] === "No stack detected" ? t("mgr.src.detail.noStack") : match[1]!;
    return t("mgr.src.detail.identity", { stack, description: match[2] ? t("mgr.src.detail.identityDescription") : "" });
  }
  match = /^(\d+) of (\d+) active tasks listed(?:, (\d+) archived counted)?\.$/.exec(detail);
  if (match) {
    const base = t("mgr.src.detail.tasksListed", { listed: match[1]!, active: match[2]! });
    return `${base}${match[3] ? t("mgr.src.detail.archivedCounted", { count: match[3] }) : ""}.`;
  }
  match = /^(\d+) confirmed\.$/.exec(detail);
  if (match) return t("mgr.src.detail.confirmed", { count: match[1]! });
  return detail;
}
