import type { ReactNode } from "react";
import { t, localeStore } from "@/i18n/core";
import { isSyntheticEvidenceSource, type MoneyAmount, type RunCost } from "../../../shared/usage-analytics.ts";
import type { quotaFor } from "../../../bun/usage-analytics/resources.ts";

export const unknown = () => t("usage.unknown");
export const number = (value: number | null | undefined) => value == null ? unknown() : new Intl.NumberFormat(localeStore.getSnapshot(), { maximumFractionDigits: 2 }).format(value);
export const date = (value: number | null | undefined) => value == null ? unknown() : new Date(value).toLocaleString(localeStore.getSnapshot());
export function duration(value: number | null | undefined): string {
  if (value == null) return unknown();
  const abs = Math.abs(value);
  const unit = abs >= 3_600_000 ? "hour" : abs >= 60_000 ? "minute" : "second";
  const divisor = unit === "hour" ? 3_600_000 : unit === "minute" ? 60_000 : 1000;
  return new Intl.NumberFormat(localeStore.getSnapshot(), { style: "unit", unit, maximumFractionDigits: 2 }).format(value / divisor);
}
export const money = (value: MoneyAmount | null | undefined) => !value ? unknown() :
  new Intl.NumberFormat(localeStore.getSnapshot(), { style: "currency", currency: value.currency, maximumFractionDigits: 8 }).format(value.amount);

export function costText(cost: RunCost | null | undefined) {
  if (!cost || cost.kind === "unknown") return unknown();
  const label = t(`usage.${cost.kind}`);
  if (cost.kind === "subscription") return label;
  return `${label} · ${money(cost.money)}${cost.pricingId ? ` · ${t("usage.configured")} #${cost.pricingId}` : ""}`;
}

export function Metrics({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
    {items.map(([label, value]) => <div key={label} className="rounded-md border bg-card px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words font-medium tabular-nums">{value}</dd>
    </div>)}
  </dl>;
}

export function DataTable({ headings, rows }: { headings: string[]; rows: Array<{ id: string; cells: ReactNode[] }> }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{t("usage.empty")}</p>;
  return <div className="overflow-x-auto rounded-md border">
    <table className="w-full text-left text-xs">
      <thead className="bg-muted/60 text-muted-foreground"><tr>{headings.map(h => <th scope="col" key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} className="border-t align-top">
        {row.cells.map((cell, i) => <td key={i} className="px-3 py-2 tabular-nums">{cell}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export const selectClass = "w-full min-w-0 rounded-md border bg-background px-2 py-1.5 text-sm";
export const notesClass = "text-xs leading-relaxed text-muted-foreground";

export function Picker({ label, value, options, onChange, placeholder, id }: {
  label: string; value: string; options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void; placeholder?: string; id?: string;
}) {
  return <label className="min-w-0 space-y-1 text-xs text-muted-foreground">{label}
    <select className={selectClass} value={value} onChange={e => onChange(e.target.value)} data-testid={id}>
      <option value="">{placeholder ?? t("usage.all")}</option>
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
  </label>;
}

type Quota = ReturnType<typeof quotaFor>[number];

export function quotaEvidenceKind(o: Quota["current"]) {
  return !o ? "unknown" : isSyntheticEvidenceSource(o.source) ? "synthetic" : o.verification === "verified" ? "verified"
    : o.provenance === "user-provided" ? "ownerReported" : "local";
}

export function QuotaTable({ quota }: { quota: ReturnType<typeof quotaFor> }) {
  return <DataTable headings={[t("usage.quota"), t("usage.scope"), t("usage.limit"), t("usage.used"), t("usage.remaining"), t("usage.reset"), t("usage.observed")]}
    rows={quota.flatMap(q => {
      const unit = "name" in q.unit ? q.unit.name : "currency" in q.unit ? q.unit.currency + " · " + t("usage.moneyMinor") : q.unit.kind;
      const amount = (n: number | null | undefined) => n == null ? unknown() : `${number(n)} ${unit}`;
      const byId = new Map([q.current, q.ownerReported, ...q.observations].flatMap(o => o ? [[o.id, o] as const] : []));
      const rows = byId.size ? [...byId.values()] : [null];
      return rows.map(o => {
        const superseded = o && "superseded" in o && o.superseded;
        const active = !!o && (q.current?.id === o.id || q.ownerReported?.id === o.id) && q.status === "current" && o.freshness === "fresh";
        const status = superseded ? t("usage.quotaSuperseded") : active ? t("usage.quotaFresh")
          : q.status === "conflict" ? t("usage.conflict") : o?.freshness === "stale" ? t("usage.stale") : t("usage.observed");
        const used = [o?.used == null ? null : amount(o.used), o?.indicator?.kind === "percent-used" ? `${number(o.indicator.value)}%` : null].filter(Boolean).join(" · ");
        const remaining = [o?.remaining == null ? null : amount(o.remaining), o?.remainingPercent == null ? null : `${number(o.remainingPercent)}%`].filter(Boolean).join(" · ");
        return { id: o?.id ?? q.id, cells: [
          <span>{t(`usage.${quotaEvidenceKind(o)}`)}
            <small className="block text-muted-foreground">{status}{o?.revises ? " · " + t("usage.quotaRevised") : ""}</small>
            {o?.source && o.source !== "manual" && <small className="block text-muted-foreground">{o.officialUrl
              ? <a href={o.officialUrl} target="_blank" rel="noreferrer">{o.source}</a> : o.source}</small>}
            {(o?.sourceNote || o?.evidenceReference || o?.reason) &&
              <small className="block break-all text-muted-foreground">{[o.sourceNote, o.evidenceReference, o.reason].filter(Boolean).join(" · ")}</small>}
          </span>,
          <span>{q.scope} · {q.window}
            {q.windowMs != null && <small className="block text-muted-foreground">{duration(q.windowMs)}</small>}
            {(o?.sharedPool || q.scope.startsWith("group:")) && <small className="block text-muted-foreground">{t("usage.quotaShared")}</small>}
            {q.archived && <small className="block text-muted-foreground">{t("usage.archivedPool")}</small>}
          </span>, amount(o?.limit), used || unknown(), remaining || unknown(),
          <span>{date(o?.resetAt)}{o?.resetAt != null && o.verification !== "verified" && <small className="block text-muted-foreground">{t("usage.unverified")}</small>}
            {o?.period?.endAt != null && <small className="block text-muted-foreground">{t("usage.contractEnd")} · {date(o.period.endAt)}</small>}</span>,
          date(o?.observedAt),
        ] };
      });
    })} />;
}
