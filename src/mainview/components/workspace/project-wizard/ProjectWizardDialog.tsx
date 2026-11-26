import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, type DocTargetCheck, type DocWriteResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { defaultDocPaths, pathBasename, type DocKind, type ProjectDiscovery } from "../../../../shared/project-discovery.ts";
import type { Project } from "../../../../shared/types.ts";
import {
  EMPTY_WIZARD_DRAFT,
  SKIPPED_ENVIRONMENT,
  WIZARD_STEPS,
  projectMetaKey,
  relativeInside,
  resolvedDirectory,
  serializeProjectMeta,
  effectiveSkips,
  validateDocSelection,
  validateProjectStep,
  type PlannedDocWrite,
  type ReviewEnvironment,
  type WizardDraft,
} from "../../../../shared/project-wizard.ts";
import type { ProfileDraft } from "@/i18n/environment";
import type { LaunchProfile } from "../../../../shared/environment/types.ts";
import {
  createLaunchProfileId,
  evaluateLaunch,
  launchSetupNote,
  manualLaunchDraft,
  profileCreateIsDuplicate,
  profileSaveFailureMessage,
  suggestLaunchProfiles,
} from "../../../../shared/wizard-launch.ts";
import {
  acceptedDocWrites,
  emptyInterviewState,
  remainingDocWrites,
  planInterviewDocs,
  syncTargets,
  type InterviewState,
} from "../../../../shared/project-interview.ts";
import { ProjectInterview } from "./ProjectInterview";
import {
  DiscoveryStep,
  DocsStep,
  EnvironmentStep,
  ProjectStep,
  ReviewStep,
  WarningList,
} from "./WizardPanels";
import { LaunchProfileStep } from "./LaunchProfileStep";

interface Props {
  open: boolean;
  homeDir: string;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

function requestKey(draft: WizardDraft, home: string): string {
  const directory = resolvedDirectory(draft, home);
  if (draft.mode === "create" && draft.placement === "new-folder") {
    return `new:${directory}:${draft.folderName.trim()}`;
  }
  return `dir:${directory}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Add-project wizard. The sidebar and the overview both open this; App only
 * hears about a project after the user confirms. Discovery is read-only.
 * The directory is created, when requested, only inside the confirm request.
 */
export function ProjectWizardDialog({ open, homeDir, onClose, onCreated }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [draft, setDraft] = useState<WizardDraft>(EMPTY_WIZARD_DRAFT);
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [discoveredKey, setDiscoveredKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "browse" | "discover" | "submit">(null);
  const [nameTouched, setNameTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // FO-003 AI interview. Lives here so Back, step switches and the Docs
  // sub-view never lose it; also saved per folder (see the save effect).
  const [interview, setInterview] = useState<InterviewState | null>(null);
  const [interviewRestored, setInterviewRestored] = useState(false);
  const [docsView, setDocsView] = useState<"summary" | "interview">("summary");
  const [docChecks, setDocChecks] = useState<DocTargetCheck[] | null>(null);
  const [docResults, setDocResults] = useState<DocWriteResult[] | null>(null);
  // Set once registration succeeded but a document failed to save, so a
  // retry only re-sends the documents.
  const [registered, setRegistered] = useState<Project | null>(null);
  // The documents a retry still owes, frozen when the save failed. Never
  // re-derived from the interview, so a retry can't resend a created file
  // or silently send nothing.
  const pendingWritesRef = useRef<ReturnType<typeof acceptedDocWrites> | null>(null);
  // Launch profile chosen on the environment step. The id is assigned once,
  // when the user picks a suggestion, and reused if saving has to be retried.
  const [launchChoice, setLaunchChoice] = useState("skip");
  const [launchDraft, setLaunchDraft] = useState<ProfileDraft | null>(null);
  const [hold, setHold] = useState<null | "docs" | "profile">(null);
  const draftsByChoice = useRef<Record<string, ProfileDraft>>({});
  const pendingProfileRef = useRef<LaunchProfile | null>(null);
  const profileSavedRef = useRef(false);
  const interviewRef = useRef(interview);
  interviewRef.current = interview;
  const savedJsonRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_WIZARD_DRAFT);
    setStep(0);
    setFurthest(0);
    setDiscovery(null);
    setDiscoveredKey(null);
    setError(null);
    setBusy(null);
    setNameTouched(false);
    setInterview(null);
    setInterviewRestored(false);
    setDocsView("summary");
    setDocChecks(null);
    setDocResults(null);
    setRegistered(null);
    pendingWritesRef.current = null;
    savedJsonRef.current = null;
    setLaunchChoice("skip");
    setLaunchDraft(null);
    setHold(null);
    draftsByChoice.current = {};
    pendingProfileRef.current = null;
    profileSavedRef.current = false;
  }, [open]);

  const key = requestKey(draft, homeDir);
  const fresh = discovery != null && discoveredKey === key && discovery.duplicate == null
    && !(draft.mode === "create" && draft.placement === "new-folder" && !discovery.willCreateDirectory && !discovery.empty);
  const warnings = discovery == null ? [] : [
    ...discovery.warnings,
    ...(draft.mode === "create" && draft.placement === "existing" && !discovery.empty && !discovery.willCreateDirectory
      ? [tr("common.this_folder_is_not_empty_nothing_inside_it")]
      : []),
  ];
  const stepId = WIZARD_STEPS[step]?.id ?? "project";
  const plan = useMemo(
    () => (discovery
      ? planInterviewDocs(
        discovery.documentation,
        { ideaPath: draft.ideaPath, prdPath: draft.prdPath },
        { idea: draft.ideaSkipped, prd: draft.prdSkipped },
      )
      : null),
    [discovery, draft.ideaPath, draft.prdPath, draft.ideaSkipped, draft.prdSkipped, uiLocale],
  );
  const docWrites = acceptedDocWrites(interview);
  const plannedWrites: PlannedDocWrite[] = docWrites.map((write) => ({ kind: write.kind, path: write.path }));
  const docWritesKey = JSON.stringify(plannedWrites);
  const docsBlocked = (docChecks ?? []).some((check) => check.state !== "free");

  // A changed Docs selection changes which documents are drafted.
  useEffect(() => {
    if (!plan) return;
    setInterview((current) => (current ? syncTargets(current, plan) : current));
  }, [plan]);

  // Save the interview for this folder (debounced). Outside the project,
  // in ForgeOrbit's own database. An untouched interview isn't stored.
  useEffect(() => {
    if (!open || !interview) return;
    if (interview.messages.length === 0 && !interview.drafts.idea && !interview.drafts.prd) return;
    const json = JSON.stringify(interview);
    if (json === savedJsonRef.current) return;
    const timer = setTimeout(() => {
      savedJsonRef.current = json;
      void api.saveInterviewDraft(interview).catch(() => {
        savedJsonRef.current = null;
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [open, interview]);

  // Re-check, read-only, that every accepted draft's path is still free.
  useEffect(() => {
    if (!open || stepId !== "review" || !discovery || plannedWrites.length === 0) {
      setDocChecks(null);
      return;
    }
    let cancelled = false;
    api.checkProjectDocs({ projectPath: discovery.path, files: plannedWrites })
      .then((result) => { if (!cancelled) setDocChecks(result.checks); })
      .catch((caught) => {
        if (!cancelled) setError(tr("common.couldn_t_check_the_document_paths", { p0: String(errorText(caught)) }));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepId, discovery?.path, docWritesKey]);

  const suggestions = useMemo(
    () => (discovery ? suggestLaunchProfiles(discovery) : []),
    [discovery, uiLocale],
  );
  const launchGate = discovery
    ? evaluateLaunch(discovery.path, launchChoice, launchDraft)
    : { state: "skip" as const, summary: null, profile: null };
  const environmentReview: ReviewEnvironment = launchGate.state === "ready"
    ? { state: "ready", summary: launchGate.summary }
    : launchGate.state === "invalid"
      ? { state: "invalid", summary: null }
      : SKIPPED_ENVIRONMENT;

  useEffect(() => {
    if (!open || !discoveredKey || discoveredKey === key) return;
    setFurthest(0);
    setStep(0);
    setLaunchChoice("skip");
    setLaunchDraft(null);
    draftsByChoice.current = {};
    pendingProfileRef.current = null;
    profileSavedRef.current = false;
  }, [open, discoveredKey, key]);

  const flushInterview = () => {
    const current = interviewRef.current;
    if (!current || (current.messages.length === 0 && !current.drafts.idea && !current.drafts.prd)) return;
    const json = JSON.stringify(current);
    if (json === savedJsonRef.current) return;
    savedJsonRef.current = json;
    void api.saveInterviewDraft(current).catch(() => {});
  };

  const requestClose = () => {
    if (busy === "submit") return;
    flushInterview();
    if (registered) {
      onCreated(registered);
      onClose();
      return;
    }
    onClose();
  };

  const openInterview = () => {
    if (!discovery || !plan) return;
    setInterview((current) => current ?? emptyInterviewState(discovery.path, plan));
    setDocsView("interview");
  };

  const discardInterview = () => {
    const current = interviewRef.current;
    if (current) void api.deleteInterviewDraft(current.projectPath).catch(() => {});
    savedJsonRef.current = null;
    setInterview(null);
    setInterviewRestored(false);
    setDocsView("summary");
  };

  const patch = (next: Partial<WizardDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setError(null);
  };

  const browse = async () => {
    if (busy) return;
    setBusy("browse");
    try {
      const start = resolvedDirectory(draftRef.current, homeDir);
      const refs = await api.pickRefs("folder", start.startsWith("/") ? start : undefined);
      const dir = refs.find((ref) => ref.isDirectory);
      if (!dir) return;
      setDraft((current) => {
        const name = nameTouched || current.name.trim() ? current.name : pathBasename(dir.path) || current.name;
        return { ...current, directory: dir.path, name };
      });
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const chooseDoc = async (kind: DocKind) => {
    if (!discovery || busy) return;
    setBusy("browse");
    try {
      const refs = await api.pickRefs("files", discovery.path);
      const file = refs.find((ref) => !ref.isDirectory);
      if (!file) return;
      const rel = relativeInside(discovery.path, file.path);
      if (!rel) {
        setError(tr("common.choose_a_file_inside_the_project_folder"));
        return;
      }
      setDraft((current) => ({
        ...current,
        ...(kind === "idea" ? { ideaPath: rel, ideaSkipped: false } : { prdPath: rel, prdSkipped: false }),
      }));
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    const current = draftRef.current;
    const problem = validateProjectStep(current, homeDir);
    if (problem) {
      setError(staticLabel(problem));
      return;
    }
    setBusy("discover");
    setError(null);
    try {
      const directory = resolvedDirectory(current, homeDir);
      const folderName = current.mode === "create" && current.placement === "new-folder"
        ? current.folderName.trim()
        : undefined;
      const sentKey = requestKey(current, homeDir);
      const report = await api.discoverProject({ path: directory, ...(folderName ? { folderName } : {}) });
      if (requestKey(draftRef.current, homeDir) !== sentKey) return;
      const docs = defaultDocPaths(report.documentation);
      if (interviewRef.current && interviewRef.current.projectPath !== report.path) {
        flushInterview();
        setInterview(null);
        setInterviewRestored(false);
        savedJsonRef.current = null;
      }
      setDocsView("summary");
      setDiscovery(report);
      setDiscoveredKey(sentKey);
      setLaunchChoice("skip");
      setLaunchDraft(null);
      draftsByChoice.current = {};
      pendingProfileRef.current = null;
      profileSavedRef.current = false;
      if (!interviewRef.current) {
        void api.loadInterviewDraft(report.path)
          .then(({ state }) => {
            if (!state || interviewRef.current || requestKey(draftRef.current, homeDir) !== sentKey) return;
            savedJsonRef.current = JSON.stringify(state);
            setInterview(state);
            setInterviewRestored(true);
          })
          .catch(() => { /* no saved interview */ });
      }
      const sameFolder = discoveredKey === sentKey;
      setDraft((prev) => ({
        ...prev,
        name: nameTouched ? prev.name : (prev.name.trim() || report.nameSuggestion),
        ideaPath: docs.ideaPath,
        prdPath: docs.prdPath,
        ideaSkipped: sameFolder && !docs.ideaPath ? prev.ideaSkipped : false,
        prdSkipped: sameFolder && !docs.prdPath ? prev.prdSkipped : false,
      }));
      if (report.duplicate) {
        setError(tr("common.already_registered_as", { p0: String(report.duplicate.name) }));
        return;
      }
      if (current.mode === "create" && current.placement === "new-folder" && !report.willCreateDirectory && !report.empty) {
        setError(tr("common.that_folder_already_exists_and_is_not_empty"));
        return;
      }
      setStep(1);
      setFurthest((max) => Math.max(max, 1));
    } catch (caught) {
      setDiscovery(null);
      setDiscoveredKey(null);
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Create the accepted drafts in a project that is already registered. */
  const saveDocs = async (project: Project): Promise<boolean> => {
    const writes = pendingWritesRef.current ?? acceptedDocWrites(interviewRef.current);
    if (writes.length === 0) return true;
    let results: DocWriteResult[];
    try {
      ({ results } = await api.writeProjectDocs({ projectPath: project.path, files: writes }));
    } catch (caught) {
      // No per-file answer: the core refused before writing (409/400) or
      // the request was lost. Retry sends the same set; the server refuses
      // anything that now exists instead of overwriting it.
      pendingWritesRef.current = writes;
      setRegistered(project);
      setError(tr("common.the_project_was_added_but_the_documents_were", { p0: String(errorText(caught)) }));
      return false;
    }
    pendingWritesRef.current = remainingDocWrites(writes, results);
    setDocResults((previous) => [
      ...(previous ?? []).filter((old) => old.status === "created" && !results.some((r) => r.kind === old.kind)),
      ...results,
    ]);
    const failed = results.filter((result) => result.status !== "created");
    const created = results.filter((result) => result.status === "created");
    if (created.length > 0) {
      // Saved docs become the project's documentation paths.
      setDraft((prev) => ({
        ...prev,
        ...(created.some((result) => result.kind === "idea") ? { ideaPath: created.find((r) => r.kind === "idea")!.path } : {}),
        ...(created.some((result) => result.kind === "prd") ? { prdPath: created.find((r) => r.kind === "prd")!.path } : {}),
      }));
      draftRef.current = {
        ...draftRef.current,
        ...(created.some((result) => result.kind === "idea") ? { ideaPath: created.find((r) => r.kind === "idea")!.path } : {}),
        ...(created.some((result) => result.kind === "prd") ? { prdPath: created.find((r) => r.kind === "prd")!.path } : {}),
      };
      // Keep only what still needs saving in the stored interview.
      setInterview((prev) => {
        if (!prev) return prev;
        const targets = { ...prev.targets };
        for (const result of created) targets[result.kind] = null;
        return { ...prev, targets };
      });
    }
    if (failed.length > 0) {
      setRegistered(project);
      setError(
        tr("common.the_project_was_added_but_could_not_be", { p0: String(created.length > 0 ? tr("common.and_was_created", { p0: String(created.map((r) => r.path).join(", ")) }) : ""), p1: String(failed
          .map((r) => r.path)
          .join(", ")) }),
      );
      return false;
    }
    void api.deleteInterviewDraft(interviewRef.current?.projectPath ?? project.path).catch(() => {});
    if (interviewRef.current && interviewRef.current.projectPath !== project.path) {
      void api.deleteInterviewDraft(project.path).catch(() => {});
    }
    savedJsonRef.current = null;
    setInterview(null);
    toast.success(tr("common.created_f04822", { p0: String(created.map((r) => r.path).join(" and ")) }));
    return true;
  };

  const saveMeta = async (project: Project) => {
    const current = draftRef.current;
    const meta = serializeProjectMeta({
      description: current.description,
      idea: current.ideaPath,
      prd: current.prdPath,
    });
    if (!meta) return;
    try {
      await api.setPreference(projectMetaKey(project.path), meta);
    } catch (caught) {
      toast.error(tr("common.project_added_but_its_description_could_not_be"), {
        description: errorText(caught),
      });
    }
  };

  const saveProfile = async (project: Project): Promise<boolean> => {
    const profile = pendingProfileRef.current;
    if (!profile || profileSavedRef.current) return true;
    try {
      const result = await api.createEnvironmentProfile(project.path, profile);
      if (!result.ok) {
        const detail = result.error ?? tr("common.the_environment_manager_refused_the_profile");
        if (profileCreateIsDuplicate(detail)) {
          const index = await api.getEnvironment(project.path);
          if (index.profiles.some((row) => row.profile.id === profile.id)) {
            profileSavedRef.current = true;
            return true;
          }
        }
        setRegistered(project);
        setHold("profile");
        setError(profileSaveFailureMessage(detail));
        return false;
      }
      profileSavedRef.current = true;
      return true;
    } catch (caught) {
      const detail = errorText(caught);
      if (profileCreateIsDuplicate(detail)) {
        try {
          const index = await api.getEnvironment(project.path);
          if (index.profiles.some((row) => row.profile.id === profile.id)) {
            profileSavedRef.current = true;
            return true;
          }
        } catch {
          /* the original error is the one to show */
        }
      }
      setRegistered(project);
      setHold("profile");
      setError(profileSaveFailureMessage(detail));
      return false;
    }
  };

  /** Documents first, then the launch profile. A failed step is the only one retried. */
  const finishRegistered = async (project: Project): Promise<void> => {
    const docsSaved = await saveDocs(project);
    await saveMeta(project);
    if (!docsSaved) {
      setHold("docs");
      return;
    }
    const profileSaved = await saveProfile(project);
    if (!profileSaved) return;
    if (pendingProfileRef.current) toast.success(tr("common.launch_profile_saved_it_was_not_started"));
    onCreated(project);
    onClose();
  };

  const submit = async () => {
    if (registered) {
      setBusy("submit");
      setError(null);
      try {
        await finishRegistered(registered);
      } finally {
        setBusy(null);
      }
      return;
    }
    const current = draftRef.current;
    if (!discovery || discovery.duplicate || discoveredKey !== requestKey(current, homeDir)) {
      setError(tr("common.check_the_folder_again_before_adding_the_project"));
      setStep(0);
      return;
    }
    const docsProblem = validateDocSelection(current);
    if (docsProblem) {
      setError(docsProblem);
      return;
    }
    const gate = evaluateLaunch(discovery.path, launchChoice, launchDraft);
    if (gate.state === "invalid") {
      setError(gate.error);
      const launchIndex = WIZARD_STEPS.findIndex((item) => item.id === "launch");
      if (launchIndex >= 0) setStep(launchIndex);
      return;
    }
    pendingProfileRef.current = gate.profile;
    profileSavedRef.current = false;
    setBusy("submit");
    setError(null);
    try {
      if (docsBlocked) {
        setError(tr("common.a_document_path_is_taken_change_it_in"));
        return;
      }
      const project = await api.registerProject({
        path: discovery.path,
        name: current.name.trim(),
        rejectDuplicate: true,
        createDirectory: discovery.willCreateDirectory,
      });
      await finishRegistered(project);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError(caught.message);
      } else {
        setError(errorText(caught));
      }
    } finally {
      setBusy(null);
    }
  };

  const chooseLaunch = (choiceId: string) => {
    setError(null);
    if (!discovery) return;
    if (choiceId === "skip") {
      setLaunchChoice("skip");
      return;
    }
    const existing = draftsByChoice.current[choiceId];
    if (existing) {
      setLaunchChoice(choiceId);
      setLaunchDraft(existing);
      return;
    }
    const seed = choiceId === "manual"
      ? manualLaunchDraft(discovery.path)
      : suggestions.find((suggestion) => suggestion.id === choiceId)?.draft;
    if (!seed) return;
    const next = { ...seed, id: createLaunchProfileId() };
    draftsByChoice.current[choiceId] = next;
    setLaunchChoice(choiceId);
    setLaunchDraft(next);
  };

  const updateLaunch = (next: ProfileDraft) => {
    setLaunchDraft(next);
    if (launchChoice !== "skip") draftsByChoice.current[launchChoice] = next;
    setError(null);
  };

  const goNext = () => {
    if (busy) return;
    if (stepId === "project") {
      void discover();
      return;
    }
    if (stepId === "docs") {
      const problem = validateDocSelection(draft);
      if (problem) {
        setError(staticLabel(problem));
        return;
      }
    }
    if (stepId === "launch") {
      if (!discovery) return;
      const gate = evaluateLaunch(discovery.path, launchChoice, launchDraft);
      if (gate.state === "invalid") {
        setError(gate.error);
        return;
      }
    }
    if (stepId === "review") {
      void submit();
      return;
    }
    setError(null);
    setDocsView("summary");
    const next = Math.min(WIZARD_STEPS.length - 1, step + 1);
    setFurthest((max) => Math.max(max, next));
    setStep(next);
  };

  /** One click skips every document that doesn't exist yet and moves on.
   *  Nothing is created, asked, or confirmed: the workspace can create them. */
  const skipBothDocs = () => {
    if (busy || !discovery) return;
    setDraft((current) => ({
      ...current,
      ideaSkipped: !discovery.documentation.idea,
      prdSkipped: !discovery.documentation.prd,
      ...(discovery.documentation.idea ? {} : { ideaPath: null }),
      ...(discovery.documentation.prd ? {} : { prdPath: null }),
    }));
    setError(null);
    setDocsView("summary");
    const next = Math.min(WIZARD_STEPS.length - 1, step + 1);
    setFurthest((max) => Math.max(max, next));
    setStep(next);
  };

  const goBack = () => {
    if (busy === "submit" || registered) return;
    setError(null);
    if (stepId === "docs" && docsView === "interview") {
      setDocsView("summary");
      return;
    }
    setStep((current) => Math.max(0, current - 1));
  };

  const interviewOpen = stepId === "docs" && docsView === "interview" && interview != null && plan != null;

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      labelledBy="project-wizard-title"
      describedBy="project-wizard-desc"
      initialFocusRef={nameRef}
      className={cn(
        "glass-elevated flex flex-col overflow-hidden p-0",
        interviewOpen ? "max-h-[min(52rem,calc(100dvh-2rem))] max-w-3xl" : "max-h-[min(44rem,calc(100dvh-2rem))] max-w-2xl",
      )}
    >
      <div data-testid="project-wizard" className="flex min-h-0 flex-1 flex-col">
        <header className="space-y-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="project-wizard-title" className="text-base font-semibold tracking-tight"><I18nText id="common.add_project" />{" "}</h2>
            <p id="project-wizard-desc" className="sr-only"><I18nText id="projects.import_an_existing_folder_or_create_a_new" />{" "}</p>
          </div>
          <ol className="flex gap-1" aria-label={tr("common.steps")}>
            {WIZARD_STEPS.map((item, index) => {
              const enabled = index === 0 || (fresh && index <= furthest);
              return (
                <li key={item.id} className="min-w-0 flex-1">
                  <button
                    type="button"
                    data-testid={`wizard-step-${item.id}`}
                    aria-current={index === step ? "step" : undefined}
                    aria-label={item.id === "launch" ? tr("common.development_environment", { p0: String(index + 1) }) : undefined}
                    title={item.id === "launch" ? tr("projects.development_environment") : undefined}
                    disabled={!enabled || busy === "submit" || registered != null}
                    onClick={() => {
                      if (!enabled) return;
                      setDocsView("summary");
                      setStep(index);
                    }}
                    className={cn(
                      "glass-nav-item flex w-full flex-col items-center rounded-md px-1 py-1 text-[10px] leading-tight",
                      index === step && "glass-selected",
                    )}
                  >
                    <span className="font-medium tabular-nums">{index + 1}</span>
                    <span className="truncate">{staticLabel(item.label)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </header>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            goNext();
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" data-testid="wizard-body" data-step={stepId}>
            {stepId === "project" && (
              <ProjectStep
                draft={draft}
                nameRef={nameRef}
                browsing={busy === "browse"}
                onChange={patch}
                onNameTouched={() => setNameTouched(true)}
                onBrowse={() => { void browse(); }}
              />
            )}
            {stepId === "discovery" && discovery && <DiscoveryStep discovery={discovery} />}
            {stepId === "docs" && discovery && plan && (interviewOpen && interview ? (
              <ProjectInterview
                discovery={discovery}
                draft={draft}
                plan={plan}
                state={interview}
                restored={interviewRestored}
                onChange={(update) => setInterview((current) => (current ? update(current) : current))}
                onBack={() => setDocsView("summary")}
                onDiscard={discardInterview}
              />
            ) : (
              <DocsStep
                discovery={discovery}
                draft={draft}
                plan={plan}
                interview={interview}
                onSelect={(kind, next) => patch(
                  kind === "idea"
                    ? { ideaPath: next, ...(next ? { ideaSkipped: false } : {}) }
                    : { prdPath: next, ...(next ? { prdSkipped: false } : {}) },
                )}
                onSkip={(kind, skip) => patch(
                  kind === "idea"
                    ? { ideaSkipped: skip, ...(skip ? { ideaPath: null } : {}) }
                    : { prdSkipped: skip, ...(skip ? { prdPath: null } : {}) },
                )}
                onSkipAll={skipBothDocs}
                onChooseFile={(kind) => { void chooseDoc(kind); }}
                onOpenInterview={openInterview}
              />
            ))}
            {stepId === "environment" && discovery && <EnvironmentStep discovery={discovery} />}
            {stepId === "launch" && discovery && (
              <LaunchProfileStep
                projectPath={discovery.path}
                suggestions={suggestions}
                note={launchSetupNote(discovery, suggestions.length)}
                choice={launchChoice}
                draft={launchDraft}
                onChoose={chooseLaunch}
                onDraft={updateLaunch}
              />
            )}
            {stepId === "review" && discovery && (
              <ReviewStep
                draft={draft}
                discovery={discovery}
                docWrites={plannedWrites}
                docChecks={docChecks}
                docResults={docResults}
                environment={environmentReview}
              />
            )}
            {discovery && stepId !== "project" && <WarningList warnings={warnings} />}
            {error && (
              <p role="alert" className="text-xs text-danger" data-testid="wizard-error">
                {error}
              </p>
            )}
          </div>
          <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <Button type="button" variant="ghost" onClick={requestClose} disabled={busy === "submit"} data-testid="wizard-cancel">
              {registered
                ? (hold === "profile" ? tr("common.finish_without_the_launch_profile") : tr("common.finish_without_documents"))
                : tr("common.cancel")}
            </Button>
            <div className="flex gap-2">
              {step > 0 && !registered && (
                <Button type="button" variant="outline" onClick={goBack} disabled={busy === "submit"} data-testid="wizard-back"><I18nText id="common.back" />{" "}</Button>
              )}
              <Button
                type="submit"
                disabled={(busy != null && busy !== "browse") || (stepId === "review" && ((docsBlocked && !registered) || (launchGate.state === "invalid" && !registered)))}
                data-testid={stepId === "review" ? "wizard-submit" : "wizard-next"}
              >
                {busy === "discover"
                  ? tr("common.checking")
                  : busy === "submit"
                    ? (registered ? tr("common.saving_23e392") : tr("common.adding"))
                    : stepId === "review"
                      ? (registered
                        ? (hold === "profile" ? tr("common.try_saving_the_profile_again") : tr("common.try_saving_again"))
                        : tr("common.add_project"))
                      : tr("common.next")}
              </Button>
            </div>
          </footer>
        </form>
      </div>
    </Dialog>
  );
}
