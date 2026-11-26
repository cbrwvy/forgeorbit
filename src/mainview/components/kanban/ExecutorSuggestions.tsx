import { requestOpenAccounts } from "@/lib/open-accounts";
import { evidenceLabel, routingReasonText, staticLabel } from "@/i18n/presentation";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EVIDENCE_TONE, buildPreflightBody, type ExecutionDraft } from "@/lib/employee-execution";
import {
  EXECUTOR_CLASSES,
  type ExecutorClass,
  type ExecutorOption,
  type ExecutorPreferences,
  type RecommendationResponse,
} from "../../../shared/execution/executor-routing.ts";
import { ROUTING_POLICIES } from "../../../shared/model-router/types.ts";
import { AGENT_OPTIONS } from "../../../shared/types.ts";
import { RESOURCE_ROLES, type ResourceRole } from "../../../shared/model-router/account-eligibility.ts";
import { PermissionDisclosureView } from "./PermissionDisclosure";

const CLASS_TONE: Record<ExecutorClass, string> = {
  "verified-eligible": "text-success",
  "potential-unknown": "text-warning",
  blocked: "text-danger",
  unsupported: "text-muted-foreground",
};

const csv = (value: string): string[] => [...new Set(value.split(",").map((x) => x.trim()).filter(Boolean))];

/** Every permission mode id any harness offers, with its first label. Ids are harness-defined; this only lists them. */
function allModes(): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const kind of Object.keys(AGENT_OPTIONS) as (keyof typeof AGENT_OPTIONS)[]) {
    for (const mode of AGENT_OPTIONS[kind].modes) if (!seen.has(mode.id)) seen.set(mode.id, mode.id);
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

export function OptionCard({ option, onChoose, chosen }: { option: ExecutorOption; onChoose?: (option: ExecutorOption) => void; chosen: boolean }) {
  useUILocale();
  return (
    <li
      className="min-w-0 rounded-md border border-border/70 px-2 py-1.5"
      data-testid="executor-option"
      data-harness={option.harnessId}
      data-model={option.modelId}
      data-class={option.classification}
      data-availability={option.availability}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{option.harnessLabel}</span>
        <span className="text-muted-foreground">{option.modelLabel}</span>
        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${EVIDENCE_TONE[option.evidence]}`} data-testid="executor-evidence" data-state={option.evidence}>{evidenceLabel(option.evidence)}</span>
        <span className="text-[10px] text-muted-foreground" data-testid="executor-availability">{tr("routing.availability")}: {tr(`routing.availability.${option.availability}`)}</span>
        {chosen && <span className="text-[10px] font-medium text-info">{tr("routing.selected")}</span>}
      </div>
      {option.resource && <div className="mt-1 space-y-1" data-testid="account-resource-comparison" data-account={option.resource.evidence.account?.id ?? ""} data-eligibility={option.resource.state}>
        <p>{tr("routing02.account")}: {option.resource.evidence.account?.label ?? tr("routing02.unknown")} · {option.resource.evidence.account?.provider ?? option.kind} · {option.kind}</p>
        <p>{tr("routing02.authentication")}: {tr(`routing02.auth.${option.resource.evidence.authentication}`)} · {tr(`routing02.state.${option.resource.state}`)} · {tr(`routing02.role.${option.resource.role}`)}</p>
        <p>{tr("routing02.capabilities")}: {option.resource.evidence.capabilities.map(c => c === "file-modification" ? tr("routing02.file_modification") : c === "read-only" ? tr("routing02.read_only") : c).join(", ") || tr("routing02.unknown")}</p>
        <p>{tr("routing02.quota")}: {option.quota?.length ? option.quota.map(q => q === "Unknown" ? tr("routing02.unknown") : q).join(" · ") : tr("routing02.unknown")}</p>
        <p>{tr("routing02.cost")}: {option.cost ? `${option.cost.money.currency} ${option.cost.money.minor} minor units · ${option.cost.source} · ${option.cost.basis}` : tr("routing02.cost_unknown")}</p>
        <p className="text-muted-foreground">{tr("routing02.usage_note")}</p>
        <ul>{option.resource.reasons.map(r => <li key={r.code} data-code={r.code}>{tr(`routing02.reason.${r.code}` as TranslationKey)}</li>)}</ul>
        {option.resource.evidence.providerRefusal && <ProviderRefusalNotice refusal={option.resource.evidence.providerRefusal} accountLabel={option.resource.evidence.account?.label} modelLabel={option.modelLabel} testId="router-provider-refusal" className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1" onOpenAccount={requestOpenAccounts} />}
        <details><summary className="cursor-pointer">{tr("routing02.fingerprint")}</summary><code className="break-all">{option.harnessId} · {option.resource.evidence.account?.id ?? tr("routing02.unknown")} · {option.resource.evidence.fingerprint ?? tr("routing02.unknown")}</code></details>
        <p className="text-muted-foreground">{tr("routing02.identity_note")}</p>
      </div>}
      {option.evidenceSources.length > 0 && <p className="break-words text-muted-foreground" data-testid="executor-evidence-sources">{option.evidenceSources.join(" · ")}</p>}
      {option.mode && <p className="mt-0.5 text-muted-foreground">{tr("routing.mode")}: {staticLabel(option.mode.label)}</p>}
      {option.why.length > 0 && (
        <ul className="mt-1 list-disc pl-4" data-testid="executor-why">
          {option.why.map((w) => <li key={w.code} data-code={w.code}>{routingReasonText(w)}</li>)}
        </ul>
      )}
      {option.limitations.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-muted-foreground" data-testid="executor-limitations">
          {option.limitations.map((l) => <li key={l.code} data-code={l.code} title={l.message}>{routingReasonText(l)}</li>)}
        </ul>
      )}
      {option.permission && <div className="mt-1"><PermissionDisclosureView disclosure={option.permission} testId="executor-permission" /></div>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {option.selectable && onChoose && (
          <Button type="button" size="sm" variant="outline" data-testid="executor-use" onClick={() => onChoose(option)}>
            {option.classification === "verified-eligible" ? tr("routing.use") : tr("routing.use_unknown")}
          </Button>
        )}
        <span className="text-[10px] text-muted-foreground">{tr("routing.confirmation_required")}</span>
      </div>
    </li>
  );
}

export function PreferencesForm({ harnesses }: { harnesses: readonly { id: string; label: string }[] }) {
  useUILocale();
  const ids = useId();
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preferredHarnessId, setPreferredHarnessId] = useState("");
  const [preferredAccountId, setPreferredAccountId] = useState("");
  const [accounts, setAccounts] = useState<{ id: string; displayName: string }[]>([]);
  const [avoidUnverified, setAvoidUnverified] = useState(false);
  const [preferredModel, setPreferredModel] = useState("");
  const [allowed, setAllowed] = useState("");
  const [forbidden, setForbidden] = useState("");
  const [requiredMode, setRequiredMode] = useState("");
  const [policy, setPolicy] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    void api.accountCore.accounts().then(rows => { if (!cancelled) setAccounts(rows); }).catch(() => {});
    void api.getExecutorPreferences().then(({ preferences: p }) => {
      if (cancelled) return;
      setPreferredHarnessId(p.preferredHarnessId ?? "");
      setPreferredAccountId(p.preferredAccountId ?? "");
      setAvoidUnverified(p.avoidUnverified ?? false);
      setPreferredModel(p.preferredModel ?? "");
      setAllowed((p.allowedHarnessIds ?? []).join(", "));
      setForbidden(p.forbiddenModels.join(", "));
      setRequiredMode(p.requiredMode ?? "");
      setPolicy(p.policy ?? "");
      setLoaded(true);
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [shown]);

  const save = () => {
    const allowedList = csv(allowed);
    const body: ExecutorPreferences = {
      preferredHarnessId: preferredHarnessId || null,
      preferredAccountId: preferredAccountId || null,
      avoidUnverified,
      preferredModel: preferredModel.trim() || null,
      allowedHarnessIds: allowedList.length > 0 ? allowedList : null,
      forbiddenModels: csv(forbidden),
      requiredMode: requiredMode || null,
      policy: (policy || null) as ExecutorPreferences["policy"],
    };
    setStatus(null);
    void api.putExecutorPreferences(body).then(() => setStatus({ ok: true, text: tr("routing.prefs.saved") }))
      .catch((error: unknown) => setStatus({ ok: false, text: error instanceof ApiError || error instanceof Error ? error.message : tr("routing.prefs.failed") }));
  };

  const label = (text: string, child: React.ReactNode) => (
    <label className="flex min-w-0 flex-col gap-1 text-[11px]"><span className="text-muted-foreground">{text}</span>{child}</label>
  );
  return (
    <div className="rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid="executor-prefs">
      <button type="button" className="text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="executor-prefs-toggle" aria-expanded={shown} onClick={() => setShown((v) => !v)}>{tr("routing.prefs.title")}</button>
      {shown && <>
      <p className="mt-1 text-muted-foreground">{tr("routing.prefs.note")}</p>
      <fieldset disabled={!loaded} className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        {label(tr("routing.prefs.preferred_harness"), (
          <Select id={`${ids}-ph`} className="h-8 text-xs" data-testid="executor-prefs-harness" value={preferredHarnessId} onChange={(e) => setPreferredHarnessId(e.target.value)}>
            <option value="">{tr("routing.prefs.any_mode")}</option>
            {harnesses.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </Select>
        ))}
        {label(tr("routing02.preferred_account"), <Select aria-label={tr("routing02.preferred_account")} data-testid="executor-prefs-account" value={preferredAccountId} onChange={e => setPreferredAccountId(e.target.value)}><option value="">{tr("routing.prefs.any_mode")}</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}</Select>)}
        <label><input type="checkbox" data-testid="executor-prefs-avoid-unverified" checked={avoidUnverified} onChange={e => setAvoidUnverified(e.target.checked)} /> {tr("routing02.avoid_unverified")}</label>
        {label(tr("routing.prefs.preferred_model"), <Input className="h-8 text-xs" data-testid="executor-prefs-model" value={preferredModel} onChange={(e) => setPreferredModel(e.target.value)} />)}
        {label(tr("routing.prefs.allowed"), <Input className="h-8 text-xs" data-testid="executor-prefs-allowed" value={allowed} onChange={(e) => setAllowed(e.target.value)} />)}
        {label(tr("routing.prefs.forbidden"), <Input className="h-8 text-xs" data-testid="executor-prefs-forbidden" value={forbidden} onChange={(e) => setForbidden(e.target.value)} />)}
        {label(tr("routing.prefs.required_mode"), (
          <Select id={`${ids}-rm`} className="h-8 text-xs" data-testid="executor-prefs-mode" value={requiredMode} onChange={(e) => setRequiredMode(e.target.value)}>
            <option value="">{tr("routing.prefs.any_mode")}</option>
            {allModes().map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        ))}
        {label(tr("routing.prefs.priority"), (
          <Select id={`${ids}-po`} className="h-8 text-xs" data-testid="executor-prefs-policy" value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="">{tr("routing.prefs.policy.none")}</option>
            {ROUTING_POLICIES.filter((p) => p !== "balanced").map((p) => <option key={p} value={p}>{tr(`routing.prefs.policy.${p}`)}</option>)}
          </Select>
        ))}
      </fieldset>
      <p className="mt-1 text-muted-foreground">{tr("routing.prefs.priority_note")}</p>
      <div className="mt-2 flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="executor-prefs-save" disabled={!loaded} onClick={save}>{tr("routing.prefs.save")}</Button>
        <span role="status" aria-live="polite" className={status?.ok === false ? "text-danger" : "text-muted-foreground"} data-testid="executor-prefs-status">{status?.text ?? ""}</span>
      </div>
      </>}
    </div>
  );
}

/**
 * Executor options for the task (FO-ORCH01). Read-only: choosing an option only fills
 * the harness and model fields above. The Owner still prepares, reviews and confirms.
 */
export function ExecutorSuggestions({ taskId, draft, harnesses, refreshKey, onChoose }: {
  taskId: string;
  draft: ExecutionDraft;
  harnesses: readonly { id: string; label: string }[];
  /** Changes whenever the shown preflight does, so alternatives follow a blocked selection. */
  refreshKey: string;
  onChoose: (harnessId: string, model: string) => void;
}) {
  useUILocale();
  const [role, setRole] = useState<ResourceRole>("developer");
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const load = () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    setRequested(true);
    void api.employeeExecutionRecommendations({ ...buildPreflightBody(taskId, draft, null), role }, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setData(response);
      setLoading(false);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setError(caught instanceof ApiError || caught instanceof Error ? caught.message : tr("routing.failed"));
    });
  };
  // Once the Owner has asked, keep the list in step with the prepared result and the draft.
  useEffect(() => {
    if (!requested) return;
    const timer = setTimeout(load, 250);
    return () => { clearTimeout(timer); abort.current?.abort(); };
  }, [taskId, refreshKey, draft.harnessId, draft.model, draft.effort, draft.complexity, role]);

  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => { setData(null); setError(tr("routing02.expired")); }, Math.max(0, data.recommendations.capturedAt + 30_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [data]);
  const r = data?.recommendations ?? null;
  const chosenId = r?.selection?.optionId ?? null;
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border/70 px-2 py-1.5 text-[11px]" data-testid="executor-suggestions">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">{tr("routing.title")}</h3>
      <p className="text-muted-foreground">{tr("routing.intro")}</p>
      <label>{tr("routing02.role")} <Select data-testid="executor-role" value={role} onChange={e => { abort.current?.abort(); setData(null); setRole(e.target.value as ResourceRole); }}>{RESOURCE_ROLES.map(r => <option key={r} value={r}>{tr(`routing02.role.${r}`)}</option>)}</Select></label>
      <p className="text-muted-foreground">{tr("routing02.advisory")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-testid="executor-suggest" disabled={loading} onClick={load}>
          {loading ? tr("routing.loading") : requested ? tr("routing.refresh") : tr("routing.suggest")}
        </Button>
      </div>
      <div role="status" aria-live="polite">{error && <p className="text-danger" data-testid="executor-error">{error}</p>}</div>
      {r && (
        <div className="flex flex-col gap-2" data-testid="executor-groups" data-automatic={r.automaticSelection}>
          {r.automaticSelection === "none" && <p className="text-warning" data-testid="executor-no-verified">{tr("routing.no_verified")}</p>}
          {r.automaticSelection !== "none" && r.automaticRouter.harnessId && (
            <p data-testid="executor-router-pick">{tr("routing.router_picks")} {r.automaticRouter.harnessId}{r.automaticRouter.modelId ? ` / ${r.automaticRouter.modelId}` : ""}</p>
          )}
          <p>{tr("routing02.captured")}: {new Date(r.capturedAt).toISOString()}</p>
          <p className="text-muted-foreground" data-testid="executor-ordering">{r.ordering.note}</p>
          {EXECUTOR_CLASSES.map((cls) => (
            <div key={cls} data-testid={`executor-group-${cls}`}>
              <h4 className={`text-[10px] font-medium uppercase tracking-wide ${CLASS_TONE[cls]}`}>{tr(`routing.class.${cls}`)} ({r.groups[cls].length})</h4>
              {r.groups[cls].length === 0 ? <p className="text-muted-foreground">{tr("routing.none")}</p> : (
                <ul className="mt-1 flex flex-col gap-1.5">
                  {r.groups[cls].map((option) => (
                    <OptionCard key={option.id} option={option} chosen={option.id === chosenId} onChoose={role === "developer" ? (o) => onChoose(o.harnessId, o.modelId) : undefined} />
                  ))}
                </ul>
              )}
            </div>
          ))}
          {r.selection && r.selection.alternatives.length > 0 && (
            <div data-testid="executor-alternatives">
              <h4 className="text-[10px] font-medium uppercase tracking-wide text-info">{tr("routing.alternatives")}</h4>
              <ul className="mt-1 flex flex-col gap-1.5">
                {r.selection.alternatives.map((option) => (
                  <OptionCard key={option.id} option={option} chosen={false} onChoose={role === "developer" ? (o) => onChoose(o.harnessId, o.modelId) : undefined} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <PreferencesForm harnesses={harnesses} />
    </section>
  );
}
