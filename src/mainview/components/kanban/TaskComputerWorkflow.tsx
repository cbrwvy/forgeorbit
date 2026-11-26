import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/core";
import { api } from "@/lib/api";
import type { TaskComputerReview, TaskComputerScope } from "../../../shared/task-computer-workflow.ts";
import type { Task } from "../../../shared/types.ts";

type View = Awaited<ReturnType<typeof api.getTaskComputerWorkflow>>;
const defaultBrowser = { url: "", expected: "", submitLabel: "" };
const defaultDocument = { document: "", find: "", replace: "" };

function useWorkflow(task: Task, enabled = true) {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const refresh = () => void api.getTaskComputerWorkflow(task.id)
      .then(result => { if (current) setView(result); }).catch(() => undefined);
    refresh();
    const timer = task.column === "running" ? setInterval(refresh, 1200) : null;
    return () => { current = false; if (timer) clearInterval(timer); };
  }, [task.id, task.computerWorkflowRevision, task.runId, task.column, enabled]);
  return [view, setView] as const;
}

export function TaskComputerReviewSummary({ review }: { review: TaskComputerReview }) {
  return <div className="ds-panel space-y-2 p-3 text-sm [overflow-wrap:anywhere]" data-testid="task-computer-review">
    <p className="font-medium">{t(review.kind === "browser" ? "taskComputer.browser" : "taskComputer.textedit")}</p>
    {review.kind === "browser" ? <>
      <p className="break-words">{t("taskComputer.approvedSite", { page: review.page })}</p>
      <p>{t("taskComputer.reviewExpected", { value: review.expected })}</p>
      {review.fields.length > 0 && <p>{t("taskComputer.reviewFields", { value: review.fields.join(", ") })}</p>}
      <p>{review.submitLabel ? t("taskComputer.reviewSubmit", { label: review.submitLabel })
        : t(review.fields.length ? "taskComputer.fillOnly" : "taskComputer.observeOnly")}</p>
      <p className="text-xs text-muted-foreground">{t("taskComputer.browserBoundary")}</p>
    </> : <>
      <p className="break-words">{t("taskComputer.reviewDocument", { app: review.application, path: `${review.workspace}/${review.document}` })}</p>
      <p>{t(review.writable ? "taskComputer.reviewWrite" : "taskComputer.observeOnly")}</p>
    </>}
    <p className="text-xs text-muted-foreground">{t("taskComputer.once")}</p>
  </div>;
}

export function TaskComputerResult({ task }: { task: Task }) {
  const [view] = useWorkflow(task, Boolean(task.computerWorkflowRevision));
  if (!view?.run || view.run.runId !== task.runId) return null;
  const outcome = view.run.outcome;
  return <p className="text-sm" role="status" data-testid="task-computer-result" data-outcome={outcome}>
    {t(`taskComputer.outcome.${outcome}`)}
  </p>;
}

export function TaskComputerWorkflowDetails({ task, onChanged }: { task: Task; onChanged?: (id: string, patch: Partial<Task>) => void }) {
  const [view, setView] = useWorkflow(task);
  const [kind, setKind] = useState<TaskComputerScope["kind"]>("browser");
  const [editing, setEditing] = useState(false);
  const [browser, setBrowser] = useState(defaultBrowser);
  const [fields, setFields] = useState([{ label: "", value: "" }]);
  const [document, setDocument] = useState(defaultDocument);
  const [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<{ runId: string; image: string } | null>(null);
  if (task.pipelineId || task.pipelineParentId || task.objectiveMissionId) return null;
  const editable = task.archivedAt == null && !["running", "done"].includes(task.column);
  const run = view?.run;

  async function save(scope: TaskComputerScope | null) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveTaskComputerWorkflow(task.id, scope);
      setView(next);
      onChanged?.(task.id, { computerWorkflowRevision: next.review?.revision });
      setEditing(false);
      setFields([{ label: "", value: "" }]);
      setDocument(defaultDocument);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }

  const configure = () => {
    const review = view?.review;
    if (review?.kind === "browser") {
      setKind("browser");
      setBrowser({ url: review.page, expected: review.expected, submitLabel: review.submitLabel ?? "" });
      setFields(review.fields.length ? review.fields.map(label => ({ label, value: "" })) : [{ label: "", value: "" }]);
    } else if (review?.kind === "textedit") {
      setKind("textedit");
      setDocument({ ...defaultDocument, document: review.document });
      setWritable(review.writable);
    }
    setEditing(true);
  };

  return <section className="space-y-3 rounded-lg border border-border p-3" data-testid="task-computer-workflow">
    <h3 className="text-sm font-semibold">{t("taskComputer.title")}</h3>
    <p className="text-xs text-muted-foreground">{t(editable ? "taskComputer.setupHint" : "taskComputer.readOnlyScope")}</p>
    {view?.review && !editing && <TaskComputerReviewSummary review={view.review} />}
    {view?.used && <p className="text-xs text-warning">{t("taskComputer.used")}</p>}
    {editable && !editing && <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={configure}>{t(view?.review ? "taskComputer.editScope" : "taskComputer.configure")}</Button>
      {view?.review && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>{t("taskComputer.remove")}</Button>}
    </div>}
    {editing && editable && <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      void save(kind === "browser" ? { kind, ...browser, submitLabel: browser.submitLabel.trim() || null,
        fields: fields.filter(field => field.label.trim()) }
        : { kind, document: document.document, edit: writable ? { find: document.find, replace: document.replace } : null });
    }}>
      <label className="block space-y-1 text-sm">
        <span>{t("taskComputer.kind")}</span>
        <select value={kind} onChange={event => setKind(event.target.value as TaskComputerScope["kind"])} className="block w-full rounded border border-border bg-background p-2">
          <option value="browser">{t("taskComputer.browser")}</option>
          <option value="textedit">{t("taskComputer.textedit")}</option>
        </select>
      </label>
      {kind === "browser" ? <>
        <label className="block space-y-1 text-sm"><span>{t("taskComputer.site")}</span><Input required type="url" value={browser.url} onChange={event => setBrowser({ ...browser, url: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>{t("taskComputer.expected")}</span><Input required maxLength={240} value={browser.expected} onChange={event => setBrowser({ ...browser, expected: event.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>{t("taskComputer.submit")}</span><Input maxLength={120} value={browser.submitLabel} onChange={event => setBrowser({ ...browser, submitLabel: event.target.value })} /></label>
        <p className="text-xs text-muted-foreground">{t("taskComputer.testData")}</p>
        {fields.map((field, index) => <div key={index} className="grid gap-2 sm:grid-cols-2">
          <Input aria-label={t("taskComputer.fieldLabel")} placeholder={t("taskComputer.fieldLabel")} maxLength={120} value={field.label}
            onChange={event => setFields(previous => previous.map((item, n) => n === index ? { ...item, label: event.target.value } : item))} />
          <Input aria-label={t("taskComputer.fieldValue")} placeholder={t("taskComputer.fieldValue")} maxLength={240} value={field.value} autoComplete="off"
            onChange={event => setFields(previous => previous.map((item, n) => n === index ? { ...item, value: event.target.value } : item))} />
        </div>)}
        <Button type="button" size="sm" variant="ghost" disabled={fields.length >= 8} onClick={() => setFields(previous => [...previous, { label: "", value: "" }])}>{t("taskComputer.addField")}</Button>
      </> : <>
        <label className="block space-y-1 text-sm"><span>{t("taskComputer.document")}</span><Input required value={document.document} onChange={event => setDocument({ ...document, document: event.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writable} onChange={event => setWritable(event.target.checked)} />{t("taskComputer.allowEdit")}</label>
        {writable && <>
          <label className="block space-y-1 text-sm"><span>{t("taskComputer.find")}</span><Input required maxLength={160} value={document.find} onChange={event => setDocument({ ...document, find: event.target.value })} /></label>
          <label className="block space-y-1 text-sm"><span>{t("taskComputer.replacement")}</span><Input maxLength={160} value={document.replace} onChange={event => setDocument({ ...document, replace: event.target.value })} /></label>
        </>}
      </>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>{t("taskComputer.saveScope")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t("mc.cancel")}</Button>
      </div>
    </form>}
    {run && <div className="space-y-2" data-testid="task-computer-history">
      <p className="text-sm">{t(`taskComputer.outcome.${run.outcome}`)}</p>
      {run.steps.length > 0 && <ol className="list-decimal space-y-1 pl-5 text-xs">
        {run.steps.map((step, index) => <li key={index}>
          <span className="font-medium">{t(`taskComputer.step.${step.operation}`)}{step.label && ` · ${step.label}`}</span>
          <span className="block break-all text-muted-foreground">{[step.page, step.observed].filter(Boolean).join(" · ")}</span>
          {step.outcome !== "running" && step.outcome !== "verified" && <span>{t(`taskComputer.outcome.${step.outcome}`)}</span>}
        </li>)}
      </ol>}
      {run.screenshot && (screenshot?.runId === run.runId
        ? <img className="w-full rounded border border-border" src={`data:image/png;base64,${screenshot.image}`} alt={t("taskComputer.screenshot")} />
        : <Button size="sm" variant="outline" onClick={() => void api.getTaskComputerScreenshot(task.id, run.runId)
          .then(result => setScreenshot({ runId: run.runId, image: result.image })).catch(problem => setError(problem.message))}>{t("taskComputer.screenshot")}</Button>)}
    </div>}
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
  </section>;
}
