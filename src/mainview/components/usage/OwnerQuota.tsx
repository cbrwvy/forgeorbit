import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import type { QuotaCategory, QuotaUnit } from "../../../shared/accounts/types.ts";
import { date, notesClass, number, Picker, unknown } from "./presentation";

type ResourceAccount = Awaited<ReturnType<typeof api.usageResources>>["accounts"][number];
type Pool = ResourceAccount["quota"][number];
type Reading = Pool["observations"][number];
const hours = 3_600_000;
const categoryLabels: Record<QuotaCategory, TranslationKey> = {
  subscription: "usage.subscription", "api-rate": "usage.apiRate", "api-credit": "usage.apiCredit",
  "organization-budget": "usage.organizationBudget", other: "usage.otherQuota",
};
const unitLabels = {
  percentage: "usage.percentage", requests: "usage.requests", tokens: "usage.tokens", money: "usage.moneyMinor",
  "provider-specific": "usage.providerUnit",
} as const;
const localDate = (value: number | null) => value == null ? "" :
  new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);

export function OwnerQuota({ account, onChange }: { account: ResourceAccount; onChange: () => Promise<void> }) {
  const [poolId, setPool] = useState("");
  const [revision, revise] = useState<Reading | null>(null);
  const [show, setShow] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [scope, setScope] = useState("account");
  const [kind, setKind] = useState<keyof typeof unitLabels>("percentage");
  const [category, setCategory] = useState<QuotaCategory>("subscription");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const pools = account.quota.filter(q => !q.archived);
  const pool = pools.find(q => q.id === poolId);
  const unitKind = pool?.unit.kind ?? kind;
  const correction = (p: Pool, row: Reading) => {
    setPool(p.id); revise(row); setSaved(false); setError(""); setShow(true); setFormKey(n => n + 1);
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const str = (key: string) => String(fields.get(key) ?? "").trim();
    const num = (key: string) => str(key) ? Number(str(key)) : null;
    const ms = (key: string) => str(key) ? new Date(str(key)).getTime() : null;
    const observedAt = revision && str("observedAt") === localDate(revision.observedAt) ? revision.observedAt : ms("observedAt") ?? Date.now();
    const resetAt = revision && str("resetAt") === localDate(revision.resetAt) ? revision.resetAt : ms("resetAt");
    const freshness = num("freshness");
    const expiresAt = freshness === null ? null : Math.round(observedAt + freshness * hours);
    const usedPercent = num("usedPercent");
    const limit = num("limit"), used = num("used"), remaining = num("remaining");
    setError(""); setSaved(false);
    if (![observedAt, resetAt, expiresAt, usedPercent, limit, used, remaining].every(n => n === null || Number.isFinite(n)) ||
        [usedPercent, limit, used, remaining, resetAt].every(n => n === null)) {
      setError(t("usage.quotaInputError")); return;
    }
    const observation = { observedAt, resetAt, expiresAt, limit, used, remaining,
      indicator: usedPercent === null ? null : { kind: "percent-used" as const, value: usedPercent },
      sourceNote: str("sourceNote") || undefined, evidenceReference: str("evidenceReference") || undefined,
      revises: revision?.id, confidence: "unknown" as const };
    setBusy(true);
    try {
      if (pool) await api.accountCore.recordObservation(pool.id, observation);
      else {
        const unit: QuotaUnit = kind === "money" ? { kind, currency: str("currency").toUpperCase() }
          : kind === "provider-specific" ? { kind, name: str("unitName") } : { kind };
        const subject = str("scopeName");
        const result = await api.accountCore.recordOwnerPool(account.id, {
          subscriptionId: null, category, scope: scope === "account" ? scope : `${scope}:${subject}`,
          modelIds: scope === "group" ? str("modelIds").split(",").map(id => id.trim()).filter(Boolean) : [],
          unit, window: str("window"), windowMs: num("windowHours") === null ? null : Math.round(num("windowHours")! * hours),
          warnAtRemainingPercent: num("warning"),
        }, observation);
        setPool(result.definition.id);
      }
      await onChange();
      revise(null); setFormKey(n => n + 1); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const field = (name: string, label: TranslationKey, props: React.ComponentProps<typeof Input> = {}) =>
    <label className="block space-y-1 text-xs text-muted-foreground">{t(label)}<Input name={name} {...props} /></label>;
  if (account.archived) return null;
  return <div className="space-y-2">
    <Button type="button" variant="outline" size="sm" onClick={() => { setShow(!show); revise(null); setFormKey(n => n + 1); }}>{t("usage.ownerQuota")}</Button>
    {show && <form key={formKey} onSubmit={save} className="space-y-3 rounded border p-3">
      <p className={notesClass}>{t("usage.quotaManualHint")}</p>
      {revision && <p>{t("usage.quotaCorrection")} · {date(revision.observedAt)} <Button type="button" variant="ghost" onClick={() => { revise(null); setFormKey(n => n + 1); }}>{t("usage.quotaCancel")}</Button></p>}
      <Picker label={t("usage.selectPool")} value={poolId} placeholder={t("usage.newPool")}
        onChange={id => { setPool(id); revise(null); setFormKey(n => n + 1); }}
        options={pools.map(q => ({ id: q.id, label: `${q.scope} · ${q.window}` }))} />
      {!pool && <div className="grid gap-2 sm:grid-cols-3">
        <Picker label={t("usage.quotaCategory")} value={category} onChange={id => { if (id) { setCategory(id as QuotaCategory); if (id === "api-credit") setKind("money"); } }}
          options={Object.entries(categoryLabels).map(([id, label]) => ({ id, label: t(label) }))} />
        <Picker label={t("usage.poolScope")} value={scope} onChange={id => setScope(id || "account")}
          options={[{ id: "account", label: t("usage.accountWide") }, { id: "model", label: t("usage.model") }, { id: "group", label: t("usage.modelGroup") }]} />
        {scope !== "account" && field("scopeName", scope === "model" ? "usage.model" : "usage.modelGroup", { required: true, maxLength: 140 })}
        {scope === "group" && field("modelIds", "usage.modelIds", { maxLength: 1000 })}
        {field("window", "usage.window", { required: true, maxLength: 160 })}
        {field("windowHours", "usage.windowHours", { type: "number", min: 0.001, step: "any" })}
        <Picker label={t("usage.nativeUnit")} value={kind} onChange={id => id && setKind(id as keyof typeof unitLabels)}
          options={Object.entries(unitLabels).map(([id, label]) => ({ id, label: t(label) }))} />
        {kind === "money" && field("currency", "usage.currency", { required: true, maxLength: 3, defaultValue: "USD" })}
        {kind === "provider-specific" && field("unitName", "usage.providerUnit", { required: true, maxLength: 160 })}
        {field("warning", "usage.remainingWarning", { type: "number", min: 0, max: 100, step: "any" })}
      </div>}
      <div className="grid gap-2 sm:grid-cols-3">
        {unitKind !== "percentage" && ([["limit", "usage.limit", revision?.limit], ["used", "usage.used", revision?.used], ["remaining", "usage.remaining", revision?.remaining]] as const)
          .map(([key, label, value]) => <div key={key}>{field(key, label, { type: "number", min: 0, step: "any", defaultValue: value ?? "" })}</div>)}
        {field("usedPercent", "usage.usedPercent", { type: "number", min: 0, max: 100, step: "any",
          defaultValue: revision?.indicator ? revision.indicator.kind === "percent-used" ? revision.indicator.value : 100 - revision.indicator.value : "" })}
        {field("observedAt", "usage.observedTime", { type: "datetime-local", step: 1, defaultValue: localDate(revision?.observedAt ?? null) })}
        {field("resetAt", "usage.reset", { type: "datetime-local", step: 1, defaultValue: localDate(revision?.resetAt ?? null) })}
        {field("freshness", "usage.freshHours", { type: "number", min: 0.001, step: "any",
          defaultValue: revision ? revision.expiresAt === null ? "" : (revision.expiresAt - revision.observedAt) / hours : 24 })}
        {field("sourceNote", "usage.sourceNote", { maxLength: 160, defaultValue: revision?.sourceNote ?? "" })}
        {field("evidenceReference", "usage.evidenceRef", { maxLength: 160, defaultValue: revision?.evidenceReference ?? "" })}
      </div>
      <Button type="submit" disabled={busy}>{t("usage.quotaSave")}</Button>
      {saved && <p role="status">{t("usage.quotaSaved")}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </form>}
    {pools.some(q => q.observations.some(o => o.provenance === "user-provided" && !o.superseded)) &&
      <details><summary className="cursor-pointer text-xs">{t("usage.quotaCorrection")}</summary>
        {pools.flatMap(p => p.observations.filter(o => o.provenance === "user-provided" && !o.superseded)
          .map(o => <Button key={o.id} variant="ghost" type="button" size="sm" onClick={() => correction(p, o)}>
            {p.scope} · {p.window} · {date(o.observedAt)}
          </Button>))}
      </details>}
    {pools.map(q => <QuotaThreshold key={q.id} pool={q} onChange={onChange} />)}
  </div>;
}

function QuotaThreshold({ pool, onChange }: { pool: Pool; onChange: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("threshold");
    setBusy(true); setError("");
    try {
      await api.accountCore.updateQuotaThreshold(pool.id, value ? Number(value) : null);
      await onChange();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <details className="text-xs">
    <summary className="cursor-pointer">{t("usage.remainingWarning")} · {pool.scope} · {pool.window} · {pool.threshold === null ? unknown() : number(pool.threshold) + "%"}</summary>
    <form onSubmit={save} className="mt-2 flex items-center gap-2">
      <Input className="w-32" aria-label={t("usage.remainingWarning")} name="threshold" type="number" min={0} max={100} step="any" defaultValue={pool.threshold ?? ""} />
      <Button type="submit" variant="outline" size="sm" disabled={busy}>{t("usage.saveThreshold")}</Button>
      {error && <p role="alert">{error}</p>}
    </form>
  </details>;
}
