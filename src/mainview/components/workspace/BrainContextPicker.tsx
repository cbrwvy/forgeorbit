import { brainOriginText } from "@/lib/status-presenters";
import { t as tr } from "@/i18n/core";
import { I18nText } from "@/i18n/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Brain, ChevronDown, Loader2, ShieldCheck, X } from "lucide-react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  BRAIN_CONTEXT_LIMITS,
  type BrainContextAccess,
  type BrainContextGrant,
  type BrainContextIssue,
  type BrainContextMode,
  type BrainContextPreview,
  type BrainContextTarget,
  type BrainEligibleMemory,
  type BrainTransmission,
} from "../../../shared/brain/context.ts";

export interface ApprovedBrain {
  grantId: string;
  expiresAt: number;
  preview: BrainContextPreview;
}

interface Props {
  target: BrainContextTarget;
  grant: ApprovedBrain | null;
  onGrantChange: (grant: ApprovedBrain | null) => void;
  disabled?: boolean;
  testId: string;
  allowedProjectPaths?: readonly string[];
}

const PM_MODES: BrainContextMode[] = ["project", "project-company", "company"];
const HEAD_MODES: BrainContextMode[] = ["company", "projects"];

/** Head scoped to one registered project starts on that project's memories. */
export function initialBrainSelection(portfolio: boolean, allowedProjectPaths?: readonly string[]): { mode: BrainContextMode; projectPaths: string[] } {
  if (!portfolio) return { mode: "project", projectPaths: [] };
  const only = allowedProjectPaths?.length === 1 ? allowedProjectPaths[0] : "";
  if (only) return { mode: "projects", projectPaths: [only] };
  return { mode: "company", projectPaths: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesOf(error: unknown): BrainContextIssue[] {
  if (!(error instanceof ApiError)) return [];
  const issues = (error.body as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as BrainContextIssue[]) : [];
}

function modeLabel(mode: BrainContextMode): string {
  if (mode === "company") return tr("brain.context.mode.company");
  if (mode === "project") return tr("brain.context.mode.project");
  if (mode === "project-company") return tr("brain.context.mode.project_company");
  return tr("brain.context.mode.projects");
}

function kindLabel(kind: string): string {
  if (kind === "decision") return tr("brain.context.kind.decision");
  if (kind === "observation") return tr("brain.context.kind.observation");
  return tr("brain.context.kind.fact");
}

export function BrainContextPreviewBody({ preview, testId }: { preview: BrainContextPreview; testId: string }) {
  return (
    <div className="rounded-md border px-2 py-1.5" data-testid={`${testId}-preview`}>
      <p className="text-[11px] font-medium"><I18nText id="brain.context.preview_heading" /></p>
      <p className="text-[11px] text-muted-foreground" data-testid={`${testId}-preview-size`}>
        {tr("brain.context.count", { count: preview.count })}
        {" · "}
        {tr("brain.context.size", { chars: preview.totalChars })}
        {" · "}
        {tr("brain.context.digest")} {preview.digest.slice(0, 12)}
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {preview.items.map((item) => (
          <li key={item.id} className="text-[11px]" data-testid={`${testId}-preview-row`} data-memory-id={item.id}>
            <span className="font-medium">{item.title}</span>
            {" · "}
            {item.scope.kind === "company" ? tr("brain.context.scope.company") : tr("brain.context.scope.project")}
            {" · "}
            {item.scopeLabel}
            {" · "}
            {kindLabel(item.kind)}
            {" · "}
            {tr("brain.context.origin")} {brainOriginText(item.origin)}
            {" · "}
            {tr("brain.context.revision")} {item.revision}
            {" · "}
            {item.active ? tr("brain.context.active") : ""}
            {item.valid ? ` · ${tr("brain.context.data_only")}` : ""}
            <span className="mt-0.5 block whitespace-pre-wrap text-muted-foreground">{item.excerpt}</span>
          </li>
        ))}
      </ul>
      {preview.issues.length > 0 && (
        <ul className="mt-1 text-[11px] text-warning" data-testid={`${testId}-preview-issues`}>
          {preview.issues.map((issue) => <li key={`${issue.code}-${issue.memoryId}`}>{issue.message}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Chooses Brain records for one manager message. Browsing and previewing
 * send nothing. Only the confirm button creates a one-message permission.
 */
export function BrainContextPicker({ target, grant, onGrantChange, disabled, testId, allowedProjectPaths }: Props) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const portfolio = target.kind === "portfolio";
  const initial = initialBrainSelection(portfolio, allowedProjectPaths);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BrainContextMode>(initial.mode);
  const [projectPaths, setProjectPaths] = useState<string[]>(initial.projectPaths);
  const [inheritCompany, setInheritCompany] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<{ key: string; memories: BrainEligibleMemory[] } | null>(null);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<BrainContextPreview | null>(null);
  const [issues, setIssues] = useState<BrainContextIssue[]>([]);
  const [busy, setBusy] = useState<"preview" | "approve" | "revoke" | null>(null);
  const [history, setHistory] = useState<BrainTransmission[] | null>(null);
  const targetKey = target.kind === "project" ? target.projectPath : "portfolio";
  const pathsKey = JSON.stringify(projectPaths);
  const text = query.trim();
  const access: BrainContextAccess = mode === "projects"
    ? { mode, projectPaths, inheritCompany }
    : { mode, projectPaths: [], inheritCompany: mode === "company" || mode === "project-company" };
  const listKey = JSON.stringify([targetKey, mode, pathsKey, inheritCompany, text]);
  const memories = listing?.key === listKey ? listing.memories : [];
  const loading = open && listing?.key !== listKey;

  useEffect(() => {
    if (!open) return;
    let current = true;
    const emptyProjects = mode === "projects" && projectPaths.length === 0;
    const lookup: BrainContextAccess = emptyProjects
      ? { mode: "company", projectPaths: [], inheritCompany: true }
      : access;
    setError(null);
    const timer = setTimeout(() => {
      void api.brainContextEligible(target, lookup, emptyProjects ? "" : text).then((result) => {
        if (!current) return;
        const fresh = emptyProjects ? [] : result.memories;
        setProjects(result.availableProjects);
        setListing({ key: listKey, memories: fresh });
        setSelected((previous) => new Set([...previous].filter((id) => fresh.some((item) => item.id === id))));
      }, (caught) => {
        if (!current) return;
        setListing({ key: listKey, memories: [] });
        setSelected(new Set());
        setError(messageOf(caught));
      });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
    // The key captures every field of the target, access, and search used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listKey]);

  const resetSelection = () => {
    setPreview(null);
    setIssues([]);
    setSelected(new Set());
  };

  const toggleProject = (path: string) => {
    resetSelection();
    setProjectPaths((current) => {
      if (current.includes(path)) return current.filter((item) => item !== path);
      if (current.length >= BRAIN_CONTEXT_LIMITS.projects) return current;
      return [...current, path];
    });
  };

  const toggleMemory = (id: string) => {
    setPreview(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < BRAIN_CONTEXT_LIMITS.memories) next.add(id);
      return next;
    });
  };

  const runPreview = async () => {
    if (loading || selected.size === 0) return;
    setBusy("preview");
    setError(null);
    try {
      const result = await api.brainContextPreview(
        target,
        access,
        memories.filter((item) => selected.has(item.id)).map(({ id, revision, sha256 }) => ({ id, revision, sha256 })),
      );
      setPreview(result);
      setIssues(result.issues);
    } catch (caught) {
      setPreview(null);
      setIssues(issuesOf(caught));
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!preview?.canApprove) return;
    setBusy("approve");
    setError(null);
    try {
      const result: BrainContextGrant = await api.brainContextApprove(
        target,
        access,
        preview.items.map((item) => ({ id: item.id, revision: item.revision, sha256: item.sha256 })),
        preview.previewKey,
      );
      onGrantChange({ grantId: result.grantId, expiresAt: result.expiresAt, preview: result.preview });
      setOpen(false);
      resetSelection();
      toggleRef.current?.focus();
    } catch (caught) {
      setPreview(null);
      setIssues(issuesOf(caught));
      setError(messageOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!grant) return;
    setBusy("revoke");
    try {
      await api.brainContextRevoke(target, grant.grantId);
    } catch {
      /* the permission also expires on its own */
    } finally {
      setBusy(null);
      onGrantChange(null);
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
    ? tr("brain.context.approved", { count: grant.preview.count })
    : selected.size > 0
      ? tr("brain.context.selected", { count: selected.size })
      : tr("brain.context.off");
  const modes = portfolio ? (allowedProjectPaths?.length === 0 ? ["company"] as const : HEAD_MODES) : PM_MODES;
  const selectableProjects = allowedProjectPaths ? projects.filter((project) => allowedProjectPaths.includes(project.path)) : projects;
  const visibleHistory = history?.filter((entry) =>
    !allowedProjectPaths || entry.items.every((item) => item.scope.kind === "company" || allowedProjectPaths.includes(item.scope.id)));
  const controlsDisabled = busy != null || grant != null || disabled;

  return (
    <section
      className="surface-solid rounded-lg border px-3 py-2"
      aria-label={tr("brain.context.title")}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          ref={toggleRef}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          disabled={disabled}
          data-testid={`${testId}-toggle`}
        >
          <Brain className="size-3.5" aria-hidden />
          <I18nText id="brain.context.title" />
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        <span className={cn("text-[11px]", grant ? "text-success" : "text-muted-foreground")} role="status" data-testid={`${testId}-summary`}>
          {grant && <ShieldCheck className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />}
          {summary}
        </span>
        {grant && (
          <Button type="button" size="sm" variant="outline" onClick={() => void revoke()} disabled={busy === "revoke" || disabled} data-testid={`${testId}-revoke`}>
            <X className="size-3.5" aria-hidden />
            <I18nText id="brain.context.dont_send" />
          </Button>
        )}
      </div>
      {grant && (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`${testId}-grant-detail`}>
          {grant.preview.items.map((item) => item.title).join(" · ")}. {tr("brain.context.size", { chars: grant.preview.totalChars })}. <I18nText id="brain.context.grant_detail" />
        </p>
      )}
      {open && (
        <div id={panelId} className="mt-2 flex flex-col gap-2" data-testid={`${testId}-panel`}>
          <p className="text-[11px] text-muted-foreground"><I18nText id="brain.context.note" /></p>
          <label className="flex flex-col gap-1 text-[11px]" htmlFor={`${panelId}-mode`}>
            <I18nText id="brain.context.mode" />
            <Select
              id={`${panelId}-mode`}
              className="h-8 text-xs"
              value={mode}
              disabled={controlsDisabled}
              onChange={(event) => {
                resetSelection();
                setMode(event.target.value as BrainContextMode);
              }}
              data-testid={`${testId}-mode`}
            >
              {modes.map((item) => <option key={item} value={item}>{modeLabel(item)}</option>)}
            </Select>
          </label>
          {portfolio && mode === "projects" && (
            <fieldset className="min-w-0" data-testid={`${testId}-projects`}>
              <legend className="mb-1 text-[11px] font-medium"><I18nText id="brain.context.select_projects" /></legend>
              <label className="mb-1 flex items-center gap-2 text-[11px]">
                <input type="checkbox" checked={inheritCompany} disabled={controlsDisabled} onChange={(event) => { resetSelection(); setInheritCompany(event.target.checked); }} data-testid={`${testId}-inherit`} />
                <I18nText id="brain.context.inherit" />
              </label>
              <ul className="flex flex-col gap-1">
                {selectableProjects.map((project) => (
                  <li key={project.path}>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={projectPaths.includes(project.path)}
                        disabled={controlsDisabled}
                        aria-label={project.name}
                        onChange={() => toggleProject(project.path)}
                        data-testid={`${testId}-project`}
                      />
                      <span className="truncate">{project.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <Input
            className="h-8 text-xs"
            aria-label={tr("brain.context.search")}
            placeholder={tr("brain.context.search")}
            disabled={controlsDisabled}
            value={query}
            onChange={(event) => { setPreview(null); setIssues([]); setQuery(event.target.value); }}
            data-testid={`${testId}-search`}
          />
          {loading && <p className="text-xs text-muted-foreground" role="status"><I18nText id="brain.context.loading" /></p>}
          {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger" role="alert" data-testid={`${testId}-error`}>{error}</p>}
          {!loading && !error && memories.length === 0 && <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}><I18nText id="brain.context.empty" /></p>}
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto" data-testid={`${testId}-list`}>
            {memories.map((item) => (
              <li key={item.id} className="rounded-md border px-2 py-1.5" data-testid={`${testId}-row`}>
                <label className="flex w-full cursor-pointer items-start gap-2 text-left text-xs">
                  <input
                    type="checkbox"
                    aria-label={item.title}
                    aria-describedby={`${panelId}-${item.id}-scope`}
                    checked={selected.has(item.id)}
                    disabled={controlsDisabled}
                    className="mt-0.5 size-4 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    onChange={() => toggleMemory(item.id)}
                    data-testid={`${testId}-check`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.title}</span>
                    <span id={`${panelId}-${item.id}-scope`} className="block text-[11px] text-muted-foreground">
                      {item.scope.kind === "company" ? tr("brain.context.scope.company") : tr("brain.context.scope.project")}
                      {" · "}
                      {item.scopeLabel}
                      {" · "}
                      {kindLabel(item.kind)}
                      {" · "}
                      {tr("brain.context.revision")} {item.revision}
                      {" · "}
                      {tr("brain.context.active")}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">{item.excerpt}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {issues.length > 0 && !preview && (
            <ul className="text-[11px] text-warning">
              {issues.map((issue) => <li key={`${issue.code}-${issue.memoryId}`}>{issue.message}</li>)}
            </ul>
          )}
          {preview && <BrainContextPreviewBody preview={preview} testId={testId} />}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void runPreview()} disabled={controlsDisabled || loading || selected.size === 0} data-testid={`${testId}-preview-button`}>
              {busy === "preview" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              <I18nText id="brain.context.preview" />
            </Button>
            <Button type="button" size="sm" onClick={() => void approve()} disabled={busy != null || !preview?.canApprove || grant != null || disabled} data-testid={`${testId}-approve`}>
              <I18nText id="brain.context.approve" />
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void api.brainContextTransmissions(target).then((result) => setHistory(result.transmissions), (caught) => setError(messageOf(caught)))} data-testid={`${testId}-history`}>
              <I18nText id="brain.context.history" />
            </Button>
          </div>
          {visibleHistory && (
            <div data-testid={`${testId}-history-list`}>
              {visibleHistory.length === 0 && <p className="text-[11px] text-muted-foreground"><I18nText id="brain.context.history_empty" /></p>}
              <ul className="flex flex-col gap-1">
                {visibleHistory.map((item) => (
                  <li key={item.ref} className="text-[11px] text-muted-foreground" data-testid={`${testId}-history-row`}>
                    {item.status} · {item.used ? tr("brain.context.used") : tr("brain.context.not_used")} · {tr("brain.context.digest")} {item.digest.slice(0, 12)} · {item.items.map((memory) => memory.title).join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
