import { codeLabel, staticLabel } from "@/i18n/presentation";

import { intlLocale, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError } from "@/lib/api";
import { knowledgeUrlTransform } from "@/lib/knowledge-markdown";
import { registerLeaveGuard } from "@/lib/leave-guard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { PageHeader } from "../PageHeader";
import { ExternalLink } from "../../kanban/md-components";
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CONTEXT_NOTE,
  KNOWLEDGE_CREDENTIAL_WARNING,
  KNOWLEDGE_INFRASTRUCTURE_NOTE,
  KNOWLEDGE_TEMPLATES,
  type KnowledgeDocument,
  type KnowledgeOwnerRef,
  type KnowledgeRevisionInfo,
  type KnowledgeScope,
} from "../../../../shared/knowledge/document.ts";
import { knowledgeImagePolicy, knowledgeLinkPolicy } from "../../../../shared/knowledge/markdown.ts";

interface Props {
  owner: KnowledgeOwnerRef;
  heading: string;
  contextNote: string;
  layout?: "page" | "embedded";
  onDirtyChange?: (dirty: boolean) => void;
}

interface Draft {
  id: string | null;
  title: string;
  description: string;
  category: string;
  tags: string;
  content: string;
  sensitive: boolean;
  revision: number | null;
  archivedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  byteLength: number;
}

const EMPTY: Draft = {
  id: null,
  title: "",
  description: "",
  category: "general",
  tags: "",
  content: "",
  sensitive: false,
  revision: null,
  archivedAt: null,
  createdAt: null,
  updatedAt: null,
  byteLength: 0,
};

function knowledgeErrorText(error: unknown): string {
  const message = error instanceof ApiError || error instanceof Error ? error.message : "";
  if (message.length > 0 && message.length < 300) return message;
  return tr("common.could_not_update_the_note");
}

function tagsFromInput(value: string): string[] {
  const tags: string[] = [];
  for (const part of value.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function snapshot(draft: Draft): string {
  return JSON.stringify({
    title: draft.title,
    description: draft.description,
    category: draft.category,
    tags: draft.tags,
    content: draft.content,
    sensitive: draft.sensitive,
  });
}

function draftFrom(document: KnowledgeDocument, content: string): Draft {
  return {
    id: document.id,
    title: document.title,
    description: document.description,
    category: document.category,
    tags: document.tags.join(", "),
    content,
    sensitive: document.sensitive,
    revision: document.revision,
    archivedAt: document.archivedAt,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    byteLength: document.byteLength,
  };
}

/**
 * Markdown notes for one owner. The same browser is the company library,
 * a cluster's Knowledge tab, and a project's Knowledge page.
 */
export function KnowledgeBrowser({ owner, heading, contextNote, layout = "page", onDirtyChange }: Props) {
  const { locale: uiLocale } = useUILocale();
  const confirm = useConfirm();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saved, setSaved] = useState(snapshot(EMPTY));
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<KnowledgeRevisionInfo[]>([]);
  const [scope, setScope] = useState<KnowledgeScope | null>(null);
  const [editing, setEditing] = useState(false);
  const requestRef = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = editing && snapshot(draft) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => registerLeaveGuard(() => (
    dirtyRef.current
      ? { title: tr("common.discard_unsaved_note_changes"), description: tr("common.the_markdown_in_the_editor_has_not_been") }
      : null
  )), []);
  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const text = query.trim();
      const listed = text
        ? (await api.searchKnowledge({
          q: text,
          owner,
          includeArchived,
          category: categoryFilter || undefined,
          tag: tagFilter || undefined,
          limit: 50,
        })).hits.map((hit) => hit.document)
        : (await api.listKnowledge(owner, {
          includeArchived,
          category: categoryFilter || undefined,
          tag: tagFilter || undefined,
        })).documents;
      if (requestId !== requestRef.current) return;
      setDocuments(listed);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(knowledgeErrorText(err));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [categoryFilter, includeArchived, owner, query, tagFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (owner.kind !== "project") {
      setScope(null);
      return;
    }
    let cancelled = false;
    void api.knowledgeScope(owner.id).then(
      (next) => { if (!cancelled) setScope(next); },
      () => { if (!cancelled) setScope(null); },
    );
    return () => { cancelled = true; };
  }, [owner.id, owner.kind]);

  const discardConfirmed = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return confirm(() => ({
      title: tr("common.discard_unsaved_note_changes"),
      description: tr("common.the_markdown_in_the_editor_has_not_been"),
      confirmLabel: tr("common.discard"),
      cancelLabel: tr("common.keep_editing"),
      variant: "destructive",
    }));
  }, [confirm]);

  const openDocument = useCallback(async (id: string) => {
    if (!(await discardConfirmed())) return;
    try {
      const [full, history] = await Promise.all([api.readKnowledge(id), api.knowledgeRevisions(id)]);
      const next = draftFrom(full, full.content);
      setDraft(next);
      setSaved(snapshot(next));
      setEditing(true);
      setRevisions(history.revisions);
      setConflict(null);
      setStatus(null);
      setError(null);
    } catch (err) {
      setError(knowledgeErrorText(err));
    }
  }, [discardConfirmed]);

  const startNew = useCallback(async () => {
    if (!(await discardConfirmed())) return;
    setDraft(EMPTY);
    setSaved(snapshot(EMPTY));
    setEditing(true);
    setRevisions([]);
    setConflict(null);
    setStatus(null);
    setMode("edit");
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }, [discardConfirmed]);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const tags = tagsFromInput(draft.tags);
      const body = {
        title: draft.title,
        description: draft.description,
        category: draft.category,
        tags,
        content: draft.content,
        sensitive: draft.sensitive,
      };
      const savedDocument = draft.id == null
        ? await api.createKnowledge({ ownerKind: owner.kind, ownerId: owner.id, ...body })
        : await api.updateKnowledge(draft.id, { expectedRevision: draft.revision ?? 0, ...body });
      const full = await api.readKnowledge(savedDocument.id);
      const next = draftFrom(full, full.content);
      setDraft(next);
      setSaved(snapshot(next));
      setEditing(true);
      setConflict(null);
      setStatus("Saved");
      setRevisions((await api.knowledgeRevisions(savedDocument.id)).revisions);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.message);
      else setError(knowledgeErrorText(err));
    } finally {
      setSaving(false);
    }
  }, [draft, load, owner.id, owner.kind]);

  const reloadSaved = useCallback(async () => {
    if (!draft.id) return;
    try {
      const full = await api.readKnowledge(draft.id);
      const next = draftFrom(full, full.content);
      setDraft(next);
      setSaved(snapshot(next));
      setConflict(null);
      setStatus("Reloaded the saved note");
    } catch (err) {
      setError(knowledgeErrorText(err));
    }
  }, [draft.id]);

  const archive = useCallback(async () => {
    if (!draft.id || draft.revision == null) return;
    if (dirtyRef.current) {
      const ok = await confirm(() => ({
        title: tr("common.discard_unsaved_note_changes"),
        description: tr("common.archiving_keeps_the_last_saved_markdown_and_drops"),
        confirmLabel: tr("common.discard_and_archive"),
        variant: "destructive",
      }));
      if (!ok) return;
    }
    const ok = await confirm(() => ({
      title: tr("common.archive_this_note"),
      description: tr("common.the_note_leaves_the_active_list_restore_brings"),
      confirmLabel: tr("common.archive_note"),
    }));
    if (!ok) return;
    try {
      const next = await api.archiveKnowledge(draft.id, draft.revision);
      const full = await api.readKnowledge(next.id);
      const archived = draftFrom(full, full.content);
      setDraft(archived);
      setSaved(snapshot(archived));
      setStatus("Archived");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.message);
      else setError(knowledgeErrorText(err));
    }
  }, [confirm, draft.id, draft.revision, load]);

  const restore = useCallback(async () => {
    if (!draft.id || draft.revision == null) return;
    try {
      const next = await api.restoreKnowledge(draft.id, draft.revision);
      const full = await api.readKnowledge(next.id);
      const restored = draftFrom(full, full.content);
      setDraft(restored);
      setSaved(snapshot(restored));
      setStatus("Restored");
      await load();
    } catch (err) {
      setError(knowledgeErrorText(err));
    }
  }, [draft.id, draft.revision, load]);

  const remove = useCallback(async () => {
    if (!draft.id || draft.revision == null) return;
    const ok = await confirm(() => ({
      title: tr("common.delete_this_note_permanently"),
      description: tr("common.the_saved_markdown_is_removed_from_forgeorbit_this"),
      confirmLabel: tr("common.delete_note"),
      variant: "destructive",
    }));
    if (!ok) return;
    try {
      await api.deleteKnowledge(draft.id, draft.revision);
      setDraft(EMPTY);
      setSaved(snapshot(EMPTY));
      setEditing(false);
      setRevisions([]);
      setStatus("Deleted");
      await load();
    } catch (err) {
      setError(knowledgeErrorText(err));
    }
  }, [confirm, draft.id, draft.revision, load]);

  const copyMarkdown = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft.content);
      setStatus("Copied Markdown");
    } catch {
      setError(tr("common.couldn_t_copy_markdown"));
    }
  }, [draft.content]);

  const exportMarkdown = useCallback(async () => {
    if (!draft.id) return;
    try {
      const exported = await api.exportKnowledge(draft.id);
      const url = URL.createObjectURL(new Blob([exported.markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(url);
      setStatus("Exported the saved note");
    } catch (err) {
      setError(knowledgeErrorText(err));
    }
  }, [draft.id]);

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-document-id]"));
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.findIndex((button) => button.getAttribute("data-document-id") === draft.id);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    const id = buttons[next]?.dataset.documentId;
    buttons[next]?.focus();
    if (id) void openDocument(id);
  };

  const onEditorKey = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  const applyTemplate = async (id: string) => {
    const template = KNOWLEDGE_TEMPLATES.find((item) => item.id === id);
    if (!template || template.id === "blank") return;
    if (draft.content.trim()) {
      const ok = await confirm(() => ({
        title: tr("common.replace_the_draft_with_this_template"),
        confirmLabel: tr("common.replace"),
        variant: "destructive",
      }));
      if (!ok) return;
    }
    setDraft((current) => ({
      ...current,
      title: current.title.trim() ? current.title : template.title,
      category: template.category,
      content: template.body,
    }));
    setEditing(true);
    setMode("edit");
  };

  const knownCategory = (KNOWLEDGE_CATEGORIES as readonly string[]).includes(draft.category);
  const scopeCounts = useMemo(() => {
    const counts = { company: 0, cluster: 0, project: 0 };
    for (const document of scope?.documents ?? []) counts[document.owner.kind] += 1;
    return counts;
  }, [scope, uiLocale]);

  return (
    <div
      className={cn("glass-surface flex min-w-0 flex-col overflow-x-hidden [container-type:inline-size] [container-name:knowledge]", layout === "page" ? "min-h-0 flex-1" : "min-h-[28rem]")}
      data-testid="knowledge-page"
      data-owner-kind={owner.kind}
      onKeyDown={onEditorKey}
    >
      {layout === "page" ? (
        <PageHeader
          title={heading}
          titleTestId="knowledge-heading"
          subtitle={staticLabel(contextNote)}
        >
          <Button type="button" size="sm" data-testid="knowledge-create" onClick={() => void startNew()}><I18nText id="knowledge.create_note" /></Button>
        </PageHeader>
      ) : null}
      <header className={cn("flex flex-col gap-3 px-4 sm:px-page", layout === "page" ? "pb-3" : "py-4")}>
        {layout !== "page" && (
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold tracking-tight" data-testid="knowledge-heading">{heading}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{staticLabel(contextNote)}</p>
          </div>
        )}
        {/* One notice block instead of two stacked ones: the credential rule stays prominent. */}
        <div className="space-y-1 rounded-lg border px-3 py-2 text-xs">
          <p className="text-warning" data-testid="knowledge-credential-warning">{staticLabel(KNOWLEDGE_CREDENTIAL_WARNING)}</p>
          <p className="text-muted-foreground" data-testid="knowledge-infrastructure-note">{staticLabel(KNOWLEDGE_INFRASTRUCTURE_NOTE)}</p>
        </div>
        {owner.kind === "project" && (
          <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-testid="knowledge-scope">
            <p>{scope?.note ?? KNOWLEDGE_CONTEXT_NOTE}</p>
            <p className="mt-1">
              {scope?.cluster
                ? tr("common.allowed_context_company_cluster_project", { p0: String(scopeCounts.company), p1: String(scopeCounts.cluster), p2: String(scopeCounts.project) })
                : tr("common.no_cluster_allowed_context_is_company_notes_and")}
            </p>
          </div>
        )}
      </header>
      <div className="knowledge-columns flex min-h-0 flex-1 flex-col gap-4 px-4 pb-6 sm:px-6">
        <aside className="knowledge-list-column flex w-full min-w-0 flex-col gap-2">
          {layout !== "page" && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" data-testid="knowledge-create" onClick={() => void startNew()}><I18nText id="knowledge.create_note" /></Button>
            </div>
          )}
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("knowledge.search_notes")}
            aria-label={tr("knowledge.search_notes")}
            data-testid="knowledge-search"
          />
          <div className="flex flex-wrap gap-2">
            <Select
              className="min-w-0 flex-1"
              aria-label={tr("knowledge.filter_by_category")}
              data-testid="knowledge-filter-category"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value=""><I18nText id="knowledge.all_categories" /></option>
              {KNOWLEDGE_CATEGORIES.map((category) => <option key={category} value={category}>{codeLabel(category)}</option>)}
            </Select>
            <Input
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              placeholder={tr("knowledge.tag")}
              aria-label={tr("knowledge.filter_by_tag")}
              data-testid="knowledge-filter-tag"
              className="w-28"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              data-testid="knowledge-show-archived"
            /><I18nText id="knowledge.show_archived" />{" "}</label>
          {loading && documents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="knowledge-loading"><I18nText id="knowledge.loading_notes" /></p>
          ) : documents.length === 0 && error ? (
            <EmptyState
              className="rounded-lg border px-2"
              testId="knowledge-unavailable"
              title={tr("m7.unavailable.notes.title")}
              description={tr("m7.unavailable.notes.description")}
            />
          ) : documents.length === 0 && (query.trim() !== "" || categoryFilter !== "" || tagFilter.trim() !== "") ? (
            <EmptyState
              className="rounded-lg border px-2"
              testId="knowledge-no-match"
              title={tr("m7.empty.knowledge.filtered_title")}
              description={tr("m7.empty.knowledge.filtered_description")}
              action={<Button type="button" size="sm" variant="outline" data-testid="knowledge-clear-filters" onClick={() => { setQuery(""); setCategoryFilter(""); setTagFilter(""); }}>{tr("m7.empty.tasks.clear")}</Button>}
            />
          ) : documents.length === 0 ? (
            <EmptyState
              className="rounded-lg border px-2"
              testId="knowledge-empty"
              title={tr("m7.empty.knowledge.title")}
              description={tr("m7.empty.knowledge.description")}
              action={<Button type="button" size="sm" data-testid="knowledge-empty-create" onClick={() => void startNew()}>{tr("m7.empty.knowledge.create")}</Button>}
            />
          ) : (
            <div role="listbox" aria-label={tr("common.notes")} className="knowledge-document-list flex max-h-80 flex-col gap-1 overflow-y-auto" onKeyDown={onListKey} data-testid="knowledge-list">
              {documents.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  role="option"
                  aria-selected={draft.id === document.id}
                  data-testid="knowledge-item"
                  data-document-id={document.id}
                  className={cn("glass-nav-item min-w-0 rounded-lg border px-2 py-2 text-left", draft.id === document.id && "glass-selected")}
                  onClick={() => void openDocument(document.id)}
                >
                  <span className="block truncate text-sm font-medium" title={document.title}>{document.title}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <span className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{document.category}</span>
                    {document.tags.map((tag) => (
                      <span key={tag} className="rounded border px-1 text-[10px] text-muted-foreground">{tag}</span>
                    ))}
                    {document.archivedAt != null && <span className="text-[10px] text-muted-foreground"><I18nText id="common.archived_bdb865" /></span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col gap-3" aria-label={tr("knowledge.note_editor")}>
          {!editing ? (
            <p className="text-sm text-muted-foreground"><I18nText id="knowledge.select_a_note_or_create_one_templates_stay" /></p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label={tr("knowledge.editor_or_preview")} className="flex rounded-lg border p-0.5">
                  <button type="button" role="tab" aria-selected={mode === "edit"} className={cn("glass-nav-item rounded-md px-2 py-1 text-xs", mode === "edit" && "glass-selected")} data-testid="knowledge-mode-edit" onClick={() => setMode("edit")}><I18nText id="common.edit" /></button>
                  <button type="button" role="tab" aria-selected={mode === "preview"} className={cn("glass-nav-item rounded-md px-2 py-1 text-xs", mode === "preview" && "glass-selected")} data-testid="knowledge-mode-preview" onClick={() => setMode("preview")}><I18nText id="common.preview" /></button>
                </div>
                <label className="min-w-0 text-xs">
                  <span className="sr-only"><I18nText id="knowledge.template" /></span>
                  <select className="h-8 rounded-md border border-input bg-transparent px-2 text-xs" data-testid="knowledge-template" value="" onChange={(event) => { const id = event.target.value; event.target.value = ""; void applyTemplate(id); }}>
                    <option value=""><I18nText id="knowledge.template_a203d0" /></option>
                    {KNOWLEDGE_TEMPLATES.filter((item) => item.id !== "blank").map((item) => <option key={item.id} value={item.id}>{staticLabel(item.label)}</option>)}
                  </select>
                </label>
              </div>
              {mode === "preview" ? (
                <KnowledgeMarkdown text={draft.content} />
              ) : (
                <div className="flex flex-col gap-2">
                  <Input ref={titleRef} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder={tr("common.title")} aria-label={tr("common.title")} data-testid="knowledge-title" />
                  <Input value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder={tr("common.description")} aria-label={tr("common.description")} data-testid="knowledge-description" />
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                      aria-label={tr("common.category")}
                      data-testid="knowledge-category"
                      value={knownCategory ? draft.category : "other"}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => ({ ...current, category: value === "other" ? "" : value }));
                      }}
                    >
                      {KNOWLEDGE_CATEGORIES.map((category) => <option key={category} value={category}>{codeLabel(category)}</option>)}
                      <option value="other"><I18nText id="common.other" /></option>
                    </select>
                    {!knownCategory && (
                      <Input
                        value={draft.category}
                        onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
                        placeholder="custom-category"
                        aria-label={tr("knowledge.custom_category_315f56")}
                        data-testid="knowledge-category-custom"
                        className="w-40"
                      />
                    )}
                    <Input
                      value={draft.tags}
                      onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
                      placeholder={tr("knowledge.tags_separated_by_commas")}
                      aria-label={tr("knowledge.tags")}
                      data-testid="knowledge-tags"
                      className="min-w-0 flex-1"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={draft.sensitive} onChange={(event) => setDraft((current) => ({ ...current, sensitive: event.target.checked }))} data-testid="knowledge-sensitive" /><I18nText id="knowledge.sensitive_hide_search_excerpts_this_does_not_make" />{" "}</label>
                  <textarea
                    value={draft.content}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                    aria-label={tr("knowledge.markdown")}
                    data-testid="knowledge-body"
                    className="max-h-[50vh] min-h-48 w-full resize-y overflow-auto rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" data-testid="knowledge-save" disabled={saving || draft.archivedAt != null} onClick={() => void save()}><I18nText id="common.save" /></Button>
                <Button type="button" size="sm" variant="outline" data-testid="knowledge-copy" onClick={() => void copyMarkdown()}><I18nText id="knowledge.copy_markdown" /></Button>
                <Button type="button" size="sm" variant="outline" data-testid="knowledge-export" disabled={!draft.id} onClick={() => void exportMarkdown()}><I18nText id="knowledge.export_markdown" /></Button>
                {draft.archivedAt == null ? (
                  <Button type="button" size="sm" variant="outline" data-testid="knowledge-archive" disabled={!draft.id} onClick={() => void archive()}><I18nText id="common.archive" /></Button>
                ) : (
                  <>
                    <Button type="button" size="sm" variant="outline" data-testid="knowledge-restore" onClick={() => void restore()}><I18nText id="common.restore" /></Button>
                    <Button type="button" size="sm" variant="outline" data-testid="knowledge-delete" onClick={() => void remove()}><I18nText id="common.delete" /></Button>
                  </>
                )}
              </div>
              {draft.id && (
                <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground" data-testid="knowledge-details">
                  <p className="break-all"><I18nText id="common.owner" />{" "}{draft.id ? `${owner.kind}` : ""}{" "}<I18nText id="common.revision" />{" "}<span data-testid="knowledge-revision">{draft.revision}</span></p>
                  <p className="break-all"><I18nText id="knowledge.id" />{" "}{draft.id}</p>
                  <p><I18nText id="common.created" />{" "}{draft.createdAt ? new Date(draft.createdAt).toLocaleString(intlLocale()) : "—"}{" "}<I18nText id="knowledge.updated" />{" "}{draft.updatedAt ? new Date(draft.updatedAt).toLocaleString(intlLocale()) : "—"} · {draft.byteLength}{" "}<I18nText id="knowledge.bytes" /></p>
                  <p><I18nText id="knowledge.stored_by_forgeorbit_a_note_does_not_point" /></p>
                  {revisions.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {revisions.map((revision) => (
                        <button
                          key={revision.revision}
                          type="button"
                          className="glass-nav-item rounded border px-1.5 py-0.5"
                          onClick={() => {
                            void api.readKnowledge(draft.id!, revision.revision).then((full) => {
                              setMode("preview");
                              setDraft((current) => ({ ...current, content: full.content }));
                              setStatus(`Showing revision ${revision.revision}. Save stores it as a new revision.`);
                            }).catch((err: unknown) => setError(knowledgeErrorText(err)));
                          }}
                        ><I18nText id="knowledge.r" />{revision.revision}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {conflict && (
            <div role="alert" className="rounded-lg border px-3 py-2 text-sm text-warning" data-testid="knowledge-conflict">
              <p>{conflict}</p>
              <Button type="button" size="sm" variant="outline" className="mt-2" data-testid="knowledge-reload" onClick={() => void reloadSaved()}><I18nText id="knowledge.reload_saved_note" /></Button>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive" data-testid="knowledge-error">{error}</p>}
          {status && <p role="status" className="text-sm text-muted-foreground" data-testid="knowledge-status">{status}</p>}
        </section>
      </div>
    </div>
  );
}

function KnowledgeMarkdown({ text }: { text: string }) {
  useUILocale();
  if (!text.trim()) return <p className="text-sm text-muted-foreground" data-testid="knowledge-preview"><I18nText id="knowledge.nothing_to_preview" /></p>;
  return (
    <div className="agetor-md max-h-[50vh] overflow-auto rounded-lg border p-3 text-sm" data-testid="knowledge-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={knowledgeUrlTransform}
        components={{
          a: ({ href, children }) => (
            knowledgeLinkPolicy(href ?? "") === "external"
              ? <ExternalLink href={href}>{children}</ExternalLink>
              : <span data-testid="knowledge-link-blocked">{children}</span>
          ),
          img: ({ src, alt }) => <KnowledgeImage src={typeof src === "string" ? src : ""} alt={typeof alt === "string" ? alt : ""} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function KnowledgeImage({ src, alt }: { src: string; alt: string }) {
  useUILocale();
  const [shown, setShown] = useState(false);
  if (knowledgeImagePolicy(src) !== "remote") {
    return <span data-testid="knowledge-image-blocked" className="text-xs text-muted-foreground">{alt || tr("common.image_omitted")}</span>;
  }
  if (!shown) {
    return (
      <button type="button" className="glass-nav-item rounded border px-2 py-1 text-xs" data-testid="knowledge-image-remote" onClick={() => setShown(true)}><I18nText id="knowledge.show_image" />{alt ? `: ${alt}` : ""}
      </button>
    );
  }
  return <img alt={alt} src={src} className="max-h-96 max-w-full" />;
}
