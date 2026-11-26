import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { NativeSessionView } from "../../../../shared/native-computer/types.ts";
import type { NativeActionView } from "../../../../shared/native-computer/agent.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NativeAccessPicker({
  managerKind,
  projectPath,
  grantId,
  disabled,
  onGrantChange,
  onOpenNativeComputer,
  testId,
  sessions: initialSessions,
}: {
  managerKind: "head-of-pm" | "project-manager";
  projectPath?: string;
  grantId: string | null;
  disabled?: boolean;
  onGrantChange: (grantId: string | null) => void;
  onOpenNativeComputer?: () => void;
  testId: string;
  sessions?: NativeSessionView[];
}) {
  useUILocale();
  const [sessions, setSessions] = useState<NativeSessionView[]>(initialSessions ?? []);
  const [selectedId, setSelectedId] = useState(initialSessions?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = sessions.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (initialSessions) return;
    let stopped = false;
    void api.listNativeComputerSessions().then(
      (result) => {
        if (stopped) return;
        const active = result.sessions.filter((item) => item.status === "active");
        setSessions(active);
        setSelectedId((current) => current || active[0]?.id || "");
      },
      () => {
        if (!stopped) setSessions([]);
      },
    );
    return () => {
      stopped = true;
    };
  }, [initialSessions]);

  async function allow() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const grant = await api.createNativeAgentGrant({
        managerKind,
        ...(projectPath ? { projectPath } : {}),
        sessionId: selected.id,
      });
      onGrantChange(grant.grantId);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!grantId || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.revokeNativeAgentGrant(grantId, managerKind, projectPath);
      onGrantChange(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) onGrantChange(null);
      else setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1 rounded-md border border-border px-2 py-1.5 text-[11px]" data-testid={testId}>
      <p className="font-medium text-muted-foreground">{tr("native.agent.limit")}</p>
      {!grantId && <p data-testid={`${testId}-off`}>{tr("native.agent.off")}</p>}
      <label className="flex items-center gap-2">
        <span>{tr("native.agent.session")}</span>
        <select
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1 py-0.5"
          value={selectedId}
          disabled={disabled || busy || grantId != null}
          data-testid={`${testId}-session`}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {sessions.length === 0 && <option value="">{tr("native.agent.none")}</option>}
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.application.displayName || item.application.bundleId} — {item.window.title || `Window ${item.window.windowId}`}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p data-testid={`${testId}-preview`}>
          {tr("native.agent.preview")}: {tr("m0.pidLabel", { name: selected.application.displayName || selected.application.bundleId, pid: selected.application.pid, title: selected.window.title || "—", id: selected.window.windowId })}
          {selected.actionBoundary === "read-only" ? (
            <span className="ml-1 text-muted-foreground" data-testid={`${testId}-read-only`}>
              · {selected.readOnlyReason || tr("native.read_only")}
            </span>
          ) : (
            <span className="ml-1 text-muted-foreground" data-testid={`${testId}-supported`}>
              · {tr("native.actions_supported_short")}
            </span>
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!grantId ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled || busy || !selected} onClick={() => void allow()} data-testid={`${testId}-allow`}>
            {tr("native.agent.enable")}
          </Button>
        ) : (
          <>
            <span data-testid={`${testId}-allowed`}>{tr("native.agent.allowed")}</span>
            <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => void revoke()} data-testid={`${testId}-revoke`}>
              {tr("native.agent.revoke")}
            </Button>
          </>
        )}
        {onOpenNativeComputer && (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenNativeComputer} data-testid={`${testId}-open`}>
            {tr("native.agent.open_native")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">{tr("native.agent.untrusted_short")}</p>
      {error && <p role="alert" className="text-danger" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  );
}

export function NativeActionCard({
  action,
  onOpenNativeComputer,
}: {
  action: NativeActionView;
  onOpenNativeComputer?: () => void;
}) {
  useUILocale();
  const [opened, setOpened] = useState("");
  const kindKey = action.kind ? `native.agent.kind.${action.kind}` : "native.agent.kind.none";
  const statusKey = `native.agent.status.${action.status}`;
  return (
    <div className="space-y-1 rounded-md border border-border px-2 py-1.5 text-[11px]" data-testid="native-action-card" data-status={action.status}>
      <p className="font-medium">{tr("native.agent.action")}: {tr(kindKey as TranslationKey)} · {tr(statusKey as TranslationKey)}</p>
      {action.elementId && <p data-testid="native-action-element">{action.elementId}</p>}
      {action.reasonCode && <p data-testid="native-action-reason">{action.reasonCode}</p>}
      {action.status === "interrupted" && <p className="text-muted-foreground" data-testid="native-action-interrupted-note">{tr("native.agent.interrupted_note")}</p>}
      <div className="flex flex-wrap gap-2">
        {action.sessionId && action.status === "accepted" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="native-action-observation"
            onClick={() => {
              void api.refreshNativeComputerObservation(action.sessionId!).then(
                (observation) => setOpened(`${observation.application.bundleId} ${observation.window.title || ""}`.trim()),
                (error) => setOpened(messageOf(error)),
              );
            }}
          >
            {tr("native.agent.open_observation")}
          </Button>
        )}
        {onOpenNativeComputer && (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenNativeComputer} data-testid="native-action-open-native">
            {tr("native.agent.open_native")}
          </Button>
        )}
      </div>
      {opened && <p data-testid="native-action-opened">{opened}</p>}
    </div>
  );
}
