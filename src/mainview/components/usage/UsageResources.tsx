import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import type { PricingTerms } from "../../../shared/usage-analytics.ts";
import { DataTable, date, notesClass, number, Picker, QuotaTable, quotaEvidenceKind, unknown } from "./presentation";

import { OwnerQuota } from "./OwnerQuota";

type Resources = Awaited<ReturnType<typeof api.usageResources>>;
const fields = [
  ["inputPerMillion", "usage.input"], ["outputPerMillion", "usage.output"],
  ["cacheReadPerMillion", "usage.cacheRead"], ["cacheWritePerMillion", "usage.cacheWrite"],
] as const;
const keyOf = (r: Resources["resources"][number]) => JSON.stringify([r.harnessId, r.modelId, r.accountId]);

export function UsageResources({ data, onChange }: { data: Resources; onChange: () => Promise<void> }) {
  const [account, selectAccount] = useState("");
  const [provider, selectProvider] = useState("");
  const [model, selectModel] = useState("");
  const [priceKey, setPriceKey] = useState("");
  const [billing, setBilling] = useState<PricingTerms["billing"]>("unknown");
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accounts = new Map(data.accounts.map(a => [a.id, a]));
  const resource = data.resources.find(r => keyOf(r) === priceKey);
  const matching = data.resources.filter(r =>
    (!provider || r.provider === provider) && (!account || r.accountId === account) && (!model || r.modelId === model));
  const visibleAccount = (a: Resources["accounts"][number]) => (!provider || a.provider === provider) &&
    (!account || a.id === account) && (!model || matching.some(r => r.accountId === a.id));
  async function save() {
    if (!resource) return;
    const rate = (field: string) => rates[field]?.trim() ? Number(rates[field]) : null;
    setBusy(true);
    setError("");
    try {
      await api.usagePricing({
        harnessId: resource.harnessId, modelId: resource.modelId, accountId: resource.accountId, currency, billing,
        inputPerMillion: rate("inputPerMillion"), outputPerMillion: rate("outputPerMillion"),
        cacheReadPerMillion: rate("cacheReadPerMillion"), cacheWritePerMillion: rate("cacheWritePerMillion"),
      });
      await onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const filterOptions = (items: string[]) => [...new Set(items)].sort().map(id => ({ id, label: id }));
  return <div className="space-y-4" data-testid="usage-resources">
    <details className="rounded-md border bg-card p-3">
      <summary className="cursor-pointer font-semibold">{t("usage.providerInventory")}</summary>
      <div className="mt-2">
        <DataTable headings={[t("usage.provider"), t("usage.installation"), t("usage.auth"), t("usage.modelsDiscovered"), t("usage.executionModes"), t("usage.binding")]}
          rows={data.inventory.map(p => ({ id: p.kind, cells: [
            <span>{p.provider} · {p.kind}{p.blockers.map(b => <small key={b} className="block text-muted-foreground">{b}</small>)}</span>,
            status(p.installed, "usage.installed", "usage.notInstalled"),
            p.harnesses.map(h => `${h.label}: ${status(h.auth, "usage.ready", "usage.authRequired")}`).join(" · ") || unknown(),
            p.harnesses.some(h => h.discoveredModels.length) ? <details><summary>{number(new Set(p.harnesses.flatMap(h => h.discoveredModels)).size)}</summary>
              {p.harnesses.filter(h => h.discoveredModels.length).map(h => <p className="break-words" key={h.id}>{h.label}: {h.discoveredModels.join(", ")}</p>)}</details> : unknown(),
            p.modes.map(m => m.label).join(", ") || unknown(),
            <span>{p.accountSelection === "child-home" ? t("usage.selectableProfile") : p.isolation === "partial" ? t("usage.partialIsolation") : unknown()}
              <small className="block text-muted-foreground">{t("usage.runTelemetry")}: {p.tokens ? t("usage.local") : unknown()}</small>
              <small className="block text-muted-foreground">{t("usage.upstreamRequests")}: {p.requests ? t("usage.ownerReported") : unknown()}</small>
              <small className="block text-muted-foreground">{t("usage.billingEvidence")}: {unknown()}</small>
            </span>,
          ] }))} />
      </div>
    </details>
    <p className={notesClass}>{t("usage.resourcesNote")}</p>
    <div className="grid gap-2 sm:grid-cols-3">
      <Picker label={t("usage.provider")} value={provider} options={filterOptions([...data.inventory.map(p => p.provider), ...data.accounts.map(a => a.provider)])} onChange={selectProvider} />
      <Picker label={t("usage.account")} value={account} options={data.accounts.map(a => ({ id: a.id, label: a.label }))} onChange={selectAccount} />
      <Picker label={t("usage.model")} value={model} options={filterOptions(data.resources.map(r => r.modelId))} onChange={selectModel} />
    </div>
    <details>
      <summary className="cursor-pointer font-semibold">{t("usage.configuredModels")}</summary>
      <DataTable headings={[t("usage.provider"), t("usage.model"), t("usage.account"), t("usage.installation"), t("usage.auth"), t("usage.binding"), t("usage.execution")]}
        rows={matching.map(r => ({ id: keyOf(r), cells: [
          `${r.provider} · ${r.harness}`, r.modelId, r.accountId ? accounts.get(r.accountId)?.label ?? unknown() : unknown(),
          status(r.installed, "usage.installed", "usage.notInstalled"), status(r.auth, "usage.ready", "usage.authRequired"),
          r.binding === "exact" ? t("usage.exactBinding") : r.binding === "metadata" ? t("usage.metadataBinding") : unknown(),
          <span>{!r.enabled ? t("usage.disabled") : r.blocks.length || r.installed === false && !r.simulated || r.auth === false ? t("usage.blocked")
            : r.simulated ? t("usage.synthetic") : r.auth === true ? t("usage.eligible") : t("usage.preflight")}
            <small className="block text-muted-foreground">{[r.mode, ...r.blocks].join(" · ")}</small>
            {r.accountId && <small className="block text-muted-foreground">{t("usage.resourceLimits")}: {number(r.occupied)} / {number(r.limit)}</small>}</span>,
        ] }))} />
    </details>
    {data.accounts.filter(visibleAccount).map(a => <section key={a.id} className="space-y-3 rounded-md border bg-card p-3">
      <h3 className="font-semibold">{a.label} · {a.provider}{a.archived ? " · " + t("usage.archivedAccount") : ""}</h3>
      <p className={notesClass}>{t("usage.identity")} · {a.identity === "verified" ? t("usage.verified") : unknown()}</p>
      <p className={notesClass}>{t("usage.resourceLimits")} · {t("usage.limit")}: {number(a.profileLimit)} · {t("usage.sharedLimit")}: {number(a.providerLimit)}</p>
      <AccountQuota account={a} onChange={onChange} />
    </section>)}
    <details>
      <summary className="cursor-pointer font-semibold">{t("usage.observedConsumption")}</summary>
      <div className="mt-2">
        <DataTable headings={[t("usage.provider"), t("usage.used"), t("usage.reset"), t("usage.observed")]}
          rows={data.observations.filter(o => !provider && !account && !model || !account && matching.some(r => r.harnessId === o.harnessId))
            .flatMap(o => o.meters.map(m => ({ id: o.harnessId + m.id, cells: [
              `${o.harnessId} · ${m.id}`, m.usedPercent == null ? unknown() : `${number(m.usedPercent)}%`,
              date(m.resetsAtMs), date(o.observedAt),
            ] })))} />
      </div>
    </details>
    <details>
      <summary className="cursor-pointer font-semibold">{t("usage.pricing")}</summary>
      <div className="mt-2 space-y-3">
        <p className={notesClass}>{t("usage.pricingNote")}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Picker label={t("usage.model")} value={priceKey} onChange={setPriceKey} placeholder={t("usage.select")}
            options={matching.map(r => ({ id: keyOf(r), label: `${r.harness} · ${r.modelId} · ${r.accountId ? accounts.get(r.accountId)?.label ?? unknown() : unknown()}` }))} />
          <Picker label={t("usage.billing")} value={billing} options={["api", "subscription", "internal", "unknown"].map(id => ({ id, label: t(`usage.${id}` as TranslationKey) }))}
            onChange={value => setBilling((value || "unknown") as PricingTerms["billing"])} />
          <label className="space-y-1 text-xs text-muted-foreground">{t("usage.currency")}
            <Input value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} />
          </label>
          {fields.map(([key, label]) => <label key={key} className="space-y-1 text-xs text-muted-foreground">{t(label)}
            <Input type="number" min={0} step="any" value={rates[key] ?? ""} onChange={e => setRates(previous => ({ ...previous, [key]: e.target.value }))} />
          </label>)}
        </div>
        <Button disabled={!resource || busy} onClick={() => void save()}>{t("usage.savePricing")}</Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DataTable headings={[t("usage.revision"), t("usage.model"), t("usage.billing"), t("usage.currency"), ...fields.map(([, label]) => t(label)), t("usage.observed")]}
          rows={data.pricing.filter(p => !provider && !account && !model || matching.some(r => r.harnessId === p.harnessId && r.modelId === p.modelId && r.accountId === p.accountId))
            .map(p => ({ id: String(p.id), cells: [
              `#${p.id}`, `${p.modelId} · ${p.accountId ? accounts.get(p.accountId)?.label ?? unknown() : unknown()}`,
              t(`usage.${p.terms.billing}`), p.terms.currency, ...fields.map(([key]) => number(p.terms[key])), date(p.createdAt),
            ] }))} />
      </div>
    </details>
  </div>;
}

function status(value: boolean | null, yes: TranslationKey, no: TranslationKey) {
  return value === null ? unknown() : t(value ? yes : no);
}

function AccountQuota({ account, onChange }: { account: Resources["accounts"][number]; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sections = [
    ["usage.verifiedQuotaSection", ["verified"]], ["usage.ownerReported", ["ownerReported"]],
    ["usage.diagnosticQuotaSection", ["synthetic", "local"]],
  ] as const;
  async function refresh(source: string) {
    setBusy(true); setError("");
    try { await api.accountCore.refreshQuota(account.id, source); await onChange(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <>
    {!account.quota.some(q => q.current && quotaEvidenceKind(q.current) === "verified") &&
      <p className={notesClass}>{t("usage.verifiedQuotaSection")} · {unknown()}</p>}
    {account.quota.filter(q => q.warning).map(q => <p key={q.id} className="text-sm text-warning">
      {q.window} · {t("usage.thresholdReached")} · {q.current ? t(`usage.${quotaEvidenceKind(q.current)}`) : t("usage.ownerReported")}
    </p>)}
    <OwnerQuota account={account} onChange={onChange} />
    {sections.map(([label, kinds]) => {
      const matches = (o: Parameters<typeof quotaEvidenceKind>[0]) => (kinds as readonly string[]).includes(quotaEvidenceKind(o));
      const pools = account.quota.map(q => ({ ...q, current: matches(q.current) ? q.current : null,
        ownerReported: matches(q.ownerReported) ? q.ownerReported : null, observations: q.observations.filter(matches) }))
        .filter(q => q.current || q.ownerReported || q.observations.length);
      return pools.length ? <div key={label} className="space-y-1">
        <h4 className="text-sm font-semibold">{t(label)}</h4><QuotaTable quota={pools} />
      </div> : null;
    })}
    {account.quota.map(pool => <QuotaHistory key={pool.id} pool={pool} />)}
    {account.quota.some(q => q.changes.length) && <details>
      <summary className="cursor-pointer text-sm">{t("usage.quotaChanges")}</summary>
      <DataTable headings={[t("usage.scope"), t("usage.used"), t("usage.observed")]}
        rows={account.quota.flatMap(q => q.changes.map((c, index) => ({
          id: `${q.id}:${index}`, cells: [
            `${q.scope} · ${q.window} · ${c.provenance === "user-provided" ? t("usage.ownerReported") : c.source}`,
            [c.amount === null ? null : `${number(c.amount)} ${"name" in q.unit ? q.unit.name : "currency" in q.unit ? q.unit.currency + " · " + t("usage.moneyMinor") : q.unit.kind}`,
              c.percent === null ? null : `${number(c.percent)} ${t("usage.quotaPercentagePoints")}`].filter(Boolean).join(" · "),
            `${date(c.from)} → ${date(c.to)}`,
          ],
        })))} />
    </details>}
    <details>
      <summary className="cursor-pointer text-sm">{t("usage.quotaSources")}</summary>
      {!account.sources.some(s => s.refreshAvailable) && <p className={notesClass}>{t("usage.refreshUnavailable")}</p>}
      {account.sources.filter(s => s.id !== "manual").map(s => <div className="my-2 text-xs" key={s.id}>
        {s.officialUrl ? <a href={s.officialUrl} target="_blank" rel="noreferrer" className="underline">{s.label}</a> : s.label}
        <p className={notesClass}>{s.reason}</p>
        {s.refreshAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh(s.id)}>{t("usage.refreshQuota")}</Button>}
      </div>)}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </details>
  </>;
}

function QuotaHistory({ pool }: { pool: Resources["accounts"][number]["quota"][number] }) {
  const [rows, setRows] = useState<typeof pool.observations>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try {
      const page = await api.usageQuotaHistory(pool.id, cursor);
      setRows(previous => [...previous, ...page.observations]);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <details className="text-xs">
    <summary className="cursor-pointer">{t("usage.quotaHistory")} · {pool.scope} · {pool.window}</summary>
    {loaded && <QuotaTable quota={[{ ...pool, current: null, ownerReported: null, observations: rows }]} />}
    {(!loaded || cursor !== null) && <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>{t("usage.quotaMoreHistory")}</Button>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </details>;
}
