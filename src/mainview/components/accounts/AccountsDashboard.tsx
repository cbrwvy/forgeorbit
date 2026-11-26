import { CodexProfiles } from "./CodexProfiles";
import { ExecutionProfiles } from "./ExecutionProfiles";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { QuotaSources } from "./QuotaSources";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  accountError,
  accountMetrics,
  currentQuotas,
  moneyLabel,
  profileWarning,
  quantity,
  unitLabel,
  when,
} from "@/lib/accounts";
import type { AccountResource, AccountResources } from "@/lib/account-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import {
  accountForm,
  associationForm,
  observationForm,
  ResourceFormDialog,
  subscriptionForm,
  type ResourceForm,
} from "./AccountForms";
import { AccountLimits, Facts, LegacyUsage, QuotaCard, QuotaHistory } from "./AccountEvidence";
import { PROVIDER_REFUSAL_FRESHNESS_MS } from "../../../shared/provider-refusal.ts";
import type { AgentProfile, Harness } from "../../../shared/types.ts";
import type { QuotaDefinition } from "../../../shared/accounts/types.ts";

import { AccountDetails, ArchivedAccounts } from "./AccountDetails";
import {
  SubscriptionFacts,
  SubscriptionCommitments,
} from "./AccountSubscriptions";

type View =
  | "Quota Sources"
  | "Accounts"
  | "Subscriptions"
  | "Quotas"
  | "Resource Availability"
  | "Unassigned Usage"
  | "Archived Accounts";
const VIEWS: View[] = [
  "Accounts",
  "Subscriptions",
  "Quotas",
  "Quota Sources",
  "Resource Availability",
  "Unassigned Usage",
  "Archived Accounts",
];
const PAGE_SIZE = 12;

export function AccountsDashboard({
  harnesses,
  onOpenPortfolio,
  onResourcesChanged,
}: {
  harnesses: Harness[];
  onOpenPortfolio?: () => void;
  onResourcesChanged?: () => Promise<void>;
}) {
  const { locale: uiLocale } = useUILocale();
  const confirm = useConfirm();
  const [data, setData] = useState<AccountResources | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [view, setView] = useState<View>("Accounts");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ResourceForm | null>(null);
  const [history, setHistory] = useState<QuotaDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutating = useRef(false);

  const refresh = useCallback(async () => {
    const seq = ++generation.current;
    setLoading(true);
    try {
      const [resources, nextProfiles] = await Promise.all([
        api.accountCore.resources(),
        api.listAgentProfiles(),
      ]);
      if (!mounted.current || seq !== generation.current) return;
      setData(resources);
      setProfiles(nextProfiles);
      setError(null);
      setNow(Date.now());
      setLoadedAt(Date.now());
      setVersion((v) => v + 1);
    } catch (err) {
      if (mounted.current && seq === generation.current)
        setError(accountError(err));
    } finally {
      if (mounted.current && seq === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [refresh]);
  // Local evidence expiry only: no recurring network requests or provider work.
  useEffect(() => {
    const boundaries =
      data?.accounts.flatMap((row) => [
        ...(row.providerRefusals ?? []).map(refusal => refusal.observedAt + PROVIDER_REFUSAL_FRESHNESS_MS),
        ...row.quotas.flatMap((q) =>
          q.observations.flatMap((o) => [o.expiresAt, o.resetAt]),
        ),
      ]) ?? [];
    const next = boundaries
      .filter((n): n is number => n !== null && n > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(1, next - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [data, now]);
  useEffect(() => {
    const onFocus = () => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  const rows = useMemo(
    () =>
      data?.accounts.map((row) => ({
        ...row,
        quotas: currentQuotas(row, data.subscriptions, now),
      })) ?? [],
    [data, now, uiLocale],
  );
  const selected = rows.find((r) => r.account.id === selectedId);
  const filtered = rows.filter((row) =>
    `${row.account.displayName} ${row.account.provider} ${row.account.id}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const shown = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const openAccount = (id: string) => {
    setSelectedId(id);
    setView("Accounts");
    setHistory(null);
  };
  const run = async (
    action: () => Promise<unknown>,
    title?: string,
    description?: string,
  ) => {
    if (mutating.current) return;
    if (
      title &&
      !(await confirm(() => ({
        title,
        description,
        confirmLabel: tr("common.confirm"),
        variant: "destructive",
      })))
    )
      return;
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice("Changes saved.");
      await refresh();
    } catch (err) {
      setError(accountError(err));
    } finally {
      mutating.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const subscriptions = data?.subscriptions ?? [];
  const accountSubscriptions = (row: AccountResource) =>
    subscriptions.filter((s) => row.subscriptionIds.includes(s.id));
  const onHistory = (definition: QuotaDefinition) => setHistory(definition);

  return (
    <section
      className="account-dashboard min-w-0 space-y-4 py-4 [overflow-wrap:anywhere]"
      data-testid="accounts-dashboard"
      aria-label={tr("common.accounts_resources_d23794")}
      aria-busy={loading || busy}
    >
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold"><I18nText id="common.accounts_resources" />{" "}</h2>
            <p className="text-xs text-muted-foreground"><I18nText id="accounts.owner_control_of_registered_identities_subscription_commitments_and" />{" "}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {onOpenPortfolio && (
              <Button size="sm" variant="outline" onClick={onOpenPortfolio}><I18nText id="accounts.open_portfolio" />{" "}</Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={loading || busy}
              onClick={() => void refresh()}
            ><I18nText id="accounts.refresh_accounts" />{" "}</Button>
          </div>
        </div>
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"><I18nText id="accounts.registered_account_verified_account_harness_binding_actual_cli" />{" "}</p>
        {loadedAt !== null && (
          <p className="text-xs text-muted-foreground"><I18nText id="accounts.local_snapshot_loaded" />{" "}{when(loadedAt)}<I18nText id="accounts.this_does_not_refresh_provider_quotas_refresh_to" />{" "}</p>
        )}
        <nav
          aria-label={tr("accounts.account_resource_views")}
          className="flex flex-wrap gap-1"
        >
          {VIEWS.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={view === item ? "secondary" : "ghost"}
              aria-pressed={view === item}
              onClick={() => {
                setView(item);
                setSelectedId(null);
                setHistory(null);
              }}
            >
              {tr(`acct.view.${item}` as TranslationKey)}
            </Button>
          ))}
        </nav>
      </header>
      {view === "Accounts" && !selectedId && <CodexProfiles onChanged={async () => { await refresh(); await onResourcesChanged?.(); }} />}
      {view === "Accounts" && !selectedId && <ExecutionProfiles refreshKey={version} />}
      {loading && (
        <p role="status" className="text-sm"><I18nText id="accounts.loading_account_resources" />{" "}</p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/50 p-3 text-sm text-destructive"
        >
          {error}
          {data && tr("common.the_last_loaded_snapshot_is_still_shown")}
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {data && (
        <>
          <dl
            className="grid grid-cols-2 gap-2 lg:grid-cols-4"
            aria-label={tr("accounts.accounts_overview")}
          >
            {accountMetrics(
              rows,
              profiles,
              harnesses.length,
              subscriptions.length,
              now,
            ).map(([label, count]) => (
              <div
                key={label}
                className="glass-column rounded-xl border p-3"
                data-testid={`account-metric-${label.toLowerCase().replaceAll(" ", "-")}`}
              >
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums">
                  {quantity(count)}
                </dd>
              </div>
            ))}
          </dl>
          <fieldset disabled={busy || loading} className="min-w-0 space-y-4">
            {view === "Accounts" &&
              (selected ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedId(null);
                      setHistory(null);
                    }}
                  ><I18nText id="accounts.back_to_accounts" />{" "}</Button>
                  <AccountDetails
                    onQuotaUpdated={refresh}
                    row={selected}
                    profiles={profiles}
                    harnesses={harnesses}
                    subscriptions={subscriptions}
                    now={now}
                    version={version}
                    onForm={setForm}
                    onHistory={onHistory}
                    onRun={run}
                  />
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="min-w-0 flex-1 text-xs"><I18nText id="accounts.search_accounts" />{" "}<Input
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(0);
                        }}
                        placeholder={tr("accounts.name_provider_or_account_id")}
                      />
                    </label>
                    <Button size="sm" onClick={() => setForm(accountForm())}><I18nText id="accounts.create_account" />{" "}</Button>
                  </div>
                  {rows.length === 0 && (
                    <p className="rounded-lg border border-dashed p-5 text-sm"><I18nText id="accounts.no_registered_accounts_create_a_metadata_card_to" />{" "}</p>
                  )}
                  {rows.length > 0 && filtered.length === 0 && (
                    <p className="text-sm"><I18nText id="accounts.no_matching_accounts" /></p>
                  )}
                  <div className="grid min-w-0 gap-3 xl:grid-cols-2">
                    {shown.map((row) => {
                      const a = row.account;
                      const latest = row.quotas
                        .flatMap((q) => q.observations)
                        .sort((a, b) => b.observedAt - a.observedAt)[0];
                      return (
                        <article
                          key={a.id}
                          className="glass-column min-w-0 space-y-3 rounded-xl border p-3"
                          data-testid="account-card"
                        >
                          <div>
                            <h3 className="text-sm font-semibold">
                              {a.displayName}
                            </h3>
                            <p className="text-xs text-muted-foreground"><I18nText id="accounts.registered_account" />{" "}{a.provider}
                            </p>
                          </div>
                          <AccountLimits row={row} now={now} />
                          <Facts
                            values={[
                              [tr("common.account_id"), a.id],
                              [tr("accounts.identity_provenance"), a.provenance],
                              [tr("common.verification_status"), a.verification],
                              [tr("accounts.declared_availability"), a.availability],
                              [
                                tr("common.related_harnesses"),
                                row.bindings
                                  .map(
                                    (b) =>
                                      harnesses.find(
                                        (h) => h.id === b.harnessId,
                                      )?.label ?? b.harnessId,
                                  )
                                  .join(", ") || tr("common.none_dc937b"),
                              ],
                              [
                                tr("common.associated_agent_profiles"),
                                row.profiles
                                  .map(
                                    (p) =>
                                      profiles.find(
                                        (item) => item.id === p.profileId,
                                      )?.name ?? p.profileId,
                                  )
                                  .join(", ") || tr("common.none_dc937b"),
                              ],
                              [
                                tr("common.subscriptions"),
                                accountSubscriptions(row)
                                  .map((s) => `${s.planLabel} (${s.id})`)
                                  .join(", ") || tr("common.none_dc937b"),
                              ],
                              [
                                tr("common.quota_summary"),
                                tr("common.definitions_unknown_balances", { p0: String(row.quotas.length), p1: String(row.quotas.filter((q) => q.current?.remaining == null).length) }),
                              ],
                              [tr("common.last_observation"), when(latest?.observedAt)],
                            ]}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openAccount(a.id)}
                          ><I18nText id="accounts.view_account_details" />{" "}</Button>
                        </article>
                      );
                    })}
                  </div>
                  {filtered.length > PAGE_SIZE && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                      ><I18nText id="accounts.previous_accounts" />{" "}</Button>
                      <span className="text-xs"><I18nText id="common.page" />{" "}{currentPage + 1}{" "}<I18nText id="common.of" />{" "}{lastPage + 1} ·{" "}
                        {filtered.length}{" "}<I18nText id="common.accounts" />{" "}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={currentPage === lastPage}
                        onClick={() => setPage(currentPage + 1)}
                      ><I18nText id="accounts.next_accounts" />{" "}</Button>
                    </div>
                  )}
                </>
              ))}
            {view === "Subscriptions" && (
              <section
                className="space-y-3"
                aria-label={tr("accounts.subscription_management")}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold"><I18nText id="accounts.subscription_management" />{" "}</h3>
                  <Button size="sm" onClick={() => setForm(subscriptionForm())}><I18nText id="accounts.create_subscription" />{" "}</Button>
                </div>
                <p className="text-xs text-muted-foreground"><I18nText id="accounts.shared_subscriptions_are_counted_once_by_subscription_id" />{" "}</p>
                <SubscriptionCommitments subscriptions={subscriptions} />
                {subscriptions.length === 0 && (
                  <p className="text-sm"><I18nText id="accounts.no_subscriptions_registered" /></p>
                )}
                {subscriptions.map((s) => (
                  <article
                    key={s.id}
                    className="glass-column min-w-0 space-y-3 rounded-xl border p-3"
                    data-testid="subscription-card"
                  >
                    <h4 className="text-sm font-semibold">{s.planLabel}</h4>
                    <SubscriptionFacts subscription={s} />
                    <div className="space-y-2">
                      <p className="text-xs font-medium"><I18nText id="accounts.associated_accounts" /></p>
                      {rows
                        .filter((r) => r.subscriptionIds.includes(s.id))
                        .map((r) => (
                          <div
                            key={r.account.id}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <button
                              className="text-xs underline"
                              onClick={() => openAccount(r.account.id)}
                            >
                              {r.account.displayName} · {r.account.id}
                            </button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void run(() =>
                                  api.accountCore.unlinkSubscription(
                                    r.account.id,
                                    s.id,
                                  ),
                                )
                              }
                            ><I18nText id="accounts.remove_membership" />{" "}</Button>
                          </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setForm(subscriptionForm(s))}
                      ><I18nText id="accounts.edit_subscription" />{" "}</Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setForm(
                            associationForm(
                              "Link Account to Subscription",
                              "Account",
                              rows
                                .filter(
                                  (r) =>
                                    r.account.provider === s.provider &&
                                    !r.subscriptionIds.includes(s.id),
                                )
                                .map((r) => ({
                                  id: r.account.id,
                                  label: r.account.displayName,
                                })),
                              (id) =>
                                api.accountCore.linkSubscription(id, s.id),
                            ),
                          )
                        }
                      ><I18nText id="accounts.link_account" />{" "}</Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () => api.accountCore.archiveSubscription(s.id),
                            "Archive subscription?",
                            "History remains available. Its quota evidence will no longer establish current capacity.",
                          )
                        }
                      ><I18nText id="accounts.archive_subscription" />{" "}</Button>
                    </div>
                  </article>
                ))}
              </section>
            )}
            {view === "Quota Sources" && <QuotaSources version={version} />}
            {view === "Quotas" && (
              <section className="space-y-3" aria-label={tr("accounts.quota_dashboard")}>
                <h3 className="text-sm font-semibold"><I18nText id="accounts.quota_dashboard" /></h3>
                <p className="text-xs text-muted-foreground"><I18nText id="accounts.each_definition_has_its_own_scope_unit_and" />{" "}</p>
                {rows.every((r) => r.quotas.length === 0) && (
                  <p className="text-sm"><I18nText id="accounts.no_quota_definitions" /></p>
                )}
                {rows
                  .filter((r) => r.quotas.length)
                  .map((row) => (
                    <div key={row.account.id} className="space-y-2">
                      <button
                        className="text-sm font-medium underline"
                        onClick={() => openAccount(row.account.id)}
                      >
                        {row.account.displayName} · {row.account.id}
                      </button>
                      {row.quotas.map((q) => (
                        <QuotaCard
                          key={q.definition.id}
                          state={q}
                          now={now}
                          onHistory={() => onHistory(q.definition)}
                          onObserve={() =>
                            setForm(observationForm(q.definition))
                          }
                          onArchive={() =>
                            void run(
                              () =>
                                api.accountCore.archiveDefinition(
                                  q.definition.id,
                                ),
                              "Archive quota definition?",
                              "Observation history is retained. Create a new definition to change units or semantics.",
                            )
                          }
                        />
                      ))}
                    </div>
                  ))}
              </section>
            )}
            {view === "Resource Availability" && (
              <section className="space-y-3" aria-label={tr("accounts.resource_availability")}>
                <h3 className="text-sm font-semibold"><I18nText id="accounts.resource_availability" /></h3>
                <p className="text-xs text-muted-foreground"><I18nText id="accounts.model_declarations_are_evidence_only_model_support_and" />{" "}</p>
                {harnesses.length === 0 && (
                  <p className="text-sm"><I18nText id="accounts.no_harness_configurations" /></p>
                )}
                {harnesses.map((h) => {
                  const bound = rows.filter((r) =>
                    r.bindings.some((b) => b.harnessId === h.id),
                  );
                  return (
                    <article
                      key={h.id}
                      className="glass-column min-w-0 space-y-3 rounded-xl border p-3"
                      data-testid="availability-card"
                    >
                      <h4 className="text-sm font-semibold">{h.label}</h4>
                      <Facts
                        values={[
                          [tr("common.harness"), `${h.id} · ${h.kind}`],
                          [tr("common.configuration"), h.enabled ? tr("common.enabled") : tr("common.disabled_75081b")],
                          [tr("common.actual_cli_authentication"), tr("common.unknown")],
                          [tr("common.executable_readiness"), tr("common.unknown")],
                        ]}
                      />
                      {bound.length === 0 && (
                        <p className="text-xs"><I18nText id="accounts.registered_accounts_none_known_quota_capacity_unknown_model" />{" "}</p>
                      )}
                      {bound.map((r) => (
                        <div
                          key={r.account.id}
                          className="space-y-2 rounded-lg border p-2"
                        >
                          <button
                            className="text-xs font-medium underline"
                            onClick={() => openAccount(r.account.id)}
                          >
                            {r.account.displayName} · {r.account.id}
                          </button>
                          <Facts
                            values={[
                              [tr("accounts.declared_availability"), r.account.availability],
                              [tr("accounts.identity_provenance"), r.account.provenance],
                              [tr("common.verification"), r.account.verification],
                              [
                                tr("common.known_quota_capacity"),
                                r.quotas
                                  .filter((q) => q.current?.remaining != null)
                                  .map(
                                    (q) =>
                                      `${quantity(q.current!.remaining)} ${unitLabel(q.definition.unit)} · ${q.definition.scope} · ${q.definition.window}`,
                                  )
                                  .join("; ") || tr("common.unknown"),
                              ],
                              [
                                tr("common.unknown_capacity"),
                                tr("common.definitions_other_limits_unknown", { p0: String(r.quotas.filter((q) => q.current?.remaining == null).length) }),
                              ],
                              [
                                tr("common.profile_associations"),
                                r.profiles
                                  .filter((p) => p.harnessId === h.id)
                                  .map(
                                    (p) =>
                                      `${profiles.find((item) => item.id === p.profileId)?.name ?? p.profileId}${
                                        profileWarning(
                                          r,
                                          profiles.find(
                                            (item) => item.id === p.profileId,
                                          ),
                                          p.harnessId,
                                        )
                                          ? tr("common.unreliable")
                                          : tr("common.user_declared")
                                      }`,
                                  )
                                  .join(", ") || tr("common.none_dc937b"),
                              ],
                              [
                                tr("common.model_capability_evidence"),
                                tr("common.declarations_verified_model_support_unknown", { p0: String(r.models.filter((m) => m.harnessId === h.id).length) }),
                              ],
                              [
                                tr("common.resource_conflicts"),
                                quantity(
                                  r.quotas.filter(
                                    (q) => q.status === "conflict",
                                  ).length,
                                ),
                              ],
                              [
                                tr("common.freshness_warnings"),
                                r.quotas.flatMap((q) => q.warnings).join(" ") ||
                                  tr("common.no_current_quota_warnings_undeclared_capacity_remains_unknown"),
                              ],
                            ]}
                          />
                          {r.bindings.length > 1 && (
                            <p className="text-xs text-muted-foreground"><I18nText id="accounts.shared_account_across" />{" "}{r.bindings.length}{" "}<I18nText id="accounts.harnesses_displayed_evidence_belongs_to_the_account_and" />{" "}</p>
                          )}
                        </div>
                      ))}
                    </article>
                  );
                })}
              </section>
            )}
            {view === "Unassigned Usage" && (
              <LegacyUsage now={now} version={version} />
            )}
            {view === "Archived Accounts" && (
              <ArchivedAccounts version={version} onHistory={onHistory} />
            )}
            {history && (
              <div className="rounded-xl border p-3">
                <div className="mb-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistory(null)}
                  ><I18nText id="accounts.close_history" />{" "}</Button>
                </div>
                <QuotaHistory
                  definition={history}
                  now={now}
                  version={version}
                />
              </div>
            )}
          </fieldset>
        </>
      )}
      {form && (
        <ResourceFormDialog
          form={form}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setNotice("Changes saved.");
            await refresh();
          }}
        />
      )}
    </section>
  );
}
