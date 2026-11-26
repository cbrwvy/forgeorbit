import { ManagerResourceComparison } from "@/components/router/AccountResourceComparison";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HarnessAuthHint } from "../../kanban/HarnessAuthHint";
import { useTaskLaunch } from "../../kanban/TaskLaunchPickers";
import { interviewSupportFor, type InterviewIsolation } from "../../../../shared/project-interview.ts";
import {
  MANAGER_LANGUAGES,
  MANAGER_LIMITS,
  validateExtraDoc,
  type ManagerConfig,
  type ManagerLanguage,
} from "../../../../shared/project-manager.ts";

/** Whether the manager can answer right now, and why not. */
export interface ManagerAgentStatus {
  /** Null when a message can be sent. */
  problem: string | null;
  /** The owner still has to confirm the isolation summary. */
  needsConsent: boolean;
  label: string | null;
  model: string | null;
}

interface Props {
  /** The project this manager belongs to. Omitted for the portfolio manager. */
  projectPath?: string;
  /** Who the panel configures (FO-008C reuses it for the portfolio manager). */
  variant?: "project" | "portfolio";
  /** Saves the config. Defaults to the project manager's config route. */
  onSave?: (config: ManagerConfig) => Promise<unknown>;
  /** Prefix of every test id, so two managers never share ids. */
  idPrefix?: string;
  config: ManagerConfig;
  /** Disabled while a turn runs, so the agent can't change under it. */
  busy: boolean;
  onConfigChange: (config: ManagerConfig) => void;
  onStatus: (status: ManagerAgentStatus) => void;
  onManageAgents: () => void;
}

/**
 * Agent, model, language and standing instructions for one project's
 * manager. Every change is saved to that project's config; nothing here
 * calls a model (the isolation check runs local CLI probes only).
 */
export function ManagerAgentPanel({
  projectPath,
  variant = "project",
  onSave,
  idPrefix = "manager",
  config,
  busy,
  onConfigChange,
  onStatus,
  onManageAgents,
}: Props) {
  useUILocale();
  const portfolio = variant === "portfolio";
  const launch = useTaskLaunch(true, { withProfiles: true });
  const seededRef = useRef(false);
  const [seeded, setSeeded] = useState(false);
  const configRef = useRef(config);
  configRef.current = config;

  const save = (patch: Partial<ManagerConfig>) => {
    const next = { ...configRef.current, ...patch };
    configRef.current = next;
    onConfigChange(next);
    const persist = onSave ?? ((value: ManagerConfig) => api.saveManagerConfig(projectPath ?? "", value));
    void persist(next).catch(() => {
      /* the page shows the stored config again on the next load */
    });
  };

  // Seed the pickers from the saved config once the harness list loads.
  useEffect(() => {
    if (seededRef.current || launch.loading || launch.harnesses.length === 0) return;
    seededRef.current = true;
    const saved = configRef.current;
    if (saved.profileId && launch.profiles.some((profile) => profile.id === saved.profileId)) {
      launch.setAgentProfileId(saved.profileId);
    } else if (saved.harness && launch.harnesses.some((harness) => harness.id === saved.harness)) {
      launch.seed({ agent: saved.harness, ...(saved.model ? { model: saved.model } : {}), effort: saved.effort });
    } else {
      // No saved agent: start on the first enabled harness that can run a
      // manager, so the picker doesn't open on one that can't.
      const first = launch.availableHarnesses.find((harness) => interviewSupportFor(harness.kind).supported);
      if (first) launch.switchAgent(first.id);
    }
    setSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.loading, launch.harnesses.length, launch.profiles.length]);

  const profile = launch.selectedProfile;
  const harnessId = profile ? profile.harness : launch.agent;
  const harness = launch.harnesses.find((item) => item.id === harnessId) ?? null;
  const kind = harness?.kind ?? launch.kind;
  const support = interviewSupportFor(kind);
  const status = launch.agents.find((item) => item.harnessId === harnessId);
  const model = profile ? profile.model : launch.model;
  const effort = profile ? profile.effort : launch.effort;
  const fast = profile ? profile.fast : launch.fast;
  const maxMode = profile ? profile.maxMode : launch.maxMode;

  // Persist the agent picks for this project.
  useEffect(() => {
    if (!seeded) return;
    const current = configRef.current;
    const next = {
      profileId: profile?.id ?? null,
      harness: profile ? null : harness?.id ?? null,
      model: profile ? null : model || null,
      effort: profile ? null : effort ?? null,
      fast: profile ? false : fast,
      maxMode: profile ? false : maxMode,
    };
    if (
      current.profileId === next.profileId && current.harness === next.harness && current.model === next.model
      && current.effort === next.effort && current.fast === next.fast && current.maxMode === next.maxMode
    ) return;
    const timer = setTimeout(() => save(next), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, profile?.id, harness?.id, model, effort, fast, maxMode]);

  const baseProblem = launch.loading || !seeded
    ? tr("common.loading_agents")
    : launch.loadError
      ? tr("common.couldn_t_load_agents", { p0: String(launch.loadError) })
      : !harness
        ? tr("common.choose_an_agent")
        : !harness.enabled
          ? tr("common.is_disabled_enable_it_in_settings", { p0: String(harness.label) })
          : !support.supported
            ? support.reason
            : status && !status.available
              ? tr("common.is_not_available", { p0: String(harness.label), p1: String(status.reason) })
              : status?.loggedIn === false
                ? tr("common.isn_t_logged_in", { p0: String(harness.label) })
                : null;

  const [isolation, setIsolation] = useState<InterviewIsolation | null>(null);
  const [isolationError, setIsolationError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const preflightKey = baseProblem || !harness ? null : `${harness.id}\0${model}\0${effort ?? ""}`;
  useEffect(() => {
    if (!preflightKey || !harness) {
      setIsolation(null);
      setIsolationError(null);
      return;
    }
    let cancelled = false;
    setIsolation(null);
    setIsolationError(null);
    setChecking(true);
    const timer = setTimeout(() => {
      api.interviewPreflight({ harness: harness.id, model, effort })
        .then((result) => {
          if (cancelled) return;
          setIsolation(result.isolation);
          setIsolationError(null);
        })
        .catch((caught) => {
          if (cancelled) return;
          setIsolation(null);
          setIsolationError((caught as Error).message);
        })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflightKey]);

  const consented = isolation != null && config.consentKey === isolation.consentKey;
  const problem = baseProblem ?? isolationError ?? (checking || !isolation ? tr("common.checking_what_this_agent_can_do") : null);

  useEffect(() => {
    onStatus({
      problem,
      needsConsent: problem == null && !consented,
      label: harness?.label ?? null,
      model: model || null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem, consented, harness?.label, model]);

  const managerProfiles = launch.profiles.filter((item) => {
    const owner = launch.harnesses.find((h) => h.id === item.harness);
    return owner ? interviewSupportFor(owner.kind).supported : false;
  });

  const [instructions, setInstructions] = useState(config.instructions);
  const [docDraft, setDocDraft] = useState("");
  const docError = docDraft.trim() ? validateExtraDoc(docDraft) : null;

  return (
    <div className="space-y-3 text-xs" data-testid={`${idPrefix}-agent`}>
      <fieldset className="space-y-2" disabled={busy}>
        <legend className="sr-only"><I18nText id="common.agent" /></legend>
        <label className="block min-w-0 space-y-1">
          <span className="text-muted-foreground"><I18nText id="common.agent_profile" /></span>
          <Select
            value={launch.agentProfileId ?? ""}
            onChange={(event) => launch.setAgentProfileId(event.target.value || null)}
            className="h-8"
            data-testid={`${idPrefix}-profile`}
          >
            <option value=""><I18nText id="common.none_pick_a_harness" /></option>
            {managerProfiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </label>
        {!profile && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.harness" /></span>
              <Select value={launch.agent} onChange={(event) => launch.switchAgent(event.target.value)} className="h-8" data-testid={`${idPrefix}-harness`}>
                {launch.availableHarnesses.map((item) => {
                  const itemSupport = interviewSupportFor(item.kind);
                  const itemStatus = launch.agents.find((s) => s.harnessId === item.id);
                  const suffix = !itemSupport.supported
                    ? tr("common.not_supported")
                    : itemStatus && !itemStatus.available
                      ? tr("common.not_installed")
                      : itemStatus?.loggedIn === false
                        ? tr("common.logged_out")
                        : "";
                  return <option key={item.id} value={item.id}>{`${item.label}${suffix}`}</option>;
                })}
              </Select>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.model" /></span>
              <Select value={launch.model} onChange={(event) => launch.setModel(event.target.value)} className="h-8" data-testid={`${idPrefix}-model`}>
                {launch.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="text-muted-foreground"><I18nText id="common.effort" /></span>
              <Select
                value={launch.effort ?? ""}
                onChange={(event) => launch.setEffort(event.target.value)}
                disabled={launch.efforts.length === 0}
                className="h-8"
                data-testid={`${idPrefix}-effort`}
              >
                {launch.efforts.length === 0
                  ? <option value=""><I18nText id="common.n_a" /></option>
                  : launch.efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
            </label>
          </div>
        )}
        {profile && (
          <p className="text-[11px] text-muted-foreground" data-testid={`${idPrefix}-profile-summary`}>
            {harness?.label ?? profile.harness} · {model}{effort ? ` · ${effort}` : ""}<I18nText id="approvals.the_profile_s_instructions_and_skills_are_not" />{" "}</p>
        )}
        {!profile && harness && <ManagerResourceComparison role={portfolio ? "head" : "project-manager"} harnessId={harness.id} model={model} onChoose={o => launch.seed({ agent:o.harnessId, model:o.modelId, effort:null })} />}
        <button type="button" className="text-[11px] text-info underline-offset-2 hover:underline" onClick={onManageAgents}><I18nText id="approvals.manage_agent_profiles" />{" "}</button>
      </fieldset>

      {support.supported && harness && isolation && (
        <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px]" data-testid={`${idPrefix}-isolation`}>
          <p className="font-medium text-foreground"><I18nText id="approvals.what" />{" "}{harness.label}{" "}<I18nText id="common.can_do_here" /></p>
          <p>
            {portfolio
              ? tr("common.each_message_runs_the_cli_once_in_an")
              : tr("common.each_message_runs_the_cli_once_in_an_b3cf0a")}
            {" "}<I18nText id="approvals.file_writes" />{" "}{isolation.writes}
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {isolation.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
          <p>
            {portfolio
              ? tr("common.this_is_not_a_guaranteed_sandbox_the_portfolio")
              : tr("common.this_is_not_a_guaranteed_sandbox_the_manager")}
          </p>
          <label className="flex items-start gap-2 font-medium text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consented}
              disabled={busy || checking}
              onChange={(event) => save({ consentKey: event.target.checked ? isolation.consentKey : null })}
              data-testid={`${idPrefix}-consent`}
            /><I18nText id="common.i_understand_use" />{" "}{harness.label}{" "}<I18nText id="approvals.as" />{" "}{portfolio ? tr("common.the_portfolio_manager") : tr("common.this_project_s_manager")}.
          </label>
        </div>
      )}
      {(baseProblem ?? isolationError) && !launch.loading && seeded && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${idPrefix}-agent-problem`}>{baseProblem ?? isolationError}</p>
      )}
      <HarnessAuthHint status={status} />

      <label className="block space-y-1">
        <span className="text-muted-foreground"><I18nText id="approvals.reply_language" /></span>
        <Select
          value={config.language}
          onChange={(event) => save({ language: event.target.value as ManagerLanguage })}
          className="h-8"
          data-testid={`${idPrefix}-language`}
        >
          {MANAGER_LANGUAGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select>
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">{portfolio ? tr("common.instructions_for_the_portfolio_manager") : tr("common.project_instructions_for_the_manager")}</span>
        <Textarea
          value={instructions}
          rows={3}
          maxLength={MANAGER_LIMITS.instructionsChars}
          placeholder={portfolio ? tr("common.for_example_client_projects_come_before_internal_ones") : tr("common.for_example_keep_tasks_under_a_day_of")}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions.trim() !== configRef.current.instructions) save({ instructions: instructions.trim() });
          }}
          className="text-xs"
          data-testid={`${idPrefix}-instructions`}
        />
      </label>

      {!portfolio && (
      <div className="space-y-1">
        <span className="text-muted-foreground"><I18nText id="approvals.extra_documents_markdown_in_this_project" /></span>
        {config.extraDocs.length > 0 && (
          <ul className="space-y-1" data-testid={`${idPrefix}-extra-docs`}>
            {config.extraDocs.map((rel) => (
              <li key={rel} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1">
                <span className="min-w-0 truncate font-mono" title={rel}>{rel}</span>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline"
                  onClick={() => save({ extraDocs: config.extraDocs.filter((item) => item !== rel) })}
                  aria-label={tr("common.remove_55fbe4", { p0: String(rel) })}
                ><I18nText id="common.remove" />{" "}</button>
              </li>
            ))}
          </ul>
        )}
        {config.extraDocs.length < MANAGER_LIMITS.extraDocs && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const rel = docDraft.trim();
              if (!rel || validateExtraDoc(rel) || config.extraDocs.includes(rel)) return;
              save({ extraDocs: [...config.extraDocs, rel] });
              setDocDraft("");
            }}
          >
            <Input
              value={docDraft}
              onChange={(event) => setDocDraft(event.target.value)}
              placeholder={tr("approvals.docs_architecture_md")}
              spellCheck={false}
              className="h-8 font-mono text-xs"
              aria-label={tr("approvals.add_a_document")}
              aria-invalid={docError != null}
              data-testid={`${idPrefix}-extra-doc-input`}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!docDraft.trim() || docError != null} data-testid={`${idPrefix}-extra-doc-add`}><I18nText id="common.add" />{" "}</Button>
          </form>
        )}
        {docError && <p className="text-[11px] text-danger">{docError}</p>}
      </div>
      )}
    </div>
  );
}
