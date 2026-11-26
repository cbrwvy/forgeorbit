import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { Check, CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { goalBlocker, stepSatisfied, type AiToolReadiness, type GettingStartedStatus, type GettingStartedStep, type GettingStartedStepId } from "@/lib/getting-started";
import { cn } from "@/lib/utils";

interface Props {
  steps: readonly GettingStartedStep[];
  ai: AiToolReadiness;
  /** Opens the native folder picker / project wizard. Registers a folder only. */
  onAddProject: () => void;
  /** Opens Settings on the AI tools panel. Changes nothing by itself. */
  onOpenAiSettings: () => void;
  /** Moves focus to Home's goal target select (M6). Never picks a project, never sends. */
  onChooseTarget: () => void;
  onDismiss: () => void;
}

const STEP_TITLE: Record<GettingStartedStepId, TranslationKey> = {
  project: "m7.gs.step.project",
  "ai-tool": "m7.gs.step.ai-tool",
  goal: "m7.gs.step.goal",
};

function StepMarker({ status, index }: { status: GettingStartedStatus; index: number }) {
  if (status === "done") {
    return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success" aria-hidden><Check className="size-3.5" /></span>;
  }
  if (status === "unchecked") {
    return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-info/15 text-info" aria-hidden><CircleHelp className="size-3.5" /></span>;
  }
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted-foreground" aria-hidden>{index + 1}</span>;
}

/**
 * The one getting-started block on Home (FO-UX-SIMPLIFY02-M7): Add a project, Set up an AI tool,
 * Give the Head of PM a goal. It reads state the app already holds and never infers readiness:
 * an AI tool whose sign-in cannot be read is shown as "installed — sign-in not checked", not as done.
 * Nothing here sends a message, creates a grant or starts work; every action only opens an existing
 * screen or focuses an existing control.
 */
export function GettingStarted({ steps, ai, onAddProject, onOpenAiSettings, onChooseTarget, onDismiss }: Props) {
  useUILocale();
  const done = steps.filter((step) => step.status === "done").length;
  const label = ai.label ?? "";
  const blocker = goalBlocker(ai);
  const projectStep = steps.find((step) => step.id === "project");

  const describe = (step: GettingStartedStep): string => {
    switch (step.id) {
      case "project":
        return tr(step.status === "done" ? "m7.gs.project.done" : "m7.gs.project.todo");
      case "ai-tool":
        return tr(`m7.gs.ai.${ai.state}` as TranslationKey, { label });
      case "goal":
        return tr(step.status === "done" ? "m7.gs.goal.done" : step.status === "blocked" ? "m7.gs.goal.blocked" : "m7.gs.goal.todo");
    }
  };

  const action = (step: GettingStartedStep) => {
    if (step.id === "project" && step.status !== "done") {
      return <Button type="button" size="sm" onClick={onAddProject} data-testid="getting-started-add-project">{tr("m7.gs.project.action")}</Button>;
    }
    if (step.id === "ai-tool" && step.status !== "done") {
      return <Button type="button" size="sm" variant="outline" onClick={onOpenAiSettings} data-testid="getting-started-open-ai-settings">{tr("m7.gs.ai.action")}</Button>;
    }
    if (step.id === "goal" && step.status === "todo") {
      return <Button type="button" size="sm" variant="outline" onClick={onChooseTarget} data-testid="getting-started-choose-target">{tr("m7.gs.goal.action")}</Button>;
    }
    return null;
  };

  return (
    <section className="surface-solid flex flex-col gap-3 rounded-xl border px-4 py-3" data-testid="getting-started" aria-labelledby="getting-started-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id="getting-started-heading" className="text-sm font-semibold">{tr("m7.gs.title")}</h2>
          <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("m7.gs.intro")}</p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={onDismiss} data-testid="getting-started-dismiss">{tr("m7.gs.dismiss")}</Button>
          <span className="text-[11px] text-muted-foreground" data-testid="getting-started-progress">{tr("m7.gs.progress", { done: String(done), total: String(steps.length) })}</span>
        </div>
      </div>

      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={cn("flex flex-wrap items-start gap-3 rounded-lg border border-border/60 px-3 py-2", stepSatisfied(step) && "bg-muted/30")}
            data-testid={`getting-started-step-${step.id}`}
            data-status={step.status}
          >
            <StepMarker status={step.status} index={index} />
            <div className="min-w-0 flex-1 basis-56 space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cn("text-sm font-medium", step.status === "done" && "text-muted-foreground")}>{tr(STEP_TITLE[step.id])}</span>
                <span className="text-[11px] text-muted-foreground" data-testid={`getting-started-status-${step.id}`}>{tr(`m7.gs.status.${step.status}` as TranslationKey)}</span>
              </div>
              <p className="text-[length:var(--text-secondary)] text-muted-foreground" data-testid={`getting-started-detail-${step.id}`}>{describe(step)}</p>
              {step.id === "ai-tool" && ai.state === "needs-login" && ai.authHelp && (
                <p className="text-[11px] text-muted-foreground" data-testid="getting-started-auth-help">{ai.authHelp}</p>
              )}
              {step.id === "goal" && step.status === "todo" && blocker && projectStep?.status === "done" && (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[length:var(--text-secondary)]" data-testid="getting-started-goal-blocker" data-blocker={blocker}>
                  {tr(`m7.gs.goal.blocker.${blocker}` as TranslationKey)}{" "}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenAiSettings} data-testid="getting-started-goal-blocker-settings">{tr("m7.gs.ai.action")}</button>
                </p>
              )}
            </div>
            {action(step)}
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-muted-foreground">{tr("m7.gs.hint")}</p>
    </section>
  );
}
