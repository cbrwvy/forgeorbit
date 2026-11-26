import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SearchSelect } from "@/components/ui/search-select";
import { MultiSearchSelect, type MultiSearchSelectItem } from "@/components/ui/multi-search-select";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import { outgoingSteps } from "../../../shared/pipeline.ts";
import { PIPELINE_LIMITS, type AgentProfile, type Harness, type PipelineGraph, type PipelineStep } from "../../../shared/types.ts";

import { AgentProfilePicker } from "../kanban/AgentProfilePicker";
import { AgentProfileFormDialog } from "../kanban/AgentProfileFormDialog";

interface StepPanelProps {
  step: PipelineStep;
  graph: PipelineGraph;
  profiles: AgentProfile[];
  harnesses: Harness[];
  onChange: (step: PipelineStep) => void;
  onConnect: (toId: string) => void;
  onEdgeLabel: (edgeId: string, label: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onSetStart: () => void;
  onDelete: () => void;
  onProfilesChanged: () => void;
  className?: string;
}

/**
 * The canvas editor's right-hand side panel for the selected step — name,
 * instructions, agent profile (+ inline "New agent…"), subagent delegation
 * (profiles + cap), transition/join behavior, outgoing connections, and
 * step-level actions (set start, delete). See `docs/plans/pipelines.md` T5.
 */
export function StepPanel({
  step,
  graph,
  profiles,
  harnesses,
  onChange,
  onConnect,
  onEdgeLabel,
  onRemoveEdge,
  onSetStart,
  onDelete,
  onProfilesChanged,
  className,
}: StepPanelProps) {
  useUILocale();
  const confirm = useConfirm();
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  const subagentItems: MultiSearchSelectItem[] = profiles
    .filter((p) => p.id !== step.agentProfileId)
    .map((p) => ({ value: p.id, label: p.name, hint: p.harness }));

  const connectItems = graph.steps
    .filter((s) => s.id !== step.id)
    .map((s) => ({ value: s.id, label: s.name }));

  const outgoing = outgoingSteps(graph, step.id);
  const isStart = graph.startStepId === step.id;

  const capUnlimited = step.subagents.cap == null;

  const handleDelete = async () => {
    const ok = await confirm(() => ({
      title: tr("common.delete_step", { p0: String(step.name) }),
      description: tr("common.this_removes_the_step_and_every_connection_to"),
      confirmLabel: tr("pipelines.delete_step"),
      variant: "destructive",
    }));
    if (ok) onDelete();
  };

  return (
    <div data-testid="pipeline-step-panel" className={cn("flex h-full flex-col gap-4 overflow-y-auto p-4", className)}>
      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="pipeline-step-name-input"><I18nText id="pipelines.step_name" />{" "}</label>
        <Input
          id="pipeline-step-name-input"
          data-testid="pipeline-step-name"
          value={step.name}
          maxLength={PIPELINE_LIMITS.stepName}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
          className="mt-1"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="pipeline-step-instructions-input"><I18nText id="common.instructions" />{" "}</label>
        <Textarea
          id="pipeline-step-instructions-input"
          data-testid="pipeline-step-instructions"
          value={step.instructions}
          maxLength={PIPELINE_LIMITS.instructions}
          onChange={(e) => onChange({ ...step, instructions: e.target.value })}
          className="mt-1 min-h-[120px]"
          placeholder={tr("pipelines.what_should_this_step_do")}
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground"><I18nText id="common.agent" /></span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="pipeline-step-new-agent"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={() => setNewAgentOpen(true)}
          >
            <Plus className="size-3" aria-hidden /><I18nText id="pipelines.new_agent" />{" "}</Button>
        </div>
        <AgentProfilePicker
          value={step.agentProfileId}
          onChange={(id) => onChange({ ...step, agentProfileId: id })}
          profiles={profiles}
          harnesses={harnesses}
          className="mt-1"
        />
        <AgentProfileFormDialog
          open={newAgentOpen}
          profileId={null}
          onClose={() => setNewAgentOpen(false)}
          onSaved={(profile) => {
            onProfilesChanged();
            onChange({ ...step, agentProfileId: profile.id });
            setNewAgentOpen(false);
          }}
        />
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground"><I18nText id="pipelines.subagents_this_step_may_delegate_to" /></span>
        <div data-testid="pipeline-step-subagents" className="mt-1">
          <MultiSearchSelect
            values={step.subagents.profileIds}
            onChange={(profileIds) => onChange({ ...step, subagents: { ...step.subagents, profileIds } })}
            items={subagentItems}
            emptyLabel={tr("pipelines.no_subagents_allowed")}
            placeholder={tr("common.search_agents")}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Switch
            data-testid="pipeline-step-cap-unlimited"
            checked={capUnlimited}
            onCheckedChange={(checked) =>
              onChange({ ...step, subagents: { ...step.subagents, cap: checked ? null : 1 } })
            }
          />
          <span className="text-xs text-muted-foreground"><I18nText id="pipelines.no_limit" /></span>
          {!capUnlimited && (
            <Input
              type="number"
              min={1}
              max={PIPELINE_LIMITS.subagentCap}
              data-testid="pipeline-step-cap"
              value={step.subagents.cap ?? 1}
              onChange={(e) => {
                // Clamp into the server's own accepted range so a typed
                // value can't make Save fail validation later.
                const n = Math.min(PIPELINE_LIMITS.subagentCap, Math.max(1, Math.floor(Number(e.target.value) || 1)));
                onChange({ ...step, subagents: { ...step.subagents, cap: n } });
              }}
              className="h-7 w-20"
            />
          )}
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground"><I18nText id="pipelines.after_this_step" /></span>
        <div data-testid="pipeline-step-transition" role="radiogroup" className="mt-1 flex flex-col gap-1.5">
          <RadioRow
            testId="pipeline-step-transition-choose"
            checked={step.transition === "choose"}
            onSelect={() => onChange({ ...step, transition: "choose" })}
            label={tr("pipelines.let_the_agent_choose_one_next_step")}
          />
          <RadioRow
            testId="pipeline-step-transition-all"
            checked={step.transition === "all"}
            onSelect={() => onChange({ ...step, transition: "all" })}
            label={tr("pipelines.run_all_next_steps_in_parallel")}
          />
        </div>
        {step.transition === "all" && (
          <p className="mt-1 text-xs text-warning"><I18nText id="pipelines.parallel_steps_share_this_pipeline_s_worktree_keep" />{" "}</p>
        )}
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground"><I18nText id="pipelines.start_when" /></span>
        <div data-testid="pipeline-step-join" role="radiogroup" className="mt-1 flex flex-col gap-1.5">
          <RadioRow
            testId="pipeline-step-join-any"
            checked={step.join === "any"}
            onSelect={() => onChange({ ...step, join: "any" })}
            label={tr("pipelines.any_incoming_step_finishes")}
          />
          <RadioRow
            testId="pipeline-step-join-all"
            checked={step.join === "all"}
            onSelect={() => onChange({ ...step, join: "all" })}
            label={tr("pipelines.all_incoming_steps_have_finished")}
          />
        </div>
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground"><I18nText id="pipelines.connect_to" /></span>
        <div data-testid="pipeline-step-connect" className="mt-1">
          <SearchSelect
            value=""
            onChange={(toId) => onConnect(toId)}
            items={connectItems}
            placeholder={tr("pipelines.pick_a_step_to_connect_to")}
            emptyLabel={tr("pipelines.connect_to_another_step")}
          />
        </div>
        {outgoing.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {outgoing.map(({ step: target, edge }) => (
              <li key={edge.id} className="flex items-center gap-1.5" data-testid="pipeline-step-edge-row">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={target.name}>
                  → {target.name}
                </span>
                <Input
                  value={edge.label}
                  placeholder={tr("common.label")}
                  maxLength={PIPELINE_LIMITS.edgeLabel}
                  onChange={(e) => onEdgeLabel(edge.id, e.target.value)}
                  className="h-7 w-24 text-xs"
                  data-testid="pipeline-step-edge-label"
                />
                <button
                  type="button"
                  title={tr("pipelines.remove_connection")}
                  data-testid="pipeline-step-edge-remove"
                  onClick={() => onRemoveEdge(edge.id)}
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/40 hover:text-danger"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pipeline-step-set-start"
          disabled={isStart}
          onClick={onSetStart}
        >
          {isStart ? tr("pipelines.start_step") : tr("common.set_as_start")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-testid="pipeline-step-delete"
          onClick={handleDelete}
        ><I18nText id="pipelines.delete_step" />{" "}</Button>
      </div>
    </div>
  );
}

function RadioRow({
  testId,
  checked,
  onSelect,
  label,
}: {
  testId: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
}) {
  useUILocale();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-testid={testId}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
        checked ? "border-info bg-info/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-info" : "border-muted-foreground",
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-info" />}
      </span>
      {label}
    </button>
  );
}
