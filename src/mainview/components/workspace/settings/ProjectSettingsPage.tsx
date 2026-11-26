import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { Plus, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { subscribeProjectPermissionEvents } from "@/lib/project-permission-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { HandsoffSettings } from "@/components/handsoff/HandsoffSettings";
import { BranchNamingDialog } from "@/components/settings/BranchNamingDialog";
import { DEFAULT_BRANCH_CONFIG, type BranchNamingConfig } from "@/i18n/options";
import type { Project, ProjectRule } from "../../../../shared/types.ts";

interface Props {
  project: Project;
}

export function ProjectSettingsPage({ project }: Props) {
  useUILocale();
  const [rules, setRules] = useState<ProjectRule[]>([]);
  const [version, setVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchConfig, setBranchConfig] = useState<BranchNamingConfig>(DEFAULT_BRANCH_CONFIG);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [inheritCompany, setInheritCompany] = useState(false);
  const [inheritCluster, setInheritCluster] = useState(false);
  const [inheritLoading, setInheritLoading] = useState(true);
  const [previewLines, setPreviewLines] = useState<string[]>([]);
  const [workspaceDev, setWorkspaceDev] = useState(Boolean(project.workspaceDevelopment));
  const [workspaceDevLoading, setWorkspaceDevLoading] = useState(true);
  const [workspaceDevSaving, setWorkspaceDevSaving] = useState(false);

  const reloadWorkspaceDev = useCallback(async () => {
    const payload = await api.getProjectPermissions(project.path);
    setWorkspaceDev(Boolean(payload.workspaceDevelopment));
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceDevLoading(true);
    void reloadWorkspaceDev()
      .catch(() => {
        if (!cancelled) setWorkspaceDev(Boolean(project.workspaceDevelopment));
      })
      .finally(() => {
        if (!cancelled) setWorkspaceDevLoading(false);
      });
    return () => { cancelled = true; };
  }, [project.path, project.workspaceDevelopment, reloadWorkspaceDev]);

  useEffect(
    () => subscribeProjectPermissionEvents((event) => {
      if (event.projectPath === project.path) void reloadWorkspaceDev().catch(() => {});
    }),
    [project.path, reloadWorkspaceDev],
  );

  const toggleWorkspaceDev = async (enabled: boolean) => {
    setWorkspaceDevSaving(true);
    try {
      const result = await api.setProjectWorkspaceDevelopment(project.path, enabled);
      setWorkspaceDev(Boolean(result.workspaceDevelopment));
      toast.success(tr(result.workspaceDevelopment ? "perm.dev.saved_on" : "perm.dev.saved_off"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    } finally {
      setWorkspaceDevSaving(false);
    }
  };

  const reloadInheritance = useCallback(async () => {
    const payload = await api.getKnowledgeInheritanceSettings(project.path);
    setInheritCompany(payload.settings.acceptCompany);
    setInheritCluster(payload.settings.acceptCluster);
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    setInheritLoading(true);
    void reloadInheritance()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setInheritLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadInheritance]);

  const saveInheritance = async (patch: { acceptCompany?: boolean; acceptCluster?: boolean }) => {
    try {
      const payload = await api.patchKnowledgeInheritanceSettings(project.path, patch);
      setInheritCompany(payload.settings.acceptCompany);
      setInheritCluster(payload.settings.acceptCluster);
      setPreviewLines([]);
      toast.success("Knowledge inheritance updated. New PM replies and launches only.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    }
  };

  const previewEffective = async () => {
    try {
      const payload = await api.knowledgeEffectivePreview(project.path);
      const titles = payload.preview.included.map((line) => `${line.level}: ${line.title} (${line.reason})`);
      const excluded = payload.preview.excluded.slice(0, 8).map((line) => `excluded: ${line.title} (${line.reason})`);
      setPreviewLines(
        titles.length + excluded.length > 0
          ? [...titles, ...excluded]
          : ["No notes in effective context yet."],
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    }
  };

  const reload = useCallback(async () => {
    const payload = await api.listProjectRules(project.path);
    setRules(payload.rules);
    setVersion(payload.version);
  }, [project.path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([reload(), api.getProjectBranchConfig(project.path)])
      .then(([, cfg]) => {
        if (!cancelled) setBranchConfig(cfg);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path, reload]);

  const startCreate = () => {
    setDraftId("new");
    setDraftName("");
    setDraftBody("");
  };

  const startEdit = (rule: ProjectRule) => {
    setDraftId(rule.id);
    setDraftName(rule.name);
    setDraftBody(rule.body);
  };

  const cancelDraft = () => {
    setDraftId(null);
    setDraftName("");
    setDraftBody("");
  };

  const saveDraft = async () => {
    if (!draftId) return;
    setSaving(true);
    try {
      if (draftId === "new") {
        await api.createProjectRule(project.path, { name: draftName, body: draftBody });
        toast.success(tr("project_rules.created"));
      } else {
        await api.updateProjectRule(project.path, draftId, { name: draftName, body: draftBody });
        toast.success(tr("project_rules.saved"));
      }
      cancelDraft();
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (rule: ProjectRule) => {
    try {
      await api.updateProjectRule(project.path, rule.id, { enabled: !rule.enabled });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    }
  };

  const removeRule = async (rule: ProjectRule) => {
    if (!window.confirm(tr("project_rules.delete_confirm", { p0: rule.name }))) return;
    try {
      await api.deleteProjectRule(project.path, rule.id);
      if (draftId === rule.id) cancelDraft();
      await reload();
      toast.success(tr("project_rules.deleted"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tr("common.error"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack overflow-y-auto px-page pb-[calc(1.25rem+var(--shell-dock-clearance))] pt-5" data-testid="project-settings-page">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold"><I18nText id="project_rules.title" /></h2>
        <p className="text-xs text-muted-foreground">
          <I18nText id="project_rules.project_label" />{" "}
          <span className="font-mono text-foreground" data-testid="project-rules-path">{project.path}</span>
        </p>
        <p className="text-xs text-muted-foreground"><I18nText id="project_rules.effect_hint" /></p>
        {version ? (
          <p className="text-[11px] text-muted-foreground" data-testid="project-rules-version">
            <I18nText id="project_rules.version" />{" "}{version}
          </p>
        ) : null}
      </header>

      <section className="surface-solid space-y-2.5 rounded-xl border p-4" data-testid="project-workspace-development-section">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">{tr("perm.dev.title")}</h3>
            <p className="text-xs text-muted-foreground">{tr("perm.dev.desc")}</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
            <Switch
              checked={workspaceDev}
              disabled={workspaceDevLoading || workspaceDevSaving}
              onCheckedChange={(checked) => void toggleWorkspaceDev(checked)}
              data-testid="project-workspace-development-toggle"
            />
            <span>{tr(workspaceDev ? "perm.dev.enabled" : "perm.dev.disabled")}</span>
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">{tr("perm.dev.boundaries")}</p>
        <p className="text-[11px] text-muted-foreground">{tr("perm.dev.next_launch")}</p>
      </section>

      <HandsoffSettings projectPath={project.path} />

      <section className="surface-solid space-y-3 rounded-xl border p-4" data-testid="project-rules-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium"><I18nText id="project_rules.rules_heading" /></h3>
          <Button type="button" size="sm" variant="outline" onClick={startCreate} data-testid="project-rule-add">
            <Plus className="size-3.5" aria-hidden /><I18nText id="project_rules.add" />
          </Button>
        </div>
        {loading ? (
          <p className="text-xs text-muted-foreground"><I18nText id="common.loading" /></p>
        ) : rules.length === 0 && !draftId ? (
          <p className="text-xs text-muted-foreground"><I18nText id="project_rules.empty" /></p>
        ) : (
          <ul className="space-y-2">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded-lg border border-border/60 p-3" data-testid="project-rule-row" data-rule-id={rule.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{rule.name}</p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{rule.body}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Switch checked={rule.enabled} onCheckedChange={() => void toggleEnabled(rule)} data-testid={`project-rule-enabled-${rule.id}`} />
                      <I18nText id="project_rules.enabled" />
                    </label>
                    <Button type="button" size="sm" variant="ghost" onClick={() => startEdit(rule)} data-testid={`project-rule-edit-${rule.id}`}>
                      <I18nText id="common.edit" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void removeRule(rule)} data-testid={`project-rule-delete-${rule.id}`}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {draftId && (
          <div className="space-y-2 rounded-lg border border-dashed border-border p-3" data-testid="project-rule-editor">
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground"><I18nText id="project_rules.name" /></span>
              <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} data-testid="project-rule-name" />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground"><I18nText id="project_rules.body" /></span>
              <Textarea value={draftBody} onChange={(e) => setDraftBody(e.target.value)} rows={6} className="font-mono text-xs" data-testid="project-rule-body" />
            </label>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={saving} onClick={() => void saveDraft()} data-testid="project-rule-save">
                <I18nText id="common.save" />
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={cancelDraft}>
                <I18nText id="common.cancel" />
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="surface-solid space-y-3 rounded-xl border p-4" data-testid="project-knowledge-inheritance">
        <h3 className="text-sm font-medium">{tr("m0.pk.title")}</h3>
        <p className="text-xs text-muted-foreground">
          {tr("m0.pk.intro")}
        </p>
        {inheritLoading ? (
          <p className="text-xs text-muted-foreground"><I18nText id="common.loading" /></p>
        ) : (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={inheritCompany}
                onCheckedChange={(checked) => void saveInheritance({ acceptCompany: checked })}
                data-testid="project-inherit-company"
              />
              {tr("m0.pk.company")}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={inheritCluster}
                onCheckedChange={(checked) => void saveInheritance({ acceptCluster: checked })}
                data-testid="project-inherit-cluster"
              />
              {tr("m0.pk.cluster")}
            </label>
            <Button type="button" size="sm" variant="outline" onClick={() => void previewEffective()} data-testid="project-knowledge-effective-preview">
              {tr("m0.pk.preview")}
            </Button>
            {previewLines.length > 0 ? (
              <ul className="text-[11px] text-muted-foreground" data-testid="project-knowledge-effective-list">
                {previewLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section className="surface-solid flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <div>
          <h3 className="text-sm font-medium"><I18nText id="settings.branch_naming" /></h3>
          <p className="text-xs text-muted-foreground"><I18nText id="tasks.branch_naming_settings_for_this_project" /></p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setBranchOpen(true)} data-testid="project-settings-branch-naming">
          <Settings2 className="size-3.5" aria-hidden /><I18nText id="tasks.configure_branch_naming" />
        </Button>
      </section>

      <BranchNamingDialog
        open={branchOpen}
        onClose={() => setBranchOpen(false)}
        projectPath={project.path}
        projectName={project.name}
        onSaved={(cfg) => setBranchConfig(cfg)}
      />
    </div>
  );
}
