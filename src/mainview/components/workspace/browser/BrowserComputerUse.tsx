import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { en } from "@/i18n/en";
import { PageHeader } from "../PageHeader";
import type { BrowserObservation, BrowserSessionState, BrowserSessionView } from "../../../../shared/browser/types.ts";

function errorText(error: unknown): string {
  const code = error instanceof ApiError && error.body && typeof error.body === "object" && "code" in error.body
    ? String((error.body as { code?: unknown }).code ?? "")
    : "";
  const key = `browser.error.${code}`;
  if (code && Object.hasOwn(en, key)) return tr(key as TranslationKey);
  return tr("browser.error.generic");
}

function stateLabel(state: BrowserSessionState | "none"): string {
  return tr(`browser.state.${state}` as TranslationKey);
}

export function BrowserComputerUse() {
  useUILocale();
  const [session, setSession] = useState<BrowserSessionView | null>(null);
  const [observation, setObservation] = useState<BrowserObservation | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await api.listBrowserSessions();
        if (cancelled) return;
        const active = listed.sessions.find((s) => s.state === "active");
        if (active) {
          setUrl(active.url ?? "");
          await refreshObservation(active);
        }
      } catch {
        // ignore initial load failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A manager may move the session while this page is open (one granted action), and a session can expire or end.
  // Without this the page kept showing the old title, text and screenshot and a disabled Back (Direction 19).
  // The session view is cheap and does not replace the page observation. A new observation is read only when the
  // page actually changed, because reading one replaces the observation id that an Owner grant is bound to.
  useEffect(() => {
    if (!session || session.state !== "active" || busy) return;
    const shown = session;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await api.browserSession(shown.id);
          const moved = next.state !== "active" || next.url !== (observation?.url ?? shown.url) || next.history.length !== shown.history.length;
          if (!moved) return;
          setUrl(next.url ?? "");
          await refreshObservation(next);
        } catch {
          // The next tick tries again. A closed or unknown session is reported by the page's own actions.
        }
      })();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [session, observation, busy]);

  async function refreshObservation(next: BrowserSessionView) {
    setSession(next);
    if (next.state !== "active") {
      setObservation(null);
      setPreview(null);
      return;
    }
    const seen = await api.browserObservation(next.id);
    setObservation(seen);
    if (!seen.screenshot.available) {
      setPreview(null);
      return;
    }
    const blob = await api.browserScreenshot(next.id);
    setPreview(URL.createObjectURL(blob));
  }

  async function run(action: () => Promise<BrowserSessionView>, observe: boolean) {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (observe) await refreshObservation(next);
      else {
        setSession(next);
        setObservation(null);
        setPreview(null);
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const active = session?.state === "active";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="browser-page">
      <PageHeader
        title={tr("browser.title")}
        subtitle={tr("browser.subtitle")}
        titleTestId="browser-title"
        testId="browser-header"
      >
        {active && session ? (
          <Button type="button" variant="outline" disabled={busy} data-testid="browser-close" onClick={() => void run(() => api.closeBrowserSession(session.id), false)}>
            {tr("browser.close")}
          </Button>
        ) : (
          <Button type="button" disabled={busy} data-testid="browser-start" onClick={() => void run(() => api.createBrowserSession(), false)}>
            {tr("browser.start")}
          </Button>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6 sm:px-page">
        <p className="text-sm text-muted-foreground" data-testid="browser-owner-note">{tr("browser.owner_note")}</p>
        <p className="text-xs text-muted-foreground" data-testid="browser-cu-access-mode">{tr("access.cu.browser_mode_note")}</p>
        <section className="rounded-lg border border-border bg-muted/40 px-3 py-2" data-testid="browser-agent-unavailable" aria-disabled="true">
          <h2 className="text-sm font-medium">{tr("browser.agent_heading")}</h2>
          <p className="text-sm text-muted-foreground">{tr("browser.agent_unavailable")}</p>
        </section>
        <p className="text-sm" data-testid="browser-status">
          <span className="text-muted-foreground">{tr("browser.status")}: </span>
          {stateLabel(session?.state ?? "none")}
        </p>
        {error && <p className="text-sm text-destructive" role="alert" data-testid="browser-error">{error}</p>}
        {active && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!session) return;
              void run(() => api.navigateBrowser(session.id, url), true);
            }}
          >
            <label className="min-w-0 flex-1 text-sm">
              <span className="mb-1 block text-muted-foreground">{tr("browser.url")}</span>
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={tr("browser.url_placeholder")}
                data-testid="browser-url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <Button type="submit" disabled={busy || url.trim() === ""} data-testid="browser-open">{tr("browser.open")}</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || (session?.history.length ?? 0) < 2}
              data-testid="browser-back"
              onClick={() => session && void run(() => api.backBrowser(session.id), true)}
            >
              {tr("browser.back")}
            </Button>
          </form>
        )}
        {active && <p className="text-sm text-muted-foreground">{tr("browser.retention")}</p>}
        {session && session.approvedOrigins.length > 0 && (
          <p className="text-sm" data-testid="browser-origins">
            <span className="text-muted-foreground">{tr("browser.origins")}: </span>
            {session.approvedOrigins.join(", ")}
          </p>
        )}
        {observation && (
          <div className="space-y-3">
            <p className="text-sm text-warning" data-testid="browser-untrusted">{tr("browser.untrusted")}</p>
            <p className="text-sm" data-testid="browser-page-title">
              <span className="text-muted-foreground">{tr("browser.page_title")}: </span>
              {observation.title}
            </p>
            <p className="break-all text-sm" data-testid="browser-current-url">
              <span className="text-muted-foreground">{tr("browser.page_url")}: </span>
              {observation.url}
            </p>
            <figure className="space-y-1" data-testid="browser-screenshot">
              <figcaption className="text-sm text-muted-foreground">{tr("browser.screenshot")}</figcaption>
              {preview ? (
                <img src={preview} alt="" className="max-h-96 max-w-full rounded-md border border-border" data-testid="browser-preview" />
              ) : (
                <p className="text-sm text-muted-foreground">{tr("browser.screenshot_missing")}</p>
              )}
            </figure>
            <section>
              <h2 className="mb-1 text-sm font-medium">{tr("browser.text")}</h2>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm" data-testid="browser-text">{observation.visibleText}</pre>
              {observation.textTruncated && <p className="mt-1 text-sm text-muted-foreground">{tr("browser.text_truncated")}</p>}
            </section>
            <section>
              <h2 className="mb-1 text-sm font-medium">{tr("browser.links")}</h2>
              {observation.links.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="browser-links-empty">{tr("browser.links_empty")}</p>
              ) : (
                <ul className="space-y-1" data-testid="browser-links">
                  {observation.links.map((link) => (
                    <li key={link.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <button
                        type="button"
                        className="underline disabled:no-underline disabled:opacity-60"
                        disabled={!link.permitted || busy}
                        data-testid="browser-link"
                        data-permitted={link.permitted ? "true" : "false"}
                        onClick={() => session && void run(() => api.openBrowserLink(session.id, link.id, observation.observationId), true)}
                      >
                        {link.text || link.href}
                      </button>
                      {!link.permitted && <span className="text-muted-foreground">{tr("browser.link_blocked")}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
