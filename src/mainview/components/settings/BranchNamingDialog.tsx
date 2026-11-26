import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { api, type BranchNamingConfig } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import {
  BRANCH_TEMPLATE_TAGS,
  DEFAULT_BRANCH_CONFIG,
  TASK_TYPES,
  branchPattern,
  renderBranchTemplate,
  validateBranchConfig,
  validateBranchName,
  type TaskType,
} from "@/i18n/options";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Absolute path of the project the config belongs to. */
  projectPath: string;
  /** Display name for the header (defaults to the path basename). */
  projectName?: string;
  /** The task type driving the field that opened this dialog, if any — its
   *  row is visually highlighted so the user sees which rule is in play. */
  activeTaskType?: TaskType;
  /** Called with the saved config so the parent can refresh its preview. */
  onSaved: (config: BranchNamingConfig) => void;
}

/** A representative title used only for the per-type live example. */
const EXAMPLE_TITLE = "Add login page";

/**
 * Per-project branch nomenclature editor. One prefix field per task type plus a
 * global "include card slug" toggle, with the configured pattern + a live
 * example and git-legal validation per row, plus a tags-legend footer. Opened
 * from the config icon button inside the New Task form's branch-name field.
 */
export function BranchNamingDialog({ open, onClose, projectPath, projectName, activeTaskType, onSaved }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [config, setConfig] = useState<BranchNamingConfig>(DEFAULT_BRANCH_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Load the project's stored config (server resolves to defaults when unset).
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setLoading(true);
    api
      .getProjectBranchConfig(projectPath)
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch(() => { if (!cancelled) setConfig(DEFAULT_BRANCH_CONFIG); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  const setPrefix = (typeId: string, prefix: string) =>
    setConfig((c) => ({
      ...c,
      rules: { ...c.rules, [typeId]: { prefix } },
    }));

  const validation = useMemo(() => validateBranchConfig(config), [config, uiLocale]);

  const exampleProjectName = useMemo(
    () => projectName || projectPath.split("/").filter(Boolean).pop() || "project",
    [projectName, projectPath, uiLocale],
  );

  const save = async () => {
    if (!validation.ok) { toast.error(validation.reason); return; }
    setSaving(true);
    try {
      await api.setProjectBranchConfig(projectPath, config);
      toast.success(tr("common.branch_naming_saved"));
      onSaved(config);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-lg"
      labelledBy="branch-naming-title"
      initialFocusRef={firstFieldRef}
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="min-w-0">
          <h2 id="branch-naming-title" className="text-base font-semibold"><I18nText id="settings.branch_naming" />{" "}</h2>
          <p className="truncate text-xs text-muted-foreground" title={projectPath}>
            {projectName || projectPath || tr("common.no_project_selected")}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={tr("common.close")}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-4 pt-4 text-sm">
        <p className="text-xs text-muted-foreground"><I18nText id="settings.when_a_task_runs_isolated_agetor_creates_a" />{" "}</p>

        <section className="space-y-2.5">
          {TASK_TYPES.map((t, i) => {
            const prefix = config.rules[t.id]?.prefix ?? "";
            const pattern = branchPattern(config, t.id);
            const example = renderBranchTemplate(branchPattern(config, t.id), {
              title: EXAMPLE_TITLE,
              projectName: exampleProjectName,
              taskType: t.id,
              token: "a1b2c3",
            });
            const legal = validateBranchName(example).ok;
            const active = activeTaskType === t.id;
            return (
              <div
                key={t.id}
                className={cn(
                  "grid grid-cols-[4.5rem_1fr] items-center gap-2 rounded-md p-1 -m-1",
                  active && "ring-1 ring-primary/50 bg-primary/5",
                )}
              >
                <label className="text-xs text-muted-foreground" htmlFor={`prefix-${t.id}`}>
                  {t.label}
                </label>
                <div className="space-y-0.5">
                  <Input
                    id={`prefix-${t.id}`}
                    ref={i === 0 ? firstFieldRef : undefined}
                    {...IDENTIFIER_INPUT_PROPS}
                    value={prefix}
                    onChange={(e) => setPrefix(t.id, e.target.value)}
                    placeholder="feature/"
                    className="h-8 font-mono text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground"><I18nText id="common.pattern" />{" "}
                    <span className="font-mono text-foreground/70">
                      {pattern}
                    </span>
                  </p>
                  <p
                    className={cn(
                      "text-[10px]",
                      legal ? "text-muted-foreground" : "text-destructive",
                    )}
                  ><I18nText id="settings.e_g" />{" "}<span className="font-mono">{example}</span>
                  </p>
                </div>
              </div>
            );
          })}
        </section>

        <label className="flex items-center justify-between gap-3">
          <span className="min-w-0">
            <span className="text-xs"><I18nText id="settings.include_card_name_in_the_branch" /></span>
            <span className="block text-[10px] text-muted-foreground"><I18nText id="settings.off_branch_body_is_a_short_unique_id" />{" "}</span>
          </span>
          <Switch
            checked={config.includeSlug}
            onCheckedChange={(v) => setConfig((c) => ({ ...c, includeSlug: v }))}
          />
        </label>

        <p className="text-[10px] text-muted-foreground"><I18nText id="settings.tags_are_replaced_when_the_task_is_created" />{" "}
          {BRANCH_TEMPLATE_TAGS.map(({ tag, description }, i) => (
            <span key={tag}>
              <span className="font-mono">{tag}</span> {description}
              {i < BRANCH_TEMPLATE_TAGS.length - 1 ? " · " : "."}
            </span>
          ))}
        </p>

        {!validation.ok && (
          <p className="text-xs text-destructive">{validation.reason}</p>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
          <Button variant="ghost" size="sm" onClick={onClose}><I18nText id="common.cancel" /></Button>
          <Button size="sm" onClick={() => void save()} disabled={loading || saving || !validation.ok}>
            {saving ? tr("common.saving_23e392") : tr("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
