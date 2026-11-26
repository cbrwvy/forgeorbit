/**
 * Owner controls for Supervised, Autonomous, and Full Autonomy.
 * Choosing a mode only edits the draft. The backend activates a saved revision.
 *
 * FO-UX-SIMPLIFY02-M4: the policy form (Settings → Autonomy and safety) and the
 * mission-start form (Missions) are separate components that read the same status.
 * Nothing here saves, activates or starts anything except the explicit buttons.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t as tr } from "@/i18n/core";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { api } from "@/lib/api";
import { missionStatusText } from "@/lib/status-presenters";
import { emergencyStore, requestEmergencyStop } from "@/lib/emergency-stop";
import { useClearEmergencyWithConfirm } from "@/components/EmergencyStopControl";
import type { AutonomyMode } from "../../../shared/autonomy-policy.ts";
import { buildAutonomyDraft, parseMissionTaskLines, type AutonomyDraftFields } from "@/lib/autonomy-draft";

type Status = Awaited<ReturnType<typeof api.autonomyStatus>>;

const MODES: AutonomyMode[] = ["supervised", "autonomous", "full-autonomy"];

const INITIAL: AutonomyDraftFields = {
  mode: "supervised",
  projects: "",
  providers: "codex",
  models: "gpt-6.1-sol",
  accounts: "",
  allowUnscopedAccount: false,
  workers: "2",
  launches: "12",
  minutes: "60",
  rework: "1",
  requireObservedTest: false,
  requireIndependentReviewer: true,
  autoComplete: false,
  permitSelfImprovement: false,
  testCommand: "bun test ./src/add.test.ts",
  outputPath: "src/add.ts",
};

/** Reads the autonomy status; re-reads when the title-bar emergency state changes and when the window regains focus. */
export function useAutonomyStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await api.autonomyStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Autonomy status unavailable.");
    }
  }, []);
  // The title bar can stop or resume too: re-read whenever the shared emergency state changes.
  const emergencyPhase = useSyncExternalStore(emergencyStore.subscribe, () => emergencyStore.getSnapshot().phase, () => emergencyStore.getSnapshot().phase);
  useEffect(() => {
    void load();
  }, [load, emergencyPhase]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);
  return { status, error, setError, load };
}

function activePolicyOf(status: Status | null) {
  return (status?.policies ?? []).find((policy) => policy.status === "active" && policy.mode !== "supervised");
}

export function AutonomyPolicyPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { status, error, setError, load } = useAutonomyStatus();
  const [fields, setFields] = useState<AutonomyDraftFields>(INITIAL);
  const [draft, setDraft] = useState<{ id: string; revision: number; digest: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const clearWithConfirm = useClearEmergencyWithConfirm();
  // A form with edits that no saved draft covers is "unsaved"; Settings asks before closing over it.
  const dirty = !draft && JSON.stringify(fields) !== JSON.stringify(INITIAL);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const enforced = status?.enforcement.fullAutonomyActive
    ? "full"
    : status?.enforcement.autonomousActive
      ? "autonomous"
      : "supervised";
  const preview = buildAutonomyDraft(fields);

  function edit(patch: Partial<AutonomyDraftFields>) {
    setDraft(null);
    setFields((current) => ({ ...current, ...patch }));
  }

  async function saveDraft() {
    setError(null);
    const built = buildAutonomyDraft(fields);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      const created = await api.createAutonomyPolicy(built.body);
      setDraft({ id: created.policy.id, revision: created.policy.revision, digest: created.policy.digest });
      await load();
    } catch (cause) {
      setDraft(null);
      setError(cause instanceof Error ? cause.message : "The policy draft was not saved.");
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!draft) {
      setError(tr("autonomy.draft_first"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.activateAutonomyPolicy(draft.id, draft.revision);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Policy was not activated.");
    } finally {
      setBusy(false);
    }
  }

  async function policyAction(id: string, action: "pause" | "resume" | "revoke") {
    setError(null);
    try {
      if (action === "pause") await api.pauseAutonomyPolicy(id);
      else if (action === "resume") await api.resumeAutonomyPolicy(id);
      else await api.revokeAutonomyPolicy(id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The policy action was refused.");
    }
  }

  return (
    <section className="space-y-3" data-testid="autonomy-control-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ds-meta" data-testid="autonomy-enforced-label">{tr("settings.layers.enforced_title")}</span>
        <span
          className="rounded-full border border-border px-2 py-0.5 text-[11px]"
          data-testid="autonomy-enforcement-status"
        >
          {enforced === "full"
            ? tr("autonomy.enforced.full")
            : enforced === "autonomous"
              ? tr("autonomy.enforced.autonomous")
              : tr("autonomy.enforced.supervised")}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((item) => (
          <button
            key={item}
            type="button"
            className={`rounded border px-2 py-1 text-xs ${fields.mode === item ? "border-primary bg-primary/10" : "border-border"}`}
            data-testid={`autonomy-mode-${item}`}
            onClick={() => edit({ mode: item })}
          >
            {item === "full-autonomy" ? tr("autonomy.full") : item === "autonomous" ? tr("autonomy.autonomous") : tr("autonomy.supervised")}
          </button>
        ))}
      </div>
      {fields.mode === "full-autonomy" && !status?.enforcement.fullAutonomyActive && (
        <p className="text-[11px] text-muted-foreground" data-testid="autonomy-full-not-active">{tr("autonomy.not_active")}</p>
      )}
      <label className="block text-[11px] text-muted-foreground">
        {tr("autonomy.projects")}
        <textarea className="mt-1 w-full rounded border border-border bg-background p-2 text-xs" rows={2} value={fields.projects} onChange={(event) => edit({ projects: event.target.value })} data-testid="autonomy-projects" aria-label={tr("autonomy.projects")} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">{tr("autonomy.providers")}
          <Input value={fields.providers} onChange={(event) => edit({ providers: event.target.value })} className="mt-1 h-8 text-xs" data-testid="autonomy-providers" aria-label={tr("autonomy.providers")} />
        </label>
        <label className="text-[11px] text-muted-foreground">{tr("autonomy.models")}
          <Input value={fields.models} onChange={(event) => edit({ models: event.target.value })} className="mt-1 h-8 text-xs" data-testid="autonomy-models" aria-label={tr("autonomy.models")} />
        </label>
      </div>
      <label className="block text-[11px] text-muted-foreground">{tr("autonomy.accounts")}
        <Input value={fields.accounts} onChange={(event) => edit({ accounts: event.target.value })} className="mt-1 h-8 text-xs" data-testid="autonomy-accounts" aria-label={tr("autonomy.accounts")} placeholder={tr("autonomy.accounts_hint")} />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.allowUnscopedAccount} onChange={(event) => edit({ allowUnscopedAccount: event.target.checked })} data-testid="autonomy-unscoped" />
        {tr("autonomy.unscoped")}
      </label>
      <label className="block text-[11px] text-muted-foreground">{tr("autonomy.limits")}
        <span className="mt-1 flex gap-2">
          <Input value={fields.workers} onChange={(event) => edit({ workers: event.target.value })} className="h-8 text-xs" data-testid="autonomy-workers" aria-label={tr("autonomy.workers")} />
          <Input value={fields.launches} onChange={(event) => edit({ launches: event.target.value })} className="h-8 text-xs" data-testid="autonomy-launches" aria-label={tr("autonomy.launches")} />
          <Input value={fields.minutes} onChange={(event) => edit({ minutes: event.target.value })} className="h-8 text-xs" data-testid="autonomy-minutes" aria-label={tr("autonomy.minutes")} />
          <Input value={fields.rework} onChange={(event) => edit({ rework: event.target.value })} className="h-8 text-xs" data-testid="autonomy-rework" aria-label={tr("autonomy.rework")} />
        </span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-muted-foreground">{tr("usage.expectedBudget")}
          <Input type="number" min={1} value={fields.expectedMinutes ?? ""} onChange={event => edit({ expectedMinutes: event.target.value })} className="mt-1 h-8 text-xs" />
        </label>
        <label className="text-[11px] text-muted-foreground">{tr("usage.spendBudget")}
          <Input type="number" min={0} step="any" value={fields.apiBudget ?? ""} onChange={event => edit({ apiBudget: event.target.value })} className="mt-1 h-8 text-xs" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.hardSpendCap ?? false} onChange={event => edit({ hardSpendCap: event.target.checked })} />
        {tr("usage.hardSpend")}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.requireVerifiedQuota ?? false} onChange={event => edit({ requireVerifiedQuota: event.target.checked })} />
        {tr("usage.verifiedQuota")}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.requireObservedTest} onChange={(event) => edit({ requireObservedTest: event.target.checked })} data-testid="autonomy-observed" />
        {tr("autonomy.observed")}
      </label>
      {fields.requireObservedTest && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] text-muted-foreground">{tr("autonomy.test_command")}
            <Input value={fields.testCommand} onChange={(event) => edit({ testCommand: event.target.value })} className="mt-1 h-8 text-xs" data-testid="autonomy-test-command" aria-label={tr("autonomy.test_command")} />
          </label>
          <label className="text-[11px] text-muted-foreground">{tr("autonomy.output_path")}
            <Input value={fields.outputPath} onChange={(event) => edit({ outputPath: event.target.value })} className="mt-1 h-8 text-xs" data-testid="autonomy-output-path" aria-label={tr("autonomy.output_path")} />
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.requireIndependentReviewer} onChange={(event) => edit({ requireIndependentReviewer: event.target.checked })} data-testid="autonomy-qc" />
        {tr("autonomy.qc")}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.autoComplete} onChange={(event) => edit({ autoComplete: event.target.checked })} data-testid="autonomy-autocomplete" />
        {tr("autonomy.autocomplete")}
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={fields.permitSelfImprovement} onChange={(event) => edit({ permitSelfImprovement: event.target.checked })} data-testid="autonomy-self-improve" />
        {tr("autonomy.self_improve")}
      </label>
      <p className="text-[11px] text-muted-foreground" data-testid="autonomy-draft-actions">
        {tr("autonomy.actions")}: {preview.ok ? preview.body.permittedActions.join(", ") : "—"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => void saveDraft()} data-testid="autonomy-save-draft">{tr("autonomy.save_draft")}</Button>
        <Button size="sm" className="h-8 text-xs" disabled={busy || !draft} onClick={() => void activate()} data-testid="autonomy-activate">{tr("autonomy.activate")}</Button>
        <Button size="sm" variant="destructive" className="h-8 text-xs" onClick={() => void requestEmergencyStop(tr("mc.emergencyReason")).then((ok) => { if (!ok) setError(tr("mc.emergencyFailed")); return load(); })} data-testid="autonomy-emergency">
          <ShieldAlert className="size-3.5" /> {tr("autonomy.emergency")}
        </Button>
        {status?.emergency.active && (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void clearWithConfirm().then(load)} data-testid="autonomy-clear-emergency">
            {tr("autonomy.clear_emergency")}
          </Button>
        )}
      </div>
      {draft && (
        <div className="text-[11px] text-muted-foreground" data-testid="autonomy-digest">
          {tr("m0.rev", { revision: draft.revision })}
          <TechnicalDetails className="mt-1" rows={[{ label: tr("autonomy.digest"), value: draft.digest }]} />
        </div>
      )}
      {status?.emergency.active && (
        <p className="text-xs text-warning" role="status" data-testid="autonomy-emergency-active">
          {tr("autonomy.emergency_active", { count: status.emergency.outstanding.length })}
        </p>
      )}
      <div className="space-y-1" data-testid="autonomy-policy-list">
        {(status?.policies ?? []).map((policy) => (
          <div key={`${policy.id}:${policy.revision}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/70 px-2 py-1 text-[11px]" data-testid="autonomy-policy-row">
            <span>{tr("m0.policyRow", { mode: policy.mode, revision: policy.revision, status: policy.status })}</span>
            <TechnicalDetails rows={[{ label: tr("autonomy.digest"), value: policy.digest }]} />
            <span className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => void policyAction(policy.id, "pause")} data-testid="autonomy-pause">{tr("autonomy.pause")}</Button>
              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => void policyAction(policy.id, "resume")} data-testid="autonomy-resume">{tr("autonomy.resume")}</Button>
              <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => void policyAction(policy.id, "revoke")} data-testid="autonomy-revoke">{tr("autonomy.revoke")}</Button>
            </span>
          </div>
        ))}
      </div>
      <div data-testid="autonomy-decisions">
        <div className="text-[11px] font-medium text-muted-foreground">{tr("autonomy.decisions")}</div>
        {(status?.decisions ?? []).slice(0, 6).map((decision) => (
          <p key={decision.id} className="truncate text-[11px] text-muted-foreground">
            {tr("m0.decisionRow", { verdict: decision.verdict, action: decision.action, policy: decision.policyId ?? tr("m0.noPolicy"), revision: decision.revision ?? "-" })}
          </p>
        ))}
      </div>
      {error && <p className="text-xs text-danger" role="alert" data-testid="autonomy-error">{error}</p>}
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <ShieldCheck className="size-3" /> {tr("autonomy.not_billing")}
      </p>
    </section>
  );
}

export function AutonomyMissionStart({ onMissionStarted, onOpenPolicySettings }: { onMissionStarted?: () => void; onOpenPolicySettings?: () => void }) {
  const { status, error, setError, load } = useAutonomyStatus();
  const [missionTitle, setMissionTitle] = useState("");
  const [missionGoal, setMissionGoal] = useState("");
  const [missionTasks, setMissionTasks] = useState("");
  const [missionSummary, setMissionSummary] = useState<{ title: string; status: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const activePolicy = activePolicyOf(status);

  async function startMission() {
    if (!activePolicy) {
      setError(tr("autonomy.mission_needs_policy"));
      return;
    }
    const parsed = parseMissionTaskLines(missionTasks);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!missionTitle.trim() || !missionGoal.trim()) {
      setError(tr("autonomy.mission_needs_text"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const started = await api.prepareAutonomyMission({
        policyId: activePolicy.id,
        title: missionTitle.trim(),
        goal: missionGoal.trim(),
        proposals: parsed.tasks,
      });
      setMissionSummary({ title: started.mission.title, status: started.mission.status, id: started.mission.id });
      onMissionStarted?.();
      await load();
    } catch (cause) {
      setMissionSummary(null);
      setError(cause instanceof Error ? cause.message : "The mission was not started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ds-panel space-y-3 p-4" data-testid="autonomy-mission-section">
      <h2 className="ds-section-title">{tr("missions.controls_start")}</h2>
      <div className="space-y-2 rounded-md border border-border/70 p-3" data-testid="autonomy-mission-form">
        <div className="text-xs font-medium">{tr("autonomy.mission")}</div>
        <Input value={missionTitle} onChange={(event) => setMissionTitle(event.target.value)} className="h-8 text-xs" data-testid="autonomy-mission-title" aria-label={tr("autonomy.mission_title")} placeholder={tr("autonomy.mission_title")} />
        <textarea className="w-full rounded border border-border bg-background p-2 text-xs" rows={2} value={missionGoal} onChange={(event) => setMissionGoal(event.target.value)} data-testid="autonomy-mission-goal" aria-label={tr("autonomy.mission_goal")} placeholder={tr("autonomy.mission_goal")} />
        <textarea className="w-full rounded border border-border bg-background p-2 font-mono text-[11px]" rows={3} value={missionTasks} onChange={(event) => setMissionTasks(event.target.value)} data-testid="autonomy-mission-tasks" aria-label={tr("autonomy.mission_tasks")} placeholder={tr("autonomy.mission_tasks_hint")} />
        <p className="text-[11px] text-muted-foreground">{tr("autonomy.mission_help")}</p>
        <Button size="sm" className="h-8 text-xs" disabled={busy || !activePolicy} onClick={() => void startMission()} data-testid="autonomy-mission-start">{tr("autonomy.mission_start")}</Button>
        {missionSummary && (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground" data-testid="autonomy-mission-summary">{missionSummary.title} · {missionStatusText(missionSummary.status)}</p>
            <TechnicalDetails summary={tr("mc.missionTech")} rows={[{ label: tr("mc.missionId"), value: missionSummary.id }, { label: tr("mc.statusRaw"), value: missionSummary.status }]} />
          </div>
        )}
      </div>
      {!activePolicy && status && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="autonomy-mission-needs-policy">
          <span>{tr("missions.start_needs_policy")}</span>
          {onOpenPolicySettings && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onOpenPolicySettings} data-testid="autonomy-mission-open-policy">{tr("missions.start_open_policy")}</Button>
          )}
        </div>
      )}
      {error && <p className="text-xs text-danger" role="alert" data-testid="autonomy-mission-error">{error}</p>}
    </section>
  );
}
