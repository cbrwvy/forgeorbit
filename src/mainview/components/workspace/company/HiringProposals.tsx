import { staticLabel } from "@/i18n/presentation";
import { getLocale, t as tr, type TranslationKey } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  Check,
  CheckCircle2,
  Clock,
  Code,
  DollarSign,
  Edit3,
  Eye,
  FileCode,
  History,
  Info,
  Loader2,
  type LucideIcon,
  RotateCcw,
  Sparkles,
  UserCheck,
  UserPlus,
  Users,
  X,
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatEmployeeTime } from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import type {
  HiringProposal,
  HiringProposalEvent,
  HiringProposalStatus,
} from "../../../../shared/hiring/types.ts";
import {
  hiringProposalStatusLabel,
  hiringProposalStatusTone,
} from "../../../../shared/hiring/proposals.ts";

interface Props {
  projectPath?: string;
  refreshToken?: number | string;
  onOpenProject?: (projectPath: string) => void;
  onOpenEmployee?: (employeeId: string) => void;
  onChanged?: () => void;
}

const DIVISION_COLORS: Record<string, string> = {
  academic: "#8b5cf6",
  design: "#ec4899",
  engineering: "#3b82f6",
  finance: "#10b981",
  "game-development": "#f97316",
  marketing: "#06b6d4",
  product: "#6366f1",
  "project-management": "#14b8a6",
  testing: "#eab308",
  support: "#64748b",
};

function simpleLineDiff(originalText: string, adaptedText: string): { type: "same" | "add" | "remove"; text: string }[] {
  const origLines = originalText.split("\n");
  const adaptLines = adaptedText.split("\n");
  const result: { type: "same" | "add" | "remove"; text: string }[] = [];

  const origSet = new Set(origLines);
  const adaptSet = new Set(adaptLines);

  let i = 0;
  let j = 0;

  while (i < origLines.length || j < adaptLines.length) {
    if (i < origLines.length && j < adaptLines.length && origLines[i] === adaptLines[j]) {
      result.push({ type: "same", text: origLines[i]! });
      i++;
      j++;
    } else if (j < adaptLines.length && !origSet.has(adaptLines[j]!)) {
      result.push({ type: "add", text: adaptLines[j]! });
      j++;
    } else if (i < origLines.length && !adaptSet.has(origLines[i]!)) {
      result.push({ type: "remove", text: origLines[i]! });
      i++;
    } else {
      if (i < origLines.length) {
        result.push({ type: "remove", text: origLines[i]! });
        i++;
      }
      if (j < adaptLines.length) {
        result.push({ type: "add", text: adaptLines[j]! });
        j++;
      }
    }
  }

  return result;
}

export function HiringProposals({
  projectPath,
  refreshToken,
  onOpenProject,
  onOpenEmployee,
  onChanged,
}: Props) {
  const { locale: uiLocale } = useUILocale();
  const confirm = useConfirm();
  const [proposals, setProposals] = useState<HiringProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<HiringProposalStatus | "all">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Prompt Inspect Modal
  const [inspectProposal, setInspectProposal] = useState<HiringProposal | null>(null);
  const [inspectTab, setInspectTab] = useState<"diff" | "adapted" | "original">("diff");

  // Edit / Approve Dialog
  const [editingProposal, setEditingProposal] = useState<HiringProposal | null>(null);
  const [editName, setEditName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editJustification, setEditJustification] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // History Modal
  const [historyProposal, setHistoryProposal] = useState<HiringProposal | null>(null);
  const [events, setEvents] = useState<HiringProposalEvent[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api.listHiringProposals(projectPath ? { projectPath } : {}).then(
      (result) => {
        if (cancelled) return;
        setProposals(result.proposals);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : tr("common.failed_to_load_hiring_proposals"));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    return load();
  }, [load, refreshToken]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return proposals;
    return proposals.filter((p) => p.status === statusFilter);
  }, [proposals, statusFilter, uiLocale]);

  const pendingCount = useMemo(
    () => proposals.filter((p) => p.status === "pending").length,
    [proposals, uiLocale],
  );

  const handleApprove = async (proposal: HiringProposal) => {
    const ok = await confirm(() => ({
      title: tr("common.approve_hiring_for", { p0: String(proposal.proposedName) }),
      description: tr("common.this_will_create_ai_employee_with_revision_1", { p0: String(proposal.proposedName), p1: String(proposal.professionalTitle) }),
      confirmLabel: tr("common.approve_hiring"),
    }));
    if (!ok) return;

    setBusyId(proposal.id);
    setActionStatus(null);
    try {
      const res = await api.approveHiringProposal(proposal.id, {
        expectedRevision: proposal.revision,
      });
      setActionStatus({
        tone: "ok",
        text: `Hired ${res.proposal.proposedName} as ${res.proposal.professionalTitle}.`,
      });
      load();
      onChanged?.();
    } catch (err) {
      setActionStatus({
        tone: "error",
        text: err instanceof Error ? err.message : tr("common.failed_to_approve_proposal"),
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (proposal: HiringProposal) => {
    const ok = await confirm(() => ({
      title: tr("common.reject_proposal_for", { p0: String(proposal.proposedName) }),
      description: tr("common.this_will_reject_the_project_manager_s_recommendation", { p0: String(proposal.professionalTitle) }),
      confirmLabel: tr("common.reject_proposal"),
    }));
    if (!ok) return;

    setBusyId(proposal.id);
    setActionStatus(null);
    try {
      await api.rejectHiringProposal(proposal.id, {
        expectedRevision: proposal.revision,
        note: tr("common.rejected_by_owner"),
      });
      setActionStatus({
        tone: "ok",
        text: `Rejected proposal for ${proposal.proposedName}.`,
      });
      load();
      onChanged?.();
    } catch (err) {
      setActionStatus({
        tone: "error",
        text: err instanceof Error ? err.message : tr("common.failed_to_reject_proposal"),
      });
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (proposal: HiringProposal) => {
    setEditingProposal(proposal);
    setEditName(proposal.proposedName);
    setEditTitle(proposal.professionalTitle);
    setEditPrompt(proposal.promptMarkdown);
    setEditJustification(proposal.justification);
  };

  const handleSaveAndApprove = async () => {
    if (!editingProposal) return;
    setSavingEdit(true);
    setActionStatus(null);
    try {
      const res = await api.approveHiringProposal(editingProposal.id, {
        expectedRevision: editingProposal.revision,
        proposedName: editName,
        professionalTitle: editTitle,
        promptMarkdown: editPrompt,
        changeNote: "Owner edited and approved",
      });
      setActionStatus({
        tone: "ok",
        text: `Hired ${res.proposal.proposedName} with customized professional profile.`,
      });
      setEditingProposal(null);
      load();
      onChanged?.();
    } catch (err) {
      setActionStatus({
        tone: "error",
        text: err instanceof Error ? err.message : tr("common.failed_to_edit_and_approve_proposal"),
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const openHistory = async (proposal: HiringProposal) => {
    setHistoryProposal(proposal);
    setLoadingHistory(true);
    try {
      const res = await api.getHiringProposalHistory(proposal.id);
      setEvents(res.events);
    } catch {
      setEvents([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  return (
    <section
      data-testid="hiring-proposals-container"
      className="surface-solid flex flex-col gap-3 rounded-xl border p-4 text-xs"
      aria-label={tr("employees.ai_specialist_hiring_proposals")}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <UserPlus className="size-4 text-primary" aria-hidden />
          <h3 className="text-sm font-medium"><I18nText id="employees.hiring_proposals" /></h3>
          {pendingCount > 0 && (
            <span
              data-testid="pending-proposals-count"
              className="inline-flex items-center rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold text-warning"
            >
              {pendingCount}{" "}<I18nText id="common.pending" />{" "}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-lg border p-0.5 text-xs" role="group" aria-label={tr("uxfix.hiring.filter")}>
          {(["pending", "approved", "rejected", "withdrawn", "stale", "all"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              data-testid={`filter-tab-${tab}`}
              onClick={() => setStatusFilter(tab)}
              className={cn(
                "glass-nav-item whitespace-nowrap rounded px-2 py-1 font-medium",
                statusFilter === tab ? "glass-selected text-foreground" : "text-muted-foreground",
              )}
            >
              {tr(`legacy.status.${tab}` as TranslationKey)}
            </button>
          ))}
        </div>
      </header>

      {actionStatus && (
        <div
          data-testid="hiring-action-status"
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
            actionStatus.tone === "ok"
              ? "border-success/30 bg-success/10 text-success"
              : "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {actionStatus.tone === "ok" ? (
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          )}
          <span>{actionStatus.text}</span>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => setActionStatus(null)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span><I18nText id="employees.loading_hiring_proposals" /></span>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-danger">
          <span>{error}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={load}
            className="mt-2 text-xs text-danger hover:bg-danger/20"
          >
            <RotateCcw className="size-3.5 mr-1" aria-hidden />{" "}<I18nText id="common.retry" />{" "}</Button>
        </div>
      ) : filtered.length === 0 ? (
        <div
          data-testid="empty-proposals-state"
          className="rounded-lg border border-dashed py-8 text-center text-muted-foreground"
        >
          <Users className="mx-auto mb-2 size-6 opacity-40" aria-hidden />
          <p className="font-medium">{statusFilter === "all" ? tr("legacy.noneAll") : tr("legacy.noneFiltered", { status: tr(`legacy.status.${statusFilter}` as TranslationKey).toLocaleLowerCase(getLocale()) })}</p>
          <p className="text-xs text-muted-foreground/80">
            {projectPath
              ? tr("common.ask_the_project_manager_to_build_a_team")
              : tr("common.project_managers_will_suggest_specialist_roles_here_for")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((proposal) => {
            const tone = hiringProposalStatusTone(proposal.status);
            const isPending = proposal.status === "pending";
            const isApproved = proposal.status === "approved";
            const divisionColor = DIVISION_COLORS[proposal.template?.division || "engineering"] || "#3b82f6";

            return (
              <div
                key={proposal.id}
                data-testid="hiring-proposal-card"
                className="flex flex-col gap-2.5 rounded-lg border bg-surface-base/30 p-3 transition-colors hover:border-primary/40"
              >
                {/* Header row */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <div
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-sm shadow-sm"
                      style={{
                        backgroundColor: `${divisionColor}1a`,
                        borderColor: `${divisionColor}40`,
                        borderWidth: 1,
                      }}
                    >
                      {proposal.template?.emoji || "🤖"}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          data-testid="proposal-name"
                          className="font-medium text-foreground truncate"
                        >
                          {proposal.proposedName}
                        </span>
                        <span className="text-xs text-muted-foreground">•</span>
                        <span
                          data-testid="proposal-title"
                          className="text-xs text-muted-foreground truncate"
                        >
                          {proposal.professionalTitle}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span data-testid="proposal-slug" className="font-mono">
                          {proposal.catalogRoleSlug}
                        </span>
                        {proposal.projectName && !projectPath && (
                          <>
                            <span><I18nText id="common.in" /></span>
                            <button
                              type="button"
                              onClick={() => onOpenProject?.(proposal.projectPath)}
                              className="text-primary hover:underline"
                            >
                              {proposal.projectName}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <span
                    data-testid="proposal-status"
                    data-status={proposal.status}
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                      tone === "success" && "border-success/40 text-success",
                      tone === "warning" && "border-warning/40 text-warning",
                      tone === "danger" && "border-danger/40 text-danger",
                      tone === "muted" && "text-muted-foreground",
                    )}
                  >
                    {staticLabel(hiringProposalStatusLabel(proposal.status))}
                  </span>
                </div>

                {/* Duplicate employee warning */}
                {proposal.duplicateWarning && isPending && (
                  <div
                    data-testid="duplicate-warning"
                    className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning"
                  >
                    <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                    <span>{proposal.duplicateWarning}</span>
                  </div>
                )}

                {proposal.legacyNormalization && (
                  <details className="rounded-md border p-2 text-xs text-muted-foreground" data-testid="legacy-normalization">
                    <summary><I18nText id="employees.legacy_proposal_preserved_for_review" /></summary>
                    <p>{proposal.staleReason ?? proposal.legacyNormalization.reason}</p>
                    <p><I18nText id="employees.original_message" />{" "}{proposal.sourceMessageId ?? tr("common.none_dc937b")}</p>
                    <p><I18nText id="employees.pending_proposal" />{" "}{proposal.legacyNormalization.canonicalPendingId ?? tr("common.unchanged")}</p>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(proposal.legacyNormalization, null, 2)}</pre>
                  </details>
                )}

                {/* Justification */}
                <div
                  data-testid="proposal-justification"
                  className="rounded-md bg-surface-base/60 p-2 text-xs text-muted-foreground"
                >
                  <span className="font-semibold text-foreground/80 mr-1"><I18nText id="employees.justification" /></span>
                  {proposal.justification}
                </div>

                {/* Competencies & Tasks */}
                {(proposal.competencies.length > 0 || proposal.relatedTasks.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1 text-xs">
                    {proposal.competencies.map((comp) => (
                      <span
                        key={comp}
                        className="rounded border bg-surface-elevated/40 px-1.5 py-0.5 text-muted-foreground"
                      >
                        {comp}
                      </span>
                    ))}
                    {proposal.relatedTasks.map((tRef) => (
                      <span
                        key={tRef}
                        className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-primary"
                      >
                        #{tRef}
                      </span>
                    ))}
                  </div>
                )}

                {/* Actions row */}
                <footer className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="inspect-prompt-button"
                      onClick={() => {
                        setInspectProposal(proposal);
                        setInspectTab("diff");
                      }}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <Eye className="size-3" aria-hidden />
                      <span><I18nText id="employees.inspect_prompt" /></span>
                    </button>

                    <button
                      type="button"
                      onClick={() => openHistory(proposal)}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      <History className="size-3" aria-hidden />
                      <span><I18nText id="common.history" /></span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {isPending && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid="edit-proposal-button"
                          disabled={busyId === proposal.id}
                          onClick={() => openEdit(proposal)}
                          className="h-7 text-xs"
                        >
                          <Edit3 className="size-3 mr-1" aria-hidden /><I18nText id="common.edit" />{" "}</Button>

                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="reject-proposal-button"
                          disabled={busyId === proposal.id}
                          onClick={() => handleReject(proposal)}
                          className="h-7 text-xs text-danger hover:bg-danger/10 hover:text-danger"
                        >
                          <X className="size-3 mr-1" aria-hidden /><I18nText id="common.reject" />{" "}</Button>

                        <Button
                          type="button"
                          size="sm"
                          data-testid="approve-proposal-button"
                          disabled={busyId === proposal.id}
                          onClick={() => handleApprove(proposal)}
                          className="h-7 text-xs font-semibold"
                        >
                          {busyId === proposal.id ? (
                            <Loader2 className="size-3 animate-spin mr-1" aria-hidden />
                          ) : (
                            <Check className="size-3 mr-1" aria-hidden />
                          )}<I18nText id="common.approve" />{" "}</Button>
                      </>
                    )}

                    {isApproved && proposal.createdEmployeeId && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onOpenEmployee?.(proposal.createdEmployeeId!)}
                        className="h-7 text-xs"
                      >
                        <UserCheck className="size-3 mr-1" aria-hidden /><I18nText id="employees.view_employee" />{" "}</Button>
                    )}
                  </div>
                </footer>
              </div>
            );
          })}
        </div>
      )}

      {/* Prompt Inspect Dialog */}
      {inspectProposal && (
        <Dialog
          open={true}
          onClose={() => setInspectProposal(null)}
        >
          <div className="glass-surface flex max-h-[85vh] w-[90vw] max-w-3xl flex-col rounded-xl border p-5 shadow-2xl">
            <header className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-semibold"><I18nText id="employees.professional_prompt" />{" "}{inspectProposal.proposedName}
                </h3>
                <p className="text-xs text-muted-foreground"><I18nText id="employees.role" />{" "}{inspectProposal.catalogRoleSlug} ({inspectProposal.professionalTitle})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectProposal(null)}
                className="rounded p-1 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <div className="flex items-center gap-2 border-b py-2 text-xs">
              {(["diff", "adapted", "original"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setInspectTab(tab)}
                  className={cn(
                    "rounded px-2.5 py-1 font-medium capitalize",
                    inspectTab === tab
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab === "diff"
                    ? tr("common.comparison_diff")
                    : tab === "adapted"
                      ? tr("common.adapted_prompt")
                      : tr("common.original_template")}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto py-3 font-mono text-xs">
              {inspectTab === "diff" && (
                <div className="space-y-0.5 rounded-lg border bg-surface-base/80 p-3">
                  {simpleLineDiff(
                    inspectProposal.template?.originalMarkdown || inspectProposal.promptMarkdown,
                    inspectProposal.promptMarkdown,
                  ).map((line, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "whitespace-pre-wrap break-all px-1.5 py-0.5 rounded",
                        line.type === "add" && "bg-success/20 text-success font-semibold",
                        line.type === "remove" && "bg-danger/20 text-danger line-through opacity-70",
                        line.type === "same" && "text-muted-foreground",
                      )}
                    >
                      {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                      {line.text || " "}
                    </div>
                  ))}
                </div>
              )}

              {inspectTab === "adapted" && (
                <div className="rounded-lg border bg-surface-base/80 p-4 font-sans text-xs prose prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {inspectProposal.promptMarkdown}
                  </ReactMarkdown>
                </div>
              )}

              {inspectTab === "original" && (
                <div className="rounded-lg border bg-surface-base/80 p-4 font-sans text-xs prose prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {inspectProposal.template?.originalMarkdown || tr("common.original_template_markdown_not_available")}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            <footer className="flex justify-end border-t pt-3">
              <Button type="button" size="sm" onClick={() => setInspectProposal(null)}><I18nText id="common.close" />{" "}</Button>
            </footer>
          </div>
        </Dialog>
      )}

      {/* Edit & Approve Dialog */}
      {editingProposal && (
        <Dialog
          open={true}
          onClose={() => setEditingProposal(null)}
        >
          <div className="glass-surface flex max-h-[90vh] w-[90vw] max-w-2xl flex-col rounded-xl border p-5 shadow-2xl">
            <header className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-semibold"><I18nText id="employees.edit_approve_hiring_proposal" /></h3>
                <p className="text-xs text-muted-foreground"><I18nText id="employees.review_and_customize_this_specialist_profile_before_formal" />{" "}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingProposal(null)}
                className="rounded p-1 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <form
              className="flex-1 space-y-3 overflow-y-auto py-3 text-xs"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveAndApprove();
              }}
            >
              <div>
                <label className="mb-1 block font-medium"><I18nText id="employees.proposed_employee_name" /></label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={tr("employees.e_g_alex")}
                  required
                />
              </div>

              <div>
                <label className="mb-1 block font-medium"><I18nText id="employees.professional_title" /></label>
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder={tr("employees.e_g_senior_frontend_engineer")}
                  required
                />
              </div>

              <div>
                <label className="mb-1 block font-medium"><I18nText id="employees.justification_reason" /></label>
                <Textarea
                  value={editJustification}
                  onChange={(e) => setEditJustification(e.target.value)}
                  rows={2}
                  disabled
                  className="opacity-70"
                />
              </div>

              <div>
                <label className="mb-1 block font-medium"><I18nText id="employees.adapted_markdown_prompt" /></label>
                <Textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                  required
                />
              </div>

              <footer className="flex justify-end gap-2 border-t pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingProposal(null)}
                ><I18nText id="common.cancel" />{" "}</Button>
                <Button type="submit" size="sm" disabled={savingEdit}>
                  {savingEdit ? (
                    <Loader2 className="size-3 animate-spin mr-1" aria-hidden />
                  ) : (
                    <Check className="size-3 mr-1" aria-hidden />
                  )}<I18nText id="common.save_approve" />{" "}</Button>
              </footer>
            </form>
          </div>
        </Dialog>
      )}

      {/* History Dialog */}
      {historyProposal && (
        <Dialog
          open={true}
          onClose={() => setHistoryProposal(null)}
        >
          <div className="glass-surface flex max-h-[80vh] w-[90vw] max-w-lg flex-col rounded-xl border p-5 shadow-2xl">
            <header className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-semibold"><I18nText id="employees.proposal_history_1f5c98" /></h3>
                <p className="text-xs text-muted-foreground"><I18nText id="employees.audit_trail_for" />{" "}{historyProposal.proposedName} ({historyProposal.catalogRoleSlug})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryProposal(null)}
                className="rounded p-1 text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto py-3">
              {loadingHistory ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin mr-2" aria-hidden /><I18nText id="common.loading_history" />{" "}</div>
              ) : events.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground"><I18nText id="employees.no_events_recorded" /></p>
              ) : (
                <div className="space-y-3">
                  {events.map((evt) => (
                    <div
                      key={evt.id}
                      className="flex items-start gap-3 rounded-lg border bg-surface-base/50 p-2.5 text-xs"
                    >
                      <div className="mt-0.5 rounded-full bg-primary/20 p-1 text-primary">
                        <Clock className="size-3" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold capitalize text-foreground">
                            {evt.action}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatEmployeeTime(evt.createdAt)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground"><I18nText id="employees.actor" />{" "}<span className="font-medium">{evt.actor}</span>{" "}<I18nText id="employees.revision_5f370e" />{" "}{evt.proposalRevision})
                        </p>
                        {evt.note && (
                          <p className="mt-1 text-xs italic text-muted-foreground">"{evt.note}"</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <footer className="flex justify-end border-t pt-3">
              <Button type="button" size="sm" onClick={() => setHistoryProposal(null)}><I18nText id="common.close" />{" "}</Button>
            </footer>
          </div>
        </Dialog>
      )}
    </section>
  );
}
