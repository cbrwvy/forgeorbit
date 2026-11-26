import { useEffect, useState } from "react";
import { toast } from "sonner";
import { t as tr, getLocale } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { refreshHandsoff } from "@/lib/handsoff-events";
import { authorizationNeedsAction, authorizationTone, renewalReasonsText } from "@/lib/handsoff";
import { HANDSOFF_AUTH_LIMITS, type HandsoffAuthorizationView } from "../../../shared/handsoff-authorization.ts";

interface Props {
  projectPath: string;
  authorization: HandsoffAuthorizationView;
  policyEnabled: boolean;
  /** The settings page re-reads the policy and authorization after any change here. */
  onChanged: () => void | Promise<void>;
  /** Set by the page after Save so a widening save asks for the confirmation once, right then. */
  autoAuthorize: boolean;
  onAutoAuthorizeHandled: () => void;
}

const HOURS = [1, 4, 8, 24];
const LAUNCHES = [2, 6, 12, 24, 40];
const toneClass = { info: "info", warning: "warning", success: "success", muted: "secondary", danger: "destructive" } as const;

/**
 * The project's Owner authorization: a plain state, the exact scope, expiry and remaining launches, and one action.
 * Nothing here prompts by itself; the native confirmation opens only from the Authorize / Renew action or right after
 * the Owner saved settings that need it.
 */
export function HandsoffAuthorizationPanel({ projectPath, authorization, policyEnabled, onChanged, autoAuthorize, onAutoAuthorizeHandled }: Props) {
  useUILocale();
  const [hours, setHours] = useState<number>(HANDSOFF_AUTH_LIMITS.defaultHours);
  const [launches, setLaunches] = useState<number>(HANDSOFF_AUTH_LIMITS.defaultLaunches);
  const [busy, setBusy] = useState(false);

  async function authorize() {
    if (busy) return;
    setBusy(true);
    try {
      await api.authorizeHandsoff(projectPath, { hours, launches, locale: getLocale() === "ru" ? "ru" : "en" });
      toast.success(tr("handsoff.auth.done"));
    } catch (error) {
      toast.error(tr("handsoff.auth.failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
      refreshHandsoff();
      await onChanged();
    }
  }

  async function revoke() {
    if (busy || !window.confirm(tr("handsoff.auth.revoke_confirm"))) return;
    setBusy(true);
    try {
      await api.revokeHandsoffAuthorization(projectPath);
      toast.success(tr("handsoff.auth.revoked_ok"));
    } catch (error) {
      toast.error(tr("handsoff.auth.failed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
      refreshHandsoff();
      await onChanged();
    }
  }

  // Right after a save that widened what the Owner confirmed: one confirmation, opened by the Owner's own Save.
  useEffect(() => {
    if (!autoAuthorize) return;
    onAutoAuthorizeHandled();
    if (authorization.required && policyEnabled && authorizationNeedsAction(authorization.state)) void authorize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAuthorize]);

  const state = authorization.state;
  const envelope = authorization.envelope;
  const tone = authorizationTone(state);
  const canAuthorize = authorization.required && policyEnabled && authorizationNeedsAction(state);
  const canRevoke = authorization.required && (state === "active" || state === "needs-renewal" || state === "expired" || state === "exhausted");
  const renew = state === "needs-renewal" || state === "expired" || state === "exhausted";

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="handsoff-authorization" data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-medium">{tr("handsoff.auth.title")}</h4>
        <Badge variant={toneClass[tone] as never} data-testid="handsoff-authorization-state">{tr(`handsoff.auth.state.${state}` as never)}</Badge>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="handsoff-authorization-why">
        {state === "needs-renewal"
          ? tr("handsoff.auth.why.needs-renewal", { what: renewalReasonsText(authorization.reasons) })
          : tr(`handsoff.auth.why.${state}` as never)}
      </p>
      {authorization.required && <p className="text-[11px] text-muted-foreground">{tr("handsoff.auth.hint")}</p>}

      {envelope && state !== "revoked" && (
        <div className="space-y-0.5 text-[11px]" data-testid="handsoff-authorization-scope">
          <p className="font-medium">{tr("handsoff.auth.covers")}</p>
          <p>{tr("handsoff.auth.covers_roles")}</p>
          <p data-testid="handsoff-auth-resources">{tr("handsoff.auth.covers_agents", { harnesses: envelope.resources.map((r) => `${tr(r.role === "developer" ? "handsoff.role_developer" : "handsoff.role_reviewer")}: ${r.harnessId} / ${r.accountKey}`).join("; "), accounts: String(envelope.resources.length) })}</p>
          <p>{tr("handsoff.auth.covers_models", { models: [...new Set([...envelope.developerModels, ...envelope.reviewerModels])].join(", ") })}</p>
          <p>{tr("handsoff.auth.covers_delivery", { delivery: tr(envelope.autoApply ? "handsoff.auth.delivery_apply" : "handsoff.auth.delivery_prepare") })}</p>
          <p className="text-muted-foreground">{tr("handsoff.auth.covers_never")}</p>
          {authorization.expiresAt != null && <p data-testid="handsoff-authorization-expiry">{tr("handsoff.auth.expires", { time: new Date(authorization.expiresAt).toLocaleString() })}</p>}
          {authorization.launchBudget != null && (
            <p data-testid="handsoff-authorization-launches">{tr("handsoff.auth.launches", { used: authorization.launchesUsed ?? 0, total: authorization.launchBudget, remaining: authorization.launchesRemaining ?? 0 })}</p>
          )}
        </div>
      )}

      {canAuthorize && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[11px]">
            <span>{tr("handsoff.auth.hours")}</span>
            <select className="rounded-md border bg-background px-1.5 py-0.5" value={hours} onChange={(event) => setHours(Number(event.target.value))} data-testid="handsoff-auth-hours">
              {HOURS.map((n) => <option key={n} value={n}>{tr("handsoff.auth.hours_option", { n })}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-[11px]">
            <span>{tr("handsoff.auth.launch_budget")}</span>
            <select className="rounded-md border bg-background px-1.5 py-0.5" value={launches} onChange={(event) => setLaunches(Number(event.target.value))} data-testid="handsoff-auth-launches">
              {LAUNCHES.map((n) => <option key={n} value={n}>{tr("handsoff.auth.launches_option", { n })}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canAuthorize && <Button type="button" size="sm" disabled={busy} onClick={() => void authorize()} data-testid="handsoff-authorize">{tr(renew ? "handsoff.auth.renew" : "handsoff.auth.authorize")}</Button>}
        {canRevoke && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revoke()} data-testid="handsoff-revoke">{tr("handsoff.auth.revoke")}</Button>}
        {busy && <span className="text-[11px] text-muted-foreground" role="status" data-testid="handsoff-authorization-waiting">{tr("handsoff.auth.waiting")}</span>}
      </div>
      {canAuthorize && !busy && <p className="text-[11px] text-muted-foreground">{tr("handsoff.auth.native_hint")}</p>}
    </div>
  );
}
