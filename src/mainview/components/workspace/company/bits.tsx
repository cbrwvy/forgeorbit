import { useLocale as useUILocale } from "@/i18n/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { kindLabel, statusLabel } from "@/lib/employees";
import type { Employee } from "../../../../shared/employees/types.ts";

export function StatusBadge({ employee }: { employee: Pick<Employee, "status"> }) {
  useUILocale();
  return (
    <span
      data-testid="employee-status"
      data-status={employee.status}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        employee.status === "active" && "border-success/40 text-success",
        employee.status === "inactive" && "border-warning/40 text-warning",
        employee.status === "archived" && "text-muted-foreground",
      )}
    >
      {statusLabel(employee.status)}
    </span>
  );
}

export function KindBadge({ employee }: { employee: Pick<Employee, "kind"> }) {
  useUILocale();
  return (
    <span
      data-testid="employee-kind"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        employee.kind === "worker" ? "text-muted-foreground" : "border-info/40 text-info",
      )}
    >
      {kindLabel(employee.kind)}
    </span>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  useUILocale();
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export const TEXTAREA_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function Metric({ id, label, value, hint }: { id: string; label: string; value: ReactNode; hint?: string }) {
  useUILocale();
  return (
    <div className="min-w-0 rounded-xl border p-3" data-testid={`company-metric-${id}`}>
      <dt className="break-words text-[11px] uppercase leading-tight tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`company-metric-${id}-value`}>{value}</dd>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
