import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TechnicalDetails } from "@/components/ui/technical-details";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/batches";
import { permissionAuthorityText, permissionOutcomeText, permissionStatusText } from "@/lib/project-permissions";
import { subscribeProjectPermissionEvents } from "@/lib/project-permission-events";
import { projectLabel } from "@/lib/workspace";
import { looksLikeTestCommand, projectDefault, type ProjectPermissionsPayload } from "../../../shared/project-permissions.ts";
import type { Project } from "../../../shared/types.ts";

/**
 * Settings → Autonomy and safety → Project permissions.
 * Durable project rules for one action: run one fixed test file in the offline
 * sandbox. Reading this panel changes nothing and starts nothing; a rule or a
 * default is written only by the buttons below.
 */
export function ProjectPermissionsPanel() {
  useUILocale();
  const confirm = useConfirm();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [path, setPath] = useState("");
  const [payload, setPayload] = useState<ProjectPermissionsPayload | null>(null);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void api.listProjects().then((list) => { if (!cancelled) setProjects(list); }, () => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback((projectPath: string) => {
    if (!projectPath) { setPayload(null); return; }
    const mine = ++seq.current;
    void api.getProjectPermissions(projectPath).then(
      (next) => { if (mine === seq.current) { setPayload(next); setError(null); } },
      (e) => { if (mine === seq.current) setError(e instanceof Error ? e.message : String(e)); },
    );
  }, []);
  useEffect(() => { load(path); }, [path, load]);
  useEffect(() => subscribeProjectPermissionEvents((event) => { if (event.projectPath === path) load(path); }), [path, load]);

  const project = projects?.find((p) => p.path === path) ?? null;
  const rules = payload?.rules ?? [];
  const allowRules = rules.filter((rule) => rule.mode === "allow");
  const current = projectDefault(rules, path);
  const commandOk = looksLikeTestCommand(command);
  const commandEntered = command.trim().length > 0;

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
      toast.success(done);
      load(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    if (!project || !commandOk) return;
    const ok = await confirm({
      title: tr("perm.rules.confirm_title"),
      description: tr("perm.rules.confirm_body", { project: projectLabel(project), command: command.trim() }),
      confirmLabel: tr("perm.rules.confirm"),
    });
    if (!ok) return;
    await run(() => api.addProjectPermissionRule(project.path, command.trim()), tr("perm.rules.added"));
    setCommand("");
  }

  return (
    <div className="space-y-4" data-testid="project-permissions">
      <p className="text-sm text-muted-foreground" data-testid="perm-hint">{tr("perm.panel.hint")}</p>
      {projects !== null && projects.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="perm-no-projects">{tr("perm.project.none")}</p>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tr("perm.project.label")}</span>
          <Select value={path} onChange={(e) => setPath(e.target.value)} data-testid="perm-project-select">
            <option value="">{tr("perm.project.choose")}</option>
            {(projects ?? []).map((p) => <option key={p.path} value={p.path}>{projectLabel(p)}</option>)}
          </Select>
        </label>
      )}

      {project && payload && (
        <div className="space-y-4" data-testid="perm-project-body">
          <section className="space-y-2 rounded-md border border-border/60 p-3" data-testid="perm-workspace-development">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <h4 className="text-sm font-medium">{tr("perm.dev.title")}</h4>
                <p className="text-xs text-muted-foreground">{tr("perm.dev.desc")}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs font-medium">
                <Switch
                  checked={Boolean(payload.workspaceDevelopment)}
                  disabled={busy}
                  onCheckedChange={(checked) => void run(
                    () => api.setProjectWorkspaceDevelopment(project.path, checked),
                    tr(checked ? "perm.dev.saved_on" : "perm.dev.saved_off"),
                  )}
                  data-testid="perm-workspace-development-toggle"
                />
                <span>{tr(payload.workspaceDevelopment ? "perm.dev.enabled" : "perm.dev.disabled")}</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{tr("perm.dev.boundaries")}</p>
            <p className="text-xs text-muted-foreground">{tr("perm.dev.next_launch")}</p>
          </section>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tr("perm.default.label")}</span>
            <Select
              value={current}
              disabled={busy}
              onChange={(e) => void run(() => api.setProjectPermissionDefault(project.path, e.target.value as "ask" | "deny"), tr("perm.default.saved"))}
              data-testid="perm-default-select"
            >
              <option value="ask">{tr("perm.default.ask")}</option>
              <option value="deny">{tr("perm.default.deny")}</option>
            </Select>
          </label>

          <section className="space-y-2" aria-label={tr("perm.rules.title")}>
            <h4 className="text-sm font-medium">{tr("perm.rules.title")}</h4>
            {allowRules.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="perm-rules-none">{tr("perm.rules.none")}</p>
            ) : (
              <ul className="space-y-1.5">
                {allowRules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2" data-testid="perm-rule-row" data-rule-id={rule.id}>
                    <span className="min-w-0 flex-1 basis-48 text-sm">
                      <span className="block text-xs text-muted-foreground">{tr("perm.rules.allowed")}</span>
                      <code className="break-all text-xs" data-testid="perm-rule-command">{rule.command}</code>
                    </span>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.revokeProjectPermissionRule(rule.id), tr("perm.rules.revoked"))} data-testid="perm-rule-revoke">
                      {tr("perm.rules.revoke")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-1 rounded-md border border-border/60 p-2">
              <label className="block space-y-1 text-sm">
                <span className="font-medium">{tr("perm.rules.add_title")}</span>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={tr("perm.rules.placeholder")} spellCheck={false} autoCapitalize="off" autoCorrect="off" data-testid="perm-rule-input" aria-label={tr("perm.rules.command")} />
              </label>
              {commandEntered && !commandOk && <p className="text-xs text-danger" role="alert" data-testid="perm-rule-invalid">{tr("perm.rules.invalid")}</p>}
              <Button type="button" size="sm" variant="outline" disabled={busy || !commandOk} onClick={() => void addRule()} data-testid="perm-rule-add">{tr("perm.rules.add")}</Button>
            </div>
          </section>

          <section className="space-y-2" aria-label={tr("perm.history.title")}>
            <h4 className="text-sm font-medium">{tr("perm.history.title")}</h4>
            {payload.requests.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="perm-history-none">{tr("perm.history.none")}</p>
            ) : (
              <ul className="space-y-1.5">
                {payload.requests.slice(0, 10).map((request) => (
                  <li key={request.id} className="space-y-1 rounded-md border border-border/60 p-2 text-sm" data-testid="perm-history-row" data-status={request.status} data-request-id={request.id}>
                    <p className="font-medium">
                      <span data-testid="perm-history-status">{permissionStatusText(request.status)}</span>
                      {" · "}{request.taskTitle}
                      <span className="font-normal text-muted-foreground">{" · "}{formatTime(request.createdAt)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{permissionOutcomeText(request)}{request.authority ? ` ${permissionAuthorityText(request.authority)}.` : ""}</p>
                    <TechnicalDetails
                      rows={[
                        { label: tr("perm.tech.request"), value: request.id },
                        { label: tr("perm.tech.command"), value: request.command },
                        { label: tr("perm.tech.cwd"), value: request.cwd },
                        { label: tr("perm.tech.source"), value: request.sourceFingerprint },
                        { label: tr("perm.tech.operation"), value: request.commandFingerprint },
                        { label: tr("perm.tech.message"), value: request.reason },
                        { label: tr("perm.tech.exit"), value: request.exitCode == null ? null : String(request.exitCode) },
                        { label: tr("perm.tech.isolation"), value: request.isolation },
                        { label: tr("perm.tech.output"), value: request.summary },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {error && <p className="text-sm text-danger" role="alert" data-testid="perm-error">{error}</p>}
      <p className="text-xs text-muted-foreground" data-testid="perm-limits">{tr("perm.panel.limits")}</p>
    </div>
  );
}
