import { t as tr } from "@/i18n/core";
import type { TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { ArrowUpRight } from "lucide-react";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { clampPercent, formatResetsIn } from "@/lib/usage";
import { cn } from "@/lib/utils";
import type {
  ServiceLight,
  ServiceProfileSummary,
  ServiceReasonCode,
  TopbarServiceSummary,
} from "./service-status";

export const SERVICE_LIGHT_DOT: Record<ServiceLight, string> = {
  green: "bg-success-solid",
  yellow: "bg-warning-solid",
  red: "bg-danger-solid",
};

const LIGHT_BADGE_CLASS: Record<ServiceLight, string> = {
  green: "border-success/30 bg-success/10 text-success",
  yellow: "border-warning/35 bg-warning/10 text-warning",
  red: "border-danger/35 bg-danger/10 text-danger",
};

const METER_FILL_CLASS: Record<ServiceLight, string> = {
  green: "bg-success-solid",
  yellow: "bg-warning-solid",
  red: "bg-danger-solid",
};

const REASON_BANNER_CLASS: Record<"yellow" | "red", string> = {
  yellow: "border-warning/35 bg-warning/10 text-foreground",
  red: "border-danger/35 bg-danger/10 text-foreground",
};

export function serviceTooltipText(service: Pick<TopbarServiceSummary, "label" | "reason">): string {
  const key = `topbar.services.tooltip.${service.reason}` as TranslationKey;
  return tr(key, { service: service.label });
}

export function serviceLightLabel(light: ServiceLight): string {
  return tr(`topbar.services.light.${light}` as TranslationKey);
}

export function serviceReasonText(
  reason: ServiceReasonCode,
  retryHint: string | null,
): string | null {
  if (reason === "ok") return null;
  if (reason === "provider_refusal" && retryHint) {
    return tr("topbar.services.reason.provider_refusal_hint", { hint: retryHint });
  }
  return tr(`topbar.services.reason.${reason}` as TranslationKey);
}

function profileStatusShortText(profile: ServiceProfileSummary): string {
  if (profile.reason === "ok") return tr("topbar.services.profile.ready");
  if (profile.reason === "limited_profiles") return tr("topbar.services.profile.low_limit");
  return tr(`topbar.services.profile.${profile.reason}` as TranslationKey);
}

function capitalizeFirst(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export interface TopbarServiceCardProps {
  service: TopbarServiceSummary;
  nowMs?: number;
  onOpenAccounts: (harnessId?: string) => void;
}

/**
 * Compact, manager-friendly summary card for ONE AI service (Codex, Claude,
 * Cursor, or Antigravity). Technical diagnostics and partial-isolation notes
 * stay tucked inside the collapsed "Details" disclosure or in Accounts.
 */
export function TopbarServiceCard({
  service,
  nowMs = Date.now(),
  onOpenAccounts,
}: TopbarServiceCardProps) {
  useUILocale();
  const reasonMessage = serviceReasonText(service.reason, service.retryHint);
  const resetSummary = service.nextResetAtMs ? formatResetsIn(service.nextResetAtMs, nowMs) : "";
  const availabilityLabel = tr(`topbar.services.avail.${service.availability}` as TranslationKey);
  const authLabel = tr(`topbar.services.auth.${service.auth}` as TranslationKey);

  return (
    <div className="space-y-3">
      {/* Header: service icon + name + plan + plain-language status pill */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center">
            <AgentIcon kind={service.agentKind} className="size-4" />
          </span>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span data-testid="topbar-service-title" className="truncate text-sm font-semibold text-foreground">{service.label}</span>
            {service.planType && (
              <span
                data-testid="topbar-service-plan"
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {service.planType}
              </span>
            )}
          </div>
        </div>

        <span
          data-testid="topbar-service-status-badge"
          data-service-status={service.light}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            LIGHT_BADGE_CLASS[service.light],
          )}
        >
          <span className={cn("size-1.5 rounded-full", SERVICE_LIGHT_DOT[service.light])} aria-hidden />
          <span>{serviceLightLabel(service.light)}</span>
        </span>
      </div>

      {/* Why yellow / red */}
      {reasonMessage && (service.light === "yellow" || service.light === "red") && (
        <div
          data-testid="topbar-service-reason"
          className={cn(
            "rounded-lg border px-2.5 py-2 text-[11px] leading-snug",
            REASON_BANNER_CLASS[service.light],
          )}
        >
          <div>{reasonMessage}</div>
          {resetSummary && service.light === "red" && service.reason === "limit_reached" && (
            <div data-testid="topbar-service-reset-banner" className="mt-1 text-muted-foreground">
              {capitalizeFirst(resetSummary)}
            </div>
          )}
        </div>
      )}

      {/* Main compact status & limits block */}
      <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/35 p-2.5">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">
              {tr("topbar.services.field.availability")}
            </div>
            <div data-testid="topbar-service-availability" className="mt-0.5 truncate font-medium text-foreground">
              {availabilityLabel}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] text-muted-foreground">
              {tr("topbar.services.field.auth")}
            </div>
            <div data-testid="topbar-service-auth" className="mt-0.5 truncate font-medium text-foreground">
              {authLabel}
            </div>
          </div>
        </div>

        {/* Limits */}
        <div className="border-t border-border/60 pt-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {tr("topbar.services.field.limits")}
          </div>
          {service.meters.length > 0 ? (
            <div data-testid="topbar-service-meters" className="space-y-2">
              {service.meters.map((m) => {
                const resets = formatResetsIn(m.resetsAtMs, nowMs);
                const remaining = clampPercent(m.remainingPercent);
                return (
                  <div key={m.id} data-testid="topbar-service-meter">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-foreground">
                        {m.label}
                        {m.scope && <span className="text-muted-foreground"> · {m.scope}</span>}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {remaining <= 0
                          ? tr("topbar.services.meter.exhausted")
                          : tr("topbar.services.meter.remaining", { percent: String(remaining) })}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "mt-1 h-1.5 w-full overflow-hidden rounded-full",
                        m.light === "red" ? "bg-danger/20" : "bg-muted",
                      )}
                    >
                      <div
                        data-meter-light={m.light}
                        className={cn("h-full rounded-full transition-all", METER_FILL_CLASS[m.light])}
                        style={{ width: `${remaining}%` }}
                      />
                    </div>
                    {resets && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{resets}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : service.verifiedQuota ? (
            <div data-testid="topbar-service-quota-verified" className="text-[11px] font-medium text-foreground">
              {tr("topbar.services.quota.verified_remaining", {
                remaining: String(service.verifiedQuota.remaining),
                unit: service.verifiedQuota.unit,
              })}
            </div>
          ) : (
            <div data-testid="topbar-service-quota-unknown" className="text-[11px] text-muted-foreground">
              {tr("topbar.services.quota.unknown")}
            </div>
          )}
        </div>
      </div>

      {/* Associated profiles / accounts for this service only */}
      {service.profiles.length > 0 && (
        <div data-testid="topbar-service-profiles" className="space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {tr("topbar.services.field.profiles")}
          </div>
          <div className="space-y-1">
            {service.profiles.map((profile) => {
              const profileReset = profile.resetsAtMs ? formatResetsIn(profile.resetsAtMs, nowMs) : "";
              return (
                <div
                  key={profile.id}
                  data-testid="topbar-service-profile"
                  data-profile-light={profile.light}
                  className="rounded-lg border border-border/60 bg-muted/25 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", SERVICE_LIGHT_DOT[profile.light])}
                        aria-hidden
                      />
                      <span className="truncate font-medium text-foreground">{profile.displayName}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {profileStatusShortText(profile)}
                    </span>
                  </div>
                  {profile.retryHint && (
                    <div className="mt-0.5 truncate pl-3.5 text-[10px] text-muted-foreground">
                      {tr("topbar.services.profile.retry_hint", { hint: profile.retryHint })}
                    </div>
                  )}
                  {!profile.retryHint && profileReset && profile.light === "red" && (
                    <div className="mt-0.5 truncate pl-3.5 text-[10px] text-muted-foreground">
                      {capitalizeFirst(profileReset)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Technical details tucked safely out of the main view */}
      <details data-testid="topbar-service-details" className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tr("topbar.services.details_summary")}
        </summary>
        <div className="mt-1.5 space-y-1 rounded-lg border border-border/50 bg-muted/20 p-2 text-[10px] leading-relaxed text-muted-foreground">
          {service.technicalNotes.version && (
            <div>{tr("topbar.services.details.version", { version: service.technicalNotes.version })}</div>
          )}
          {service.technicalNotes.cliReason && (
            <div>{tr("topbar.services.details.cli_missing", { reason: service.technicalNotes.cliReason })}</div>
          )}
          {service.technicalNotes.hasClaudePartialNote && (
            <div>{tr("topbar.claude_limit_note")}</div>
          )}
          {service.technicalNotes.hasDeepSeekBlockedNote && (
            <div>{tr("deepseek.blocker")}</div>
          )}
          <div>{tr("topbar.services.details.readonly")}</div>
        </div>
      </details>

      {/* Footer action to Accounts / Settings */}
      <div className="flex items-center justify-end border-t border-border/70 pt-2.5">
        <button
          type="button"
          data-testid="topbar-service-open-accounts"
          onClick={() => onOpenAccounts(service.accountsTargetHarnessId)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{tr("topbar.services.open_accounts")}</span>
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
