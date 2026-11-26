import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { BrowserSessionView } from "../../../../shared/browser/types.ts";
import type { BrowserActionView } from "../../../../shared/browser/agent.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BrowserAccessPicker({
  managerKind,
  projectPath,
  grantId,
  disabled,
  onGrantChange,
  onOpenBrowser,
  testId,
  sessions: initialSessions,
}: {
  managerKind: "head-of-pm" | "project-manager";
  projectPath?: string;
  grantId: string | null;
  disabled?: boolean;
  onGrantChange: (grantId: string | null) => void;
  onOpenBrowser?: () => void;
  testId: string;
  sessions?: BrowserSessionView[];
}) {
  useUILocale();
  const [sessions, setSessions] = useState<BrowserSessionView[]>(initialSessions ?? []);
  const [selectedId, setSelectedId] = useState(initialSessions?.[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = sessions.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (initialSessions) return;
    let stopped = false;
    void api.listBrowserSessions().then(
      (result) => {
        if (stopped) return;
        const active = result.sessions.filter((item) => item.state === "active");
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
      const grant = await api.createBrowserAgentGrant({
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
      await api.revokeBrowserAgentGrant(grantId, managerKind, projectPath);
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
      <p className="font-medium text-muted-foreground">{tr("browser.agent.limit")}</p>
      {!grantId && <p data-testid={`${testId}-off`}>{tr("browser.agent.off")}</p>}
      <label className="flex items-center gap-2">
        <span>{tr("browser.agent.session")}</span>
        <select
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1 py-0.5"
          value={selectedId}
          disabled={disabled || busy || grantId != null}
          data-testid={`${testId}-session`}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {sessions.length === 0 && <option value="">{tr("browser.agent.none")}</option>}
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>{item.url ?? item.id}</option>
          ))}
        </select>
      </label>
      {selected && (
        <p data-testid={`${testId}-preview`}>
          {tr("browser.agent.preview")}: {selected.pageTitle || "—"} · {selected.approvedOrigins[0] ?? "—"} · {selected.url ?? "—"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!grantId ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled || busy || !selected} onClick={() => void allow()} data-testid={`${testId}-allow`}>
            {tr("browser.agent.enable")}
          </Button>
        ) : (
          <>
            <span data-testid={`${testId}-allowed`}>{tr("browser.agent.allowed")}</span>
            <Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => void revoke()} data-testid={`${testId}-revoke`}>
              {tr("browser.agent.revoke")}
            </Button>
          </>
        )}
        {onOpenBrowser && (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenBrowser} data-testid={`${testId}-open`}>
            {tr("browser.agent.open_browser")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">{tr("browser.agent.untrusted_short")}</p>
      {error && <p role="alert" className="text-danger" data-testid={`${testId}-error`}>{error}</p>}
    </div>
  );
}

export function BrowserActionCard({
  action,
  onOpenBrowser,
}: {
  action: BrowserActionView;
  onOpenBrowser?: () => void;
}) {
  useUILocale();
  const [opened, setOpened] = useState("");
  const kindKey = action.kind ? `browser.agent.kind.${action.kind}` : "browser.agent.kind.none";
  const statusKey = `browser.agent.status.${action.status}`;
  return (
    <div className="space-y-1 rounded-md border border-border px-2 py-1.5 text-[11px]" data-testid="browser-action-card" data-status={action.status}>
      <p className="font-medium">{tr("browser.agent.action")}: {tr(kindKey as TranslationKey)} · {tr(statusKey as TranslationKey)}</p>
      {action.destinationHost && <p data-testid="browser-action-host">{action.destinationHost}</p>}
      {action.reasonCode && <p data-testid="browser-action-reason">{action.reasonCode}</p>}
      <div className="flex flex-wrap gap-2">
        {action.sessionId && action.status === "accepted" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="browser-action-observation"
            onClick={() => {
              void api.browserObservation(action.sessionId!).then(
                (observation) => setOpened(`${observation.title} ${observation.url ?? ""}`.trim()),
                (error) => setOpened(messageOf(error)),
              );
            }}
          >
            {tr("browser.agent.open_observation")}
          </Button>
        )}
        {onOpenBrowser && (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenBrowser} data-testid="browser-action-open-browser">
            {tr("browser.agent.open_browser")}
          </Button>
        )}
      </div>
      {opened && <p data-testid="browser-action-opened">{opened}</p>}
    </div>
  );
}
