import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/batches";
import { permissionOutcomeText, permissionStatusText } from "@/lib/project-permissions";
import type { ProjectPermissionRequest, ProjectPermissionRequestRow } from "../../../shared/project-permissions.ts";

interface Decided {
  id: string;
  title: string;
  projectPath: string;
  request: ProjectPermissionRequest | null;
  error: string | null;
}

interface Props {
  rows: readonly ProjectPermissionRequestRow[];
  projectName: (path: string) => string;
  /** The core's pending list changed: re-read it. */
  onChanged: () => void;
}

/**
 * Pending project permission requests inside the existing "Needs you" page.
 * Each row names the requesting task, the project, the exact command and the
 * working directory. Allow once approves exactly this row; Deny starts nothing.
 * Rendering the list sends nothing. Durable rules live in Settings.
 */
export function ProjectPermissionRequests({ rows, projectName, onChanged }: Props) {
  useUILocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [decided, setDecided] = useState<Decided[]>([]);
  if (rows.length === 0 && decided.length === 0) return null;

  async function decide(row: ProjectPermissionRequestRow, action: "allow" | "deny") {
    if (busy) return;
    setBusy(row.id);
    const base = { id: row.id, title: row.title, projectPath: row.projectPath };
    try {
      const request = action === "allow"
        ? await api.approveProjectPermission(row.id, { projectPath: row.projectPath, commandFingerprint: row.commandFingerprint })
        : await api.denyProjectPermission(row.id);
      setDecided((list) => [{ ...base, request, error: null }, ...list.filter((item) => item.id !== row.id)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDecided((list) => [{ ...base, request: null, error: message }, ...list.filter((item) => item.id !== row.id)]);
      toast.error(tr("perm.attn.failed", { message }));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <section aria-labelledby="attention-permissions-heading" className="space-y-2" data-testid="attention-permissions">
      <div>
        <h2 id="attention-permissions-heading" className="text-sm font-semibold">{tr("perm.attn.title")}</h2>
        <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("perm.attn.hint")}</p>
      </div>
      <ul className="surface-solid overflow-hidden rounded-xl border">
        {rows.map((row) => (
          <li key={row.id} className="space-y-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="permission-request" data-request-id={row.id} data-path={row.projectPath} data-origin={row.origin ?? "owner"}>
            <div className="flex flex-wrap items-start gap-3">
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-warning/10 px-2 py-0.5 text-xs font-medium ring-1 ring-warning/60">
                <ShieldQuestion className="size-4" aria-hidden />{tr("perm.attn.kind")}
              </span>
              <div className="min-w-0 flex-1 basis-56 space-y-1">
                <p className="text-sm font-medium" data-testid="permission-task">{tr("perm.attn.task")}: <span className="font-normal">{row.title}</span></p>
                <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="permission-project" title={row.projectPath}>{projectName(row.projectPath)}</p>
                {row.origin === "worker" && (
                  <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="permission-origin">{tr("perm.attn.origin_worker")}</p>
                )}
                <p className="text-[length:var(--text-secondary)]">{tr("perm.attn.command")}: <code className="break-all rounded bg-muted px-1 py-0.5 text-xs" data-testid="permission-command">{row.command}</code></p>
                <p className="text-[length:var(--text-secondary)]">{tr("perm.attn.cwd")}: <code className="break-all rounded bg-muted px-1 py-0.5 text-xs" data-testid="permission-cwd">{row.cwd}</code></p>
                <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("perm.attn.expires", { time: formatTime(row.expiresAt) })}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" size="sm" disabled={busy != null} onClick={() => void decide(row, "allow")} data-testid="permission-allow-once">
                  {busy === row.id ? tr("perm.attn.running") : tr("perm.attn.allow_once")}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy != null} onClick={() => void decide(row, "deny")} data-testid="permission-deny">
                  {tr("perm.attn.deny")}
                </Button>
              </div>
            </div>
            <TechnicalDetails
              testId="permission-technical"
              rows={[
                { label: tr("perm.tech.request"), value: row.id },
                { label: tr("perm.tech.command"), value: row.command },
                { label: tr("perm.tech.cwd"), value: row.cwd },
                { label: tr("perm.tech.operation"), value: row.commandFingerprint },
              ]}
            />
          </li>
        ))}
        {decided.map((item) => (
          <li key={`decided:${item.id}`} className="space-y-1 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-row last:border-b-0" data-testid="permission-outcome" data-request-id={item.id} data-status={item.request?.status ?? "error"} role="status">
            <p className="text-sm font-medium">
              {item.title}
              {" · "}
              <span data-testid="permission-outcome-status">{item.request ? permissionStatusText(item.request.status) : tr("perm.status.blocked")}</span>
            </p>
            <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid="permission-outcome-text">
              {item.request ? permissionOutcomeText(item.request) : tr("perm.attn.failed", { message: item.error ?? "" })}
            </p>
            {item.request && (
              <TechnicalDetails
                testId="permission-outcome-technical"
                rows={[
                  { label: tr("perm.tech.request"), value: item.request.id },
                  { label: tr("perm.tech.message"), value: item.request.reason },
                  { label: tr("perm.tech.exit"), value: item.request.exitCode == null ? null : String(item.request.exitCode) },
                  { label: tr("perm.tech.isolation"), value: item.request.isolation },
                  { label: tr("perm.tech.output"), value: item.request.summary },
                ]}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
