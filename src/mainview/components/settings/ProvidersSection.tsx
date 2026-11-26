import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { ApiError, api, type AccountUsageDay, type HarnessesPayload } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { AccountsDashboard } from "@/components/accounts/AccountsDashboard";
import { AiRouterDashboard } from "@/components/router/AiRouterDashboard";
import { ProviderRuntimeMatrix } from "@/components/settings/ProviderRuntimeMatrix";
import { abbreviateHome, cn, formatTokens } from "@/lib/utils";
import {
  buildProviderServiceGroups,
  type ProviderServiceAccountItem,
  type ProviderServiceGroup,
  type ProviderStatusLight,
} from "@/lib/provider-services";
import { formatArgString, type DiscoveredCli } from "../../../shared/custom-cli.ts";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";
import type { Harness } from "../../../shared/types.ts";

const LIGHT_DOT_CLASS: Record<ProviderStatusLight, string> = {
  green: "bg-success-solid",
  yellow: "bg-warning-solid",
  red: "bg-danger-solid",
  muted: "bg-muted-foreground/50",
};

function shortStatusText(status: ProviderServiceGroup["shortStatus"]): string {
  return tr(`providersUi.status.${status}` as TranslationKey);
}

function limitationText(code: DiscoveredCli["limitationCode"]): string | null {
  if (!code) return null;
  const keyMap: Record<NonNullable<DiscoveredCli["limitationCode"]>, TranslationKey> = {
    "cursor-nested-sandbox": "providersUi.limit.cursor_nested_sandbox",
    "deepseek-containment": "providersUi.limit.deepseek_containment",
    "custom-manual-only": "providersUi.limit.custom_manual_only",
    "single-login": "providersUi.limit.single_login",
  };
  return tr(keyMap[code]);
}

function InlineClaudeUsageTable({ harnessId }: { harnessId: string }) {
  useUILocale();
  const [days, setDays] = useState<AccountUsageDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setError(null);
    api.getAccountUsage(harnessId)
      .then((res) => { if (!cancelled) setDays(res.days); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [harnessId]);

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (days === null) return <p className="text-xs text-muted-foreground">{tr("settings.loading_usage")}</p>;
  if (days.length === 0) {
    return <p className="text-xs text-muted-foreground">{tr("settings.no_local_usage_history_for_this_account_last")}</p>;
  }
  return (
    <div className="max-h-44 overflow-auto rounded-md border border-border/40 bg-muted/20">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">{tr("common.day")}</th>
            <th className="px-2 py-1 text-left font-medium">{tr("common.model")}</th>
            <th className="px-2 py-1 text-right font-medium">{tr("settings.in")}</th>
            <th className="px-2 py-1 text-right font-medium">{tr("settings.out")}</th>
            <th className="px-2 py-1 text-right font-medium">{tr("settings.msgs")}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={`${d.day}:${d.model}`} className="border-t border-border/30">
              <td className="px-2 py-1 font-mono">{d.day}</td>
              <td className="max-w-36 truncate px-2 py-1">{d.model}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.inputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.outputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">{d.messageCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ProvidersSectionProps {
  payload: HarnessesPayload;
  homeDir: string;
  canAdd: boolean;
  /** Optional service or harness id to auto-expand & scroll into view (e.g. from topbar). */
  focusServiceOrHarnessId?: string | null;
  pendingToggle: Record<string, boolean>;
  onAddCli: () => void;
  onQuickConnect: (cli: DiscoveredCli) => Promise<void>;
  onAddAccountForService: (group: ProviderServiceGroup) => void;
  onEditHarness: (h: Harness) => void;
  onDeleteHarness: (h: Harness) => void;
  onToggleHarness: (h: Harness) => void;
  onOpenTerminal: (h: Harness) => void;
  onRefresh: () => Promise<void>;
  onOpenPortfolio?: () => void;
}

export function ProvidersSection({
  payload,
  homeDir,
  canAdd,
  focusServiceOrHarnessId,
  pendingToggle,
  onAddCli,
  onQuickConnect,
  onAddAccountForService,
  onEditHarness,
  onDeleteHarness,
  onToggleHarness,
  onOpenTerminal,
  onRefresh,
  onOpenPortfolio,
}: ProvidersSectionProps) {
  useUILocale();
  const confirm = useConfirm();
  const [executionProfiles, setExecutionProfiles] = useState<ExecutionProfile[]>([]);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [usageOpenFor, setUsageOpenFor] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  const loadProfiles = useCallback(async () => {
    try {
      const res = await api.accountCore.executionProfiles();
      setExecutionProfiles(res.profiles);
    } catch {
      /* keep existing profiles */
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles, payload.harnesses]);

  const groups = useMemo(
    () =>
      buildProviderServiceGroups({
        harnesses: payload.harnesses,
        statuses: payload.statuses,
        discoveredClis: payload.discoveredClis,
        executionProfiles,
        runtimeReadiness: payload.runtimeReadiness,
        providerDiagnostics: payload.providerDiagnostics,
        installations: payload.installations,
      }),
    [payload, executionProfiles],
  );

  // Auto-expand and scroll to a focused service when navigated from Topbar.
  useEffect(() => {
    if (!focusServiceOrHarnessId || groups.length === 0) return;
    const match = groups.find(
      (g) =>
        g.serviceId === focusServiceOrHarnessId ||
        g.harnesses.some((h) => h.id === focusServiceOrHarnessId) ||
        g.executionProfiles.some((p) => p.harnessId === focusServiceOrHarnessId || p.accountId === focusServiceOrHarnessId),
    );
    if (!match) return;
    setExpandedIds((prev) => ({ ...prev, [match.serviceId]: true }));
    requestAnimationFrame(() => {
      cardRefs.current[match.serviceId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [focusServiceOrHarnessId, groups]);

  const toggleExpand = (serviceId: string) => {
    setExpandedIds((prev) => ({ ...prev, [serviceId]: !prev[serviceId] }));
  };

  const handleToggleService = (group: ProviderServiceGroup) => {
    const target = group.primaryHarness;
    if (target) {
      onToggleHarness(target);
      return;
    }
    if (group.discoveredCli) {
      void handleQuickConnect(group.discoveredCli);
    }
  };

  const handleQuickConnect = async (cli: DiscoveredCli) => {
    setConnectingId(cli.serviceId);
    try {
      await onQuickConnect(cli);
      await loadProfiles();
    } finally {
      setConnectingId(null);
    }
  };

  const handleCheckAccount = async (item: ProviderServiceAccountItem) => {
    setCheckingId(item.id);
    try {
      if (item.executionProfile) {
        if (item.executionProfile.kind === "claude") {
          await api.accountCore.checkClaudeProfile(item.executionProfile.accountId);
        } else {
          await api.accountCore.checkCodexProfile(item.executionProfile.accountId);
        }
        await loadProfiles();
        await onRefresh();
        toast.success(tr("providersUi.check.ok_no_version", { label: item.displayName }));
        return;
      }
      if (item.harness) {
        const st = await api.checkHarnessConnection(item.harness.id);
        await onRefresh();
        if (!st.available) {
          toast.error(tr("providersUi.check.missing", { label: item.displayName }));
        } else if (st.loggedIn === false) {
          toast.warning(tr("providersUi.check.auth_needed", { label: item.displayName }));
        } else if (st.version) {
          toast.success(tr("providersUi.check.ok", { label: item.displayName, version: st.version }));
        } else {
          toast.success(tr("providersUi.check.ok_no_version", { label: item.displayName }));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingId(null);
    }
  };

  const handleToggleProfileDisabled = async (profile: ExecutionProfile) => {
    try {
      await api.accountCore.updateExecutionMeta(profile.accountId, { disabled: !profile.disabled });
      await loadProfiles();
      await onRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveProfile = async (profile: ExecutionProfile) => {
    try {
      if (profile.kind === "claude") {
        await api.accountCore.removeClaudeProfile(profile.accountId);
      } else {
        await api.accountCore.removeCodexProfile(profile.accountId);
      }
      await loadProfiles();
      await onRefresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && profile.kind === "claude") {
        const ok = await confirm({
          title: tr("multiaccount.remove"),
          description: tr("multiaccount.remove_active"),
          variant: "destructive",
        });
        if (!ok) return;
        await api.accountCore.removeClaudeProfile(profile.accountId, true);
        await loadProfiles();
        await onRefresh();
      } else {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };

  return (
    <div className="space-y-4 pt-2 text-sm" data-testid="providers-section">
      {/* Compact Header with prominent + Add CLI button */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{tr("providersUi.title")}</h3>
          <p className="text-xs text-muted-foreground">{tr("providersUi.subtitle")}</p>
        </div>
        <Button
          size="sm"
          onClick={onAddCli}
          disabled={!canAdd}
          data-testid="add-cli-button"
          title={canAdd ? undefined : tr("common.loading_defaults")}
        >
          <Plus className="mr-1.5 size-3.5" />
          {tr("providersUi.add_cli")}
        </Button>
      </div>

      {/* Unified Service List: strictly ONE card per service */}
      <div className="space-y-2" data-testid="provider-service-list">
        {groups.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            {tr("providersUi.filter_empty")}
          </p>
        )}

        {groups.map((group) => {
          const isExpanded = Boolean(expandedIds[group.serviceId]);
          const switchChecked = group.primaryHarness
            ? (pendingToggle[group.primaryHarness.id] ?? group.enabled)
            : group.enabled;
          const limitNote = limitationText(group.limitationCode);

          return (
            <article
              key={group.serviceId}
              ref={(el) => { cardRefs.current[group.serviceId] = el; }}
              data-testid={`provider-card-${group.serviceId}`}
              data-service-id={group.serviceId}
              className={cn(
                "rounded-xl border border-border/70 bg-card/60 transition-colors",
                !group.enabled && group.connected && "opacity-75",
              )}
            >
              {/* Compact primary row: logo + name + short status + dot + profile count + switch/connect + expand */}
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleExpand(group.serviceId)}
                  aria-expanded={isExpanded}
                  data-testid={`provider-card-toggle-${group.serviceId}`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <AgentIcon kind={group.iconKind} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{group.label}</span>
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className={cn("inline-block size-2 rounded-full", LIGHT_DOT_CLASS[group.light])}
                          aria-hidden
                        />
                        <span data-testid={`provider-card-status-${group.serviceId}`}>
                          {shortStatusText(group.shortStatus)}
                        </span>
                      </span>
                      {group.accountCount > 1 && (
                        <span
                          data-testid={`provider-card-count-${group.serviceId}`}
                          className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          {tr("providersUi.profiles_count", { count: String(group.accountCount) })}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-2">
                  {group.connected ? (
                    <Switch
                      checked={switchChecked}
                      onCheckedChange={() => handleToggleService(group)}
                      aria-label={group.enabled ? tr("providersUi.disable") : tr("providersUi.enable")}
                      data-testid={`provider-card-switch-${group.serviceId}`}
                    />
                  ) : group.discoveredCli ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={connectingId === group.serviceId}
                      onClick={() => void handleQuickConnect(group.discoveredCli!)}
                      data-testid={`provider-card-connect-${group.serviceId}`}
                    >
                      {connectingId === group.serviceId
                        ? tr("providersUi.connecting")
                        : tr("providersUi.connect")}
                    </Button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => toggleExpand(group.serviceId)}
                    aria-label={group.label}
                    aria-expanded={isExpanded}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </button>
                </div>
              </div>

              {/* Expanded card body */}
              {isExpanded && (
                <div
                  data-testid={`provider-card-body-${group.serviceId}`}
                  className="space-y-3 border-t border-border/50 px-3 py-3 text-xs"
                >
                  {/* Honest compact capabilities & short limitation note */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {group.capabilities.manualRun && (
                        <span className="rounded-md bg-muted/70 px-2 py-0.5 text-[11px] text-foreground">
                          {tr("providersUi.cap.manual")}
                        </span>
                      )}
                      {group.capabilities.automatedOutput && (
                        <span className="rounded-md bg-muted/70 px-2 py-0.5 text-[11px] text-foreground">
                          {tr("providersUi.cap.automated")}
                        </span>
                      )}
                      {group.capabilities.autonomousDeveloper && (
                        <span className="rounded-md bg-success/10 px-2 py-0.5 text-[11px] text-success">
                          {tr("providersUi.cap.autonomous")}
                        </span>
                      )}
                    </div>
                    {limitNote && (
                      <p className="text-xs leading-snug text-muted-foreground">{limitNote}</p>
                    )}
                  </div>

                  {/* Accounts & Profiles inside this service */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-muted-foreground">
                        {tr("providersUi.accounts_heading")}
                      </span>
                      {group.capabilities.multiAccount !== "single-login" && group.connected && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onAddAccountForService(group)}
                          data-testid={`provider-add-account-${group.serviceId}`}
                          className="h-7 px-2 text-xs"
                        >
                          <Plus className="mr-1 size-3" />
                          {tr("providersUi.add_account")}
                        </Button>
                      )}
                    </div>

                    {group.capabilities.multiAccount === "single-login" && (
                      <p className="text-xs text-muted-foreground">{tr("providersUi.single_login_note")}</p>
                    )}

                    {group.accounts.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{tr("providersUi.no_extra_accounts")}</p>
                    ) : (
                      <div className="space-y-1.5">
                        {group.accounts.map((acc) => {
                          const h = acc.harness;
                          const prof = acc.executionProfile;
                          const isChecking = checkingId === acc.id;
                          return (
                            <div
                              key={acc.id}
                              data-testid={`provider-account-${acc.id}`}
                              className="space-y-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className={cn("inline-block size-2 shrink-0 rounded-full", LIGHT_DOT_CLASS[acc.light])}
                                    aria-hidden
                                  />
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-foreground">
                                      {acc.displayName}
                                    </div>
                                    <div className="truncate text-[11px] text-muted-foreground">
                                      {shortStatusText(acc.shortStatus)}
                                      {acc.isPrimary && !acc.configDir && ` · ${tr("providersUi.current_login")}`}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-1">
                                  {h && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs"
                                      onClick={() => onOpenTerminal(h)}
                                      data-testid={`provider-open-terminal-${h.id}`}
                                      title={tr("providersUi.open_terminal")}
                                    >
                                      <Terminal className="mr-1 size-3.5" />
                                      {tr("providersUi.open_terminal")}
                                    </Button>
                                  )}

                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    disabled={isChecking}
                                    onClick={() => void handleCheckAccount(acc)}
                                    data-testid={`provider-check-${h?.id ?? prof?.accountId ?? acc.id}`}
                                  >
                                    <RefreshCw className={cn("mr-1 size-3", isChecking && "animate-spin")} />
                                    {isChecking ? tr("providersUi.checking") : tr("providersUi.check_connection")}
                                  </Button>

                                  {h && h.kind === "claude-code" && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      className="size-7"
                                      onClick={() => setUsageOpenFor((cur) => (cur === h.id ? null : h.id))}
                                      aria-label={tr("common.token_usage_for", {
                                        p0: usageOpenFor === h.id ? tr("common.hide") : tr("common.show"),
                                        p1: h.label,
                                      })}
                                    >
                                      <BarChart3 className="size-3.5" />
                                    </Button>
                                  )}

                                  {h && !h.isBuiltin && (
                                    <>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="size-7"
                                        onClick={() => onEditHarness(h)}
                                        aria-label={tr("providersUi.edit")}
                                        title={tr("providersUi.edit")}
                                        data-testid={`provider-edit-${h.id}`}
                                      >
                                        <Pencil className="size-3.5" />
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="size-7"
                                        onClick={() => onDeleteHarness(h)}
                                        aria-label={tr("providersUi.remove")}
                                        title={tr("providersUi.remove")}
                                        data-testid={`provider-delete-${h.id}`}
                                      >
                                        <Trash2 className="size-3.5" />
                                      </Button>
                                    </>
                                  )}

                                  {prof && !h && (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => void handleToggleProfileDisabled(prof)}
                                      >
                                        {prof.disabled ? tr("providersUi.enable") : tr("providersUi.disable")}
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="size-7"
                                        onClick={() => void handleRemoveProfile(prof)}
                                        aria-label={tr("providersUi.remove")}
                                      >
                                        <Trash2 className="size-3.5" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {h && usageOpenFor === h.id && <InlineClaudeUsageTable harnessId={h.id} />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Collapsed Additional Settings (for custom / non-builtin config summary) */}
                  {group.primaryHarness?.kind === "custom" && (
                    <details className="rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2">
                      <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                        {tr("providersUi.additional_settings")}
                      </summary>
                      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">{tr("providersUi.diag.path")}</dt>
                        <dd className="break-all font-mono">{group.primaryHarness.bin ?? "—"}</dd>
                        {group.primaryHarness.cliConfig?.args?.length ? (
                          <>
                            <dt className="text-muted-foreground">{tr("providersUi.diag.args")}</dt>
                            <dd className="break-all font-mono">{formatArgString(group.primaryHarness.cliConfig.args)}</dd>
                          </>
                        ) : null}
                        <dt className="text-muted-foreground">{tr("providersUi.diag.delivery")}</dt>
                        <dd>{tr(`providersUi.add.delivery.${group.primaryHarness.cliConfig?.promptDelivery ?? "arg"}` as TranslationKey)}</dd>
                        {group.primaryHarness.cliConfig?.defaultModel && (
                          <>
                            <dt className="text-muted-foreground">{tr("providersUi.diag.default_model")}</dt>
                            <dd className="font-mono">{group.primaryHarness.cliConfig.defaultModel}</dd>
                          </>
                        )}
                        {group.primaryHarness.cliConfig?.workdir && (
                          <>
                            <dt className="text-muted-foreground">{tr("providersUi.diag.workdir")}</dt>
                            <dd className="break-all font-mono">{abbreviateHome(group.primaryHarness.cliConfig.workdir, homeDir)}</dd>
                          </>
                        )}
                        {group.primaryHarness.home && (
                          <>
                            <dt className="text-muted-foreground">{tr("providersUi.diag.config_dir")}</dt>
                            <dd className="break-all font-mono">{abbreviateHome(group.primaryHarness.home, homeDir)}</dd>
                          </>
                        )}
                      </dl>
                    </details>
                  )}

                  {/* Collapsed Technical Diagnostics per service */}
                  <details
                    data-testid={`provider-diagnostics-${group.serviceId}`}
                    className="rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2"
                  >
                    <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
                      {tr("providersUi.diagnostics")}
                    </summary>
                    <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">{tr("providersUi.diag.path")}</dt>
                      <dd className="break-all font-mono">
                        {group.diagnostics.resolvedPath
                          ? abbreviateHome(group.diagnostics.resolvedPath, homeDir)
                          : tr("providersUi.diag.not_found")}
                      </dd>
                      <dt className="text-muted-foreground">{tr("providersUi.diag.version")}</dt>
                      <dd className="font-mono">
                        {group.diagnostics.version ?? tr("providersUi.diag.not_checked")}
                      </dd>
                      <dt className="text-muted-foreground">{tr("providersUi.diag.kind")}</dt>
                      <dd className="font-mono">{group.primaryKind}</dd>
                    </dl>
                  </details>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* Collapsed Advanced section: Subscriptions, Quotas, AccountCore & AI Router */}
      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
        data-testid="providers-advanced-accounts"
        className="rounded-xl border border-border/60 bg-muted/15 px-3 py-2.5"
      >
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          {tr("providersUi.advanced_accounts")}
        </summary>
        {advancedOpen && (
          <div className="mt-3 space-y-6 border-t border-border/50 pt-3">
            <AccountsDashboard
              harnesses={payload.harnesses}
              onOpenPortfolio={onOpenPortfolio}
              onResourcesChanged={async () => {
                await loadProfiles();
                await onRefresh();
              }}
            />
            <AiRouterDashboard onOpenAccount={() => setAdvancedOpen(true)} />
          </div>
        )}
      </details>

      {/* Collapsed System Diagnostics: ProviderRuntimeMatrix preserved on demand */}
      {payload.runtimeReadiness && payload.runtimeReadiness.length > 0 && (
        <details
          data-testid="providers-system-diagnostics"
          className="rounded-xl border border-border/60 bg-muted/15 px-3 py-2.5"
        >
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
            {tr("providersUi.system_diagnostics")}
          </summary>
          <div className="mt-3 border-t border-border/50 pt-3">
            <ProviderRuntimeMatrix reports={payload.runtimeReadiness} />
          </div>
        </details>
      )}
    </div>
  );
}
