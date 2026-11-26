import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import type { HeadPortfolioBinding as Binding } from "../../../../shared/head-portfolio-binding.ts";
import type { Employee } from "../../../../shared/employees/types.ts";

export function HeadPortfolioBinding({ head, refreshToken, onOpenManager }: {
  head: Employee | null; refreshToken: number; onOpenManager: () => void;
}) {
  useUILocale();
  const [binding, setBinding] = useState<Binding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const requestId = useRef(0);
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    try { const next = await api.getHeadPortfolioBinding(); if (id === requestId.current) { setBinding(next); setError(null); } }
    catch (e) { if (id === requestId.current) { setBinding(null); setError(e instanceof Error ? e.message : tr("common.could_not_read_head_binding")); } }
  }, []);
  useEffect(() => { void reload(); window.addEventListener("focus", reload); return () => window.removeEventListener("focus", reload); }, [reload, refreshToken]);
  const change = async (employeeId: string | null) => {
    if (!binding) return;
    if (!await confirm(() => ({ title: employeeId ? tr("common.bind_head_to_portfolio_manager") : tr("common.unbind_head_from_portfolio_manager"),
      description: employeeId ? tr("common.will_be_the_organizational_head_on_new_manager", { p0: String(head?.name), p1: String(employeeId) })
        : tr("common.new_manager_turns_will_have_no_head_attribution"), confirmLabel: employeeId ? tr("common.confirm_binding") : tr("employees.unbind") }))) return;
    ++requestId.current;
    setBusy(true); setError(null);
    try { setBinding(await api.changeHeadPortfolioBinding(employeeId, binding.revision)); }
    catch (e) { setError(e instanceof Error ? e.message : tr("common.binding_failed")); setBinding(await api.getHeadPortfolioBinding().catch(() => null)); }
    finally { setBusy(false); }
  };
  const current = head?.id ?? binding?.employeeId;
  return <div className="mt-3 space-y-2 border-t pt-3 text-xs" data-testid="head-portfolio-binding">
    {current && <p className="break-all text-muted-foreground" data-testid="head-binding-uuid"><I18nText id="employees.employee_uuid" />{" "}{current}</p>}
    {head && <p data-testid="head-binding-employee-status"><I18nText id="employees.status" />{" "}{head.status === "active" ? tr("common.active") : head.status === "archived" ? tr("common.archived_bdb865") : tr("common.inactive")}</p>}
    {!head && binding?.head && <p className="break-words"><I18nText id="employees.previously_bound_head" />{" "}{binding.head.name}</p>}
    {!head && binding?.employeeId && <p data-testid="head-binding-employee-status"><I18nText id="employees.recorded_head_status" />{" "}{binding.employeeStatus ?? tr("common.missing")}</p>}
    <p role="status" data-testid="head-binding-status"><I18nText id="employees.portfolio_manager_binding" />{" "}{binding ? ({ bound: tr("common.bound"), unbound: tr("common.unbound"), invalid: tr("common.invalid") }[binding.status]) : error ? tr("common.unknown") : tr("common.loading")}</p>
    {binding?.reason && <p className="text-warning">{binding.reason}</p>}
    {binding?.employeeId && binding.employeeId !== head?.id && <p className="break-all"><I18nText id="employees.previous_binding_uuid" />{" "}{binding.employeeId}</p>}
    {error && <div role="alert" data-testid="head-binding-error">{error} <button type="button" className="underline" onClick={() => void reload()}><I18nText id="employees.refresh_binding" /></button></div>}
    <div className="flex flex-wrap gap-2">
      {head && (binding?.status !== "bound" || binding.employeeId !== head.id) && <Button size="sm" variant="outline" disabled={!binding || busy || head.status !== "active"} data-testid="head-binding-bind" onClick={() => void change(head.id)}>{binding?.employeeId ? tr("common.change_confirm_binding") : tr("common.bind_portfolio_manager")}</Button>}
      {binding?.employeeId && <Button size="sm" variant="outline" disabled={busy} data-testid="head-binding-unbind" onClick={() => void change(null)}><I18nText id="employees.unbind" /></Button>}
      <Button size="sm" variant="outline" data-testid="head-binding-open-manager" onClick={onOpenManager}><I18nText id="employees.open_portfolio_manager" /></Button>
    </div>
    <p className="text-muted-foreground"><I18nText id="employees.binding_identifies_new_turns_it_grants_no_execution" /></p>
  </div>;
}
