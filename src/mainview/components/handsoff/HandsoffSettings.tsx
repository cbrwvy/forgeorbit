import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type HandsoffPolicyView } from "@/lib/api";
import { refreshHandsoff } from "@/lib/handsoff-events";
import { HandsoffAuthorizationPanel } from "./HandsoffAuthorizationPanel";
import { ProjectQueueSummary } from "./ProjectQueueSummary";
import { deriveResourceLists, HANDSOFF_LIMITS, hasResource, type HandsoffPolicy } from "../../../shared/handsoff.ts";

interface Props { projectPath: string }

/**
 * One-time setup of "Work independently" for a project. Short by default: what it covers, what it still asks about,
 * and the two choices most people make (which agents may work, and whether a reviewed change is applied to the
 * project folder). Everything else is under Advanced. Saving is the Owner's act; nothing here starts a task.
 */
export function HandsoffSettings({ projectPath }: Props) {
  useUILocale();
  const [view, setView] = useState<HandsoffPolicyView | null>(null);
  const [draft, setDraft] = useState<HandsoffPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoAuthorize, setAutoAuthorize] = useState(false);

  const load = useCallback(async () => {
    const next = await api.getHandsoffPolicy(projectPath);
    setView(next);
    setDraft(next.policy);
  }, [projectPath]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const dirty = useMemo(() => Boolean(view && draft && JSON.stringify(view.policy) !== JSON.stringify(draft)), [view, draft]);
  if (!view || !draft) return <section className="surface-solid rounded-xl border p-4 text-xs text-muted-foreground" data-testid="handsoff-settings">{tr("handsoff.loading")}</section>;

  const patch = (next: Partial<HandsoffPolicy>) => setDraft({ ...draft, ...next });
  const selected = (option: HandsoffPolicyView["available"][number]) => hasResource(draft.resources, option.role, option.harnessId, option.accountKey);
  // One row is one role + harness + account. Ticking or clearing it changes only that pair: another role's row for the
  // same login, or another profile that shares the login, is a separate row with its own choice.
  const toggleOption = (option: HandsoffPolicyView["available"][number], on: boolean) => {
    const others = draft.resources.filter((r) => !(r.role === option.role && r.harnessId === option.harnessId && r.accountKey === option.accountKey));
    const resources = on ? [...others, { role: option.role, harnessId: option.harnessId, accountKey: option.accountKey }] : others;
    patch({ resources, ...deriveResourceLists(resources) });
  };
  // Turning it on never chooses resources for the Owner: nothing is covered until a row is ticked.
  const toggleEnabled = (enabled: boolean) => patch({ enabled });

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const { harnessIds: _h, accountIds: _a, ...body } = draft;
      const next = await api.saveHandsoffPolicy(projectPath, body as HandsoffPolicy);
      setView(next);
      setDraft(next.policy);
      refreshHandsoff();
      toast.success(tr("handsoff.saved"));
      // Saving settings that need the Owner's confirmation opens it once, right now. Cancelling it leaves the saved
      // settings in place and the previous authorization exactly as it was.
      setAutoAuthorize(next.policy.enabled && next.authorization.required);
    } catch (error) {
      toast.error(tr("handsoff.save_failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  }

  const check = (id: string, label: string, checked: boolean, onChange: (value: boolean) => void) => (
    <label className="flex items-start gap-2 text-xs" key={id}>
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid={id} />
      <span>{label}</span>
    </label>
  );

  return (
    <section className="surface-solid space-y-3 rounded-xl border p-4" data-testid="handsoff-settings" data-enabled={draft.enabled ? "true" : "false"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium">{tr("handsoff.title")}</h3>
          <p className="text-xs text-muted-foreground">{tr("handsoff.hint")}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
          <Switch checked={draft.enabled} onCheckedChange={toggleEnabled} data-testid="handsoff-enable" aria-label={tr("handsoff.enable")} />
          <span>{tr("handsoff.enable")}</span>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">{tr("handsoff.covers")}</p>
      <p className="text-[11px] text-muted-foreground">{tr("handsoff.still_asks")}</p>
      <p className="text-[11px] text-muted-foreground">{tr("handsoff.enable_note")}</p>

      <fieldset className="space-y-1.5" data-testid="handsoff-resources">
        <legend className="text-xs font-medium">{tr("handsoff.resources")}</legend>
        {view.available.length === 0 ? <p className="text-xs text-muted-foreground">{tr("handsoff.resources_none")}</p> : view.available.map((option) => check(
          `handsoff-resource-${option.role}-${option.harnessId}-${option.accountKey}`,
          `${tr(option.role === "developer" ? "handsoff.role_developer" : "handsoff.role_reviewer")}: ${option.harnessLabel} · ${option.accountLabel}`,
          selected(option), (on) => toggleOption(option, on),
        ))}
      </fieldset>

      <div className="space-y-1.5">
        {check("handsoff-auto-apply", tr("handsoff.apply"), draft.autoApply, (on) => patch({ autoApply: on }))}
        <p className="pl-6 text-[11px] text-muted-foreground">{tr("handsoff.apply_hint")}</p>
        {check("handsoff-auto-done", tr("handsoff.done"), draft.autoDone, (on) => patch({ autoDone: on }))}
      </div>

      <details className="rounded-md border border-border/60 px-2 py-1.5" data-testid="handsoff-advanced">
        <summary className="cursor-pointer text-xs font-medium">{tr("handsoff.advanced")}</summary>
        <div className="mt-2 space-y-2">
          {check("handsoff-auto-assign", tr("handsoff.auto_assign"), draft.autoAssign, (on) => patch({ autoAssign: on }))}
          {check("handsoff-run-tests", tr("handsoff.run_tests"), draft.runOfflineTests, (on) => patch({ runOfflineTests: on }))}
          {check("handsoff-require-test", tr("handsoff.require_test"), draft.requireTest, (on) => patch({ requireTest: on }))}
          {check("handsoff-usage-notice", tr("handsoff.usage_notice"), draft.acknowledgeUsageNotice, (on) => patch({ acknowledgeUsageNotice: on }))}
          <label className="flex items-center gap-2 text-xs">
            <span>{tr("handsoff.fix_rounds")}</span>
            <select className="rounded-md border bg-background px-1.5 py-0.5" value={draft.maxFixRounds} onChange={(event) => patch({ maxFixRounds: Number(event.target.value) })} data-testid="handsoff-fix-rounds">
              {Array.from({ length: HANDSOFF_LIMITS.maxFixRounds + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span>{tr("handsoff.parallel")}</span>
            <select className="rounded-md border bg-background px-1.5 py-0.5" value={draft.maxParallel} onChange={(event) => patch({ maxParallel: Number(event.target.value) })} data-testid="handsoff-parallel">
              {Array.from({ length: HANDSOFF_LIMITS.maxParallel }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
            </select>
          </label>
        </div>
      </details>

      <HandsoffAuthorizationPanel
        projectPath={projectPath}
        authorization={view.authorization}
        policyEnabled={view.policy.enabled && !dirty}
        onChanged={load}
        autoAuthorize={autoAuthorize}
        onAutoAuthorizeHandled={() => setAutoAuthorize(false)}
      />

      {view.policy.enabled && <ProjectQueueSummary projectPath={projectPath} variant="card" />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground" data-testid="handsoff-revision">{view.revision > 0 ? tr("handsoff.revision", { revision: view.revision }) : ""}</span>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!dirty || saving} data-testid="handsoff-save">{tr("handsoff.save")}</Button>
      </div>
    </section>
  );
}
