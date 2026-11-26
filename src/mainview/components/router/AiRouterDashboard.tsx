/**
 * FO-ROUTING04: AI Router 2.0 — Owner Dashboard & Control Panel
 */

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { en } from "@/i18n/en";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { routerV2Api } from "@/lib/router-v2-api";
import { api } from "@/lib/api";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import { candidateAvailability, candidateSignedIn, capacityReading, otherEligibleOption, type CandidateAvailability, type CapacityReading } from "@/lib/router-candidate-state";
import { NO_QUALIFIER_CATEGORIES, summarizeNoQualifier } from "../../../shared/router-v2/no-qualifier.ts";
import {
  type CandidateEvaluation,
  type DimensionScore,
  type EvidenceClass,
  type ProjectRouterPolicyConfig,
  type RouterAutonomyMode,
  type RouterPolicyPreset,
  type RouterQuotaPolicy,
  type RoutingDecisionRecord,
  DEFAULT_PRESET_WEIGHTS,
  DEFAULT_ROUTER_POLICY,
  POLICY_PRESETS,
} from "../../../shared/router-v2/types.ts";

function EvidenceBadge({ evidence, label }: { evidence: EvidenceClass; label: string }) {
  const styles: Record<EvidenceClass, string> = {
    verified: "bg-success/10 text-success border-success/30",
    estimated: "bg-info/10 text-info border-info/30",
    configured: "bg-muted text-foreground border-border",
    unknown: "bg-warning/10 text-warning border-warning/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${styles[evidence]}`}
      data-testid={`evidence-badge-${evidence}`}
    >
      <span>{label}</span>
    </span>
  );
}

const READINESS_LABELS: Record<string, TranslationKey> = {
  installed: "routing_v2.readiness.installed",
  authenticated: "routing_v2.readiness.authenticated",
  "model-discoverable": "routing_v2.readiness.discoverable",
  "runtime-incompatible": "routing_v2.readiness.runtime_incompatible",
  executable: "routing_v2.readiness.executable",
  "verified-ready": "routing_v2.readiness.verified_ready",
};

function ReadinessBadge({ readiness }: { readiness: string }) {
  const isReady = readiness === "verified-ready";
  const labelKey = READINESS_LABELS[readiness];
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium ${
        isReady
          ? "bg-success/15 text-success border-success/30"
          : "bg-muted text-muted-foreground border-border"
      }`}
      data-testid={`readiness-badge-${readiness}`}
    >
      {labelKey ? tr(labelKey) : readiness}
    </span>
  );
}

const AVAILABILITY_LABELS: Record<CandidateAvailability, TranslationKey> = {
  refused: "routing_v2.state.refused",
  ineligible: "routing_v2.state.ineligible",
  unverified: "routing_v2.state.unverified",
  verified: "routing_v2.state.verified",
};
const AVAILABILITY_STYLES: Record<CandidateAvailability, string> = {
  refused: "bg-warning/15 text-warning border-warning/40",
  ineligible: "bg-muted text-muted-foreground border-border",
  unverified: "bg-info/10 text-info border-info/30",
  verified: "bg-success/15 text-success border-success/30",
};

const CAPACITY_LABELS: Record<CapacityReading, TranslationKey> = {
  shortfall: "routing_v2.capacity.shortfall",
  verified: "routing_v2.capacity.verified",
  unverified: "routing_v2.capacity.unverified",
  unknown: "routing_v2.capacity.unknown",
};
const CAPACITY_STYLES: Record<CapacityReading, string> = {
  shortfall: "bg-danger/10 text-danger border-danger/30",
  verified: "bg-success/15 text-success border-success/30",
  unverified: "bg-info/10 text-info border-info/30",
  unknown: "bg-muted text-muted-foreground border-border",
};

/** The Owner's reading of one candidate: signed in or not, refused / ineligible / unverified / verified, and its capacity on its own. */
function CandidateStateBadges({ candidate, testId }: { candidate: CandidateEvaluation; testId: string }) {
  const state = candidateAvailability(candidate);
  const capacity = capacityReading(candidate);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid={testId}>
      {candidateSignedIn(candidate) && (
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" data-testid={`${testId}-signed-in`}>{tr("routing_v2.signed_in")}</span>
      )}
      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${AVAILABILITY_STYLES[state]}`} data-testid={`${testId}-state`} data-state={state}>
        {tr(AVAILABILITY_LABELS[state])}
      </span>
      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${CAPACITY_STYLES[capacity]}`} data-testid={`${testId}-capacity`} data-capacity={capacity}>
        {tr("routing_v2.capacity.label")}: {tr(CAPACITY_LABELS[capacity])}
      </span>
    </span>
  );
}

export function AiRouterDashboard({ projectPath, onOpenAccount }: { projectPath?: string; onOpenAccount?: () => void }) {
  useUILocale();
  const [policy, setPolicy] = useState<ProjectRouterPolicyConfig>(DEFAULT_ROUTER_POLICY);
  const [history, setHistory] = useState<RoutingDecisionRecord[]>([]);
  const [previewCandidates, setPreviewCandidates] = useState<{
    selected: CandidateEvaluation | null;
    eligible: CandidateEvaluation[];
    ineligible: CandidateEvaluation[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [enforcedMode, setEnforcedMode] = useState<"supervised" | "autonomous" | "full-autonomy">("supervised");

  const scopeId = projectPath ?? "global";
  const otherOption = otherEligibleOption(previewCandidates?.selected ?? null, previewCandidates?.eligible ?? []);
  const noQualifier = previewCandidates && !previewCandidates.selected ? summarizeNoQualifier(previewCandidates.ineligible) : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pol, autonomy, hist] = await Promise.all([
        routerV2Api.getPolicy(scopeId),
        api.autonomyStatus().catch(() => null),
        routerV2Api.getHistory(30),
      ]);
      setPolicy(pol);
      setHistory(hist);
      if (autonomy) {
        setEnforcedMode(
          autonomy.enforcement.fullAutonomyActive
            ? "full-autonomy"
            : autonomy.enforcement.autonomousActive
              ? "autonomous"
              : "supervised",
        );
      }

      // Perform a preview evaluation
      const evalRes = await routerV2Api.evaluateTask({
        taskId: "preview-task",
        projectId: scopeId,
        title: "Architecture & Implementation Task",
        type: "backend",
        complexity: "high",
        role: "developer",
      });
      setPreviewCandidates(evalRes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSavePolicy() {
    setSaving(true);
    setError(null);
    setSuccessNote(null);
    try {
      const saved = await routerV2Api.savePolicy(policy);
      setPolicy(saved);
      setSuccessNote("Policy saved successfully.");
      setTimeout(() => setSuccessNote(null), 3000);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function handleSelectPreset(preset: RouterPolicyPreset) {
    const nextWeights = DEFAULT_PRESET_WEIGHTS[preset];
    setPolicy((prev) => ({
      ...prev,
      preset,
      weights: nextWeights,
    }));
  }

  return (
    <div className="space-y-6 text-sm" data-testid="ai-router-v2-dashboard">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{tr("routing_v2.title")}</h2>
          <p className="text-xs text-muted-foreground">{tr("routing_v2.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {successNote && <span className="text-xs text-success font-medium">{successNote}</span>}
          <Button
            size="sm"
            disabled={saving || loading}
            onClick={() => void handleSavePolicy()}
            data-testid="router-v2-save-policy"
          >
            {saving ? "Saving..." : tr("routing_v2.save_policy")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {/* Policy Presets */}
      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {tr("routing_v2.preset.label")}
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
          {POLICY_PRESETS.map((p) => {
            const isSelected = policy.preset === p;
            return (
              <button
                key={p}
                type="button"
                className={`flex flex-col items-center justify-center rounded-md border p-2.5 text-center transition-all ${
                  isSelected
                    ? "border-primary bg-primary/10 text-primary font-medium ring-1 ring-primary"
                    : "border-border/70 hover:bg-muted/50 text-foreground"
                }`}
                onClick={() => handleSelectPreset(p)}
                data-testid={`policy-preset-${p}`}
                data-selected={isSelected ? "true" : "false"}
              >
                <span className="text-xs">{tr(`routing_v2.preset.${p.replace("-", "_")}` as any)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quota Policy & Autonomy Mode */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 rounded-md border border-border/70 p-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tr("routing_v2.quota_policy.label")}
          </label>
          <div className="flex gap-2">
            {(["permissive", "strict"] as RouterQuotaPolicy[]).map((qp) => (
              <button
                key={qp}
                type="button"
                className={`flex-1 rounded border py-1.5 text-xs ${
                  policy.quotaPolicy === qp
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-border hover:bg-muted/40 text-muted-foreground"
                }`}
                onClick={() => setPolicy((prev) => ({ ...prev, quotaPolicy: qp }))}
                data-testid={`quota-policy-${qp}`}
              >
                {tr(`routing_v2.quota_policy.${qp}` as any)}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground pt-1">
            {policy.quotaPolicy === "strict"
              ? tr("routing_v2.quota_policy.strict_detail")
              : tr("routing_v2.quota_policy.permissive_detail")}
          </p>
        </div>

        <div className="space-y-1.5 rounded-md border border-border/70 p-3">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tr("routing_v2.autonomy_mode.label")}
          </label>
          <div className="flex gap-1.5">
            {(["supervised", "autonomous", "full-autonomy"] as RouterAutonomyMode[]).map((am) => {
              return (
                <button
                  key={am}
                  type="button"
                  className={`flex-1 rounded border py-1.5 text-xs ${
                    policy.autonomyMode === am
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-border hover:bg-muted/40 text-muted-foreground"
                  }`}
                  onClick={() => setPolicy((prev) => ({ ...prev, autonomyMode: am }))}
                  data-testid={`router-preference-${am}`}
                >
                  {tr(`router.mode.${am}` as TranslationKey)}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground pt-1" data-testid="router-autonomy-enforcement">
            {tr("router.enforcement", { preference: tr(`router.mode.${policy.autonomyMode}` as TranslationKey), enforced: tr(`router.mode.${enforcedMode}` as TranslationKey) })}
          </p>
        </div>
      </div>

      {/* Custom Weights Sliders if preset === 'custom' */}
      {policy.preset === "custom" && (
        <div className="rounded-md border border-border/70 p-3 space-y-3" data-testid="custom-weights-editor">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("router.customWeights")}</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {(["quality", "cost", "latency", "quota", "history"] as const).map((dim) => (
              <div key={dim} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{tr(`router.dim.${dim}` as TranslationKey)}</span>
                  <span className="font-mono text-muted-foreground">{policy.weights[dim]}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={policy.weights[dim]}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setPolicy((prev) => ({
                      ...prev,
                      weights: { ...prev.weights, [dim]: val },
                    }));
                  }}
                  className="w-full accent-primary"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Candidate Recommendations Preview */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {tr("routing_v2.candidate.selected")}
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="router-recommendation-boundary">{tr("routing_v2.recommendation_boundary")}</p>
        <p className="text-xs text-muted-foreground" data-testid="router-fallback-boundary">{tr("routing_v2.fallback_boundary")}</p>
        <p className="text-xs text-muted-foreground" data-testid="router-quality-note">{tr("routing_v2.quality_note")}</p>

        {previewCandidates?.selected ? (
          <div
            className="rounded-lg border border-primary/40 bg-card/60 p-4 shadow-sm"
            data-testid="selected-candidate-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-3">
              <div>
                <span className="text-base font-semibold text-foreground">
                  {previewCandidates.selected.harnessLabel} · {previewCandidates.selected.modelLabel}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  ({previewCandidates.selected.modeLabel})
                </span>
                {previewCandidates.selected.accountLabel && (
                  <span className="ml-2 text-xs font-medium text-primary">
                    [{previewCandidates.selected.accountLabel}]
                  </span>
                )}
                <p className="mt-1 text-xs text-muted-foreground" data-testid="router-account-frozen">{tr("routing_v2.account_frozen")}</p>
              </div>
              <div className="flex items-center gap-2">
                <ReadinessBadge readiness={previewCandidates.selected.readiness} />
                <span className="rounded-full bg-primary/20 px-2.5 py-0.5 font-mono text-xs font-bold text-primary">
                  {tr("router.score")} {previewCandidates.selected.scores.totalScore}/100
                </span>
              </div>
            </div>

            <div className="mt-2 space-y-2" data-testid="router-selected-availability">
              <CandidateStateBadges candidate={previewCandidates.selected} testId="router-selected-state" />
              {previewCandidates.selected.providerRefusal && (
                <ProviderRefusalNotice
                  refusal={previewCandidates.selected.providerRefusal}
                  accountLabel={previewCandidates.selected.accountLabel}
                  modelLabel={previewCandidates.selected.modelLabel}
                  testId="router-v2-provider-refusal"
                  className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs"
                  onOpenAccount={onOpenAccount}
                />
              )}
              {otherOption && (
                <p className="text-xs text-muted-foreground" data-testid="router-other-eligible">
                  {tr("routing_v2.other_eligible", {
                    resource: `${otherOption.harnessLabel} · ${otherOption.modelLabel}${otherOption.accountLabel ? ` [${otherOption.accountLabel}]` : ""}`,
                    state: tr(AVAILABILITY_LABELS[candidateAvailability(otherOption)]),
                  })}
                </p>
              )}
            </div>

            {/* Score Breakdown Grid */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
              <div className="space-y-1 rounded border border-border/50 bg-background/50 p-2">
                <div className="text-muted-foreground">{tr("routing_v2.score.quality")}</div>
                <div className="font-mono font-semibold">{previewCandidates.selected.scores.quality.score}/100</div>
                <EvidenceBadge
                  evidence={previewCandidates.selected.scores.quality.evidence}
                  label={previewCandidates.selected.scores.quality.tier ?? "Tier"}
                />
              </div>

              <div className="space-y-1 rounded border border-border/50 bg-background/50 p-2">
                <div className="text-muted-foreground">{tr("routing_v2.score.cost")}</div>
                <div className="font-mono font-semibold">{previewCandidates.selected.scores.cost.score}/100</div>
                <EvidenceBadge
                  evidence={previewCandidates.selected.scores.cost.evidence}
                  label={previewCandidates.selected.scores.cost.detail}
                />
              </div>

              <div className="space-y-1 rounded border border-border/50 bg-background/50 p-2">
                <div className="text-muted-foreground">{tr("routing_v2.score.latency")}</div>
                <div className="font-mono font-semibold">{previewCandidates.selected.scores.latency.score}/100</div>
                <EvidenceBadge
                  evidence={previewCandidates.selected.scores.latency.evidence}
                  label={previewCandidates.selected.scores.latency.detail}
                />
              </div>

              <div className="space-y-1 rounded border border-border/50 bg-background/50 p-2">
                <div className="text-muted-foreground">{tr("routing_v2.score.quota")}</div>
                <div className="font-mono font-semibold">{previewCandidates.selected.scores.quota.score}/100</div>
                <EvidenceBadge
                  evidence={previewCandidates.selected.scores.quota.evidence}
                  label={previewCandidates.selected.scores.quota.detail}
                />
              </div>

              <div className="space-y-1 rounded border border-border/50 bg-background/50 p-2">
                <div className="text-muted-foreground">{tr("routing_v2.score.history")}</div>
                <div className="font-mono font-semibold">{previewCandidates.selected.scores.history.score}/100</div>
                <EvidenceBadge
                  evidence={previewCandidates.selected.scores.history.evidence}
                  label={previewCandidates.selected.scores.history.detail}
                />
              </div>
            </div>

            {/* Reasons and Warnings */}
            <div className="mt-3 space-y-1 text-xs">
              {previewCandidates.selected.selectionReasons.map((r, i) => (
                <div key={i} className="text-success">
                  ✓ {r}
                </div>
              ))}
              {previewCandidates.selected.warnings.map((w, i) => (
                <div key={i} className="text-warning">
                  ⚠ {w}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-1 rounded-md border border-border/70 p-3 text-xs" data-testid="router-none-qualified">
            <p className="text-muted-foreground">{tr("router.noCandidate")}</p>
            <h4 className="font-semibold">{tr("routing_v2.none.title")}</h4>
            {noQualifier && noQualifier.total > 0 ? (
              <>
                <p className="text-muted-foreground">{tr("routing_v2.none.intro")}</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {NO_QUALIFIER_CATEGORIES.filter((category) => noQualifier.byCategory[category] > 0).map((category) => (
                    <li key={category} data-testid={`router-none-${category}`}>{tr(`routing_v2.none.${category}` as TranslationKey, { n: String(noQualifier.byCategory[category]) })}</li>
                  ))}
                </ul>
                {noQualifier.refused > 0 && <p className="text-warning" data-testid="router-none-refused">{tr("routing_v2.none.refused", { n: String(noQualifier.refused) })}</p>}
              </>
            ) : <p className="text-muted-foreground" data-testid="router-none-empty">{tr("routing_v2.none.empty")}</p>}
          </div>
        )}
      </div>

      {/* Eligible Alternatives & Ineligible Candidates */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2 rounded-md border border-border/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tr("routing_v2.candidate.alternatives")} ({previewCandidates?.eligible.length ? previewCandidates.eligible.length - 1 : 0})
          </h4>
          <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs">
            {previewCandidates?.eligible.slice(1).map((alt) => (
              <div
                key={alt.candidateId}
                className="flex items-start justify-between gap-2 rounded border border-border/40 p-2"
                data-testid={`alternative-candidate-${alt.modelId}`}
                data-account={alt.accountId ?? ""}
              >
                <div className="min-w-0 space-y-1">
                  <div>
                    <span className="font-medium">{alt.harnessLabel} · {alt.modelLabel}</span>
                    <span className="ml-1 text-[11px] text-muted-foreground">({alt.modeLabel})</span>
                    {alt.accountLabel && <span className="ml-1 text-[11px] font-medium text-primary" data-testid="alternative-candidate-account">[{alt.accountLabel}]</span>}
                  </div>
                  <CandidateStateBadges candidate={alt} testId={`alternative-state-${alt.modelId}`} />
                  {alt.providerRefusal && (
                    <ProviderRefusalNotice
                      refusal={alt.providerRefusal}
                      accountLabel={alt.accountLabel}
                      modelLabel={alt.modelLabel}
                      testId={`alternative-provider-refusal-${alt.modelId}`}
                      className="space-y-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px]"
                      onOpenAccount={onOpenAccount}
                    />
                  )}
                </div>
                <span className="font-mono text-xs font-bold text-muted-foreground">
                  {alt.scores.totalScore}/100
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border/70 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {tr("routing_v2.candidate.ineligible")} ({previewCandidates?.ineligible.length ?? 0})
          </h4>
          <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs">
            {previewCandidates?.ineligible.map((inel) => (
              <div
                key={inel.candidateId}
                className="rounded border border-destructive/20 bg-destructive/5 p-2"
                data-testid={`ineligible-candidate-${inel.harnessId}-${inel.modelId}`}
              >
                <div className="font-medium text-foreground">
                  {inel.harnessLabel} · {inel.modelLabel}
                  {inel.accountLabel && <span className="ml-1 text-[11px] text-primary">[{inel.accountLabel}]</span>}
                </div>
                <div className="mt-1">
                  <CandidateStateBadges candidate={inel} testId={`ineligible-state-${inel.harnessId}-${inel.modelId}`} />
                </div>
                <div className="text-[11px] text-destructive">
                  {inel.eliminationReasons.map(reason => reason.startsWith("provider-usage-limit:") ? tr("account_limit.router_block") : reason).join("; ")}
                </div>
                {inel.providerRefusal && <ProviderRefusalNotice refusal={inel.providerRefusal}
                  accountLabel={inel.accountLabel} modelLabel={inel.modelLabel} waiting
                  testId={`ineligible-limit-${inel.candidateId}`} className="mt-1 space-y-1 text-warning" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Routing History Table */}
      <div className="space-y-2 border-t border-border/60 pt-4" data-testid="router-history-table">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {tr("routing_v2.history.title")}
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tr("routing_v2.history.no_records")}</p>
        ) : (
          <div className="overflow-x-auto rounded border border-border/60">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 border-b border-border/60 text-muted-foreground">
                <tr>
                  <th className="p-2 font-medium">{tr("router.col.task")}</th>
                  <th className="p-2 font-medium">{tr("router.col.role")}</th>
                  <th className="p-2 font-medium">{tr("router.col.resource")}</th>
                  <th className="p-2 font-medium">{tr("router.col.policy")}</th>
                  <th className="p-2 font-medium">{tr("router.col.type")}</th>
                  <th className="p-2 font-medium">{tr("router.col.outcome")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {history.map((h) => (
                  <tr key={h.id} className="hover:bg-muted/20">
                    <td className="p-2 font-mono">{h.taskId?.slice(0, 8) ?? "—"}</td>
                    <td className="p-2">{Object.hasOwn(en, `router.role.${h.role}`) ? tr(`router.role.${h.role}` as TranslationKey) : h.role}</td>
                    <td className="p-2 font-medium">
                      {h.selectedHarnessId} / {h.selectedModelId}
                      {h.selectedAccountId && <span className="text-muted-foreground ml-1">({h.selectedAccountId})</span>}
                    </td>
                    <td className="p-2">{tr(`routing_v2.preset.${h.policyPreset.replace("-", "_")}` as TranslationKey)}</td>
                    <td className="p-2">{tr(`router.decision.${h.decisionType}` as TranslationKey)}</td>
                    <td className="p-2 text-muted-foreground">
                      {h.actualAttribution ? (
                        <span>
                          {tr("router.run")} {h.actualAttribution.runId?.slice(0, 8) ?? "—"} · {h.actualAttribution.outcome ?? tr("common.completed")}
                          {h.actualAttribution.qcVerdict ? ` · QC: ${h.actualAttribution.qcVerdict}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
