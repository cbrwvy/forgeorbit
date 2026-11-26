import { useEffect, useState } from "react";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { Button } from "@/components/ui/button";
import { routerV2Api } from "@/lib/router-v2-api";
import { useAutonomyStatus } from "@/components/orchestration/AutonomyControlPanel";

type Mode = "supervised" | "autonomous" | "full-autonomy";

/**
 * FO-UX-SIMPLIFY02-M4: the three things that shape autonomous work, side by side and
 * never merged — the Router's preference, the saved policy that is actually enforced,
 * and a grant given on one mission. Read-only: nothing here saves or activates anything.
 */
export function AutonomyLayers({ onOpenRouter, onOpenMissions }: { onOpenRouter?: () => void; onOpenMissions?: () => void }) {
  const { status } = useAutonomyStatus();
  const [routerMode, setRouterMode] = useState<Mode | "unknown">("unknown");
  useEffect(() => {
    let alive = true;
    routerV2Api.getPolicy("global").then((policy) => { if (alive) setRouterMode(policy.autonomyMode as Mode); }).catch(() => { if (alive) setRouterMode("unknown"); });
    return () => { alive = false; };
  }, []);
  const enforced: Mode | "unknown" = !status ? "unknown" : status.enforcement.fullAutonomyActive ? "full-autonomy" : status.enforcement.autonomousActive ? "autonomous" : "supervised";
  const modeText = (mode: Mode | "unknown") => (mode === "unknown" ? tr("settings.layers.unknown") : tr(`router.mode.${mode}` as TranslationKey));
  return (
    <div className="space-y-3" data-testid="autonomy-layers">
      <p className="text-xs text-muted-foreground">{tr("settings.layers.hint")}</p>
      <dl className="grid gap-2 xl:grid-cols-3">
        <div className="space-y-1 rounded-md border border-border/70 p-3" data-testid="layer-router">
          <dt className="text-xs font-medium">{tr("settings.layers.router_title")}</dt>
          <dd className="text-sm font-semibold" data-testid="layer-router-value">{modeText(routerMode)}</dd>
          <dd className="text-[11px] text-muted-foreground">{tr("settings.layers.router_hint")}</dd>
          {onOpenRouter && <dd><Button size="sm" variant="outline" className="h-auto min-h-7 whitespace-normal py-1 text-left text-[11px]" onClick={onOpenRouter} data-testid="layer-router-open">{tr("settings.layers.router_open")}</Button></dd>}
        </div>
        <div className="space-y-1 rounded-md border border-border/70 p-3" data-testid="layer-enforced">
          <dt className="text-xs font-medium">{tr("settings.layers.enforced_title")}</dt>
          <dd className="text-sm font-semibold" data-testid="layer-enforced-value">{modeText(enforced)}</dd>
          <dd className="text-[11px] text-muted-foreground">{tr("settings.layers.enforced_hint")}</dd>
        </div>
        <div className="space-y-1 rounded-md border border-border/70 p-3" data-testid="layer-grant">
          <dt className="text-xs font-medium">{tr("settings.layers.grant_title")}</dt>
          <dd className="text-[11px] text-muted-foreground">{tr("settings.layers.grant_hint")}</dd>
          {onOpenMissions && <dd><Button size="sm" variant="outline" className="h-auto min-h-7 whitespace-normal py-1 text-left text-[11px]" onClick={onOpenMissions} data-testid="layer-grant-open">{tr("settings.layers.grant_open")}</Button></dd>}
        </div>
      </dl>
      <p className="text-xs" role="status" data-testid="layer-emergency">
        <span className="font-medium">{tr("settings.layers.estop")}: </span>
        <span className={status?.emergency.active ? "text-warning" : "text-muted-foreground"}>
          {!status ? tr("settings.layers.unknown") : status.emergency.active ? tr("settings.layers.estop_on") : tr("settings.layers.estop_off")}
        </span>
      </p>
    </div>
  );
}
