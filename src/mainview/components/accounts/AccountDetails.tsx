import { codeLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { QuotaSources } from "./QuotaSources";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  accountError,
  moneyLabel,
  profileWarning,
  unitLabel,
  when,
} from "@/lib/accounts";
import type { AccountResource } from "@/lib/account-api";
import { Button } from "@/components/ui/button";
import {
  accountForm,
  associationForm,
  definitionForm,
  observationForm,
  type ResourceForm,
} from "./AccountForms";
import { AccountLimits, Facts, QuotaCard } from "./AccountEvidence";
import { SubscriptionFacts } from "./AccountSubscriptions";
import type {
  Account,
  QuotaDefinition,
  Subscription,
} from "../../../shared/accounts/types.ts";
import type { AgentProfile, Harness } from "../../../shared/types.ts";

const PAGE_SIZE = 12;

export function AccountDetails({
  row,
  profiles,
  harnesses,
  subscriptions,
  now,
  version,
  onForm,
  onHistory,
  onRun,
  onQuotaUpdated,
}: {
  onQuotaUpdated: () => Promise<void>;
  row: AccountResource;
  profiles: AgentProfile[];
  harnesses: Harness[];
  subscriptions: Subscription[];
  now: number;
  version: number;
  onForm: (form: ResourceForm) => void;
  onHistory: (d: QuotaDefinition) => void;
  onRun: (
    action: () => Promise<unknown>,
    title?: string,
    description?: string,
  ) => Promise<void>;
}) {
  useUILocale();
  const a = row.account;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [a.id]);
  const linked = subscriptions.filter((s) =>
    row.subscriptionIds.includes(s.id),
  );
  const warnings = [
    ...(a.verification !== "verified"
      ? [
          tr("common.account_identity_is_not_provider_verified_actual_cli"),
        ]
      : []),
    ...row.profiles.flatMap((p) => {
      const warning = profileWarning(
        row,
        profiles.find((item) => item.id === p.profileId),
        p.harnessId,
      );
      return warning ? [warning] : [];
    }),
    ...row.quotas.flatMap((q) => q.warnings),
  ];
  return (
    <article className="min-w-0 space-y-6" data-testid="account-details">
      <header>
        <h3
          ref={titleRef}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          {a.displayName}
        </h3>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {a.provider}{" "}<I18nText id="accounts.account_id" />{" "}{a.id}
        </p>
      </header>
      <AccountLimits row={row} now={now} />
      <section className="space-y-2" aria-label={tr("common.identity")}>
        <h4 className="text-sm font-semibold"><I18nText id="common.identity" /></h4>
        <Facts
          values={[
            [tr("common.external_identity"), a.externalIdentity ?? tr("common.unknown")],
            [tr("accounts.identity_provenance"), a.provenance],
            [tr("common.source"), a.source],
            [tr("common.verification_status"), a.verification],
            [tr("accounts.declared_availability"), a.availability],
            [tr("common.actual_cli_authentication"), tr("common.unknown")],
            [tr("common.created_at"), when(a.createdAt)],
            [tr("common.updated_at"), when(a.updatedAt)],
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onForm(accountForm(a))}
          ><I18nText id="accounts.edit_metadata" />{" "}</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void onRun(
                () => api.accountCore.archiveAccount(a.id),
                "Archive account?",
                "Bindings and profile associations will be removed. Quota history is retained.",
              )
            }
          ><I18nText id="accounts.archive_account" />{" "}</Button>
        </div>
      </section>
      <section className="space-y-2" aria-label={tr("accounts.harness_bindings")}>
        <h4 className="text-sm font-semibold"><I18nText id="accounts.harness_bindings" /></h4>
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.explicit_metadata_bindings_permit_several_accounts_per_harness" />{" "}</p>
        {row.bindings.length === 0 && (
          <p className="text-xs"><I18nText id="accounts.no_harness_bindings" /></p>
        )}
        {row.bindings.map((b) => (
          <div
            key={b.harnessId}
            className="flex flex-wrap items-center gap-2 text-xs"
          >
            <span>
              {harnesses.find((h) => h.id === b.harnessId)?.label ??
                b.harnessId}{" "}
              · {b.harnessId} · {codeLabel(b.provenance)} · {codeLabel(b.verification)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void onRun(
                  () => api.accountCore.unbindHarness(a.id, b.harnessId),
                  "Unbind harness?",
                  "Related profile associations and model declarations will also be removed.",
                )
              }
            ><I18nText id="accounts.unbind_harness" />{" "}</Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onForm(
              associationForm(
                "Bind Harness",
                "Harness",
                harnesses
                  .filter(
                    (h) => !row.bindings.some((b) => b.harnessId === h.id),
                  )
                  .map((h) => ({ id: h.id, label: h.label })),
                (id) => api.accountCore.bindHarness(a.id, id),
                "A binding does not authenticate or switch a CLI account.",
              ),
            )
          }
        ><I18nText id="accounts.bind_harness" />{" "}</Button>
      </section>
      <section className="space-y-2" aria-label={tr("accounts.agent_profiles")}>
        <h4 className="text-sm font-semibold"><I18nText id="accounts.agent_profiles" /></h4>
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.this_association_does_not_switch_the_cli_account" />{" "}</p>
        {row.profiles.length === 0 && (
          <p className="text-xs"><I18nText id="accounts.no_profile_associations" /></p>
        )}
        {row.profiles.map((p) => {
          const profile = profiles.find((item) => item.id === p.profileId);
          const warning = profileWarning(row, profile, p.harnessId);
          return (
            <div key={p.profileId} className="rounded-lg border p-2 text-xs">
              <p>
                {profile?.name ?? p.profileId} · {p.harnessId} ·{" "}
                {profile?.model ?? tr("common.unknown_model")}{" "}<I18nText id="accounts.configuration_declaration" />{" "}</p>
              {warning && <p role="status">{warning}</p>}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void onRun(() =>
                    api.accountCore.unbindProfile(a.id, p.profileId),
                  )
                }
              ><I18nText id="accounts.remove_profile_association" />{" "}</Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onForm(
              associationForm(
                "Associate Agent Profile",
                "Agent Profile",
                profiles
                  .filter(
                    (p) =>
                      !row.profiles.some((item) => item.profileId === p.id),
                  )
                  .map((p) => ({
                    id: p.id,
                    label: `${p.name} · ${p.harness}${row.bindings.some((b) => b.harnessId === p.harness) ? "" : " · bind harness first"}`,
                  })),
                (id) => api.accountCore.bindProfile(a.id, id),
                "This association does not switch the CLI account.",
              ),
            )
          }
        ><I18nText id="accounts.associate_agent_profile" />{" "}</Button>
      </section>
      <section className="space-y-2" aria-label={tr("common.subscriptions")}>
        <h4 className="text-sm font-semibold"><I18nText id="common.subscriptions" /></h4>
        {linked.length === 0 && (
          <p className="text-xs"><I18nText id="accounts.no_subscriptions_associated" /></p>
        )}
        {linked.map((s) => (
          <div key={s.id} className="space-y-2 rounded-lg border p-3">
            <h5 className="text-xs font-medium">{s.planLabel}</h5>
            <SubscriptionFacts subscription={s} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void onRun(() => api.accountCore.unlinkSubscription(a.id, s.id))
              }
            ><I18nText id="accounts.remove_membership" />{" "}</Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onForm(
              associationForm(
                "Link Subscription",
                "Subscription",
                subscriptions
                  .filter(
                    (s) =>
                      s.provider === a.provider &&
                      !row.subscriptionIds.includes(s.id),
                  )
                  .map((s) => ({
                    id: s.id,
                    label: `${s.planLabel} · ${moneyLabel(s.recurringCostMinor, s.currency)}`,
                  })),
                (id) => api.accountCore.linkSubscription(a.id, id),
              ),
            )
          }
        ><I18nText id="accounts.link_subscription" />{" "}</Button>
      </section>
      <QuotaSources accountId={a.id} quotas={row.quotas} now={now} version={version} onUpdated={onQuotaUpdated} />
      <section className="space-y-3" aria-label={tr("accounts.quotas")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold"><I18nText id="accounts.quotas" /></h4>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onForm(definitionForm(a, linked))}
          ><I18nText id="accounts.create_quota_definition" />{" "}</Button>
        </div>
        {row.quotas.length === 0 && (
          <p className="text-xs"><I18nText id="accounts.no_quota_definitions_capacity_unknown" /></p>
        )}
        {row.quotas.map((q) => (
          <QuotaCard
            key={q.definition.id}
            state={q}
            now={now}
            onObserve={() => onForm(observationForm(q.definition))}
            onHistory={() => onHistory(q.definition)}
            onArchive={() =>
              void onRun(
                () => api.accountCore.archiveDefinition(q.definition.id),
                "Archive quota definition?",
                "History remains immutable. Use a new definition for different units or semantics.",
              )
            }
          />
        ))}
      </section>
      <ArchivedDefinitions
        accountId={a.id}
        version={version}
        onHistory={onHistory}
      />
      <section className="space-y-2" aria-label={tr("accounts.model_capabilities")}>
        <h4 className="text-sm font-semibold"><I18nText id="accounts.model_capabilities_read_only" />{" "}</h4>
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.model_declaration_verified_model_support_no_supported_verification" />{" "}</p>
        {row.models.length === 0 && (
          <p className="text-xs"><I18nText id="accounts.no_model_capability_evidence_support_unknown" />{" "}</p>
        )}
        {row.models.map((m) => (
          <div
            key={`${m.harnessId}:${m.modelId}`}
            className="rounded-lg border p-2"
          >
            <Facts
              values={[
                [tr("common.model"), m.modelId],
                [tr("common.harness"), m.harnessId],
                [tr("common.declared_support"), m.support],
                [tr("common.source"), m.source],
                [tr("common.provenance"), m.provenance],
                [tr("common.verification"), m.verification],
                [tr("accounts.observed_at"), when(m.observedAt)],
                [tr("common.expires_at"), when(m.expiresAt)],
                [
                  tr("common.freshness"),
                  m.expiresAt === null
                    ? tr("common.unknown")
                    : m.expiresAt <= now
                      ? tr("common.expired_424a25")
                      : tr("common.within_declared_expiry"),
                ],
              ]}
            />
          </div>
        ))}
      </section>
      <section className="space-y-2" aria-label={tr("accounts.data_quality_warnings")}>
        <h4 className="text-sm font-semibold"><I18nText id="accounts.data_quality_warnings" /></h4>
        {[...new Set(warnings)].map((w) => (
          <p key={w} className="text-xs text-muted-foreground">
            {w}
          </p>
        ))}
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.unknown_quotas_are_not_unlimited_a_reset_timestamp" />{" "}</p>
      </section>
    </article>
  );
}

function ArchivedDefinitions({
  accountId,
  version,
  onHistory,
  includeAll = false,
}: {
  accountId: string;
  version: number;
  onHistory: (d: QuotaDefinition) => void;
  includeAll?: boolean;
}) {
  useUILocale();
  const [definitions, setDefinitions] = useState<QuotaDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    setError(null);
    setDefinitions([]);
    setLoading(true);
    void api.accountCore
      .definitions(accountId)
      .then((rows) => {
        if (!disposed)
          setDefinitions(
            rows.filter((d) => includeAll || d.archivedAt !== null),
          );
      })
      .catch((err) => {
        if (!disposed) setError(accountError(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [accountId, version, includeAll]);
  return (
    <section className="space-y-2" aria-label={tr("accounts.archived_quota_history")}>
      <h4 className="text-sm font-semibold"><I18nText id="accounts.archived_quota_history" /></h4>
      {loading && (
        <p role="status" className="text-xs"><I18nText id="accounts.loading_definitions" />{" "}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {definitions.length === 0 && !error && !loading && (
        <p className="text-xs text-muted-foreground"><I18nText id="accounts.no_archived_definitions" />{" "}</p>
      )}
      {definitions.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {unitLabel(d.unit)} · {d.scope} · {d.window}
          </span>
          <Button size="sm" variant="outline" onClick={() => onHistory(d)}><I18nText id="accounts.view_archived_history" />{" "}</Button>
        </div>
      ))}
    </section>
  );
}

export function ArchivedAccounts({
  version,
  onHistory,
}: {
  version: number;
  onHistory: (d: QuotaDefinition) => void;
}) {
  useUILocale();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void api.accountCore
      .accounts(true)
      .then((rows) => {
        if (!disposed) setAccounts(rows.filter((a) => a.archivedAt !== null));
      })
      .catch((err) => {
        if (!disposed) setError(accountError(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [version]);
  return (
    <section className="space-y-3" aria-label={tr("accounts.archived_accounts")}>
      <h3 className="text-sm font-semibold"><I18nText id="accounts.archived_accounts" /></h3>
      <p className="text-xs text-muted-foreground"><I18nText id="accounts.archived_metadata_and_immutable_quota_history_bindings_were" />{" "}</p>
      {loading && (
        <p role="status" className="text-xs"><I18nText id="accounts.loading_archived_accounts" />{" "}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && !accounts.length && (
        <p className="text-xs"><I18nText id="accounts.no_archived_accounts" /></p>
      )}
      {accounts.slice(0, visible).map((a) => (
        <article key={a.id} className="min-w-0 space-y-3 rounded-xl border p-3">
          <h4 className="text-sm font-medium">{a.displayName}</h4>
          <Facts
            values={[
              [tr("common.account_id"), a.id],
              [tr("common.provider"), a.provider],
              [tr("accounts.identity_provenance"), a.provenance],
              [tr("common.verification"), a.verification],
              [tr("common.archived_at"), when(a.archivedAt)],
            ]}
          />
          <Button size="sm" variant="outline" onClick={() => setSelected(a.id)}><I18nText id="accounts.browse_archived_account_history" />{" "}</Button>
          {selected === a.id && (
            <ArchivedDefinitions
              accountId={a.id}
              version={version}
              onHistory={onHistory}
              includeAll
            />
          )}
        </article>
      ))}
      {visible < accounts.length && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
        ><I18nText id="accounts.show_more_archived_accounts" />{" "}</Button>
      )}
    </section>
  );
}
