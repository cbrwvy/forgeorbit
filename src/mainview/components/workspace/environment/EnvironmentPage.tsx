import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { subscribeEnvironmentEvents } from "@/lib/environment-events";
import { Button } from "@/components/ui/button";
import { useWorkspaceDraft } from "../WorkspaceDrafts";
import { ProfileForm } from "./ProfileForm";
import {
  PHASE_LABELS,
  blockingReason,
  displayPhase,
  environmentActions,
  logMentionsService,
  openableLoopbackUrl,
  ownershipLabel,
  selectDisplayedProfile,
  websiteUrl,
  type EnvironmentIndex,
  type EnvironmentProfileView,
} from "@/i18n/environment";
import type { LogLine } from "../../../../shared/environment/types.ts";
import type { Project } from "../../../../shared/types.ts";

const LOG_CAP = 200;

interface Props {
  project: Project;
}

export function EnvironmentPage({ project }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [index, setIndex] = useState<EnvironmentIndex | null>(null);
  const [selectedId, setSelectedId] = useWorkspaceDraft<string | null>(`environment:${project.path}:selection`, null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [service, setService] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useWorkspaceDraft<"new" | "edit" | null>(`environment:${project.path}:editing`, null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const reload = async () => {
    const next = await api.getEnvironment(project.path);
    setIndex(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    setLogs([]);
    void api.getEnvironment(project.path).then(
      (next) => {
        if (cancelled) return;
        setIndex(next);
        setError(null);
        const picked = selectDisplayedProfile(next.profiles);
        setSelectedId(current => next.profiles.some(row => row.profile.id === current) ? current : picked?.profile.id ?? null);
      },
      (reason: unknown) => {
        if (!cancelled) setError(messageOf(reason));
      },
    );
    const unsubscribe = subscribeEnvironmentEvents((event) => {
      if (event.projectPath !== project.path) return;
      if (event.type === "environment_log") {
        setLogs((current) => {
          if (event.profileId !== selectedRef.current) return current;
          const next = [...current, { stream: event.stream, text: event.text, at: event.at }];
          return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
        });
        return;
      }
      void api.getEnvironment(project.path).then(
        (next) => {
          if (!cancelled) setIndex(next);
        },
        () => {},
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [project.path]);

  useEffect(() => {
    if (!selectedId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    void api.environmentLogs(project.path, selectedId, service || undefined).then(
      (payload) => {
        if (!cancelled) setLogs(payload.lines.slice(-LOG_CAP));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [project.path, selectedId, service]);

  const row = useMemo(() => {
    if (!index) return null;
    return index.profiles.find((profile) => profile.profile.id === selectedId) ?? selectDisplayedProfile(index.profiles);
  }, [index, selectedId, uiLocale]);

  const phase = displayPhase({
    configured: row !== null,
    recordedPhase: row?.status.recordedPhase ?? "stopped",
    ownership: row?.status.ownership ?? "none",
  });
  const actions = environmentActions(phase, row?.status.ownership ?? "none");
  const site = row ? websiteUrl(row.urls) : null;
  const href = site ? openableLoopbackUrl(site.url) : null;
  const reason = blockingReason(phase, row?.status.ownership ?? "none");
  const services = serviceRows(row);
  const visibleLogs = service ? logs.filter((line) => logMentionsService(line.text, service)) : logs;

  const run = (action: "start" | "stop" | "restart" | "refresh") => {
    if (!row) return;
    setBusy(true);
    setError(null);
    void api.environmentAction(project.path, row.profile.id, action).then(
      async () => {
        const next = await reload();
        const current = next.profiles.find((profile) => profile.profile.id === row.profile.id);
        if (current) {
          const payload = await api.environmentLogs(project.path, current.profile.id, service || undefined);
          setLogs(payload.lines.slice(-LOG_CAP));
        }
      },
      (reason: unknown) => setError(messageOf(reason)),
    ).finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-page" data-testid="environment-page">
      <header className="surface-solid flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[length:var(--text-base)] font-semibold">{project.name || tr("common.project_985959")}</h3>
          <p className="mt-1 text-[length:var(--text-secondary)] text-muted-foreground">
            <span data-testid="environment-phase" data-phase={phase}>{PHASE_LABELS[phase]}</span>
            {row ? ` · ${row.profile.name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {index && index.profiles.length > 1 && (
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-[length:var(--text-secondary)]"
              data-testid="environment-profile-select"
              value={row?.profile.id ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setConfirmDelete(false);
                setEditing(null);
              }}
            >
              {index.profiles.map((profile) => (
                <option key={profile.profile.id} value={profile.profile.id}>{profile.profile.name}</option>
              ))}
            </select>
          )}
          {actions.start && (
            <Button type="button" size="sm" disabled={busy} data-testid="environment-start" onClick={() => run("start")}><I18nText id="common.start" />{" "}</Button>
          )}
          {actions.stop && (
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="environment-stop" onClick={() => run("stop")}><I18nText id="common.stop" />{" "}</Button>
          )}
          {actions.restart && (
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="environment-restart" onClick={() => run("restart")}><I18nText id="common.restart" />{" "}</Button>
          )}
          {href && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="environment-open-website"
              onClick={() => {
                void api.openExternal(href).catch(() => setError("Could not open the local website"));
              }}
            ><I18nText id="environment.open_website" />{" "}</Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={row ? "ghost" : "default"}
            data-testid="environment-configure"
            onClick={() => {
              setEditing(row ? "edit" : "new");
              setConfirmDelete(false);
            }}
          >
            {row ? tr("m0.configure") : tr("m0.createProfile")}
          </Button>
          {row && (
            <Button type="button" size="sm" variant="ghost" data-testid="environment-new-profile" onClick={() => setEditing("new")}><I18nText id="environment.new_profile" />{" "}</Button>
          )}
          {row && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} data-testid="environment-refresh" onClick={() => run("refresh")} aria-label={tr("environment.refresh_status")}>
              <RefreshCw className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </header>

      {error && <p className="text-sm text-destructive" data-testid="environment-error">{error}</p>}

      {editing && index && (
        <ProfileForm
          key={`${editing}-${row?.profile.id ?? "new"}`}
          projectPath={project.path}
          existing={editing === "edit" ? row?.profile ?? null : null}
          suggestions={index?.suggestions.composeFiles ?? []}
          onCancel={() => setEditing(null)}
          onSave={async (profile) => {
            if (editing === "edit" && row) {
              await api.updateEnvironmentProfile(project.path, row.profile.id, { ...profile, id: row.profile.id });
              setSelectedId(row.profile.id);
            } else {
              const created = await api.createEnvironmentProfile(project.path, profile);
              if (created.profile) setSelectedId(created.profile.id);
            }
            await reload();
            setEditing(null);
          }}
        />
      )}

      {!editing && !row && index && (
        <section className="surface-solid rounded-xl border px-4 py-8 text-center" data-testid="environment-empty">
          <p className="text-sm text-muted-foreground"><I18nText id="environment.no_launch_profile_yet_create_one_to_start" /></p>
          {(index.suggestions.composeFiles.length > 0) && (
            <p className="mt-2 text-xs text-muted-foreground"><I18nText id="common.found" />{" "}{index.suggestions.composeFiles.map((file) => file.file).join(", ")}.
            </p>
          )}
        </section>
      )}

      {row && !editing && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="surface-solid min-w-0 rounded-xl border" data-testid="environment-services">
            <h4 className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 text-sm font-medium"><I18nText id="common.services" /></h4>
            {services.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground">
                {row.profile.launch.kind === "docker-compose"
                  ? `Every service in ${row.profile.launch.composeFile}.`
                  : "No services declared."}
              </p>
            ) : (
              <ul>
                {services.map((serviceRow) => (
                  <li key={serviceRow.name} className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 text-sm last:border-b-0">
                    <span className="font-medium">{serviceRow.name}</span>
                    <span className="text-xs text-muted-foreground">{serviceRow.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            {row.profile.expectedPorts.length > 0 && (
              <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="environment-ports"><I18nText id="environment.ports" />{" "}{row.profile.expectedPorts.map((port) => `${port.host}:${port.port}`).join(", ")}
              </p>
            )}
          </section>

          <section className="surface-solid min-w-0 rounded-xl border" data-testid="environment-urls">
            <h4 className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 text-sm font-medium"><I18nText id="environment.local_urls" /></h4>
            {row.urls.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted-foreground"><I18nText id="environment.no_local_urls_configured" /></p>
            ) : (
              <ul>
                {row.urls.map((url) => {
                  const local = openableLoopbackUrl(url.url);
                  return (
                    <li key={url.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 text-sm last:border-b-0" data-testid="environment-url">
                      <span>
                        <span className="font-medium">{url.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{urlStatusLabel(url.status)}</span>
                      </span>
                      {local ? (
                        <button
                          type="button"
                          className="min-w-0 max-w-full break-all text-left text-xs text-info underline-offset-2 hover:underline"
                          onClick={() => {
                            void api.openExternal(local).catch(() => setError("Could not open the local URL"));
                          }}
                        >
                          {local}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground"><I18nText id="environment.not_a_local_url" /></span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="surface-solid min-w-0 rounded-xl border lg:col-span-2" data-testid="environment-status-detail">
            <h4 className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 text-sm font-medium"><I18nText id="common.status" /></h4>
            <dl className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground"><I18nText id="environment.ownership" /></dt>
                <dd>{ownershipLabel(row.status.ownership)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground"><I18nText id="common.kind" /></dt>
                <dd>{row.profile.launch.kind === "docker-compose" ? tr("common.docker_compose") : tr("common.local_process")}</dd>
              </div>
              {row.status.pid !== null && (
                <div>
                  <dt className="text-xs text-muted-foreground">PID</dt>
                  <dd className="tabular-nums">{row.status.pid}</dd>
                </div>
              )}
              {row.status.composeProject && (
                <div>
                  <dt className="text-xs text-muted-foreground"><I18nText id="environment.compose_project" /></dt>
                  <dd>{row.status.composeProject}</dd>
                </div>
              )}
            </dl>
            {reason && <p className="px-4 pb-3 text-sm text-warning">{reason}</p>}
            {row.status.lastError && (
              <p className="px-4 pb-3 text-sm text-destructive" data-testid="environment-last-error">{row.status.lastError}</p>
            )}
            {row.status.health.length > 0 && (
              <ul className="border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2 text-xs" data-testid="environment-health">
                {row.status.health.map((check) => (
                  <li key={check.id} className={check.ok ? "text-success" : "text-destructive"}>
                    {check.id}: {check.detail}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-3">
              {confirmDelete ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    data-testid="profile-delete-confirm"
                    onClick={() => {
                      setBusy(true);
                      void api.deleteEnvironmentProfile(project.path, row.profile.id).then(
                        async () => {
                          setSelectedId(null);
                          setLogs([]);
                          setConfirmDelete(false);
                          await reload();
                        },
                        (reason: unknown) => setError(messageOf(reason)),
                      ).finally(() => setBusy(false));
                    }}
                  ><I18nText id="environment.delete_profile" />{" "}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}><I18nText id="common.cancel" />{" "}</Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="ghost" data-testid="profile-delete" onClick={() => setConfirmDelete(true)}><I18nText id="environment.delete_profile" />{" "}</Button>
              )}
            </div>
          </section>

          <section className="surface-solid min-w-0 rounded-xl border lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
              <h4 className="text-sm font-medium"><I18nText id="environment.logs" /></h4>
              {services.length > 1 && (
                <select
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  data-testid="environment-log-filter"
                  value={service}
                  onChange={(event) => setService(event.target.value)}
                >
                  <option value=""><I18nText id="environment.all_output" /></option>
                  {services.map((serviceRow) => (
                    <option key={serviceRow.name} value={serviceRow.name}>{serviceRow.name}</option>
                  ))}
                </select>
              )}
            </div>
            <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-5" data-testid="environment-logs">
              {visibleLogs.length === 0 ? "No log lines yet." : visibleLogs.map((line, index) => (
                <div key={`${line.at}-${index}`}>
                  <span className="text-muted-foreground">{line.stream} </span>
                  {line.text}
                </div>
              ))}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}

function serviceRows(row: EnvironmentProfileView | null): { name: string; detail: string }[] {
  if (!row) return [];
  if (row.profile.launch.kind === "local-process") {
    const executable = row.profile.launch.command.executable;
    const slash = executable.lastIndexOf("/");
    const name = slash >= 0 ? executable.slice(slash + 1) : executable;
    const health = row.status.health.map((check) => check.detail).filter(Boolean).join(" · ");
    return [{ name: name || executable, detail: health || PHASE_LABELS[displayPhase({ configured: true, recordedPhase: row.status.recordedPhase, ownership: row.status.ownership })] }];
  }
  return row.profile.launch.services.map((name) => {
    const check = row.status.health.find((outcome) => outcome.id === name || outcome.detail.includes(name));
    return { name, detail: check ? check.detail : tr("common.declared") };
  });
}

function urlStatusLabel(status: "up" | "down" | "unknown"): string {
  if (status === "up") return tr("common.up");
  if (status === "down") return tr("common.unavailable");
  return tr("common.not_checked");
}

function messageOf(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
