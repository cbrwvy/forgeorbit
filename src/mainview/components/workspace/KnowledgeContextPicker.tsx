import { englishPluralSuffix, intlLocale, t as tr } from "@/i18n/core";
import { codeLabel } from "@/i18n/presentation";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, ChevronDown, Loader2, ShieldCheck, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  KNOWLEDGE_CONTEXT_LIMITS,
  type KnowledgeContextGrant,
  type KnowledgeContextIssue,
  type KnowledgeContextPreview,
  type KnowledgeContextTarget,
  type KnowledgeEligibleDocument,
  type KnowledgeEligibleOwner,
  type KnowledgeIssueCode,
  type KnowledgeLevel,
  type KnowledgeTransmission,
} from "../../../shared/knowledge/context.ts";
import type { KnowledgeOwnerRef } from "../../../shared/knowledge/document.ts";

const LEVEL_LABEL: Record<KnowledgeLevel, string> = { get company() { return tr("common.company"); }, get cluster() { return tr("common.cluster"); }, get project() { return tr("common.project_985959"); } };
const LEVELS: KnowledgeLevel[] = ["company", "cluster", "project"];

const REASON_LABEL: Partial<Record<KnowledgeIssueCode, string>> = {
  get sensitive() { return tr("common.sensitive_never_sent"); },
  get archived() { return tr("common.archived_bdb865"); },
  get "too-large"() { return tr("common.too_large_to_send"); },
  get "out-of-scope"() { return tr("common.outside_this_manager_s_scope"); },
  get "owner-missing"() { return tr("common.owner_not_available"); },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString(intlLocale())} B`;
  return tr("common.kb", { p0: String((bytes / 1024).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })) });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesOf(error: unknown): KnowledgeContextIssue[] {
  if (!(error instanceof ApiError)) return [];
  const issues = (error.body as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as KnowledgeContextIssue[]) : [];
}

export interface ApprovedKnowledge {
  grantId: string;
  expiresAt: number;
  preview: KnowledgeContextPreview;
}

interface Props {
  target: KnowledgeContextTarget;
  /** The confirmed permission for the next message, or null. Owned by the page. */
  grant: ApprovedKnowledge | null;
  onGrantChange: (grant: ApprovedKnowledge | null) => void;
  disabled?: boolean;
  allowOwner?: (owner: KnowledgeOwnerRef) => boolean;
  testId: string;
}

/**
 * Chooses notes for ONE manager message. Browsing and previewing send
 * nothing and call no model. Only "Send these notes with my next message"
 * creates a one-message permission, which the page attaches to the next send.
 */
export function KnowledgeContextPicker({ target, grant, onGrantChange, disabled, allowOwner, testId }: Props) {
  const { locale: uiLocale } = useUILocale();
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeEligibleDocument[]>([]);
  const [owners, setOwners] = useState<KnowledgeEligibleOwner[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [preview, setPreview] = useState<KnowledgeContextPreview | null>(null);
  const [issues, setIssues] = useState<KnowledgeContextIssue[]>([]);
  const [busy, setBusy] = useState<"preview" | "approve" | "revoke" | null>(null);
  const [history, setHistory] = useState<KnowledgeTransmission[] | null>(null);
  const targetKey = target.kind === "project" ? `project:${target.projectPath}` : "portfolio";
  const portfolio = target.kind === "portfolio";

  const load = useCallback(async (owner?: KnowledgeOwnerRef, keepError = false) => {
    setLoading(true);
    if (!keepError) setError(null);
    try {
      const result = await api.knowledgeContextEligible(target, owner);
      const eligible = result.documents.filter((entry) => allowOwner?.(entry.document.owner) ?? true);
      setOwners(result.owners.filter((entry) => allowOwner?.(entry.owner) ?? true));
      setTruncated(result.truncated);
      setDocuments((current) => {
        const merged = new Map(current.map((entry) => [entry.document.id, entry]));
        if (!owner) merged.clear();
        for (const entry of eligible) merged.set(entry.document.id, entry);
        return [...merged.values()];
      });
      // A note that vanished or turned ineligible leaves the selection.
      setSelected((current) => {
        const next = new Map(current);
        const fresh = new Set(eligible.filter((entry) => entry.eligible).map((entry) => entry.document.id));
        // Portfolio picks may come from owners that are not in this default list.
        if (!owner && !portfolio) for (const id of current.keys()) if (!fresh.has(id)) next.delete(id);
        return next;
      });
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, allowOwner]);

  // The scope belongs to one manager: switching project forgets everything.
  useEffect(() => {
    setDocuments([]);
    setOwners([]);
    setSelected(new Map());
    setPreview(null);
    setIssues([]);
    setHistory(null);
    setQuery("");
    setError(null);
  }, [targetKey]);

  // Scope can change while the panel is closed (a project moved to another
  // cluster, a note archived), so every opening reads it again.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // A spent or revoked permission leaves nothing selected.
  const hadGrant = useRef(false);
  useEffect(() => {
    if (hadGrant.current && !grant) {
      setSelected(new Map());
      setPreview(null);
      setIssues([]);
      setHistory(null);
    }
    hadGrant.current = grant != null;
  }, [grant]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return documents.filter((entry) => {
      if (!needle) return true;
      const { document } = entry;
      return `${document.title}\n${document.description}\n${document.category}\n${document.tags.join(" ")}\n${entry.ownerLabel}`
        .toLowerCase()
        .includes(needle);
    });
  }, [documents, query, uiLocale]);

  const grouped = useMemo(
    () => LEVELS.map((level) => ({ level, entries: visible.filter((entry) => entry.level === level) })).filter((group) => group.entries.length > 0),
    [visible, uiLocale],
  );

  const selectionList = useMemo(
    () => [...selected.entries()].map(([id, purpose]) => ({ id, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) })),
    [selected, uiLocale],
  );

  const toggle = (entry: KnowledgeEligibleDocument) => {
    if (!entry.eligible || grant) return;
    setPreview(null);
    setIssues([]);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(entry.document.id)) next.delete(entry.document.id);
      else if (next.size < KNOWLEDGE_CONTEXT_LIMITS.documents) next.set(entry.document.id, "");
      return next;
    });
  };

  const setPurpose = (id: string, purpose: string) => {
    setPreview(null);
    setSelected((current) => new Map(current).set(id, purpose));
  };

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    setIssues([]);
    try {
      const result = await api.knowledgeContextPreview(target, selectionList);
      setPreview(result);
      setIssues(result.issues);
    } catch (caught) {
      setPreview(null);
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!preview || !preview.canApprove) return;
    setBusy("approve");
    setError(null);
    try {
      const result: KnowledgeContextGrant = await api.knowledgeContextApprove(
        target,
        preview.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256, ...(item.purpose ? { purpose: item.purpose } : {}) })),
        preview.previewKey,
      );
      onGrantChange({ grantId: result.grantId, expiresAt: result.expiresAt, preview: result.preview });
      setOpen(false);
      toggleRef.current?.focus();
    } catch (caught) {
      // A note changed after the owner looked at it: ask for a new review.
      setPreview(null);
      setIssues(issuesOf(caught));
      setError(messageOf(caught));
      void load(undefined, true);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!grant) return;
    setBusy("revoke");
    try {
      await api.knowledgeContextRevoke(target, grant.grantId);
    } catch {
      /* the permission also expires on its own */
    } finally {
      setBusy(null);
      onGrantChange(null);
    }
  };

  const showHistory = async () => {
    try {
      setHistory((await api.knowledgeContextTransmissions(target)).transmissions);
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      toggleRef.current?.focus();
    }
  };

  const summary = grant
    ? tr("common.note_approved_for_the_next_message", { p0: String(grant.preview.items.length), p1: String(grant.preview.items.length === 1 ? "" : "s") })
    : selected.size > 0
      ? tr("common.selected_not_sent", { p0: String(selected.size) })
      : tr("common.none_selected");

  return (
    <section
      className="surface-solid rounded-lg border px-3 py-2"
      aria-label={tr("knowledge.knowledge_notes_for_the_next_message")}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          ref={toggleRef}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          disabled={disabled}
          data-testid={`${testId}-toggle`}
        >
          <BookOpen className="size-3.5" aria-hidden /><I18nText id="knowledge.knowledge_notes" />{" "}<ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        <span
          className={cn("text-[11px]", grant ? "text-success" : "text-muted-foreground")}
          role="status"
          data-testid={`${testId}-summary`}
        >
          {grant && <ShieldCheck className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />}
          {summary}
        </span>
        {grant && (
          <Button type="button" size="sm" variant="outline" onClick={() => void revoke()} disabled={busy === "revoke" || disabled} data-testid={`${testId}-revoke`}>
            <X className="size-3.5" aria-hidden /><I18nText id="knowledge.don_t_send" />{" "}</Button>
        )}
      </div>
      {grant && (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`${testId}-grant-detail`}>
          {grant.preview.items.map((item) => item.title).join(" · ")}. {formatBytes(grant.preview.totalBytes)}<I18nText id="knowledge.used_by_your_next_message_only" />{" "}</p>
      )}

      {open && (
        <div id={panelId} className="mt-2 flex min-h-0 flex-col gap-2" data-testid={`${testId}-panel`}>
          <p className="text-[11px] text-muted-foreground"><I18nText id="knowledge.choosing_notes_sends_nothing_after_you_review_them" />{" "}</p>
          <div className="flex flex-wrap gap-2">
            <label htmlFor={`${panelId}-search`} className="sr-only"><I18nText id="knowledge.search_notes" /></label>
            <Input
              id={`${panelId}-search`}
              ref={searchRef}
              className="h-8 min-w-0 flex-1 text-xs"
              placeholder={tr("knowledge.search_notes")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              data-testid={`${testId}-search`}
            />
            {portfolio && (
              <>
                <label htmlFor={`${panelId}-owner`} className="sr-only"><I18nText id="knowledge.add_notes_of_a_cluster_or_project" /></label>
                <Select
                  id={`${panelId}-owner`}
                  className="h-8 min-w-0 text-xs"
                  value=""
                  onChange={(event) => {
                    const owner = owners.find((item) => `${item.owner.kind}:${item.owner.id}` === event.target.value);
                    if (owner) void load(owner.owner);
                  }}
                  data-testid={`${testId}-owner`}
                >
                  <option value=""><I18nText id="knowledge.add_notes_of_a_cluster_or_project_335da1" /></option>
                  {owners.map((item) => (
                    <option key={`${item.owner.kind}:${item.owner.id}`} value={`${item.owner.kind}:${item.owner.id}`}>
                      {LEVEL_LABEL[item.level]} · {item.label}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>

          <div className="flex max-h-[min(20rem,38vh)] min-h-0 flex-col gap-2 overflow-y-auto pr-1" data-testid={`${testId}-scroll`}>
          {loading && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-testid={`${testId}-loading`}>
              <Loader2 className="size-3.5 animate-spin" aria-hidden />{" "}<I18nText id="knowledge.loading_notes" />{" "}</p>
          )}
          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger" role="alert" data-testid={`${testId}-error`}>
              {error}
            </p>
          )}
          {!loading && !error && documents.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
              {portfolio ? tr("common.no_company_notes_yet_add_notes_of_a") : tr("common.no_notes_are_in_this_project_s_scope")}
            </p>
          )}
          {!loading && documents.length > 0 && visible.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid={`${testId}-no-match`}><I18nText id="knowledge.no_notes_match_the_search" /></p>
          )}

          <div className="flex flex-col gap-2" data-testid={`${testId}-list`}>
            {grouped.map((group) => (
              <fieldset key={group.level} className="min-w-0" data-testid={`${testId}-group-${group.level}`}>
                <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{LEVEL_LABEL[group.level]}</legend>
                <ul className="flex flex-col gap-1">
                  {group.entries.map((entry) => {
                    const { document } = entry;
                    const checked = selected.has(document.id);
                    const rowId = `${panelId}-${document.id}`;
                    return (
                      <li key={document.id} className="rounded-md border px-2 py-1.5" data-testid={`${testId}-row`} data-document-id={document.id}>
                        <div className="flex items-start gap-2">
                          <input
                            id={rowId}
                            type="checkbox"
                            className="mt-0.5 size-4"
                            checked={checked}
                            disabled={!entry.eligible || grant != null || disabled}
                            onChange={() => toggle(entry)}
                            data-testid={`${testId}-check`}
                          />
                          <label htmlFor={rowId} className={cn("min-w-0 flex-1 text-xs", !entry.eligible && "text-muted-foreground")}>
                            <span className="block truncate font-medium">{document.title}</span>
                            <span className="block text-[11px] text-muted-foreground">
                              {entry.ownerLabel}{" "}<I18nText id="knowledge.rev" />{" "}{document.revision} · {formatBytes(document.byteLength)} · {new Date(document.updatedAt).toLocaleDateString(intlLocale())}
                            </span>
                            {entry.reason && (
                              <span className="block text-[11px] text-warning" data-testid={`${testId}-reason`}>
                                {REASON_LABEL[entry.reason] ?? tr("common.can_t_be_sent")}
                              </span>
                            )}
                          </label>
                        </div>
                        {checked && portfolio && entry.level !== "company" && (
                          <div className="mt-1.5 pl-6">
                            <label htmlFor={`${rowId}-purpose`} className="sr-only"><I18nText id="knowledge.why_is_this_note_needed" /></label>
                            <Input
                              id={`${rowId}-purpose`}
                              className="h-7 text-xs"
                              maxLength={KNOWLEDGE_CONTEXT_LIMITS.purposeChars}
                              placeholder={tr("knowledge.why_does_the_portfolio_manager_need_this_note")}
                              value={selected.get(document.id) ?? ""}
                              onChange={(event) => setPurpose(document.id, event.target.value)}
                              data-testid={`${testId}-purpose`}
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </div>
          {truncated && <p className="text-[11px] text-warning"><I18nText id="knowledge.only_the_first_notes_are_listed_use_search" /></p>}

          {issues.length > 0 && (
            <ul className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" role="alert" data-testid={`${testId}-issues`}>
              {issues.map((issue, index) => (
                <li key={`${issue.code}-${issue.documentId ?? index}`} data-code={issue.code}>{issue.message}</li>
              ))}
            </ul>
          )}

          {preview && (
            <div className="rounded-md border px-2 py-2 text-xs" data-testid={`${testId}-preview`}>
              <p className="font-medium"><I18nText id="knowledge.to_be_sent_to" />{" "}{preview.receiver.label}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {preview.items.map((item) => (
                  <li key={item.id} data-testid={`${testId}-preview-item`}>
                    <span className="font-medium">{item.title}</span>
                    <span className="text-muted-foreground">
                      {" "}· {LEVEL_LABEL[item.level]} · {item.ownerLabel}{" "}<I18nText id="knowledge.rev" />{" "}{item.revision} · {new Date(item.updatedAt).toLocaleString(intlLocale())} · {formatBytes(item.byteLength)}
                    </span>
                    {item.purpose && <span className="block text-[11px] text-muted-foreground"><I18nText id="knowledge.purpose" />{" "}{item.purpose}</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`${testId}-budget`}>
                {formatBytes(preview.totalBytes)}{" "}<I18nText id="common.of" />{" "}{formatBytes(preview.limits.totalBytes)} · {preview.items.length}{" "}<I18nText id="common.of" />{" "}{preview.limits.documents}{" "}<I18nText id="knowledge.notes" />{" "}{preview.tokenNote}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">{preview.note}</p>
            </div>
          )}

          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void runPreview()}
              disabled={selected.size === 0 || busy != null || grant != null || disabled}
              data-testid={`${testId}-preview-button`}
            >
              {busy === "preview" ? tr("common.checking") : tr("common.review_selected_notes")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
              onClick={() => void approve()}
              disabled={!preview?.canApprove || busy != null || disabled}
              data-testid={`${testId}-approve`}
            >
              {busy === "approve" ? tr("common.confirming") : tr("common.send_these_notes_with_my_next_message")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void showHistory()} data-testid={`${testId}-history-button`}><I18nText id="knowledge.earlier_sends" />{" "}</Button>
          </div>

          {history && (
            <ul className="text-[11px] text-muted-foreground" data-testid={`${testId}-history`}>
              {history.length === 0 && <li><I18nText id="knowledge.nothing_was_sent_yet" /></li>}
              {history.map((entry) => (
                <li key={entry.ref} data-status={entry.status}>
                  {new Date(entry.createdAt).toLocaleString(intlLocale())} · {codeLabel(entry.status)} · {entry.items.length}{" "}<I18nText id="common.note" />{entry.items.length === 1 ? "" : englishPluralSuffix()} ({entry.items.map((item) => `${item.title} r${item.revision}`).join(", ")})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
