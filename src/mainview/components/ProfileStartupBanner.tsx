import { t as tr } from "@/i18n/core";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { shortenPath } from "@/lib/path-display";
import type { ProfileActivationStatusResponse } from "../../shared/profile-activation.ts";

export function ProfileStartupBanner() {
  const [status, setStatus] = useState<ProfileActivationStatusResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.profileActivationStatus());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (dismissed || !status) return null;

  const showRecovery =
    status.startup.recovered ||
    status.startup.warnings.length > 0 ||
    status.pendingTransition !== null;

  if (!showRecovery) return null;

  const pending = status.pendingTransition;

  return (
    <div
      className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs"
      data-testid="profile-startup-banner"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-1">
        {status.startup.recovered && (
          <p>{tr("profile_activation.startup_recovered", { from: status.startup.recoveredFrom ?? "unknown" })}</p>
        )}
        {status.startup.warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
        {pending && (
          <p>
            {tr("profile_activation.startup_pending", {
              action: pending.action,
              path: shortenPath(pending.candidatePath, "", 3),
            })}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label={tr("common.dismiss")}
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
