import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";

/**
 * Shows the exact operation a later live acceptance would have to name.
 * There is no control here that starts a provider. The trusted Owner channel
 * remains unsupported, so the status stays blocked.
 */
export function LiveExecutionApproval({
  provider,
  account,
  model,
  task,
  workspace,
  role,
  mode,
}: {
  provider?: string | null;
  account?: string | null;
  model?: string | null;
  task?: string | null;
  workspace?: string | null;
  role?: "developer" | "reviewer" | null;
  mode?: string | null;
}) {
  useUILocale();
  const rows: Array<[TranslationKey, string]> = [
    ["runtime.approval.provider", provider || tr("runtime.approval.unknown")],
    ["runtime.approval.account", account || tr("runtime.approval.unknown")],
    ["runtime.approval.identity", tr("runtime.approval.unknown")],
    ["runtime.approval.model", model || tr("runtime.approval.unknown")],
    ["runtime.approval.task", task || tr("runtime.approval.unknown")],
    ["runtime.approval.workspace", workspace || tr("runtime.approval.unknown")],
    ["runtime.approval.role", role === "reviewer" ? "Reviewer" : role === "developer" ? "Developer" : tr("runtime.approval.unknown")],
    ["runtime.approval.mode", mode || tr("runtime.approval.unknown")],
    ["runtime.approval.filesystem", tr(role === "reviewer" ? "runtime.approval.filesystem_reviewer" : "runtime.approval.filesystem_developer")],
    ["runtime.approval.terminal", tr("runtime.approval.not_granted")],
    ["runtime.approval.restrictions", tr("runtime.approval.not_granted")],
    ["runtime.approval.quota", tr("runtime.approval.unknown")],
    ["runtime.approval.cost", tr("runtime.approval.unknown")],
    ["runtime.approval.scope", tr("runtime.approval.scope_value")],
    ["runtime.approval.process", tr("runtime.approval.no_process")],
    ["runtime.approval.cancel", tr("runtime.approval.cancel_value")],
  ];
  return (
    <section className="space-y-2 rounded-md border border-border p-3" data-testid="live-execution-approval">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold">{tr("runtime.approval.title")}</h4>
        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning" data-testid="live-execution-blocked">{tr("runtime.approval.blocked")}</span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="live-execution-owner-channel">{tr("runtime.owner_channel")}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{tr(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
