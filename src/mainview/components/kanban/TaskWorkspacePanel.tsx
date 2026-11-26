import { useCallback, useEffect, useState } from "react";
import type { Task } from "../../../shared/types.ts";
import type { TaskWorkspaceView } from "../../../shared/task-workspace.ts";
import { api } from "@/lib/api";
import { t as tr } from "@/i18n/core";
import { Button } from "@/components/ui/button";

export function TaskWorkspacePanel({ task, onChanged }: { task: Task; onChanged?: () => void }) {
  const [view, setView] = useState<TaskWorkspaceView | null>(null);
  const [outputPath, setOutputPath] = useState("");
  const [checkCommand, setCheckCommand] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.getTaskWorkspace(task.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("taskWorkspace.unavailable"));
    }
  }, [task.id]);

  useEffect(() => {
    void load();
  }, [load, task.column, task.runId]);

  const isWorkingCopy = view?.writeScope === "working-copy";
  const outputs = view?.changes.filter((entry) => entry.scope === "output" && entry.kind !== "unchanged") ?? [];
  const artifacts = view?.changes.filter((entry) => entry.scope === "artifact") ?? [];
  const unauthorized = view?.changes.filter((entry) => entry.scope === "unauthorized") ?? [];
  const checks = view?.checks ?? [];

  async function prepare() {
    const outputPaths = outputPath.split(",").map((item) => item.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      setView(await api.prepareTaskWorkspace({ taskId: task.id, outputPaths }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("taskWorkspace.unavailable"));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      setView(await api.publishTaskWorkspace({ taskId: task.id, approve: true, paths: selected }));
      setApproved(false);
      // Publication changes what the QC panels below read (first-review evidence) without moving the task.
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("taskWorkspace.unavailable"));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    const cmd = checkCommand.trim();
    if (!cmd) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runTaskWorkspaceCheck(task.id, cmd);
      if (result.workspace) setView(result.workspace);
      else await load();
      setCheckCommand("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("taskWorkspace.unavailable"));
    } finally {
      setBusy(false);
    }
  }

  async function abandon() {
    setBusy(true);
    setError(null);
    try {
      setView(await api.abandonTaskWorkspace(task.id));
      setSelected([]);
      setApproved(false);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("taskWorkspace.unavailable"));
    } finally {
      setBusy(false);
    }
  }

  const checkStatusTone = (status: string) =>
    status === "passed"
      ? "text-success"
      : status === "failed" || status === "blocked"
        ? "text-destructive"
        : "text-warning";

  return (
    <section className="space-y-2 rounded-md border border-border p-2 text-xs" data-testid="task-workspace-panel">
      <h3 className="text-sm font-medium">{tr("taskWorkspace.title")}</h3>
      <p data-testid="task-workspace-boundary">{tr(isWorkingCopy ? "taskWorkspace.workingCopy.boundary" : "taskWorkspace.boundary")}</p>
      {!view && task.column !== "done" && !task.qcState?.awaitingOwnerApproval && (
        <div className="space-y-1">
          <label className="block">
            {tr("taskWorkspace.outputs")}
            <input
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1"
              value={outputPath}
              data-testid="task-workspace-output-input"
              onChange={(event) => setOutputPath(event.target.value)}
            />
          </label>
          <Button type="button" size="sm" disabled={busy || outputPath.trim() === ""} data-testid="task-workspace-prepare" onClick={() => void prepare()}>
            {tr("taskWorkspace.prepare")}
          </Button>
        </div>
      )}
      {view && (
        <div className="space-y-2">
          <p data-testid="task-workspace-status">{view.status}</p>
          <p data-testid="task-workspace-baseline">{tr("taskWorkspace.baseline")}: {view.gitHead.slice(0, 12)} · {view.fingerprint.slice(0, 12)}</p>
          {isWorkingCopy ? (
            <div className="space-y-0.5">
              <p data-testid="task-workspace-outputs">{tr("taskWorkspace.workingCopy.scope")}</p>
              {view.scratchPath && (
                <p className="break-all font-mono text-[11px] text-muted-foreground" data-testid="task-workspace-scratch">
                  {tr("taskWorkspace.workingCopy.scratch")}: {view.scratchPath}
                </p>
              )}
            </div>
          ) : (
            <p data-testid="task-workspace-outputs">{tr("taskWorkspace.outputs")}: {view.outputPaths.join(", ")}</p>
          )}
          <p data-testid="task-workspace-run">{tr("taskWorkspace.run")}: {view.developerRunId ?? "—"} · {tr("taskWorkspace.exit")}: {view.exitCode ?? "—"}</p>
          {view.interruption && (
            <p className="text-warning" data-testid="task-workspace-interrupted" data-reason={view.interruption.reason}>
              {tr(view.interruption.reason === "time-limit" ? "stop.workspace.interrupted.time-limit" : "stop.workspace.interrupted.manual")}
            </p>
          )}
          {view.violation && <p className="text-destructive" data-testid="task-workspace-violation">{tr("taskWorkspace.violation")}</p>}
          {unauthorized.length > 0 && (
            <p data-testid="task-workspace-unauthorized">{tr("taskWorkspace.unauthorized")}: {unauthorized.map((entry) => entry.path).join(", ")}</p>
          )}
          {outputs.length > 0 && (
            <div className="space-y-1">
              {outputs.length > 1 && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSelected(outputs.map((entry) => entry.path))}>
                    {tr("taskWorkspace.workingCopy.select_all")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setSelected([])}>
                    {tr("taskWorkspace.workingCopy.clear_all")}
                  </Button>
                </div>
              )}
              <ul className="space-y-1" data-testid="task-workspace-changes">
                {outputs.map((entry) => (
                  <li key={entry.path}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(entry.path)}
                        data-testid={`task-workspace-pick-${entry.path.replaceAll("/", "-")}`}
                        onChange={(event) => setSelected((current) => event.target.checked ? [...current, entry.path] : current.filter((path) => path !== entry.path))}
                      />
                      <span>
                        {entry.kind} {entry.path}
                        {entry.renamedFrom ? ` (${tr("taskWorkspace.workingCopy.renamed_from", { from: entry.renamedFrom })})` : ""}
                      </span>
                    </label>
                    <span className="text-muted-foreground">{entry.beforeSha256?.slice(0, 12) ?? "absent"} → {entry.afterSha256?.slice(0, 12) ?? "absent"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {isWorkingCopy && artifacts.length > 0 && (
            <p className="text-[11px] text-muted-foreground" data-testid="task-workspace-artifacts">
              {tr("taskWorkspace.workingCopy.artifacts")}: {artifacts.map((entry) => entry.path).join(", ")}
            </p>
          )}
          {isWorkingCopy && view.diff && (
            <details className="rounded border border-border/70 p-2" data-testid="task-workspace-diff">
              <summary className="cursor-pointer font-medium">{tr("taskWorkspace.workingCopy.diff")}</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{view.diff}</pre>
            </details>
          )}
          {isWorkingCopy && (
            <div className="space-y-1.5 rounded border border-border/70 p-2" data-testid="task-workspace-checks">
              <p className="font-medium">{tr("taskWorkspace.workingCopy.checks")}</p>
              {checks.length === 0 ? (
                <p className="text-muted-foreground" data-testid="task-workspace-checks-not-run">{tr("taskWorkspace.workingCopy.checks_not_run")}</p>
              ) : (
                <ul className="space-y-1.5">
                  {checks.map((check) => (
                    <li key={check.id} className="rounded border border-border/50 p-1.5" data-testid="task-workspace-check-row" data-status={check.status}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <code className="break-all text-[11px]">{check.command}</code>
                        <span className={`font-medium ${checkStatusTone(check.status)}`}>
                          {tr(`taskWorkspace.workingCopy.check_status.${check.status}`)}
                          {check.exitCode != null ? ` (${check.exitCode})` : ""}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{check.reason}</p>
                      {check.summary && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1 font-mono text-[10px]">{check.summary}</pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {(view.status === "settled" || view.status === "publication-partial") && !view.interruption && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <input
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
                    value={checkCommand}
                    placeholder={tr("taskWorkspace.workingCopy.run_check_placeholder")}
                    aria-label={tr("taskWorkspace.workingCopy.run_check_label")}
                    data-testid="task-workspace-check-input"
                    onChange={(event) => setCheckCommand(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !busy && checkCommand.trim()) void runCheck(); }}
                  />
                  <Button type="button" size="sm" variant="outline" disabled={busy || checkCommand.trim() === ""} data-testid="task-workspace-check-run" onClick={() => void runCheck()}>
                    {tr("taskWorkspace.workingCopy.run_check_btn")}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div data-testid="task-workspace-evidence">
            <p>{tr("taskWorkspace.evidence")}</p>
            <p data-testid="task-workspace-evidence-included">{view.evidenceScope.included.map((item) => `${item.role}:${item.path}`).join(", ") || "—"}</p>
            <p data-testid="task-workspace-evidence-omitted">{view.evidenceScope.omitted.map((item) => item.path).join(", ")}</p>
          </div>
          <p data-testid="task-workspace-separate">{tr("taskWorkspace.separate")}</p>
          {(view.status === "settled" || view.status === "publication-partial") && outputs.length > 0 && !view.interruption && (
            <div className="space-y-1">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={approved} data-testid="task-workspace-approve" onChange={(event) => setApproved(event.target.checked)} />
                {tr("taskWorkspace.approve")}
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={busy || !approved || selected.length === 0} data-testid="task-workspace-publish" onClick={() => void publish()}>
                  {tr("taskWorkspace.publish")}
                </Button>
                {isWorkingCopy && (
                  <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="task-workspace-abandon" onClick={() => void abandon()}>
                    {tr("taskWorkspace.workingCopy.abandon")}
                  </Button>
                )}
              </div>
            </div>
          )}
          {isWorkingCopy && (view.status === "settled" || view.status === "armed") && (outputs.length === 0 || view.interruption) && (
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="task-workspace-abandon" onClick={() => void abandon()}>
              {tr("taskWorkspace.workingCopy.abandon")}
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-destructive" data-testid="task-workspace-error">{error}</p>}
    </section>
  );
}
