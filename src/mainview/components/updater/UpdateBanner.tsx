import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { Download, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { api, type UpdateSnapshot } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  snapshot: UpdateSnapshot | null;
  /** Refresh snapshot from the server after an action. */
  onChange: () => void;
}

/**
 * Slim emerald strip above the kanban that appears when a staged update is
 * waiting for the user to restart into. Hidden in every other state —
 * checking, downloading, idle, error — to avoid noise from the periodic
 * background polls.
 */
export function UpdateBanner({ snapshot, onChange }: Props) {
  useUILocale();
  // Dismiss state is keyed to the specific version so that a later release
  // re-arms the banner. A boolean flag would bury every subsequent update
  // for the rest of the session after one click.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const shouldShow =
    !!snapshot
    && snapshot.status === "ready"
    && snapshot.version !== dismissedVersion;
  if (!shouldShow) return null;

  const apply = async () => {
    const ok = await confirm(() => ({
      title: snapshot.version
        ? tr("common.restart_and_update_to_v", { p0: String(snapshot.version) })
        : tr("common.restart_and_update_forgeorbit"),
      description:
        tr("common.any_running_agents_will_be_interrupted_their_work"),
      confirmLabel: tr("projects.restart_now"),
      variant: "default",
    }));
    if (!ok) return;
    setBusy(true);
    // Safety net: if applyUpdate resolves but the process never actually
    // exits (shouldn't happen, but a silent updater bug would leave the
    // spinner hung), unstick the button after 5 s. In the normal path the
    // process is gone well before this fires, so the timer dies with the
    // page. The error branch handles the explicit failure case directly.
    setTimeout(() => setBusy(false), 5000);
    try {
      await api.applyUpdate();
    } catch (e) {
      console.error("[forgeorbit] apply update failed", e);
      setBusy(false);
      onChange();
    }
  };

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 border-b border-success/30 bg-success/10 px-4 py-2 text-xs text-foreground",
      )}
    >
      <Download className="size-3.5 shrink-0 text-success" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          {snapshot.version
            ? tr("common.forgeorbit_v_is_ready_to_install", { p0: String(snapshot.version) })
            : tr("common.an_update_is_ready_to_install")}
        </span>{" "}
        <span className="text-muted-foreground"><I18nText id="projects.restart_forgeorbit_to_apply" /></span>
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={apply}
        disabled={busy}
        className="h-7 border-success/40 bg-success/10 text-success hover:bg-success/20"
      >
        {busy ? (
          <RefreshCw className="mr-1 size-3 animate-spin" />
        ) : null}<I18nText id="projects.restart_now" />{" "}</Button>
      <button
        type="button"
        onClick={() => setDismissedVersion(snapshot.version ?? "")}
        aria-label={tr("common.dismiss")}
        className="rounded p-0.5 text-muted-foreground hover:bg-success/10 hover:text-success"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
