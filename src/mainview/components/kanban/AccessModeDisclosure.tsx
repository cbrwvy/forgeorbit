import { t as tr, type TranslationKey } from "@/i18n/core";
import { en } from "@/i18n/en";
import { useLocale as useUILocale } from "@/i18n/react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ACCESS_MODES,
  type AccessDiagnostics,
  type AccessMode,
} from "../../../shared/execution/access-mode.ts";

function translatedKey(prefix: string, code: string, fallback = ""): string {
  const key = `${prefix}.${code}`;
  if (Object.hasOwn(en, key)) return tr(key as TranslationKey);
  return fallback || code;
}

export function accessModeLabel(mode: AccessMode): string {
  return tr(`access.mode.${mode}` as TranslationKey);
}

export function accessWorkspaceKindLabel(diagnostics: AccessDiagnostics): string {
  const { kind } = diagnostics.effectiveWorkspace;
  return translatedKey("access.disclosure.workspace", kind, kind);
}

export function AccessModeSelector({
  value,
  onChange,
  disabled = false,
  testId = "new-task-access-mode",
}: {
  value: AccessMode;
  onChange: (mode: AccessMode) => void;
  disabled?: boolean;
  testId?: string;
}) {
  useUILocale();
  return (
    <div className="space-y-1" data-testid={testId}>
      <label className="text-muted-foreground">{tr("access.label")}</label>
      <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={tr("access.label")}>
        {ACCESS_MODES.map((mode) => (
          <Button
            key={mode}
            type="button"
            size="sm"
            variant={value === mode ? "default" : "outline"}
            disabled={disabled}
            role="radio"
            aria-checked={value === mode}
            data-testid={`access-mode-${mode}`}
            onClick={() => onChange(mode)}
            className="h-auto min-h-8 px-1.5 py-1 text-[11px] leading-tight"
          >
            {accessModeLabel(mode)}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="access-mode-description">
        {tr(`access.desc.${value}` as TranslationKey)}
      </p>
    </div>
  );
}

export function AccessModeDisclosure({
  diagnostics,
  testId = "access-mode-disclosure",
  compact = false,
}: {
  diagnostics: AccessDiagnostics;
  testId?: string;
  compact?: boolean;
}) {
  useUILocale();
  const hasGapWarning = diagnostics.unverifiedCodes.some(
    (code) => code === "gap-no-os-sandbox" || code === "gap-network-unrestricted" || code === "gap-broad-reads",
  );
  const workspaceText = diagnostics.effectiveWorkspace.path
    ? `${accessWorkspaceKindLabel(diagnostics)} — ${diagnostics.effectiveWorkspace.path}`
    : accessWorkspaceKindLabel(diagnostics);

  return (
    <section
      className={cn(
        "space-y-1.5 rounded-md border px-2.5 py-2 text-[11px]",
        !diagnostics.launchAllowed
          ? "border-destructive/50 bg-destructive/10"
          : hasGapWarning
            ? "border-warning/40 bg-warning/5"
            : "border-border bg-muted/20",
      )}
      data-testid={testId}
      data-access-mode={diagnostics.accessMode}
      data-launch-allowed={diagnostics.launchAllowed ? "true" : "false"}
      data-os-mechanism={diagnostics.osEnforcement.mechanism}
    >
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="font-medium text-foreground">
          {tr("access.disclosure.title")} · {accessModeLabel(diagnostics.accessMode)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {tr("access.disclosure.grants_nothing")}
        </span>
      </div>

      <div>
        <span className="font-medium text-muted-foreground">{tr("access.disclosure.effective_workspace")}: </span>
        <span className="break-all font-mono text-[10px]" data-testid={`${testId}-workspace`}>
          {workspaceText}
        </span>
      </div>

      {!diagnostics.launchAllowed && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-danger"
          data-testid={`${testId}-blocked`}
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium">{tr("access.disclosure.blocked")}</div>
            <ul className="list-disc pl-4">
              {diagnostics.blockCodes.length > 0
                ? diagnostics.blockCodes.map((code) => (
                    <li key={code} data-block-code={code}>
                      {translatedKey("access.block", code, diagnostics.blockReason ?? code)}
                    </li>
                  ))
                : diagnostics.blockReason && <li>{diagnostics.blockReason}</li>}
            </ul>
          </div>
        </div>
      )}

      <div className={cn("space-y-1", compact && "text-[10px]")}>
        <div>
          <span className="font-medium text-muted-foreground">{tr("access.disclosure.os_label")}: </span>
          <ul className="list-disc pl-4 text-foreground/90" data-testid={`${testId}-os`}>
            {diagnostics.osEnforcement.summaryCodes.map((code) => (
              <li key={code} data-code={code}>{translatedKey("access.os", code)}</li>
            ))}
          </ul>
        </div>

        <div>
          <span className="font-medium text-muted-foreground">{tr("access.disclosure.app_label")}: </span>
          <ul className="list-disc pl-4 text-muted-foreground" data-testid={`${testId}-app`}>
            {diagnostics.appEnforcementCodes.map((code) => (
              <li key={code} data-code={code}>{translatedKey("access.app", code)}</li>
            ))}
          </ul>
        </div>

        {diagnostics.unverifiedCodes.length > 0 && (
          <div>
            <span className="font-medium text-warning">{tr("access.disclosure.unverified_label")}: </span>
            <ul className="list-disc pl-4 text-muted-foreground" data-testid={`${testId}-unverified`}>
              {diagnostics.unverifiedCodes.map((code) => (
                <li key={code} data-code={code}>{translatedKey("access.gap", code)}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <span className="font-medium text-muted-foreground">{tr("access.disclosure.cu_label")}: </span>
          <span className="text-muted-foreground" data-testid={`${testId}-cu`}>
            {translatedKey("access.cu", diagnostics.computerUse.activeNoteCode)}
          </span>
        </div>
      </div>
    </section>
  );
}
