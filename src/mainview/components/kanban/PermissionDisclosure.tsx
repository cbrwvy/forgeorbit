import { permissionCodeText } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import type { PermissionDisclosure } from "../../../shared/execution/permissions.ts";

/**
 * What a harness mode really grants for the workspace it will run in (FO-ORCH01).
 * Rendered from stable codes, so the text follows the UI language. A disclosure
 * describes; it grants nothing and is never a substitute for the Owner's confirmation.
 */
export function PermissionDisclosureView({ disclosure, testId = "permission-disclosure" }: { disclosure: PermissionDisclosure; testId?: string }) {
  useUILocale();
  const tone = disclosure.sandbox === "danger-full-access" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId} data-sandbox={disclosure.sandbox} data-layout={disclosure.layout} data-escalated={disclosure.escalated ? "true" : "false"}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{tr("permission.title")}</span>
      <ul className={`list-disc pl-4 ${tone}`}>
        {disclosure.codes.map((code) => (
          <li key={code} data-code={code}>{permissionCodeText(code)}</li>
        ))}
        {disclosure.predicted && <li data-code="predicted">{permissionCodeText("predicted")}</li>}
      </ul>
      {disclosure.timeLimitSeconds != null && (
        <p className="text-muted-foreground" data-testid="permission-time-limit" data-seconds={String(disclosure.timeLimitSeconds)}>
          {tr("stop.limit.preflight", { seconds: String(disclosure.timeLimitSeconds) })}
        </p>
      )}
    </div>
  );
}
