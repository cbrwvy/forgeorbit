import { brainKindText, brainOriginText } from "@/lib/status-presenters";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { intlLocale, t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "../PageHeader";
import type { BrainKind, BrainMemory, BrainMemorySummary, BrainScopeKind } from "../../../../shared/brain/document.ts";
import type { BrainExtractionCandidate } from "../../../../shared/brain/extraction.ts";
import type { EmbeddingEngineStatus, RelatedMemoryItem, SearchMode, SemanticSearchResult } from "../../../../shared/brain/embeddings.ts";
import { en } from "@/i18n/en";

interface Props {
  scope: { kind: "company" } | { kind: "project"; projectPath: string };
  heading: string;
}

const KINDS: BrainKind[] = ["decision", "fact", "observation"];
const SEARCH_MODES: SearchMode[] = ["hybrid", "semantic", "lexical"];

function errorText(error: unknown): string {
  const code = error instanceof ApiError && error.body && typeof error.body === "object" && "code" in error.body
    ? String((error.body as { code?: unknown }).code ?? "")
    : "";
  const key = `brain.error.${code}`;
  if (code && Object.hasOwn(en, key)) return tr(key as TranslationKey);
  return tr("brain.error.generic");
}

function scopeLabel(kind: BrainScopeKind): string {
  return tr(kind === "company" ? "brain.scope.company" : "brain.scope.project");
}

const originLabel = brainOriginText;

type BrainListRow = {
  id: string;
  title: string;
  kind: BrainKind;
  scope: { kind: BrainScopeKind };
  origin: string;
};

function listRowFromSummary(memory: BrainMemorySummary): BrainListRow {
  return { id: memory.id, title: memory.title, kind: memory.kind, scope: { kind: memory.scope.kind }, origin: memory.origin };
}

function listRowFromSearch(item: SemanticSearchResult): BrainListRow {
  return { id: item.id, title: item.title, kind: item.kind, scope: { kind: item.scopeKind }, origin: item.provenanceSource };
}

export function BrainBrowser({ scope, heading }: Props) {
  useUILocale();
  const [activeTab, setActiveTab] = useState<"memories" | "candidates">("memories");
  const [query, setQuery] = useState("");
  const [draftQuery, setDraftQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [showArchived, setShowArchived] = useState(false);
  const [inheritCompany, setInheritCompany] = useState(false);
  const [memories, setMemories] = useState<BrainListRow[]>([]);
  const [searchResults, setSearchResults] = useState<SemanticSearchResult[] | null>(null);
  const [servedMode, setServedMode] = useState<SearchMode | null>(null);
  const [candidates, setCandidates] = useState<BrainExtractionCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<BrainExtractionCandidate | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingEngineStatus | null>(null);
  const [relatedMemories, setRelatedMemories] = useState<RelatedMemoryItem[]>([]);
  const [issues, setIssues] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<BrainMemory | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BrainKind>("decision");
  const [content, setContent] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
    setListError("");
    try {
      const [page, status, embStatus, candList] = await Promise.all([
        query
          ? api.searchBrainSemantic({
              scopeKind: scope.kind,
              projectPath: scope.kind === "project" ? scope.projectPath : undefined,
              q: query,
              mode: searchMode,
              status: showArchived ? "archived" : "active",
              inheritCompany: scope.kind === "project" && inheritCompany && !showArchived,
            }).then((res) => ({ memories: res.results.map(listRowFromSearch), truncated: false, results: res.results, mode: res.mode }))
          : api.listBrain({
              scopeKind: scope.kind,
              projectPath: scope.kind === "project" ? scope.projectPath : undefined,
              status: showArchived ? "archived" : "active",
              inheritCompany: scope.kind === "project" && inheritCompany && !showArchived,
            }).then((res) => ({ memories: res.memories.map(listRowFromSummary), truncated: res.truncated, results: null, mode: null })),
        api.brainStatus(),
        api.brainEmbeddingStatus().catch(() => null),
        api.listBrainCandidates({
          scopeKind: scope.kind,
          projectPath: scope.kind === "project" ? scope.projectPath : undefined,
          status: "candidate",
        }).catch(() => ({ candidates: [] })),
      ]);

      setMemories(page.memories);
      setSearchResults(page.results);
      setServedMode(page.mode);
      setIssues(status.counts.issues);
      setEmbeddingStatus(embStatus);
      setCandidates(candList.candidates);
      setPhase("ready");
    } catch (error) {
      setPhase("error");
      setListError(errorText(error));
    }
  }, [inheritCompany, query, scope, searchMode, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  function startNew() {
    setSelected(null);
    setSelectedCandidate(null);
    setTitle("");
    setKind("decision");
    setContent("");
    setFormError("");
    setConfirmArchive(false);
    setRelatedMemories([]);
  }

  async function openMemory(id: string) {
    setBusy(true);
    setFormError("");
    setConfirmArchive(false);
    try {
      const [memory, related] = await Promise.all([
        api.readBrain(id),
        api.brainRelated(id).catch(() => ({ related: [] })),
      ]);
      setSelected(memory);
      setSelectedCandidate(null);
      setTitle(memory.title);
      setKind(memory.kind);
      setContent(memory.content);
      setRelatedMemories(related.related);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function selectCandidate(candidate: BrainExtractionCandidate) {
    setSelected(null);
    setSelectedCandidate(candidate);
    setTitle(candidate.title);
    setKind(candidate.kind);
    setContent(candidate.content);
    setFormError("");
  }

  async function save() {
    setBusy(true);
    setFormError("");
    try {
      const memory = selected
        ? await api.updateBrain(selected.id, { expectedRevision: selected.revision, title, kind, content })
        : await api.createBrain({
            scopeKind: scope.kind,
            projectPath: scope.kind === "project" ? scope.projectPath : undefined,
            title,
            kind,
            content,
            requestId: newRequestId(),
          });
      setSelected(memory);
      setTitle(memory.title);
      setKind(memory.kind);
      setContent(memory.content);
      await load();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!selected) return;
    setBusy(true);
    setFormError("");
    try {
      const memory = await api.archiveBrain(selected.id, selected.revision);
      setSelected(memory);
      setConfirmArchive(false);
      await load();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function approveCandidate() {
    if (!selectedCandidate) return;
    setBusy(true);
    setFormError("");
    try {
      const res = await api.approveBrainCandidate(selectedCandidate.id, {
        title,
        kind,
        content,
      });
      setSelectedCandidate(null);
      setSelected(res.memory);
      setTitle(res.memory.title);
      setKind(res.memory.kind);
      setContent(res.memory.content);
      await load();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function rejectCandidate() {
    if (!selectedCandidate) return;
    setBusy(true);
    setFormError("");
    try {
      await api.rejectBrainCandidate(selectedCandidate.id);
      startNew();
      await load();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function triggerRebuild() {
    setRebuilding(true);
    setRebuildNote("");
    try {
      const result = await api.rebuildBrainEmbeddings();
      await load();
      if (result.failed > 0) setFormError(tr("brain.error.generic"));
      else setRebuildNote(tr("brain.rebuild_success", { embedded: String(result.embedded) }));
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setRebuilding(false);
    }
  }

  const archived = selected?.status === "archived";
  const locale = intlLocale();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="brain-page">
      <PageHeader
        title={heading}
        subtitle={tr("brain.subtitle")}
        titleTestId="brain-heading"
      />
      <div className="flex items-center gap-4 px-4 pt-1 sm:px-page">
        <div className="flex rounded-lg border bg-muted/30 p-1">
          <button
            type="button"
            className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              activeTab === "memories" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => { setActiveTab("memories"); startNew(); }}
          >
            {tr("brain.tab.memories")}
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors ${
              activeTab === "candidates" ? "bg-background shadow-xs text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => { setActiveTab("candidates"); startNew(); }}
            data-testid="brain-tab-candidates"
          >
            {tr("brain.tab.candidates")}
            {candidates.length > 0 && (
              <span className="rounded-full bg-primary/20 px-1.5 py-0.2 text-xs font-semibold text-primary">
                {candidates.length}
              </span>
            )}
          </button>
        </div>

        {embeddingStatus && (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="brain-embedding-status" >
              {embeddingStatus.engine === "transformers-local" || embeddingStatus.engine === "test-mock"
                ? tr("brain.index.simple", {
                    percent: embeddingStatus.coveragePercent,
                    indexed: embeddingStatus.indexedCount,
                    total: embeddingStatus.activeCount,
                  })
                : tr("brain.embedding_unavailable", { engine: embeddingStatus.engine })}
            </span>
            <TechnicalDetails
              summary={tr("brain.index.technical")}
              testId="brain-embedding-technical"
              rows={[
                { label: "engine", value: embeddingStatus.engine },
                { label: "model", value: embeddingStatus.model },
                { label: "dimension", value: String(embeddingStatus.dimension) },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={rebuilding}
              onClick={() => void triggerRebuild()}
              className="h-6 px-2 text-xs"
            >
              {rebuilding ? tr("brain.rebuilding") : tr("brain.rebuild_index")}
            </Button>
            {rebuildNote && <span data-testid="brain-rebuild-note">{rebuildNote}</span>}
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-6 pt-3 sm:px-page lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-3">
          <p className="text-sm text-muted-foreground" data-testid="brain-scope-note">
            {scope.kind === "company" ? tr("brain.company_note") : tr("brain.project_note")}
          </p>

          {activeTab === "memories" && (
            <>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setQuery(draftQuery.trim());
                }}
              >
                <Input
                  value={draftQuery}
                  onChange={(event) => setDraftQuery(event.target.value)}
                  placeholder={tr("brain.search_placeholder")}
                  aria-label={tr("brain.search_placeholder")}
                  data-testid="brain-search"
                />
                <Button type="submit" variant="outline" size="sm">{tr("brain.search")}</Button>
              </form>

              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{tr("brain.search_mode")}:</span>
                  <Select
                    value={searchMode}
                    onChange={(e) => setSearchMode(e.target.value as SearchMode)}
                    className="h-7 text-xs"
                    aria-label={tr("brain.search_mode")}
                  >
                    {SEARCH_MODES.map((m) => (
                      <option key={m} value={m}>{tr(`brain.search_mode.${m}`)}</option>
                    ))}
                  </Select>
                </label>
                {servedMode === "lexical" && searchMode !== "lexical" && (
                  <span className="text-xs text-warning" data-testid="brain-search-served-mode">
                    {tr("brain.search_served_lexical")}
                  </span>
                )}
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    data-testid="brain-show-archived"
                    onChange={(event) => { setShowArchived(event.target.checked); setInheritCompany(false); }}
                  />
                  {tr("brain.show_archived")}
                </label>
                {scope.kind === "project" && !showArchived && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={inheritCompany}
                      data-testid="brain-inherit"
                      onChange={(event) => setInheritCompany(event.target.checked)}
                    />
                    {tr("brain.inherit_company")}
                  </label>
                )}
              </div>

              {scope.kind === "project" && inheritCompany && !showArchived && (
                <p className="text-xs text-muted-foreground">{tr("brain.inherit_note")}</p>
              )}
              <p className="text-xs text-muted-foreground" data-testid="brain-integrity">
                {issues === 0 ? tr("brain.integrity_ok") : tr("brain.integrity_issues", { count: issues })}
              </p>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">{showArchived ? tr("brain.status.archived") : tr("brain.status.active")}</h2>
                <Button type="button" size="sm" variant="outline" onClick={startNew} data-testid="brain-new">{tr("brain.create")}</Button>
              </div>

              {phase === "loading" && <p className="text-sm text-muted-foreground" data-testid="brain-loading">{tr("brain.loading")}</p>}
              {phase === "error" && (
                <div className="rounded-md border border-destructive/40 p-3 text-sm" data-testid="brain-error">
                  <p>{listError}</p>
                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void load()}>{tr("brain.search")}</Button>
                </div>
              )}
              {phase === "ready" && memories.length === 0 && (
                <p className="text-sm text-muted-foreground" data-testid="brain-empty">{query ? tr("brain.empty_search") : tr("brain.empty")}</p>
              )}
              {phase === "ready" && memories.length > 0 && (
                <ul className="flex flex-col gap-1" data-testid="brain-list">
                  {memories.map((memory) => {
                    const searchItem = searchResults?.find((r) => r.id === memory.id);
                    return (
                      <li key={memory.id}>
                        <button
                          type="button"
                          className="w-full rounded-md border px-3 py-2 text-left hover:bg-accent transition-colors"
                          data-testid="brain-memory"
                          data-memory-id={memory.id}
                          onClick={() => void openMemory(memory.id)}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="block text-sm font-medium truncate">{memory.title}</span>
                            {searchItem && searchItem.semanticScore > 0 && (
                              <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                                {Math.round(searchItem.score * 100)}%
                              </span>
                            )}
                          </div>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {tr(`brain.kind.${memory.kind}`)} · {scopeLabel(memory.scope.kind)} · {originLabel(memory.origin)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {activeTab === "candidates" && (
            <>
              <h2 className="text-sm font-medium">{tr("brain.tab.candidates")}</h2>
              {candidates.length === 0 && (
                <p className="text-sm text-muted-foreground">{tr("brain.candidate.empty")}</p>
              )}
              {candidates.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {candidates.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`w-full rounded-md border p-2.5 text-left transition-colors ${
                          selectedCandidate?.id === c.id ? "bg-accent border-primary/50" : "hover:bg-accent"
                        }`}
                        onClick={() => selectCandidate(c)}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-sm font-medium truncate">{c.title}</span>
                          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                            {Math.round(c.confidence * 100)}%
                          </span>
                        </div>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {c.sourceEventKind} · {c.quality.relationship}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="min-w-0 rounded-xl border p-4" data-testid="brain-editor">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              {selectedCandidate
                ? tr("brain.candidate.edit")
                : selected
                  ? selected.title
                  : tr("brain.create")}
            </h2>
            {(selected || selectedCandidate) && (
              <Button type="button" size="sm" variant="ghost" onClick={startNew}>{tr("brain.back")}</Button>
            )}
          </div>

          {selectedCandidate && (
            <div className="mb-4 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <div className="grid grid-cols-2 gap-2">
                <div><span>{tr("brain.candidate.event", { event: selectedCandidate.sourceEventKind })}</span></div>
                <div><span>{tr("brain.candidate.confidence", { score: Math.round(selectedCandidate.confidence * 100) })}</span></div>
                <div className="col-span-2">
                  <span>{tr("m0.sourceIds", { ids: selectedCandidate.sourceRecordIds.join(", ") })}</span>
                </div>
                {selectedCandidate.supersedesMemoryId && (
                  <div className="col-span-2 text-primary">
                    <span>{tr("brain.supersedes", { id: selectedCandidate.supersedesMemoryId })}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {selected && (
            <dl className="mb-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground" data-testid="brain-provenance">
              <div><dt>{tr("brain.scope")}</dt><dd data-testid="brain-scope">{scopeLabel(selected.scope.kind)}</dd></div>
              <div><dt>{tr("brain.origin")}</dt><dd data-testid="brain-origin">{originLabel(selected.origin)}</dd></div>
              <div><dt>{tr("brain.revision")}</dt><dd>{selected.revision}</dd></div>
              <div><dt>{tr("brain.status.active")}</dt><dd>{tr(selected.status === "archived" ? "brain.status.archived" : "brain.status.active")}</dd></div>
              <div><dt>{tr("brain.created")}</dt><dd>{new Date(selected.createdAt).toLocaleString(locale)}</dd></div>
              <div><dt>{tr("brain.updated")}</dt><dd>{new Date(selected.updatedAt).toLocaleString(locale)}</dd></div>
            </dl>
          )}

          <p className="mb-3 text-xs text-muted-foreground" data-testid="brain-data-notice">
            {selected?.provenance.note ?? tr("brain.not_instructions")}
          </p>

          <label className="mb-2 block text-sm">
            <span className="mb-1 block">{tr("brain.title_label")}</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={archived || busy}
              data-testid="brain-title"
              aria-label={tr("brain.title_label")}
            />
          </label>
          <label className="mb-2 block text-sm">
            <span className="mb-1 block">{tr("brain.kind_label")}</span>
            <Select
              value={kind}
              onChange={(event) => setKind(event.target.value as BrainKind)}
              disabled={archived || busy}
              data-testid="brain-kind"
              aria-label={tr("brain.kind_label")}
            >
              {KINDS.map((item) => (
                <option key={item} value={item}>{tr(`brain.kind.${item}`)}</option>
              ))}
            </Select>
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block">{tr("brain.content_label")}</span>
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={archived || busy}
              className="min-h-40"
              data-testid="brain-content"
              aria-label={tr("brain.content_label")}
            />
          </label>

          {formError && <p className="mb-3 text-sm text-destructive" data-testid="brain-form-error">{formError}</p>}

          <div className="flex flex-wrap gap-2">
            {selectedCandidate ? (
              <>
                <Button type="button" size="sm" disabled={busy} onClick={() => void approveCandidate()}>
                  {tr("brain.candidate.approve")}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void rejectCandidate()}>
                  {tr("brain.candidate.reject")}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" size="sm" disabled={archived || busy} onClick={() => void save()} data-testid="brain-save">
                  {tr("brain.save")}
                </Button>
                {selected && !archived && !confirmArchive && (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmArchive(true)} data-testid="brain-archive">
                    {tr("brain.archive")}
                  </Button>
                )}
                {selected && !archived && confirmArchive && (
                  <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void archive()} data-testid="brain-archive-confirm">
                    {tr("brain.confirm_archive")}
                  </Button>
                )}
              </>
            )}
          </div>

          {relatedMemories.length > 0 && (
            <div className="mt-6 border-t pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                {tr("brain.related_memories")}
              </h3>
              <ul className="flex flex-col gap-1 text-xs">
                {relatedMemories.map((rel) => (
                  <li key={rel.id} className="flex items-center justify-between rounded p-1.5 hover:bg-muted/50">
                    <button
                      type="button"
                      className="text-left font-medium hover:underline text-foreground"
                      onClick={() => void openMemory(rel.id)}
                    >
                      {brainKindText(rel.kind)}: {rel.title}
                    </button>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {Math.round(rel.similarity * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
