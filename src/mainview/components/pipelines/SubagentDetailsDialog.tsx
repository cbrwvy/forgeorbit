import { englishPluralSuffix, intlLocale, t as tr } from "@/i18n/core";

import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { createPortal } from "react-dom";
import { Bot, Check, ExternalLink, Loader2, Settings2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { SubagentSatellite } from "@/lib/pipelines";
import type { AgentProfile, AgentProfileSnapshot, Subagent } from "../../../shared/types.ts";

const TITLE_ID = "subagent-details-title";

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Details for one subagent satellite on the pipelines canvas: the persona
 * (an agent profile the step may delegate to — its harness, model, effort,
 * mode, instructions and skills, from the run's frozen snapshot or the live
 * profile), the step it hangs from and that step's cap, its current status,
 * and — in the run view — every helper the step's agent actually spawned
 * under that persona during the current execution, each openable on its own
 * transcript tab in the step task's panel. A `kind: "live"` satellite (a
 * running helper that matched no persona) shows just that helper.
 */
export function SubagentDetailsDialog({
  open,
  onClose,
  satellite,
  stepName,
  cap,
  profile,
  profileDeleted,
  onOpenTranscript,
  onOpenStep,
  onOpenSettingsAgents,
}: {
  open: boolean;
  onClose: () => void;
  satellite: SubagentSatellite | null;
  stepName: string;
  /** The step's `subagents.cap` (null = no limit). */
  cap: number | null;
  profile: AgentProfileSnapshot | AgentProfile | null;
  profileDeleted: boolean;
  /** Run view only: open the step task's panel on this helper's tab. */
  onOpenTranscript?: (subagentId: string) => void;
  /** Run view only: open the step task's panel on its main stream. */
  onOpenStep?: () => void;
  /** When set, offers "Edit in Settings" for a persona that still exists. */
  onOpenSettingsAgents?: (profileId?: string) => void;
}) {
  useUILocale();
  if (!open || !satellite) return null;

  const isLive = satellite.kind === "live";
  const name = isLive
    ? (satellite.label ?? tr("common.subagent_d6cb41"))
    : (profile?.name ?? (profileDeleted ? tr("pipelines.deleted_agent") : tr("common.unknown_agent")));
  const harnessLabel = profile ? ("harnessLabel" in profile ? profile.harnessLabel : profile.harness) : null;
  const instructions = (profile?.instructions ?? "").trim();
  const skills = profile?.skills ?? [];
  const instances: Subagent[] = satellite.instances;
  const running = instances.filter((s) => s.status === "running").length;
  const statusText =
    satellite.visual === "working"
      ? tr("common.working_now_helper_running_for_this_persona", { p0: String(running), p1: String(running === 1 ? "" : "s") })
      : satellite.visual === "done"
        ? tr("common.finished_helper_ran_for_this_persona_in_this", { p0: String(instances.length), p1: String(instances.length === 1 ? "" : "s") })
        : isLive
          ? tr("common.a_running_helper_the_step_s_agent_spawned")
          : tr("common.available_the_step_s_agent_may_delegate_to");

  return createPortal(
    <Dialog open={open} onClose={onClose} labelledBy={TITLE_ID} className="flex max-h-[85vh] w-full max-w-lg flex-col p-0">
      <div data-testid="subagent-details-dialog" data-visual={satellite.visual} className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-border/60 p-3">
          <div className="min-w-0">
            <div id={TITLE_ID} className="flex items-center gap-2 text-sm font-semibold">
              {satellite.visual === "working" ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-info" aria-hidden />
              ) : satellite.visual === "done" ? (
                <Check className="size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="truncate" data-testid="subagent-details-name">{name}</span>
              {profileDeleted && !isLive && (
                <span className="text-xs font-normal text-warning" data-testid="subagent-details-deleted"><I18nText id="common.deleted" /></span>
              )}
            </div>
            <p className="mt-1 text-[length:var(--text-caption)] text-muted-foreground" data-testid="subagent-details-status">
              {statusText}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={tr("common.close")}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <dl className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground"><I18nText id="pipelines.delegated_by" /></dt>
            <dd className="min-w-0">
              <span className="font-medium">{stepName}</span>
              <span className="text-muted-foreground"> · {cap == null ? tr("common.no_limit_on_subagents") : tr("common.at_most_subagent", { p0: String(cap), p1: String(cap === 1 ? "" : englishPluralSuffix()) })}</span>
            </dd>
            {!isLive && (
              <>
                <dt className="text-muted-foreground"><I18nText id="common.harness" /></dt>
                <dd className="min-w-0">{harnessLabel ?? "—"}</dd>
                <dt className="text-muted-foreground"><I18nText id="common.model" /></dt>
                <dd className="min-w-0">{profile?.model ?? "—"}</dd>
                <dt className="text-muted-foreground"><I18nText id="common.effort" /></dt>
                <dd className="min-w-0">{profile?.effort ?? "default"}</dd>
                <dt className="text-muted-foreground"><I18nText id="common.mode" /></dt>
                <dd className="min-w-0">{profile?.mode ?? "default"}</dd>
                <dt className="text-muted-foreground"><I18nText id="common.instructions" /></dt>
                <dd className="min-w-0 whitespace-pre-wrap" data-testid="subagent-details-instructions">
                  {instructions || <span className="text-muted-foreground">—</span>}
                </dd>
                <dt className="text-muted-foreground"><I18nText id="common.skills" /></dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {skills.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    skills.map((skill) => (
                      <Badge key={skill} variant="outline" className="rounded-md px-1.5 py-0 font-mono text-[length:var(--text-caption)]">
                        /{skill}
                      </Badge>
                    ))
                  )}
                </dd>
              </>
            )}
          </dl>

          {onOpenTranscript && (
            <div className="mt-3">
              <div className="mb-1.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="pipelines.helpers_in_this_execution" />{" "}</div>
              {instances.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="subagent-details-none"><I18nText id="pipelines.none_spawned_yet" />{" "}</p>
              ) : (
                <ul className="flex flex-col gap-1.5" data-testid="subagent-details-instances">
                  {instances.map((s) => (
                    <li
                      key={s.id}
                      data-testid="subagent-details-instance"
                      data-subagent-id={s.id}
                      data-status={s.status}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
                    >
                      {s.status === "running" ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-info" aria-label={tr("common.running")} />
                      ) : (
                        <Check className="size-3.5 shrink-0 text-success" aria-label={tr("common.finished")} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{s.description ?? s.agentType ?? tr("common.subagent_d6cb41")}</span>
                        <span className="block text-[length:var(--text-caption)] text-muted-foreground">
                          {s.agentType ?? tr("common.agent_d4f0bc")}{" "}<I18nText id="pipelines.started" />{" "}{formatClock(s.startedAt)}
                          {s.endedAt != null && tr("common.ended", { p0: String(formatClock(s.endedAt)) })}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 px-2 text-[length:var(--text-caption)]"
                        data-testid="subagent-details-open-transcript"
                        data-subagent-id={s.id}
                        onClick={() => onOpenTranscript(s.id)}
                      >
                        <ExternalLink className="size-3" aria-hidden /><I18nText id="pipelines.open_transcript" />{" "}</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border/60 p-3">
          {onOpenStep && (
            <Button size="sm" variant="outline" data-testid="subagent-details-open-step" onClick={onOpenStep}><I18nText id="pipelines.open_step" />{" "}</Button>
          )}
          {onOpenSettingsAgents && !isLive && profile && !profileDeleted && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              data-testid="subagent-details-edit"
              onClick={() => {
                onClose();
                onOpenSettingsAgents(profile.id);
              }}
            >
              <Settings2 className="size-3.5" aria-hidden /><I18nText id="common.edit_in_settings" />{" "}</Button>
          )}
          <Button size="sm" data-testid="subagent-details-close" onClick={onClose}><I18nText id="common.close" />{" "}</Button>
        </footer>
      </div>
    </Dialog>,
    document.body,
  );
}
