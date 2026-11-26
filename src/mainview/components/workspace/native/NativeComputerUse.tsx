import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { en } from "@/i18n/en";
import { PageHeader } from "../PageHeader";
import type {
  NativeApplicationRecord,
  NativeElementView,
  NativeObservation,
  NativePermissionStatus,
  NativeSessionStatus,
  NativeSessionView,
  NativeWindowRecord,
} from "../../../../shared/native-computer/types.ts";

const selectClass = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

function errorText(error: unknown): string {
  const code = error instanceof ApiError && error.body && typeof error.body === "object" && "code" in error.body
    ? String((error.body as { code?: unknown }).code ?? "")
    : "";
  const key = `native.error.${code}`;
  if (code && Object.hasOwn(en, key)) return tr(key as TranslationKey);
  return tr("native.error.generic");
}

function stateLabel(state: NativeSessionStatus | "none"): string {
  return tr(`native.state.${state}` as TranslationKey);
}

function permissionLabel(value: NativePermissionStatus["accessibility"] | undefined): string {
  if (!value) return tr("native.permissions.checking");
  return tr(`native.permissions.${value}` as TranslationKey);
}

export function NativeComputerUse() {
  useUILocale();
  const [permissions, setPermissions] = useState<NativePermissionStatus | null>(null);
  const [applications, setApplications] = useState<NativeApplicationRecord[]>([]);
  const [windows, setWindows] = useState<NativeWindowRecord[]>([]);
  const [appKey, setAppKey] = useState("");
  const [windowId, setWindowId] = useState("");
  const [session, setSession] = useState<NativeSessionView | null>(null);
  const [observation, setObservation] = useState<NativeObservation | null>(null);
  const [elementId, setElementId] = useState("");
  const [textInputValue, setTextInputValue] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [screenshotNote, setScreenshotNote] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listSessions = typeof api.listNativeComputerSessions === "function"
          ? api.listNativeComputerSessions().catch(() => ({ sessions: [], lastInterrupted: null }))
          : Promise.resolve({ sessions: [] as NativeSessionView[], lastInterrupted: null });
        const [status, listed, existing] = await Promise.all([
          api.nativeComputerPermissions(),
          api.nativeComputerApplications(),
          listSessions,
        ]);
        if (cancelled) return;
        setPermissions(status);
        setApplications(listed.applications);
        const shown = existing.sessions?.[0] ?? null;
        if (shown) {
          setSession(shown);
          setAppKey(applicationKey(shown.application));
          setWindowId(String(shown.window.windowId));
          setWindows([shown.window]);
          void api.nativeComputerWindows(shown.application).then((winList) => {
            if (!cancelled && winList.windows.length > 0) setWindows(winList.windows);
          }).catch(() => {});
          if (shown.observationId) {
            const seen = await api.nativeComputerObservation(shown.id).catch(() => null);
            if (!cancelled && seen) setObservation(seen);
          }
        } else if (existing.lastInterrupted) {
          setSession(existing.lastInterrupted);
        }
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session || session.status !== "active") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      void (async () => {
        try {
          const next = await api.nativeComputerSession(session.id);
          if (cancelled) return;
          setSession(next);
          if (next.status !== "active") {
            setObservation(null);
            setElementId("");
            if (next.lastError?.code) {
              setError(errorText({ body: { code: next.lastError.code } }));
            }
            return;
          }
          if (next.observationId && next.observationId !== observation?.observationId) {
            const seen = await api.nativeComputerObservation(next.id).catch(() => null);
            if (!cancelled && seen) {
              setObservation(seen);
              setElementId("");
            }
          }
        } catch {
          // Transient polling error should not wipe the current view.
        }
      })();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session?.id, session?.status, observation?.observationId, busy]);

  const selected = applications.find((item) => applicationKey(item) === appKey) ?? null;
  const selectedWindow = windows.find((item) => String(item.windowId) === windowId) ?? null;
  const active = session?.status === "active";
  const element = observation?.elements.find((item) => item.id === elementId) ?? null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function chooseApp(nextKey: string) {
    setAppKey(nextKey);
    setWindowId("");
    setWindows([]);
    const next = applications.find((item) => applicationKey(item) === nextKey);
    if (!next) return;
    await run(async () => {
      const listed = await api.nativeComputerWindows(next);
      setWindows(listed.windows);
    });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="native-page">
      <PageHeader title={tr("native.title")} subtitle={tr("native.subtitle")} titleTestId="native-title" testId="native-header">
        {session && session.status === "active" ? (
          <Button type="button" variant="outline" disabled={busy} data-testid="native-close" onClick={() => void run(async () => {
            const closed = await api.closeNativeComputerSession(session.id);
            setSession(closed);
            setObservation(null);
            setElementId("");
            setPreview(null);
            setResult("");
          })}>
            {tr("native.close")}
          </Button>
        ) : (
          <Button type="button" disabled={busy || !selected || !selectedWindow} data-testid="native-start" onClick={() => void run(async () => {
            if (!selected || !selectedWindow) return;
            const created = await api.createNativeComputerSession(selected, selectedWindow.windowId);
            setSession(created);
            const seen = await api.refreshNativeComputerObservation(created.id);
            setObservation(seen);
            setElementId("");
            setPreview(null);
            setResult("");
            setScreenshotNote("");
          })}>
            {tr("native.start")}
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6 sm:px-page">
        <p className="text-sm text-muted-foreground" data-testid="native-owner-note">{tr("native.owner_note")}</p>
        <section className="rounded-lg border border-border bg-muted/40 px-3 py-2" data-testid="native-agent-unavailable" aria-disabled="true">
          <h2 className="text-sm font-medium">{tr("native.agent_heading")}</h2>
          <p className="text-sm text-muted-foreground">{tr("native.agent_unavailable")}</p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="native-cu-access-mode">{tr("access.cu.native_mode_note")}</p>
        </section>
        <section className="grid gap-2 sm:grid-cols-2" data-testid="native-permissions">
          <p className="text-sm" data-testid="native-accessibility">
            <span className="text-muted-foreground">{tr("native.permissions.accessibility")}: </span>
            {permissionLabel(permissions?.accessibility)}
          </p>
          <p className="text-sm" data-testid="native-screen">
            <span className="text-muted-foreground">{tr("native.permissions.screen")}: </span>
            {permissionLabel(permissions?.screenRecording)}
          </p>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="native-open-accessibility" onClick={() => void run(async () => setPermissions(await api.openNativeComputerSettings("accessibility")))}>
              {tr("native.permissions.open_accessibility")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="native-open-screen" onClick={() => void run(async () => setPermissions(await api.openNativeComputerSettings("screen-recording")))}>
              {tr("native.permissions.open_screen")}
            </Button>
          </div>
          {permissions?.helperAvailable === false && (
            <p className="text-sm text-destructive sm:col-span-2" data-testid="native-helper-missing">{tr("native.error.helper_missing")}</p>
          )}
          {permissions?.accessibility === "denied" && (
            <p className="text-sm text-muted-foreground sm:col-span-2" data-testid="native-accessibility-missing">{tr("native.permissions.missing")}</p>
          )}
          {permissions?.screenRecording === "denied" && (
            <p className="text-sm text-muted-foreground sm:col-span-2" data-testid="native-screen-missing">{tr("native.permissions.screen_missing")}</p>
          )}
          {permissions?.restartMayBeRequired && <p className="text-sm text-muted-foreground sm:col-span-2" data-testid="native-restart-note">{tr("native.permissions.restart")}</p>}
        </section>
        <p className="text-sm" data-testid="native-status">
          <span className="text-muted-foreground">{tr("native.status")}: </span>
          {stateLabel(session?.status ?? "none")}
        </p>
        {session?.status === "interrupted" && session.lastError && (
          <p className="text-sm text-muted-foreground" data-testid="native-interrupted-notice">
            {tr("native.restarted_interrupted")} {session.lastError.message}
          </p>
        )}
        {error && <p className="text-sm text-destructive" role="alert" data-testid="native-error">{error}</p>}
        {result && <p className="text-sm" data-testid="native-result">{result}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">{tr("native.apps")}</span>
            <select className={selectClass} data-testid="native-app" value={appKey} disabled={busy || active} onChange={(event) => void chooseApp(event.target.value)}>
              <option value="">{tr("native.select_app")}</option>
              {applications.map((item) => <option key={applicationKey(item)} value={applicationKey(item)}>{item.displayName}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">{tr("native.windows")}</span>
            <select className={selectClass} data-testid="native-window" value={windowId} disabled={busy || active || !selected} onChange={(event) => setWindowId(event.target.value)}>
              <option value="">{tr("native.select_window")}</option>
              {windows.map((item) => <option key={item.windowId} value={String(item.windowId)}>{item.titleRedacted || !item.title ? `#${item.windowId}` : item.title}</option>)}
            </select>
          </label>
        </div>
        {applications.length === 0 && <p className="text-sm text-muted-foreground">{tr("native.apps_empty")}</p>}
        {selected && windows.length === 0 && <p className="text-sm text-muted-foreground">{tr("native.windows_empty")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="native-apps-refresh" onClick={() => void run(async () => {
            const listed = await api.nativeComputerApplications();
            setApplications(listed.applications);
          })}>
            {tr("native.apps_refresh")}
          </Button>
        </div>
        {active && <p className="text-sm text-muted-foreground" data-testid="native-fixed">{tr("native.fixed")}</p>}
        {active && (session?.actionBoundary === "read-only" ? (
          <p className="text-sm text-muted-foreground" data-testid="native-read-only">{session.readOnlyReason || tr("native.read_only")}</p>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="native-actions-supported">{tr("native.actions_supported")}</p>
        ))}
        {active && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} data-testid="native-refresh" onClick={() => void run(async () => {
              const seen = await api.refreshNativeComputerObservation(session.id);
              setObservation(seen);
              setElementId("");
              setPreview(null);
            })}>
              {tr("native.refresh")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="native-capture" onClick={() => void run(async () => {
              try {
                const blob = await api.nativeComputerScreenshot(session.id);
                setPreview(URL.createObjectURL(blob));
                setScreenshotNote("");
              } catch (caught) {
                setPreview(null);
                const code = caught instanceof ApiError && caught.body && typeof caught.body === "object" && "code" in caught.body
                  ? String((caught.body as { code?: unknown }).code ?? "")
                  : "";
                setScreenshotNote(code === "screen_recording_denied" ? tr("native.screenshot_denied") : tr("native.screenshot_unavailable"));
                throw caught;
              }
            })}>
              {tr("native.capture")}
            </Button>
          </div>
        )}
        <section data-testid="native-inspector">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">{tr("native.inspector")}</h2>
            {observation && (
              <span className="text-xs text-muted-foreground" data-testid="native-eligible-count">
                {tr("native.eligible_buttons", { count: observation.elements.filter((item) => item.actions.includes("press_accessible_button")).length })}
                {observation.elements.some((item) => item.actions.includes("scroll_accessible_area")) && (
                  <span className="ml-2" data-testid="native-scroll-count">
                    · {tr("native.eligible_scrolls", { count: observation.elements.filter((item) => item.actions.includes("scroll_accessible_area")).length })}
                  </span>
                )}
                {observation.elements.some((item) => item.actions.includes("select_accessible_tab")) && (
                  <span className="ml-2" data-testid="native-tab-count">
                    · {tr("native.eligible_tabs", { count: observation.elements.filter((item) => item.actions.includes("select_accessible_tab")).length })}
                  </span>
                )}
                {observation.elements.some((item) => item.actions.includes("set_accessible_text")) && (
                  <span className="ml-2" data-testid="native-text-count">
                    · {tr("native.eligible_text_fields", { count: observation.elements.filter((item) => item.actions.includes("set_accessible_text")).length })}
                  </span>
                )}
                {observation.elements.some((item) => item.actions.includes("open_accessible_menu")) && (
                  <span className="ml-2" data-testid="native-menu-count">
                    · {tr("native.eligible_menus", { count: observation.elements.filter((item) => item.actions.includes("open_accessible_menu")).length })}
                  </span>
                )}
                {observation.elements.some((item) => item.actions.includes("select_accessible_menu_item")) && (
                  <span className="ml-2" data-testid="native-menu-item-count">
                    · {tr("native.eligible_menu_items", { count: observation.elements.filter((item) => item.actions.includes("select_accessible_menu_item")).length })}
                  </span>
                )}
              </span>
            )}
          </div>
          {!observation && <p className="text-sm text-muted-foreground">{tr("native.inspector_empty")}</p>}
          {observation && (
            <ul className="space-y-1">
              {observation.elements.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full rounded-md border border-border px-2 py-1 text-left text-sm hover:bg-muted/50"
                    data-testid={`native-element-${item.id}`}
                    aria-pressed={item.id === elementId}
                    onClick={() => { setElementId(item.id); setResult(""); }}
                  >
                    <ElementSummary item={item} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {observation?.truncated && <p className="mt-2 text-sm text-muted-foreground">{tr("native.truncated")}</p>}
          {observation && observation.redactedFields > 0 && <p className="text-sm text-muted-foreground" data-testid="native-redacted">{tr("native.secure")}</p>}
        </section>
        {element && (
          <section className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="native-element-detail">
            <p><span className="text-muted-foreground">{tr("native.role")}: </span>{element.role}</p>
            <p><span className="text-muted-foreground">{tr("native.label")}: </span>{element.label || tr("native.none")}</p>
            <p><span className="text-muted-foreground">{tr("native.enabled")}: </span>{element.enabled ? tr("native.enabled") : tr("native.disabled")}</p>
            <p><span className="text-muted-foreground">{tr("native.actions")}: </span>{element.actions.length === 0 ? tr("native.none") : element.actions.join(", ")}</p>
            {element.actions.length === 0 && (
              <p className="mt-2 text-muted-foreground" data-testid="native-unsupported">
                {element.role === "AXRadioButton"
                  ? tr("native.control_read_only_tab")
                  : element.role === "AXScrollArea"
                    ? tr("native.control_read_only_scroll")
                    : (element.role === "AXTextField" || element.role === "AXTextArea")
                      ? tr("native.control_read_only_text")
                      : element.role === "AXMenuBarItem"
                        ? tr("native.control_read_only_menu")
                        : element.role === "AXMenuItem"
                          ? tr("native.control_read_only_menu_item")
                          : element.role !== "AXButton"
                            ? tr("native.control_read_only_role")
                            : !element.enabled
                              ? tr("native.control_read_only_disabled")
                              : element.valueRedacted
                                ? tr("native.control_read_only_secure")
                                : tr("native.unsupported")}
              </p>
            )}
            {element.actions.includes("press_accessible_button") && session && (
              <Button type="button" className="mt-2" disabled={busy} data-testid="native-confirm" onClick={() => void run(async () => {
                const claim = await api.requestNativeComputerAction(session.id, {
                  ...session.application,
                  windowId: session.window.windowId,
                  observationId: observation?.observationId ?? "",
                  elementId: element.id,
                });
                const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                setResult(confirmed.pressed ? tr("native.result.pressed") : tr("native.result.used"));
                const seen = await api.refreshNativeComputerObservation(session.id);
                setObservation(seen);
                setElementId("");
              })}>
                {tr("native.confirm")}
              </Button>
            )}
            {element.actions.includes("scroll_accessible_area") && session && (
              <div className="mt-2 flex gap-2">
                <Button type="button" disabled={busy} data-testid="native-scroll-down" onClick={() => void run(async () => {
                  const claim = await api.requestNativeComputerAction(session.id, {
                    ...session.application,
                    windowId: session.window.windowId,
                    observationId: observation?.observationId ?? "",
                    elementId: element.id,
                    action: "scroll_accessible_area",
                    direction: "down",
                    increment: 1,
                  });
                  const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                  setResult(confirmed.scrolled ? tr("native.result.scrolled") : tr("native.result.used"));
                  const seen = await api.refreshNativeComputerObservation(session.id);
                  setObservation(seen);
                  setElementId("");
                })}>
                  {tr("native.scroll_down")}
                </Button>
                <Button type="button" variant="outline" disabled={busy} data-testid="native-scroll-up" onClick={() => void run(async () => {
                  const claim = await api.requestNativeComputerAction(session.id, {
                    ...session.application,
                    windowId: session.window.windowId,
                    observationId: observation?.observationId ?? "",
                    elementId: element.id,
                    action: "scroll_accessible_area",
                    direction: "up",
                    increment: 1,
                  });
                  const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                  setResult(confirmed.scrolled ? tr("native.result.scrolled") : tr("native.result.used"));
                  const seen = await api.refreshNativeComputerObservation(session.id);
                  setObservation(seen);
                  setElementId("");
                })}>
                  {tr("native.scroll_up")}
                </Button>
              </div>
            )}
            {element.actions.includes("select_accessible_tab") && session && (
              <Button type="button" className="mt-2" disabled={busy} data-testid="native-select-tab" onClick={() => void run(async () => {
                const claim = await api.requestNativeComputerAction(session.id, {
                  ...session.application,
                  windowId: session.window.windowId,
                  observationId: observation?.observationId ?? "",
                  elementId: element.id,
                  action: "select_accessible_tab",
                });
                const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                setResult(confirmed.selected ? tr("native.result.tab_selected") : tr("native.result.used"));
                const seen = await api.refreshNativeComputerObservation(session.id);
                setObservation(seen);
                setElementId("");
              })}>
                {tr("native.select_tab")}
              </Button>
            )}
            {element.actions.includes("set_accessible_text") && session && (
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  placeholder={tr("native.text_placeholder")}
                  value={textInputValue}
                  maxLength={1000}
                  data-testid="native-text-input"
                  onChange={(e) => setTextInputValue(e.target.value)}
                />
                <Button type="button" disabled={busy} data-testid="native-set-text" onClick={() => void run(async () => {
                  const claim = await api.requestNativeComputerAction(session.id, {
                    ...session.application,
                    windowId: session.window.windowId,
                    observationId: observation?.observationId ?? "",
                    elementId: element.id,
                    action: "set_accessible_text",
                    text: textInputValue,
                  });
                  const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                  setResult(confirmed.textSet ? tr("native.result.text_set") : tr("native.result.used"));
                  const seen = await api.refreshNativeComputerObservation(session.id);
                  setObservation(seen);
                  setElementId("");
                  setTextInputValue("");
                })}>
                  {tr("native.set_text")}
                </Button>
              </div>
            )}
            {element.actions.includes("open_accessible_menu") && session && (
              <Button type="button" className="mt-2" disabled={busy} data-testid="native-open-menu" onClick={() => void run(async () => {
                const claim = await api.requestNativeComputerAction(session.id, {
                  ...session.application,
                  windowId: session.window.windowId,
                  observationId: observation?.observationId ?? "",
                  elementId: element.id,
                  action: "open_accessible_menu",
                });
                const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                setResult(confirmed.menuOpened ? tr("native.result.menu_opened") : tr("native.result.used"));
                const seen = await api.refreshNativeComputerObservation(session.id);
                setObservation(seen);
                setElementId("");
              })}>
                {tr("native.open_menu")}
              </Button>
            )}
            {element.actions.includes("select_accessible_menu_item") && session && (
              <Button type="button" className="mt-2" disabled={busy} data-testid="native-select-menu-item" onClick={() => void run(async () => {
                const claim = await api.requestNativeComputerAction(session.id, {
                  ...session.application,
                  windowId: session.window.windowId,
                  observationId: observation?.observationId ?? "",
                  elementId: element.id,
                  action: "select_accessible_menu_item",
                });
                const confirmed = await api.confirmNativeComputerAction(session.id, claim.id, session.application, session.window.windowId);
                setResult(confirmed.menuItemSelected ? tr("native.result.menu_item_selected") : tr("native.result.used"));
                const seen = await api.refreshNativeComputerObservation(session.id);
                setObservation(seen);
                setElementId("");
              })}>
                {tr("native.select_menu_item")}
              </Button>
            )}
          </section>
        )}
        <section data-testid="native-screenshot">
          {!preview && <p className="text-sm text-muted-foreground">{screenshotNote || tr("native.screenshot_missing")}</p>}
          {preview && <img src={preview} alt="" className="max-h-96 max-w-full rounded-md border border-border" data-testid="native-screenshot-image" />}
        </section>
      </div>
    </div>
  );
}

function ElementSummary({ item }: { item: NativeElementView }) {
  const pad = "\u00a0".repeat(item.depth * 2);
  return <span>{pad}{item.role}{item.label ? ` — ${item.label}` : ""}</span>;
}

function applicationKey(application: NativeApplicationRecord): string {
  return `${application.pid}:${application.startSec}:${application.startUsec}:${application.bundleId}`;
}
