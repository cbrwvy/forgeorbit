import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { t, type TranslationKey } from "@/i18n/core";
import { api } from "@/lib/api";
import type { AnalyticsFilter } from "../../../shared/usage-analytics.ts";
import { date, money, notesClass, Picker, unknown } from "./presentation";

type Records = Awaited<ReturnType<typeof api.usageRecords>>;
type Record = Records["records"][number];
const key = (value: string) => value as TranslationKey;

/** A bucket is one evidence category in one currency, a count-only bucket, or everything (null). */
export type Bucket = string | null;

export const bucketLabel = (bucket: Bucket): string => {
  if (bucket === null) return t("trace.bucket.all");
  if (bucket.includes("/")) {
    const [kind, currency] = bucket.split("/");
    return t("trace.bucket.cost", { category: t(key(`usage.${kind}`)), currency: currency ?? "" });
  }
  return t(key(`trace.bucket.${bucket}`));
};

/** A displayed amount that opens the records behind it. */
export function AmountButton({ bucket, active, onOpen, children }: { bucket: string; active: boolean; onOpen: (bucket: string) => void; children: React.ReactNode }) {
  return <button type="button" className="text-left font-medium text-primary underline-offset-2 hover:underline" data-testid="usage-amount"
    data-bucket={bucket} aria-pressed={active} title={t("trace.show")} onClick={() => onOpen(bucket)}>{children}</button>;
}

function amountText(record: Record): string {
  if (record.cost.amount !== null && record.cost.currency) return `${t(key(`usage.${record.cost.kind}`))} · ${money({ amount: record.cost.amount, currency: record.cost.currency })}`;
  if (record.cost.kind === "subscription") return t("usage.subscription");
  return unknown();
}

function RecordRows({ rows, open, rowTestId = "usage-record" }: { rows: Record[]; open: (taskId: string, runId: string) => void; rowTestId?: string }) {
  return <div className="overflow-x-auto rounded-md border">
    <table className="w-full min-w-[40rem] text-left text-xs">
      <thead className="bg-muted/60 text-muted-foreground"><tr>
        {(["task", "project", "account", "role", "run", "started", "evidence", "amount"] as const).map(name =>
          <th scope="col" key={name} className="px-3 py-2 font-medium">{t(key(`trace.col.${name}`))}</th>)}
      </tr></thead>
      <tbody>{rows.map(record => <tr key={record.runId} className="border-t align-top" data-testid={rowTestId} data-run-id={record.runId}
        data-task-id={record.taskId} data-bucket={record.bucket} data-counted={record.included ? "true" : "false"}>
        <td className="px-3 py-2"><button type="button" className="text-left text-primary hover:underline" data-testid="usage-record-open"
          onClick={() => open(record.taskId, record.runId)}>{record.taskTitle}</button></td>
        <td className="px-3 py-2" data-testid="usage-record-project">{record.projectLabel ?? record.projectPath ?? unknown()}</td>
        <td className="px-3 py-2" data-testid="usage-record-account">{record.accountLabel ?? record.accountId ?? unknown()}
          {record.accountId && <small className="block text-muted-foreground">{record.accountId.slice(0, 8)}</small>}</td>
        <td className="px-3 py-2">{t(key(`usage.${record.role}`))}</td>
        <td className="px-3 py-2 font-mono" title={record.runId}>{record.runId.slice(0, 8)}<small className="block font-sans text-muted-foreground">{record.status}</small></td>
        <td className="px-3 py-2">{date(record.startedAt)}</td>
        <td className="px-3 py-2" data-testid="usage-record-evidence">{record.included ? t("trace.counted") : t(key(`trace.exclusion.${record.exclusion}`))}</td>
        <td className="px-3 py-2 tabular-nums" data-testid="usage-record-amount">{amountText(record)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

/** The runs behind one displayed amount, read from the same scope as the summary. Read-only. */
export function RecordsPanel({ query, bucket, onBucket, onClose, open }: {
  query: AnalyticsFilter; bucket: Bucket; onBucket: (bucket: Bucket) => void; onClose: () => void; open: (taskId: string, runId: string) => void;
}) {
  const [data, setData] = useState<Records | null>(null);
  const [failed, setFailed] = useState(false);
  const [project, setProject] = useState("");
  const [account, setAccount] = useState("");
  useEffect(() => {
    let current = true;
    setData(null);
    setFailed(false);
    api.usageRecords(query).then(result => { if (current) setData(result); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [query]);
  const view = useMemo(() => {
    if (!data) return null;
    const matches = (record: Record) => (!project || (record.projectPath ?? "unknown") === project) && (!account || (record.accountId ?? "unknown") === account);
    const scoped = data.records.filter(matches);
    const shown = scoped.filter(record => bucket === null ? record.included : record.bucket === bucket);
    const context = bucket === "excluded" ? [] : scoped.filter(record => !record.included);
    const whole = data.buckets.find(item => item.key === bucket);
    const subset = !!project || !!account || data.recordsTruncated;
    const sum = shown.reduce((total, record) => total + (record.cost.amount ?? 0), 0);
    const currency = shown[0]?.cost.currency ?? null;
    return { shown, context, whole, subset, sum, currency };
  }, [data, bucket, project, account]);
  if (failed) return <p role="alert" className="text-sm text-destructive" data-testid="usage-records-error">{t("trace.loadFailed")}</p>;
  if (!data || !view) return <p role="status" className={notesClass}>{t("trace.loading")}</p>;
  const count = (key: string) => data.buckets.find(item => item.key === key)?.runs ?? 0;
  const priced = data.buckets.filter(item => item.key.includes("/")).reduce((total, item) => total + item.runs, 0);
  const reconciled = data.reconciliation.matchesSummary;
  const wholeAmount = view.whole?.amount != null && view.whole.currency ? money({ amount: view.whole.amount, currency: view.whole.currency }) : null;
  return <section className="space-y-3 rounded-md border bg-card p-3" data-testid="usage-records" data-bucket={bucket ?? "all"} data-reconciled={String(reconciled)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">{t("trace.title")} · <span data-testid="usage-records-bucket">{bucketLabel(bucket)}</span></h3>
      <Button size="sm" variant="ghost" data-testid="usage-records-close" onClick={onClose}>{t("trace.close")}</Button>
    </div>
    <p className={notesClass} data-testid="usage-records-coverage">{t("trace.coverage", {
      counted: data.counts.included, priced, unknown: count("unknown-cost"), subscription: count("subscription"), excluded: data.counts.excluded,
    })}</p>
    {data.recordsTruncated && <p className="text-sm text-warning" data-testid="usage-records-truncated">
      {t("trace.truncated", { listed: data.counts.listed, total: data.counts.records })}</p>}
    {data.scopeTruncated && <p className="text-sm text-warning" data-testid="usage-records-scope-truncated">
      {t("trace.scopeTruncated", { limit: data.taskScopeLimit })}</p>}
    {reconciled === false && <p className="text-sm text-warning" data-testid="usage-records-unreconciled">{t("trace.notReconciled")}</p>}
    {reconciled && bucket !== null && !view.subset && <p className="text-sm" data-testid="usage-records-reconciles">
      {wholeAmount ? t("trace.reconciles", { amount: wholeAmount }) : t("trace.reconcilesCount", { count: view.shown.length })}</p>}
    {view.subset && bucket?.includes("/") && view.currency && <p className="text-sm" data-testid="usage-records-subset">
      {wholeAmount ? t("trace.subsetOf", { amount: money({ amount: view.sum, currency: view.currency }), whole: wholeAmount })
        : t("trace.subset", { amount: money({ amount: view.sum, currency: view.currency }) })}</p>}
    <div className="grid gap-2 sm:grid-cols-2">
      <Picker label={t("trace.filterProject")} value={project} onChange={setProject} id="usage-records-project"
        options={data.byProject.map(group => ({ id: group.id, label: `${group.label ?? (group.id === "unknown" ? t("usage.unknown") : group.id)} · ${t("trace.runs", { count: group.runs })}` }))} />
      <Picker label={t("trace.filterAccount")} value={account} onChange={setAccount} id="usage-records-account"
        options={data.byAccount.map(group => ({ id: group.id, label: `${group.label ?? (group.id === "unknown" ? t("usage.unknown") : group.id.slice(0, 8))} · ${t("trace.runs", { count: group.runs })}` }))} />
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={bucket === null ? "default" : "outline"} onClick={() => onBucket(null)} data-testid="usage-records-all">{t("trace.bucket.all")}</Button>
    </div>
    {view.shown.length ? <RecordRows rows={view.shown} open={open} /> : <p className={notesClass} data-testid="usage-records-empty">{t("trace.empty")}</p>}
    {view.context.length > 0 && <details data-testid="usage-records-context">
      <summary className="cursor-pointer text-sm font-medium">{t("trace.context", { count: view.context.length })}</summary>
      <div className="mt-2"><RecordRows rows={view.context} open={open} rowTestId="usage-record-context" /></div>
    </details>}
    <p className={notesClass}>{t("trace.recorded")}</p>
  </section>;
}
