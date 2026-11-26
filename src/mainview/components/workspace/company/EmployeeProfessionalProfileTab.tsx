import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Box,
  Check,
  ClipboardList,
  Code,
  Copy,
  DollarSign,
  Edit3,
  Eye,
  FileCode,
  FlaskConical,
  Gamepad2,
  GraduationCap,
  History,
  LifeBuoy,
  type LucideIcon,
  Map,
  Megaphone,
  PenTool,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { RoleTemplateSummary } from "../../../../shared/catalog/types.ts";
import type {
  EmployeeProfessionalProfile,
  EmployeePromptRevision,
  EmployeePromptRevisionSummary,
} from "../../../../shared/employees/profile-types.ts";
import type { Employee } from "../../../../shared/employees/types.ts";
import { formatEmployeeTime } from "@/lib/employees";

const DIVISION_ICONS: Record<string, LucideIcon> = {
  academic: GraduationCap,
  design: PenTool,
  engineering: Code,
  finance: DollarSign,
  "game-development": Gamepad2,
  gis: Map,
  healthcare: Stethoscope,
  marketing: Megaphone,
  "paid-media": Target,
  product: Box,
  "project-management": ClipboardList,
  research: Search,
  sales: TrendingUp,
  security: ShieldCheck,
  "spatial-computing": Boxes,
  specialized: Sparkles,
  support: LifeBuoy,
  testing: FlaskConical,
};

interface Props {
  employee: Employee;
  onChanged?: () => void;
  onOpenRoleCatalog?: () => void;
}

export function EmployeeProfessionalProfileTab({ employee, onChanged, onOpenRoleCatalog }: Props) {
  const { locale: uiLocale } = useUILocale();
  const confirm = useConfirm();
  const [profile, setProfile] = useState<EmployeeProfessionalProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // Editor states
  const [editing, setEditing] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Revision history states
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<EmployeePromptRevisionSummary[]>([]);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [viewingRevision, setViewingRevision] = useState<EmployeePromptRevision | null>(null);

  // Assign role dialog
  const [assignOpen, setAssignOpen] = useState(false);
  const [catalogRoles, setCatalogRoles] = useState<RoleTemplateSummary[]>([]);
  const [assignSearch, setAssignSearch] = useState("");
  const [selectedRoleSlug, setSelectedRoleSlug] = useState("");
  const [assigning, setAssigning] = useState(false);

  const loadProfile = () => {
    setLoading(true);
    setError(null);
    api
      .getEmployeeProfessionalProfile(employee.id)
      .then((res) => {
        setProfile(res.profile);
        if (res.profile) {
          setEditorText(res.profile.activePrompt.promptMarkdown);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : tr("common.failed_to_load_professional_profile"));
        setLoading(false);
      });
  };

  useEffect(() => {
    loadProfile();
  }, [employee.id]);

  const loadCatalogRoles = () => {
    if (catalogRoles.length > 0) return;
    api
      .getCatalogRoles()
      .then((res) => setCatalogRoles(res.roles))
      .catch(() => {});
  };

  const handleStartEdit = () => {
    if (!profile) return;
    setEditorText(profile.activePrompt.promptMarkdown);
    setPreview(false);
    setEditing(true);
    setStatus(null);
  };

  const handleCancelEdit = async () => {
    if (profile && editorText !== profile.activePrompt.promptMarkdown) {
      const ok = await confirm(() => ({
        title: tr("common.discard_changes_85bcf4"),
        description: tr("common.you_have_unsaved_edits_in_the_professional_prompt"),
        confirmLabel: tr("common.discard"),
        variant: "destructive",
      }));
      if (!ok) return;
    }
    setEditing(false);
    setPreview(false);
    if (profile) setEditorText(profile.activePrompt.promptMarkdown);
  };

  const handleSavePrompt = async () => {
    if (!profile) return;
    const text = editorText.trim();
    if (!text) {
      setStatus({ tone: "error", text: "Prompt cannot be empty." });
      return;
    }

    setSaving(true);
    setStatus(null);

    try {
      const res = await api.updateEmployeeProfessionalPrompt(employee.id, {
        promptMarkdown: text,
        expectedRevision: profile.currentRevision,
        changeNote: "Owner prompt customization",
      });
      setProfile(res.profile);
      setEditorText(res.profile.activePrompt.promptMarkdown);
      setEditing(false);
      setPreview(false);
      setStatus({ tone: "ok", text: `Saved revision ${res.profile.currentRevision}.` });
      onChanged?.();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : tr("common.failed_to_save_prompt") });
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreTemplate = async () => {
    if (!profile) return;
    const ok = await confirm(() => ({
      title: tr("common.restore_original_template"),
      description: tr("common.reset_s_instructions_back_to_the_original_unmodified", { p0: String(employee.name) }),
      confirmLabel: tr("common.restore_as_new_revision"),
    }));
    if (!ok) return;

    setSaving(true);
    setStatus(null);

    try {
      const res = await api.resetEmployeeProfessionalPrompt(employee.id, profile.currentRevision);
      setProfile(res.profile);
      setEditorText(res.profile.activePrompt.promptMarkdown);
      setEditing(false);
      setStatus({ tone: "ok", text: `Restored original template as revision ${res.profile.currentRevision}.` });
      onChanged?.();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : tr("common.failed_to_restore_template") });
    } finally {
      setSaving(false);
    }
  };

  const openHistory = () => {
    setHistoryOpen(true);
    setLoadingRevisions(true);
    api
      .getEmployeePromptRevisions(employee.id)
      .then((res) => {
        setRevisions(res.revisions);
        setLoadingRevisions(false);
      })
      .catch(() => {
        setLoadingRevisions(false);
      });
  };

  const inspectRevision = (revNum: number) => {
    api
      .getEmployeePromptRevision(employee.id, revNum)
      .then((res) => {
        setViewingRevision(res.revision);
      })
      .catch(() => {});
  };

  const handleAssignRole = async () => {
    if (!selectedRoleSlug) return;
    setAssigning(true);
    setStatus(null);

    try {
      const res = await api.assignEmployeeProfessionalRole(employee.id, {
        catalogRoleSlug: selectedRoleSlug,
        expectedRevision: profile ? profile.currentRevision : 0,
      });
      setProfile(res.profile);
      setEditorText(res.profile.activePrompt.promptMarkdown);
      setAssignOpen(false);
      setStatus({ tone: "ok", text: `Assigned ${res.profile.professionalTitle} from catalog.` });
      onChanged?.();
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : tr("common.failed_to_assign_role_07e7d1") });
    } finally {
      setAssigning(false);
    }
  };

  const copyPrompt = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {}
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const filteredAssignRoles = useMemo(() => {
    if (!assignSearch.trim()) return catalogRoles;
    const q = assignSearch.trim().toLowerCase();
    return catalogRoles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.division.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q),
    );
  }, [catalogRoles, assignSearch, uiLocale]);

  const DivIcon = profile ? DIVISION_ICONS[profile.division] || Code : Code;

  return (
    <div className="flex flex-col gap-5" data-testid="employee-professional-profile-tab">
      {status && (
        <p
          role="status"
          aria-live="polite"
          data-testid="prompt-status"
          className={status.tone === "error" ? "text-sm text-destructive" : "text-sm text-success"}
        >
          {status.text}
        </p>
      )}

      {loading && (
        <p className="text-sm text-muted-foreground" data-testid="profile-loading"><I18nText id="employees.loading_professional_profile" />{" "}</p>
      )}

      {error && !loading && (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm text-destructive">
          <p>{error}</p>
        </div>
      )}

      {/* Empty State: No Role Assigned Yet */}
      {!loading && !error && !profile && (
        <section
          aria-label={tr("employees.no_professional_profile")}
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 p-8 text-center"
          data-testid="profile-empty-state"
        >
          <Sparkles className="size-8 text-muted-foreground/50 mb-2" aria-hidden />
          <h3 className="text-sm font-semibold text-foreground"><I18nText id="employees.no_professional_profession_assigned" /></h3>
          <p className="mt-1 max-w-md text-xs text-muted-foreground leading-relaxed"><I18nText id="employees.assign_a_specialized_role_from_the_283_agency" />{" "}</p>
          <div className="mt-4 flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="employee-assign-catalog-role"
              onClick={() => {
                loadCatalogRoles();
                setAssignOpen(true);
              }}
            ><I18nText id="employees.choose_from_role_catalog" />{" "}</Button>
          </div>
        </section>
      )}

      {/* Active Profile View */}
      {!loading && !error && profile && (
        <div className="flex flex-col gap-5" data-testid="active-profile-view">
          {/* Specialization Header Card */}
          <section
            aria-label={tr("employees.professional_specialization")}
            className="flex flex-col gap-3 rounded-xl border bg-card p-4"
            data-testid="professional-specialization-card"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl" aria-hidden>{profile.template?.emoji || "🤖"}</span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold tracking-tight" data-testid="profile-title">
                      {profile.professionalTitle}
                    </h3>
                    <span
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: `${profile.template?.color || "#3B82F6"}18`,
                        color: profile.template?.color || "#3B82F6",
                      }}
                      data-testid="profile-division-badge"
                    >
                      <DivIcon className="size-2.5" aria-hidden />
                      {profile.division}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px]" data-testid="profile-revision-badge"><I18nText id="employees.rev" />{" "}{profile.currentRevision}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground mt-0.5" data-testid="profile-slug"><I18nText id="employees.catalog" />{" "}{profile.catalogRoleSlug}
                  </p>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                {!editing && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="prompt-edit"
                    onClick={handleStartEdit}
                  >
                    <Edit3 className="size-3.5" /><I18nText id="employees.edit_instructions" />{" "}</Button>
                )}

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="prompt-copy"
                  onClick={() => copyPrompt(profile.activePrompt.promptMarkdown)}
                >
                  {copiedPrompt ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  {copiedPrompt ? tr("common.copied") : tr("common.copy_prompt")}
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="prompt-history"
                  onClick={openHistory}
                >
                  <History className="size-3.5" /><I18nText id="employees.revision_history" />{" "}</Button>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="prompt-restore-template"
                  disabled={saving || editing}
                  onClick={handleRestoreTemplate}
                >
                  <RotateCcw className="size-3.5" /><I18nText id="employees.reset_to_template" />{" "}</Button>

                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid="prompt-change-role"
                  disabled={editing}
                  onClick={() => {
                    loadCatalogRoles();
                    setSelectedRoleSlug(profile.catalogRoleSlug);
                    setAssignOpen(true);
                  }}
                ><I18nText id="employees.change_profession" />{" "}</Button>
              </div>
            </div>

            {/* Template Info & Description */}
            {profile.template && (
              <p className="text-xs text-muted-foreground leading-relaxed mt-1" data-testid="profile-description">
                {profile.template.description}
              </p>
            )}

            {/* Metadata Footer */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground border-t border-border/40 pt-2.5">
              <span><I18nText id="employees.provenance" />{" "}<strong className="font-medium text-foreground capitalize">{profile.activePrompt.ownerProvenance}</strong>
              </span>
              <span><I18nText id="employees.updated" />{" "}{formatEmployeeTime(profile.updatedAt)}</span>
              {profile.template && <span><I18nText id="employees.source" />{" "}{profile.template.sourcePath}</span>}
              <span className="font-mono"><I18nText id="employees.sha" />{" "}{profile.activePrompt.promptSha256.slice(0, 10)}…</span>
            </div>
          </section>

          {/* Prompt Instructions Display / Editor */}
          <section aria-label={tr("employees.professional_prompt_instructions")} className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {editing ? tr("common.customize_professional_prompt_markdown") : tr("common.active_professional_instructions")}
              </h4>

              {editing && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-testid="prompt-preview-toggle"
                    onClick={() => setPreview((p) => !p)}
                  >
                    {preview ? <FileCode className="size-3.5" /> : <Eye className="size-3.5" />}
                    {preview ? tr("common.edit_raw") : tr("common.preview")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="prompt-cancel"
                    disabled={saving}
                    onClick={handleCancelEdit}
                  ><I18nText id="common.cancel" />{" "}</Button>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="prompt-save"
                    disabled={saving || !editorText.trim()}
                    onClick={handleSavePrompt}
                  >
                    {saving ? tr("common.saving_23e392") : tr("common.save_revision")}
                  </Button>
                </div>
              )}
            </div>

            {editing ? (
              <div className="flex flex-col gap-2">
                {preview ? (
                  <div
                    data-testid="prompt-editor-preview"
                    className="min-h-[300px] max-h-[500px] overflow-y-auto rounded-xl border bg-muted/10 p-4 prose prose-sm dark:prose-invert max-w-none font-sans text-xs"
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {editorText}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    id="prompt-editor-textarea"
                    data-testid="prompt-editor-textarea"
                    value={editorText}
                    onChange={(e) => setEditorText(e.target.value)}
                    rows={16}
                    placeholder={tr("employees.enter_customized_professional_instructions_in_markdown")}
                    className="w-full rounded-xl border border-input bg-background p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                )}
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span><I18nText id="employees.new_revision_will_be_created_monotonically_on_save" /></span>
                  <span>{editorText.length}{" "}<I18nText id="common.characters" /></span>
                </div>
              </div>
            ) : (
              <div
                data-testid="prompt-instructions-display"
                className="max-h-[500px] overflow-y-auto rounded-xl border bg-muted/10 p-4 prose prose-sm dark:prose-invert max-w-none font-sans text-xs leading-relaxed"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {profile.activePrompt.promptMarkdown}
                </ReactMarkdown>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Revision History Dialog */}
      {historyOpen && (
        <Dialog
          open={historyOpen}
          onClose={() => {
            setHistoryOpen(false);
            setViewingRevision(null);
          }}
          className="max-w-2xl max-h-[85vh] flex flex-col"
        >
          <div className="flex flex-col gap-4 overflow-hidden" data-testid="revision-history-dialog">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-semibold"><I18nText id="employees.prompt_revision_history" /></h3>
                <p className="text-xs text-muted-foreground"><I18nText id="employees.immutable_audit_trail_of_all_previous_prompt_versions" />{" "}{employee.name}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen(false);
                  setViewingRevision(null);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={tr("common.close")}
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5">
              {loadingRevisions ? (
                <p className="text-sm text-muted-foreground"><I18nText id="employees.loading_revisions" /></p>
              ) : revisions.length === 0 ? (
                <p className="text-sm text-muted-foreground"><I18nText id="employees.no_recorded_revisions" /></p>
              ) : (
                revisions.map((rev) => (
                  <div
                    key={rev.id}
                    data-testid="revision-item"
                    data-revision={rev.revision}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30 transition-colors"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <strong className="text-sm"><I18nText id="employees.revision" />{" "}{rev.revision}</strong>
                        {profile?.currentRevision === rev.revision && (
                          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.2 text-[10px] font-medium"><I18nText id="common.active" />{" "}</span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatEmployeeTime(rev.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {rev.changeNote || tr("common.prompt_update")}{" "}<I18nText id="employees.by" />{" "}{rev.ownerProvenance}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground/70"><I18nText id="employees.sha" />{" "}{rev.promptSha256.slice(0, 16)}…
                      </p>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`view-revision-${rev.revision}`}
                      onClick={() => inspectRevision(rev.revision)}
                    ><I18nText id="employees.inspect" />{" "}</Button>
                  </div>
                ))
              )}
            </div>

            {/* Past revision inspection modal/panel */}
            {viewingRevision && (
              <div className="rounded-xl border bg-muted/20 p-3 mt-2">
                <div className="flex items-center justify-between pb-2 border-b">
                  <span className="text-xs font-semibold"><I18nText id="employees.viewing_revision" />{" "}{viewingRevision.revision}{" "}<I18nText id="employees.read_only" />{" "}</span>
                  <button
                    type="button"
                    onClick={() => setViewingRevision(null)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={tr("employees.close_revision_view")}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="max-h-[220px] overflow-y-auto pt-2 font-mono text-[11px] whitespace-pre-wrap leading-relaxed">
                  {viewingRevision.promptMarkdown}
                </div>
              </div>
            )}
          </div>
        </Dialog>
      )}

      {/* Assign / Change Role Dialog */}
      {assignOpen && (
        <Dialog
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          className="max-w-xl max-h-[85vh] flex flex-col"
        >
          <div className="flex flex-col gap-3 overflow-hidden" data-testid="assign-role-dialog">
            <div className="flex items-center justify-between border-b pb-2.5">
              <div>
                <h3 className="text-base font-semibold">
                  {profile ? tr("common.change_ai_profession") : tr("common.assign_catalog_profession")}
                </h3>
                <p className="text-xs text-muted-foreground"><I18nText id="employees.select_a_role_from_the_agency_agents_catalog" />{" "}{employee.name}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAssignOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={tr("common.close")}
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Search within dialog */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                placeholder={tr("employees.search_catalog_roles")}
                value={assignSearch}
                onChange={(e) => setAssignSearch(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>

            {/* Roles list */}
            <div className="flex-1 overflow-y-auto max-h-[350px] space-y-1.5 pr-1">
              {filteredAssignRoles.map((role) => {
                const Icon = DIVISION_ICONS[role.division] || Code;
                const isSelected = selectedRoleSlug === role.slug;
                return (
                  <div
                    key={role.slug}
                    onClick={() => setSelectedRoleSlug(role.slug)}
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/40 border-border/60"
                    }`}
                  >
                    <span className="text-lg" aria-hidden>{role.emoji}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <strong className="text-xs font-semibold">{role.name}</strong>
                        <span
                          className="rounded px-1.5 py-0.2 text-[9px] font-medium"
                          style={{
                            backgroundColor: `${role.color}18`,
                            color: role.color,
                          }}
                        >
                          {role.division}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-[11px] text-muted-foreground mt-0.5">
                        {role.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAssignOpen(false)}
                disabled={assigning}
              ><I18nText id="common.cancel" />{" "}</Button>
              <Button
                type="button"
                size="sm"
                data-testid="confirm-assign-role-btn"
                disabled={assigning || !selectedRoleSlug}
                onClick={handleAssignRole}
              >
                {assigning ? tr("common.assigning") : tr("common.assign_profession")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
