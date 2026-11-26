import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { cn } from "@/lib/utils";

/**
 * The one provider-launch safety notice (FO-UX-SIMPLIFY02-M2, audit S1).
 * The sentence that changes what the Owner can do stays visible; the longer explanation of the
 * Owner channel sits behind a disclosure. Screens show this once instead of repeating both paragraphs.
 */
export function RuntimeSafetyNotice({ liveTestId, channelTestId, className }: {
  liveTestId?: string;
  channelTestId?: string;
  className?: string;
}) {
  useUILocale();
  return (
    <div className={cn("space-y-1 text-xs text-muted-foreground", className)}>
      <p data-testid={liveTestId}>{tr("runtime.live_unavailable")}</p>
      <details>
        <summary className="cursor-pointer select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tr("runtime.notice.more")}
        </summary>
        <p className="mt-1" data-testid={channelTestId}>{tr("runtime.owner_channel")}</p>
      </details>
    </div>
  );
}
