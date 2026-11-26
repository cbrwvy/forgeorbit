/**
 * FO-ORCH-SCALE01: Scalable Multi-Project Orchestration — Mission Control UI
 */

import { missionAuthority } from "@/lib/mission-authority";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Play,
  Pause,
  Square,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Layers,
  Cpu,
  ShieldCheck,
  RefreshCw,
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Lock,
  User,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/state";
import { Input } from "@/components/ui/input";
import { LiveExecutionApproval } from "@/components/kanban/LiveExecutionApproval";
import { MissionAccountLimitNotice } from "@/components/ui/account-limit-notice";
import { t as tr, type TranslationKey } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { TechnicalDetails, TechnicalDetailRows, TechnicalDisclosure } from "@/components/ui/technical-details";
import { RuntimeSafetyNotice } from "@/components/ui/runtime-safety-notice";
import { dependencyConditionText, missionEventText, priorityText } from "@/lib/status-presenters";
import { ownerExecutionState } from "../../../shared/provider-runtime/owner-state.ts";
import { api } from "@/lib/api";
import type { ProjectSurfacePage } from "@/lib/workspace";
import type {
  MissionRecord,
  MissionTaskPlan,
  MissionReservation,
  MissionTaskDependency,
  MissionStatus,
  MissionTaskPhase,
} from "../../../shared/orchestration/types.js";
import { ObjectiveMissionForm, ObjectiveMissionTasks } from "./ObjectiveMission";
import type { Project } from "../../../shared/types.ts";
import { MissionReplanPanel } from "./MissionReplanPanel";
import { AutonomyMissionStart } from "./AutonomyControlPanel";
import { PracticalCyclePanel } from "./PracticalCyclePanel";
import { InfraOperationsSection } from "../workspace/infrastructure/InfraOperationsPanel";

interface MissionControlPageProps {
  onOpenProject?: (path: string, page: ProjectSurfacePage) => void;
  onOpenTask?: (taskId: string) => void;
  /**
   * Open a Settings section from here (M4). Opening saves, confirms and starts nothing. An
   * `ownerContext` carries the exact mission (and task) so Settings shows only that operation.
   */
  onOpenSettings?: (target: { section: "autonomy"; anchor: "autonomy_policy" | "owner_trust"; ownerContext?: { missionId: string; missionTitle?: string; taskId?: string; taskTitle?: string } }) => void;
  /** Render inside Settings: the settings pane scrolls, and this view does not fill the window. */
  embedded?: boolean;
}

export function MissionControlPage({ onOpenProject, onOpenTask, onOpenSettings, embedded = false }: MissionControlPageProps) {
  useUILocale();
  const [projects, setProjects] = useState<Project[]>([]);
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [authorityStatus, setAuthorityStatus] = useState<Awaited<ReturnType<typeof api.autonomyStatus>> | null>(null);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [reservations, setReservations] = useState<MissionReservation[]>([]);
  const [dependencies, setDependencies] = useState<MissionTaskDependency[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedPhaseFilter, setSelectedPhaseFilter] = useState<string>("all");
  const controlsRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<"projects" | "queue" | "dependencies" | "history">("projects");

  const loadData = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const res = await api.getOrchestrationMissions();
      setMissions(res.missions);
      if (res.missions.length > 0 && res.missions[0] && !selectedMissionId) {
        setSelectedMissionId(res.missions[0].id);
      }

      const resList = await api.getOrchestrationReservations();
      setReservations(resList.reservations);
      setAuthorityStatus(await api.autonomyStatus().catch(() => null));
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedMissionId]);

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      void loadData();
    }, 4000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    let active = true;
    void api.listProjects().then(rows => { if (active) setProjects(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const selectObjectiveDraft = useCallback(async (id: string) => {
    setSelectedMissionId(id);
    setActiveTab("projects");
    const result = await api.getOrchestrationMissions().catch(() => null);
    if (result) setMissions(result.missions);
  }, []);
  const currentMission = useMemo(() => {
    return missions.find((m) => m.id === selectedMissionId) || missions[0] || null;
  }, [missions, selectedMissionId]);

  useEffect(() => {
    if (currentMission?.id) {
      void api
        .getOrchestrationDependencies(currentMission.id)
        .then((res) => setDependencies(res.dependencies))
        .catch(() => setDependencies([]));
    }
  }, [currentMission?.id]);

  // Actions
  const handleAuthorize = async () => {
    if (!currentMission) return;
    setActionError(null);
    try {
      await api.authorizeOrchestrationMission(currentMission.id, currentMission.planDigest);
      await loadData();
    } catch (e) {
      setActionError(tr("mc.error.authorize", { message: (e as Error).message }));
    }
  };

  const handleStart = async () => {
    if (!currentMission) return;
    setActionError(null);
    try {
      await api.startOrchestrationMission(currentMission.id);
      await loadData();
    } catch (e) {
      setActionError(tr("mc.error.start", { message: (e as Error).message }));
    }
  };

  const handlePause = async () => {
    if (!currentMission) return;
    setActionError(null);
    try {
      await api.pauseOrchestrationMission(currentMission.id, "Paused by Owner");
      await loadData();
    } catch (e) {
      setActionError(tr("mc.error.pause", { message: (e as Error).message }));
    }
  };

  const handleResume = async () => {
    if (!currentMission) return;
    setActionError(null);
    try {
      await api.resumeOrchestrationMission(currentMission.id);
      await loadData();
    } catch (e) {
      setActionError(tr("mc.error.resume", { message: (e as Error).message }));
    }
  };

  const handleCancel = async () => {
    if (!currentMission) return;
    setActionError(null);
    try {
      await api.cancelOrchestrationMission(currentMission.id, "Cancelled by Owner");
      await loadData();
    } catch (e) {
      setActionError(tr("mc.error.cancel", { message: (e as Error).message }));
    }
  };

  // Group tasks by project
  const tasksByProject = useMemo(() => {
    if (!currentMission) return new Map<string, MissionTaskPlan[]>();
    const map = new Map<string, MissionTaskPlan[]>();
    for (const task of currentMission.plan.tasks) {
      if (searchFilter && !task.taskTitle.toLowerCase().includes(searchFilter.toLowerCase()) && !task.projectPath.toLowerCase().includes(searchFilter.toLowerCase())) {
        continue;
      }
      if (selectedPhaseFilter !== "all" && task.phase !== selectedPhaseFilter) {
        continue;
      }
      const list = map.get(task.projectPath) || [];
      list.push(task);
      map.set(task.projectPath, list);
    }
    return map;
  }, [currentMission, searchFilter, selectedPhaseFilter]);

  const statusTone: Record<MissionStatus, BadgeProps["variant"]> = {
    draft: "warning",
    planned: "info",
    authorized: "info",
    running: "info",
    paused: "warning",
    completed: "success",
    failed: "destructive",
    cancelled: "secondary",
  };

  const phaseTone: Record<MissionTaskPhase, string> = {
    planned: "bg-muted text-muted-foreground",
    authorized: "bg-info/20 text-info",
    blocked: "bg-danger/20 text-danger",
    reserved: "bg-info/20 text-info",
    starting: "bg-warning/20 text-warning",
    running: "bg-info/20 text-info",
    awaiting_qc: "bg-info/20 text-info",
    qc_running: "bg-info/30 text-info",
    awaiting_owner: "bg-warning/30 text-warning",
    completed: "bg-success/20 text-success",
    failed: "bg-danger/30 text-danger",
    cancelled: "bg-muted text-muted-foreground",
  };
  const phaseLabel = (phase: string) => {
    const key = `mc.phase.${phase}`;
    return Object.hasOwn(phaseTone, phase) ? tr(key as TranslationKey) : phase;
  };
  const projectName = (path: string) => projects.find((project) => project.path === path)?.name || path.split("/").pop() || path;
  // A dependency names tasks by id; show the title when the plan knows it, the id otherwise.
  const taskTitle = (taskId: string) => currentMission?.plan.tasks.find((task) => task.taskId === taskId)?.taskTitle ?? taskId;
  const statusLabel = (status: string) => {
    const key = `mc.status.${status}`;
    return Object.hasOwn(statusTone, status) ? tr(key as TranslationKey) : tr("common.unknown");
  };

  return (
    <div className={embedded ? "flex w-full min-w-0 max-w-full flex-col gap-4 text-foreground" : "flex h-full w-full flex-col space-y-6 overflow-y-auto bg-background p-6 text-foreground"} data-testid="mission-control-page">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="size-5 text-primary" />
            {embedded ? (
              <h2 className="text-xl font-bold tracking-tight">{tr("missions.title")}</h2>
            ) : (
              <h1 className="text-xl font-bold tracking-tight">{tr("missions.title")}</h1>
            )}
          </div>
          <p className="text-xs text-muted-foreground pt-0.5">
            {tr("missions.subtitle")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            data-testid="mission-jump-controls"
            onClick={() => { controlsRef.current?.scrollIntoView({ block: "start" }); controlsRef.current?.focus({ preventScroll: true }); }}
          >
            {tr("missions.jump_controls")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadData()}
            disabled={loading}
            className="h-8 gap-1 text-xs"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {tr("mc.refresh")}
          </Button>
        </div>
      </div>

      {!currentMission && <ObjectiveMissionForm projects={projects} onDraft={selectObjectiveDraft} />}
      {!currentMission?.plan.objective && <LiveExecutionApproval />}
      {actionError && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-danger" />
          <span>{actionError}</span>
        </div>
      )}

      {missions.length === 0 && !loading && !actionError && (
        <EmptyState
          className="rounded-lg border border-border/80 bg-card/60"
          testId="missions-empty"
          title={tr("m7.empty.missions.title")}
          description={tr("m7.empty.missions.description")}
          action={<Button type="button" size="sm" variant="outline" data-testid="missions-empty-controls" onClick={() => { controlsRef.current?.scrollIntoView({ block: "start" }); controlsRef.current?.focus({ preventScroll: true }); }}>{tr("m7.empty.missions.setup")}</Button>}
        />
      )}
      {missions.length === 0 && !loading && actionError && (
        <EmptyState
          className="rounded-lg border border-danger/40 bg-card/60"
          testId="missions-unavailable"
          title={tr("m7.unavailable.missions.title")}
          description={tr("m7.unavailable.missions.description")}
          action={<Button type="button" size="sm" variant="outline" data-testid="missions-retry" onClick={() => void loadData()}>{tr("m7.unavailable.retry")}</Button>}
        />
      )}

      {/* Mission selector & Concurrency slots */}
      {missions.length > 0 && currentMission && (
        <div className="grid min-w-0 gap-4">
          {/* Mission Details */}
          <div className="ds-panel min-w-0 space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <select
                  value={currentMission.id}
                  onChange={(e) => setSelectedMissionId(e.target.value)}
                  className="min-w-0 max-w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-semibold"
                  aria-label={tr("objective.selectMission")}
                  data-testid="mission-select"
                >
                  {missions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
                <Badge variant={statusTone[currentMission.status]} data-testid="mission-status">
                  {currentMission.plan.objective && currentMission.status === "draft" ? tr("objective.awaitingPlanApproval") : statusLabel(currentMission.status)}
                </Badge>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-1.5">
                {!currentMission.plan.objective && (currentMission.status === "draft" || currentMission.status === "planned") && (
                  <Button size="sm" onClick={handleAuthorize} className="h-8 gap-1 text-xs" data-testid="authorize-mission-button">
                    <ShieldCheck className="size-3.5" />
                    {tr("mc.authorizePlan")}
                  </Button>
                )}
                {currentMission.status === "authorized" && (
                  <Button size="sm" onClick={handleStart} className="h-8 gap-1 text-xs" data-testid="start-mission-button">
                    <Play className="size-3.5" />
                    {tr("mc.startMission")}
                  </Button>
                )}
                {currentMission.status === "running" && (
                  <Button size="sm" variant="outline" onClick={handlePause} className="h-8 gap-1 text-xs" data-testid="pause-mission-button">
                    <Pause className="size-3.5" />
                    {tr("mc.pause")}
                  </Button>
                )}
                {currentMission.status === "paused" && (
                  <Button size="sm" onClick={handleResume} className="h-8 gap-1 text-xs" data-testid="resume-mission-button">
                    <Play className="size-3.5" />
                    {tr("mc.resume")}
                  </Button>
                )}
                {onOpenSettings && !currentMission.plan.objective && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    title={tr("missions.owner_review_hint")}
                    data-testid="mission-owner-review"
                    onClick={() => onOpenSettings({ section: "autonomy", anchor: "owner_trust", ownerContext: { missionId: currentMission.id, missionTitle: currentMission.title } })}
                  >
                    {tr("missions.owner_review")}
                  </Button>
                )}
                {["draft", "planned", "authorized", "running", "paused"].includes(currentMission.status) && (
                  <Button size="sm" variant="ghost" onClick={handleCancel} className="h-8 gap-1 text-xs text-danger hover:text-danger" data-testid="cancel-mission-button">
                    <Square className="size-3.5" />
                    {tr(currentMission.plan.objective && !["draft", "planned"].includes(currentMission.status) ? "objective.stop" : "mc.cancel")}
                  </Button>
                )}
              </div>
            </div>

            <h3 className="break-words text-base font-semibold [overflow-wrap:anywhere]">{currentMission.title}</h3>
            <p className="break-words text-sm [overflow-wrap:anywhere]">{currentMission.goal}</p>
            <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {currentMission.projects.map(projectName).join(" · ")}
            </p>
            {!currentMission.plan.objective && (() => {
              const authority = missionAuthority(currentMission.id, authorityStatus);
              const text = authority.kind === "inactive"
                ? tr("d7.authority.inactive", { why: tr(`d7.authority.why.${authority.why}` as TranslationKey) })
                : tr(`d7.authority.${authority.kind}` as TranslationKey);
              return (
                <p className="text-xs font-medium text-foreground" data-testid="mission-authority" data-kind={authority.kind}>{text}</p>
              );
            })()}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div>
                <span className="text-foreground/70">{tr("mc.projects")}</span> {currentMission.projects.length}
              </div>
              <div>
                <span className="text-foreground/70">{tr("mc.tasks")}</span> {currentMission.plan.tasks.length}
              </div>
              <div>
                <span className="text-foreground/70">{tr("mc.ownerApproval")}</span> {currentMission.authorization ? tr("m0.approval.approved") : tr("m0.approval.pending")}
              </div>
            </div>
            <TechnicalDetails
              testId="mission-tech"
              rows={[
                { label: tr("mc.planDigest"), value: currentMission.planDigest, testId: "mission-plan-digest" },
                { label: tr("mc.missionId"), value: currentMission.id },
                { label: tr("mc.revisionLabel"), value: String(currentMission.revision) },
                { label: tr("mc.statusRaw"), value: currentMission.status },
              ]}
            />
          </div>

          {/* Concurrency Slots Gauge */}
          {!currentMission.plan.objective && <details className="ds-panel space-y-3 p-3">
            <summary className="cursor-pointer text-sm font-medium">{tr("mc.concurrency")}</summary>
            <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <span>{tr("mc.globalSlots")}</span>
              <Cpu className="size-4 text-primary" />
            </div>

            <div className="space-y-2">
              <div>
                <div className="flex justify-between text-xs pb-1">
                  <span>{tr("mc.globalSlots")}</span>
                  <span className="font-mono">
                    {reservations.length} / {currentMission.concurrencyLimits.globalMax}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{
                      width: `${Math.min(100, (reservations.length / (currentMission.concurrencyLimits.globalMax || 1)) * 100)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="flex justify-between text-[11px] text-muted-foreground pt-1">
                <span>{tr("mc.perProject", { count: currentMission.concurrencyLimits.perProjectMax })}</span>
                <span>{tr("mc.perAccount", { count: currentMission.concurrencyLimits.perAccountMax })}</span>
              </div>
            </div>

            <div className="text-[11px] text-muted-foreground/80 flex items-center gap-1.5 border-t border-border/50 pt-2">
              <Lock className="size-3 text-success" />
              <span>{tr("mc.launchAuthority")}</span>
            </div>
          </details>}
        </div>
      )}

      {currentMission?.authorization && !currentMission.plan.objective && <MissionReplanPanel key={currentMission.id} mission={currentMission} onSettled={() => void loadData()} />}

      {/* Tabs */}
      {!currentMission?.plan.objective && <div className="flex items-center gap-2 border-b border-border/80">
        <button
          type="button"
          onClick={() => setActiveTab("projects")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "projects" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-projects"
        >
          {tr("mc.tab.projects", { count: currentMission?.projects.length || 0 })}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("queue")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "queue" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-queue"
        >
          {tr("mc.tab.queue", { count: currentMission?.plan.tasks.length || 0 })}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("dependencies")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "dependencies" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-dependencies"
        >
          {tr("mc.tab.dependencies", { count: dependencies.length })}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("history")}
          className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
            activeTab === "history" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-history"
        >
          {tr("mc.tab.history", { count: currentMission?.history.length || 0 })}
        </button>
      </div>}

      {/* Filters */}
      {!currentMission?.plan.objective && <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="size-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder={tr("mc.searchPlaceholder")}
            aria-label={tr("mc.searchPlaceholder")}
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>

        <select
          value={selectedPhaseFilter}
          onChange={(e) => setSelectedPhaseFilter(e.target.value)}
          className="rounded border border-border bg-background px-2.5 py-1 text-xs focus:outline-none"
          aria-label={tr("mc.allPhases")}
        >
          <option value="all">{tr("mc.allPhases")}</option>
          <option value="running">{tr("mc.phase.running")}</option>
          <option value="blocked">{tr("mc.phase.blocked")}</option>
          <option value="completed">{tr("mc.phase.completed")}</option>
          <option value="authorized">{tr("mc.phase.authorized")}</option>
        </select>
      </div>}

      {/* Tab 1: Project Overview (Optimized for 30+ projects) */}
      {currentMission?.plan.objective && <ObjectiveMissionTasks key={currentMission.id} mission={currentMission}
        projects={projects} onOpenTask={onOpenTask} onChanged={() => void loadData()} />}
      {activeTab === "projects" && !currentMission?.plan.objective && (
        <div className="space-y-4" data-testid="project-overview-grid">
          {Array.from(tasksByProject.entries()).map(([projectPath, projectTasks]) => {
            const completedCount = projectTasks.filter((t) => t.phase === "completed").length;
            const runningCount = projectTasks.filter((t) => t.phase === "running" || t.phase === "qc_running").length;
            const blockedCount = projectTasks.filter((t) => t.phase === "blocked").length;
            const projectName = projectPath.split("/").pop() || projectPath;

            return (
              <div key={projectPath} className="rounded-lg border border-border/70 bg-card/40 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{projectName}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-muted-foreground">
                      {tr("mc.tasksDone", { done: completedCount, total: projectTasks.length })}
                    </span>
                    {runningCount > 0 && (
                      <span className="text-info font-medium">{tr("mc.activeCount", { count: runningCount })}</span>
                    )}
                    {blockedCount > 0 && (
                      <span className="text-danger font-medium">{tr("mc.blockedCount", { count: blockedCount })}</span>
                    )}
                  </div>
                </div>

                <TechnicalDetails rows={[{ label: tr("mc.projectFolder"), value: projectPath }]} />

                {/* Progress Bar */}
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-success transition-all duration-300"
                    style={{
                      width: `${projectTasks.length > 0 ? (completedCount / projectTasks.length) * 100 : 0}%`,
                    }}
                  />
                </div>

                {/* Task badges */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
                  {projectTasks.map((t) => (
                    <div
                      key={t.taskId}
                      onClick={() => onOpenTask?.(t.taskId)}
                      className="rounded border border-border/50 bg-background/50 p-2 text-xs flex flex-col justify-between hover:border-primary/50 cursor-pointer transition-colors"
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="font-medium truncate" title={t.taskTitle}>
                          {t.taskTitle}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${phaseTone[t.phase] || "bg-muted"}`}>
                          {phaseLabel(t.phase)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between pt-2 text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <User className="size-3" />
                          {t.specialistRole}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tab 2: Work Queue */}
      {activeTab === "queue" && currentMission && !currentMission.plan.objective && (
        <div className="space-y-2">
          <RuntimeSafetyNotice liveTestId="mission-queue-live-unavailable" />
          {currentMission.plan.tasks.map((task) => (
            <div
              key={task.taskId}
              className="rounded border border-border/70 bg-card/40 p-3 flex flex-wrap items-center justify-between gap-2 text-xs"
              data-testid={`mission-task-${task.taskId}`}
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{task.taskTitle}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${phaseTone[task.phase] ?? "bg-muted"}`}>
                    {phaseLabel(task.phase)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{priorityText(task.priority)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {tr("mc.projectLine", { name: task.projectPath.split("/").pop() ?? task.projectPath })} · {task.specialistRole}
                </div>
                <p className="text-[11px] font-medium" data-testid={`mission-task-state-${task.taskId}`}>
                  {tr(`runtime.state.${ownerExecutionState({ phase: task.phase, reworkEpoch: task.reworkEpoch })}` as TranslationKey)}
                  {(task.phase === "running" || task.phase === "starting" || task.phase === "qc_running") && ` · ${tr("runtime.recorded_driver")}`}
                </p>
                {task.accountLimit && <MissionAccountLimitNotice mission={currentMission} task={task} onChanged={() => void loadData()} />}
                {task.waitingOn && task.waitingOn !== "quota" && (
                  <p className="text-[11px] font-medium text-warning" data-testid={`mission-task-wait-${task.taskId}`} data-kind={task.waitingOn}>
                    {tr(`d6.wait.${task.waitingOn}` as TranslationKey)}
                  </p>
                )}
                {task.phaseReason && !task.accountLimit && <div className="text-[11px] text-muted-foreground">{task.phaseReason}</div>}
                {task.blockers && task.blockers.length > 0 && (
                  <div className="text-[11px] text-danger font-medium">
                    {tr("mc.blockers", { list: task.blockers.join("; ") })}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <TechnicalDetails
                  summary={tr("mc.taskTech")}
                  rows={[
                    { label: tr("ownerTrust.provider"), value: task.harnessId },
                    { label: tr("ownerTrust.model"), value: task.modelId },
                    { label: tr("ownerTrust.mode"), value: task.mode },
                    { label: tr("ownerTrust.account"), value: task.accountId },
                    { label: tr("mc.runLabel"), value: task.runId },
                    { label: tr("mcDep.task"), value: task.taskId },
                  ]}
                />
                {onOpenSettings && task.phase === "awaiting_owner" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    data-testid={`mission-task-owner-review-${task.taskId}`}
                    onClick={() => onOpenSettings({ section: "autonomy", anchor: "owner_trust", ownerContext: { missionId: currentMission.id, missionTitle: currentMission.title, taskId: task.taskId, taskTitle: task.taskTitle } })}
                  >
                    {tr("missions.owner_review_task")}
                  </Button>
                )}
                {onOpenTask && (
                  <Button variant="ghost" size="sm" onClick={() => onOpenTask(task.taskId)} className="h-7 text-xs">
                    {tr("mc.inspect")}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tab 3: Cross-Project Dependencies */}
      {activeTab === "dependencies" && !currentMission?.plan.objective && (
        <div className="space-y-2">
          {dependencies.length === 0 ? (
            <div className="rounded border border-border/50 p-6 text-center text-xs text-muted-foreground">
              {tr("mc.noDependencies")}
            </div>
          ) : (
            dependencies.map((dep) => (
              <div
                key={dep.id || `${dep.taskId}-${dep.dependsOnTaskId}`}
                className="rounded border border-border/70 bg-card/40 p-3 flex items-start justify-between gap-3 text-xs"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-foreground font-medium">{projectName(dep.projectPath)}: {taskTitle(dep.taskId)}</span>
                  <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">{tr("mc.dependsOn")}</span>
                  <span className="text-primary font-medium">{projectName(dep.dependsOnProjectPath)}: {taskTitle(dep.dependsOnTaskId)}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {dependencyConditionText(dep.condition)}
                  </span>
                  <TechnicalDetails
                    summary={tr("mcDep.tech")}
                    className="basis-full"
                    rows={[
                      { label: tr("mcDep.task"), value: dep.taskId },
                      { label: tr("mcDep.dependsOnTask"), value: dep.dependsOnTaskId },
                      { label: tr("mcDep.condition"), value: dep.condition },
                    ]}
                  />
                </div>

                <div>
                  {dep.satisfiedAt ? (
                    <span className="flex items-center gap-1 text-success font-medium text-xs">
                      <CheckCircle2 className="size-3.5" /> {tr("mc.satisfied")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-warning font-medium text-xs">
                      <Clock className="size-3.5" /> {tr("mc.awaiting")}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Tab 4: Execution History */}
      {activeTab === "history" && !currentMission?.plan.objective && currentMission && (
        <ol className="rounded border border-border/70 bg-card/30 p-4 space-y-2 text-xs" data-testid="mission-history">
          {currentMission.history.length === 0 && <li className="text-muted-foreground">{tr("mc.historyEmpty")}</li>}
          {currentMission.history.map((ev, i) => {
            const reason = typeof ev.details?.reason === "string" ? ev.details.reason : null;
            return (
              <li key={i} className="space-y-1 border-b border-border/30 pb-2 last:border-b-0" data-testid="mission-history-row">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <time className="shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(ev.timestamp).toISOString()}>{new Date(ev.timestamp).toLocaleTimeString()}</time>
                  <span className="font-medium" data-testid="mission-history-event">{missionEventText(ev.event)}</span>
                </div>
                {reason && <p className="text-muted-foreground">{tr("mcEvent.reason", { reason })}</p>}
                <TechnicalDisclosure summary={tr("mcEvent.tech")}>
                  <TechnicalDetailRows
                    rows={[
                      { label: tr("mcEvent.name"), value: ev.event, testId: "mission-history-event-raw" },
                      { label: tr("mcEvent.details"), value: ev.details ? JSON.stringify(ev.details) : null },
                    ]}
                  />
                </TechnicalDisclosure>
              </li>
            );
          })}
        </ol>
      )}

      {/* M3: missions come first; the administrative panels keep every control and sit below. */}
      {currentMission && <ObjectiveMissionForm projects={projects} onDraft={selectObjectiveDraft} />}

      <section id="mission-controls" ref={controlsRef} tabIndex={-1} aria-labelledby="mission-controls-heading" className="space-y-6 border-t border-border pt-6 outline-none" data-testid="mission-controls">
        <div>
          <h2 id="mission-controls-heading" className="text-base font-semibold">{tr("missions.controls")}</h2>
          <p className="text-xs text-muted-foreground">{tr("missions.controls_hint")}</p>
        </div>
        <AutonomyMissionStart
          onMissionStarted={() => void loadData()}
          onOpenPolicySettings={onOpenSettings ? () => onOpenSettings({ section: "autonomy", anchor: "autonomy_policy" }) : undefined}
        />
        <PracticalCyclePanel
          missionId={currentMission?.id}
          tasks={currentMission?.plan.tasks.map((task) => ({ taskId: task.taskId, title: task.taskTitle, phase: task.phase })) ?? []}
        />
        <InfraOperationsSection />
        {onOpenSettings && (
          <div className="ds-panel flex flex-wrap items-center justify-between gap-3 p-4" data-testid="missions-setup-in-settings">
            <div className="min-w-0 flex-1 basis-64">
              <h2 className="ds-section-title">{tr("missions.setup_title")}</h2>
              <p className="ds-meta">{tr("missions.setup_hint")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" data-testid="missions-open-policy" onClick={() => onOpenSettings({ section: "autonomy", anchor: "autonomy_policy" })}>{tr("missions.open_policy")}</Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" data-testid="missions-open-owner" onClick={() => onOpenSettings({ section: "autonomy", anchor: "owner_trust" })}>{tr("missions.open_owner")}</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
