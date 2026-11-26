import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import { api } from "@/lib/api";
import type { MissionRecord } from "../../../shared/orchestration/types.ts";
import { MissionResourceReview } from "./MissionResourceReview";
import { Picker } from "../usage/presentation";
import { ScheduleStages } from "../usage/UsageForecast";

export function MissionReplanPanel({ mission, onSettled }: { mission: MissionRecord; onSettled: () => void }) {
  useLocale();
  const [taskId, setTask] = useState("");
  const [role, setRole] = useState<"developer" | "reviewer">("reviewer");
  const [reason, setReason] = useState("");
  const [optionId, setOption] = useState("");
  const [globalMax, setGlobalMax] = useState("");
  const [perProjectMax, setProjectMax] = useState("");
  const [perAccountMax, setAccountMax] = useState("");
  const [perClusterMax, setClusterMax] = useState("");
  const [state, setState] = useState<Awaited<ReturnType<typeof api.missionResourceProposals>>>();
  const [options, setOptions] = useState<Awaited<ReturnType<typeof api.missionResourceOptions>>["options"]>([]);
  const [schedule, setSchedule] = useState<Awaited<ReturnType<typeof api.usageForecast>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Array<{ taskId: string; role: "developer" | "reviewer"; resource: { harnessId: string; modelId: string; accountId: string; mode: string }; label: string }>>([]);
  const canPrepare = mission.status === "paused" || mission.status === "authorized";
  const refresh = () => api.missionResourceProposals(mission.id).then(setState);
  useEffect(() => { void refresh().catch(reason => setError(reason.message)); }, [mission.id, mission.revision]);
  useEffect(() => {
    let current = true;
    setOptions([]);
    setOption("");
    setError("");
    if (taskId && canPrepare) void api.missionResourceOptions(mission.id, taskId, role).then(data => {
      if (current) setOptions(data.options);
    }).catch(reason => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [mission.id, mission.revision, taskId, role, canPrepare]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try { await work(); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  const task = mission.plan.tasks.find(row => row.taskId === taskId);
  return <section className="space-y-3 rounded-lg border bg-card/60 p-4 text-sm" data-testid="mission-replan">
    <h3 className="font-semibold">{t("usage.replanTitle")} · #{mission.revision}</h3>
    <p className="text-muted-foreground">{t("usage.replanHold")}</p>
    <p className="text-muted-foreground" data-testid="router-fallback-boundary">{t("routing_v2.fallback_boundary")}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
      setSchedule(await api.usageForecast({ missionId: mission.id, compareAllocations: true }));
    })}>{t("usage.stageSchedule")}</Button>
    {schedule?.missionRevision === mission.revision && <ScheduleStages data={schedule} />}
    {canPrepare && <>
      <div className="grid gap-2 sm:grid-cols-2">
        <Picker id="mission-replan-task" label={t("usage.task")} value={taskId}
          options={mission.plan.tasks.filter(row => !["completed", "cancelled"].includes(row.phase))
            .map(row => ({ id: row.taskId, label: row.taskTitle }))}
          placeholder={t("usage.select")} onChange={setTask} />
        <Picker id="mission-replan-role" label={t("usage.replanStage")} value={role}
          options={["developer", "reviewer"].map(id => ({ id, label: t(id === "developer" ? "usage.developer" : "usage.reviewer") }))}
          onChange={value => setRole(value === "developer" ? "developer" : "reviewer")} />
        <Picker id="mission-replan-resource" label={t("usage.replacementResource")} value={optionId}
          options={options.map(row => ({ id: row.candidateId, label: [row.kind, row.modelLabel, row.accountLabel, row.mode].join(" · ") }))}
          placeholder={t("usage.select")} onChange={setOption} />
        <label className="space-y-1">{t("usage.replanReason")}
          <Input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} />
        </label>
      </div>
      {task?.phaseReason && <p role="status">{task.phaseReason}</p>}
      {task && !options.length && !error && <p>{t("usage.replanNoOptions")}</p>}
      <p className="text-muted-foreground">{t("usage.replanAtomic")}</p>
      <Button size="sm" variant="outline" disabled={busy || !optionId || draft.length >= 12} onClick={() => {
        const selected = options.find(row => row.candidateId === optionId);
        if (!selected) return;
        setDraft(rows => rows.some(row => row.taskId === taskId && row.role === role) ? rows : [...rows, {
          taskId, role, resource: selected.resource, label: [task?.taskTitle ?? taskId, role, selected.accountLabel ?? selected.accountId, selected.modelId].join(" · "),
        }]);
      }}>{t("usage.replanAddStage")}</Button>
      {draft.length > 0 && <ul data-testid="mission-replan-draft">
        <li className="font-medium">{t("usage.replanDraft")}</li>
        {draft.map(row => <li key={`${row.taskId}:${row.role}`}>{row.label}</li>)}
      </ul>}
      <details>
        <summary>{t("usage.replanLimits")}</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {([
            ["usage.replanGlobalLimit", globalMax, setGlobalMax, mission.concurrencyLimits.globalMax],
            ["usage.replanProjectLimit", perProjectMax, setProjectMax, mission.concurrencyLimits.perProjectMax],
            ["usage.replanAccountLimit", perAccountMax, setAccountMax, mission.concurrencyLimits.perAccountMax],
            ["usage.replanClusterLimit", perClusterMax, setClusterMax, mission.concurrencyLimits.perClusterMax],
          ] as const).map(([key, value, set, current]) => <label key={key}>{t(key)}
            <Input type="number" min={1} value={value} placeholder={current === undefined ? undefined : String(current)} onChange={event => set(event.target.value)} />
          </label>)}
        </div>
      </details>
      <Button size="sm" disabled={busy || !reason.trim() || (!optionId && draft.length === 0)} onClick={() => void act(async () => {
        const limits = {
          globalMax: globalMax ? Number(globalMax) : undefined,
          perProjectMax: perProjectMax ? Number(perProjectMax) : undefined,
          perAccountMax: perAccountMax ? Number(perAccountMax) : undefined,
          perClusterMax: perClusterMax ? Number(perClusterMax) : undefined,
        };
        const selected = options.find(row => row.candidateId === optionId);
        const changes = draft.length ? draft.map(({ taskId: id, role: stage, resource }) => ({ taskId: id, role: stage, resource }))
          : selected ? [{ taskId, role, resource: selected.resource }] : [];
        if (!changes.length) return;
        await api.prepareMissionResourceProposal(mission.id, changes.length > 1
          ? { reason, changes, limits } : { taskId: changes[0]!.taskId, role: changes[0]!.role, resource: changes[0]!.resource, reason, limits });
        setDraft([]);
        await refresh();
      })}>{t("usage.replanPrepare")}</Button>
    </>}
    {state?.proposals.map(proposal => <details key={proposal.id} className="rounded-md border p-2" open={proposal.status === "pending"}>
      <summary>{t("usage.replanProposal")} · #{proposal.revision + 1} · {t(`usage.replanStatus.${proposal.status}`)}</summary>
      <MissionResourceReview proposal={proposal} />
      {proposal.status === "pending" && (proposal.headMessageId ? <p>{t("usage.replanHeadDecision")}</p> : <div className="mt-2 flex gap-2">
        {(["approve", "reject"] as const).map(decision => <Button key={decision} size="sm" variant={decision === "reject" ? "outline" : "default"}
          disabled={busy || decision === "approve" && !canPrepare} onClick={() => void act(async () => {
            await api.settleMissionResourceProposal(mission.id, proposal, decision);
            await refresh();
            onSettled();
          })}>{t(decision === "approve" ? "usage.replanApprove" : "usage.replanReject")}</Button>)}
      </div>)}
    </details>)}
    {state?.revisions.map(revision => <details key={revision.revision}>
      <summary>{t("usage.frozen")} · #{revision.revision}</summary>
      <p className="break-all font-mono text-xs">{revision.planDigest}</p>
      <ul>{revision.plan.tasks.map(row => <li key={row.taskId}>
        {row.taskTitle} · {row.harnessId} · {row.modelId} · {row.accountId ?? "—"} · {row.mode}
        {row.reviewerBinding && ` · ${t("usage.reviewer")} ${row.reviewerBinding.modelId} / ${row.reviewerBinding.accountId}`}
      </li>)}</ul>
    </details>)}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
