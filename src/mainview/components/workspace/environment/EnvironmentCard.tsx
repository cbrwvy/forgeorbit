import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { subscribeEnvironmentEvents } from "@/lib/environment-events";
import { Button } from "@/components/ui/button";
import {
  PHASE_LABELS,
  displayPhase,
  environmentActions,
  openableLoopbackUrl,
  selectDisplayedProfile,
  websiteUrl,
  type EnvironmentIndex,
} from "@/i18n/environment";
import type { Project } from "../../../../shared/types.ts";

interface Props {
  project: Project;
  onOpen: () => void;
}

/** Compact environment summary for the project overview. */
export function EnvironmentCard({ project, onOpen }: Props) {
  useUILocale();
  const [index, setIndex] = useState<EnvironmentIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api.getEnvironment(project.path).then(
      (next) => {
        setIndex(next);
        setError(null);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    void api.getEnvironment(project.path).then(
      (next) => {
        if (!cancelled) {
          setIndex(next);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    const unsubscribe = subscribeEnvironmentEvents((event) => {
      if (event.projectPath === project.path) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [project.path]);

  const row = index ? selectDisplayedProfile(index.profiles) : null;
  const phase = displayPhase({
    configured: row !== null,
    recordedPhase: row?.status.recordedPhase ?? "stopped",
    ownership: row?.status.ownership ?? "none",
  });
  const actions = environmentActions(phase, row?.status.ownership ?? "none");
  const site = row ? websiteUrl(row.urls) : null;
  const href = site ? openableLoopbackUrl(site.url) : null;

  const run = (action: "start" | "stop") => {
    if (!row) return;
    setBusy(true);
    setError(null);
    void api.environmentAction(project.path, row.profile.id, action).then(
      () => load(),
      (reason: unknown) => setError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : String(reason)),
    ).finally(() => setBusy(false));
  };

  return (
    <section className="surface-solid overflow-hidden rounded-xl border" data-testid="environment-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Server className="size-3.5 text-muted-foreground" aria-hidden /><I18nText id="common.environment" />{" "}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground" data-testid="environment-card-summary">
            <span data-testid="environment-card-phase">{PHASE_LABELS[phase]}</span>
            {row ? ` · ${row.profile.name}` : ""}
            {site?.status === "down" ? " · Website unavailable" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.start && (
            <Button type="button" size="sm" disabled={busy} onClick={() => run("start")} data-testid="environment-card-start"><I18nText id="common.start" />{" "}</Button>
          )}
          {actions.stop && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run("stop")} data-testid="environment-card-stop"><I18nText id="common.stop" />{" "}</Button>
          )}
          {href && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="environment-card-open-website"
              onClick={() => {
                void api.openExternal(href).catch(() => setError("Could not open the local website"));
              }}
            ><I18nText id="environment.open_website" />{" "}</Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onOpen} data-testid="environment-card-open"><I18nText id="common.environment" />{" "}</Button>
        </div>
      </div>
      {error && <p className="border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
