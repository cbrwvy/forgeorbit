import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { projectLabel } from "@/lib/workspace";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { DocKind, ProjectDiscovery } from "../../../../shared/project-discovery.ts";
import {
  DOC_FILE_NAMES,
  emptyInterviewState,
  planInterviewDocs,
  syncTargets,
  validateDocTarget,
  type InterviewState,
} from "../../../../shared/project-interview.ts";
import {
  EMPTY_WIZARD_DRAFT,
  parseProjectMeta,
  projectMetaKey,
  serializeProjectMeta,
  withDocPath,
} from "../../../../shared/project-wizard.ts";
import type { Project } from "../../../../shared/types.ts";
import { ProjectInterview } from "../project-wizard/ProjectInterview";

interface Props {
  project: Project;
  kind: DocKind;
  discovery: ProjectDiscovery;
  existing: { idea: string | null; prd: string | null };
  description: string;
  /** Closes the dialog; the card re-reads the documents afterwards. */
  onClose: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates one missing IDEA.md or PRD.md in a project that already exists
 * (FO-002.1). It is the wizard's AI interview, reused: nothing is sent to an
 * agent until the owner starts it, and the file is written only by the
 * explicit Create button, never over an existing file.
 */
export function CreateProjectDocDialog({ project, kind, discovery, existing, description, onClose }: Props) {
  const { locale: uiLocale } = useUILocale();
  const name = DOC_FILE_NAMES[kind];
  const plan = useMemo(
    () => planInterviewDocs(
      discovery.documentation,
      { ideaPath: existing.idea, prdPath: existing.prd },
      { idea: kind !== "idea", prd: kind !== "prd" },
    ),
    [discovery, existing.idea, existing.prd, kind, uiLocale],
  );
  const [interview, setInterview] = useState<InterviewState | null>(null);
  const [restored, setRestored] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<InterviewState | null>(null);
  stateRef.current = interview;
  const savedJsonRef = useRef<string | null>(null);

  // A draft saved earlier for this folder (by the wizard or this dialog).
  useEffect(() => {
    let cancelled = false;
    void api.loadInterviewDraft(project.path).then(
      ({ state }) => {
        if (cancelled) return;
        if (state) {
          savedJsonRef.current = JSON.stringify(state);
          setInterview(syncTargets(state, plan));
          setRestored(true);
        } else {
          setInterview(emptyInterviewState(project.path, plan));
        }
      },
      (caught) => {
        if (cancelled) return;
        setLoadError(errorText(caught));
        setInterview(emptyInterviewState(project.path, plan));
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path]);

  useEffect(() => {
    if (!interview) return;
    if (interview.messages.length === 0 && !interview.drafts.idea && !interview.drafts.prd) return;
    const json = JSON.stringify(interview);
    if (json === savedJsonRef.current) return;
    const timer = setTimeout(() => {
      savedJsonRef.current = json;
      void api.saveInterviewDraft(interview).catch(() => { savedJsonRef.current = null; });
    }, 600);
    return () => clearTimeout(timer);
  }, [interview]);

  const flush = () => {
    const current = stateRef.current;
    if (!current || (current.messages.length === 0 && !current.drafts.idea && !current.drafts.prd)) return;
    const json = JSON.stringify(current);
    if (json === savedJsonRef.current) return;
    savedJsonRef.current = json;
    void api.saveInterviewDraft(current).catch(() => {});
  };

  const close = () => {
    if (saving) return;
    flush();
    onClose();
  };

  const discard = () => {
    void api.deleteInterviewDraft(project.path).catch(() => {});
    savedJsonRef.current = null;
    setInterview(null);
    onClose();
  };

  const target = interview?.targets[kind] ?? null;
  const content = interview?.drafts[kind]?.trim() ? interview.drafts[kind]! : null;
  const targetProblem = target ? validateDocTarget(target) : tr("common.choose_where_to_save_it");

  const create = async () => {
    if (!interview || !target || !content || targetProblem || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { checks } = await api.checkProjectDocs({ projectPath: project.path, files: [{ kind, path: target }] });
      const blocked = checks.find((check) => check.state !== "free");
      if (blocked) {
        setError(tr("common.nothing_was_overwritten_change_the_path_in_the", { p0: String(blocked.error ?? tr("common.can_t_be_created", { p0: String(blocked.path) })) }));
        return;
      }
      const { results } = await api.writeProjectDocs({
        projectPath: project.path,
        files: [{ kind, path: target, content }],
      });
      const result = results[0];
      if (!result || result.status !== "created") {
        setError(result?.error ?? tr("common.couldn_t_create_your_draft_is_kept", { p0: String(target) }));
        return;
      }
      try {
        const prefs = await api.listPreferences();
        const meta = withDocPath(parseProjectMeta(prefs[projectMetaKey(project.path)]), kind, result.path);
        const serialized = serializeProjectMeta(meta);
        if (serialized) await api.setPreference(projectMetaKey(project.path), serialized);
      } catch (caught) {
        toast.error(tr("common.was_created_but_its_location_could_not_be", { p0: String(name) }), { description: errorText(caught) });
      }
      void api.deleteInterviewDraft(project.path).catch(() => {});
      savedJsonRef.current = null;
      toast.success(tr("common.created_f04822", { p0: String(result.path) }));
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const wizardDraft = useMemo(
    () => ({ ...EMPTY_WIZARD_DRAFT, mode: "import" as const, name: projectLabel(project), description }),
    [project, description, uiLocale],
  );

  return (
    <Dialog
      open
      onClose={close}
      labelledBy="create-doc-title"
      describedBy="create-doc-desc"
      className="glass-elevated flex max-h-[min(52rem,calc(100dvh-2rem))] max-w-3xl flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="create-doc-dialog" data-kind={kind}>
        <header className="border-b border-border px-4 py-3">
          <h2 id="create-doc-title" className="text-base font-semibold tracking-tight"><I18nText id="common.create" />{" "}{kind === "idea" ? "IDEA" : "PRD"}</h2>
          <p id="create-doc-desc" className="text-[11px] text-muted-foreground">
            {name}{" "}<I18nText id="projects.will_be_saved_at" />{" "}{target ?? tr("common.a_path_you_choose")}{" "}<I18nText id="projects.only_when_you_press_create_nothing_is_sent" />{" "}</p>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {loadError && (
            <p role="alert" className="text-xs text-danger" data-testid="create-doc-load-error"><I18nText id="projects.couldn_t_load_a_saved_interview" />{" "}{loadError}<I18nText id="projects.you_can_start_a_new_one" />{" "}</p>
          )}
          {interview ? (
            <ProjectInterview
              workspace
              discovery={discovery}
              draft={wizardDraft}
              plan={plan}
              state={interview}
              restored={restored}
              onChange={(update) => setInterview((current) => (current ? update(current) : current))}
              onBack={close}
              onDiscard={discard}
            />
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="create-doc-loading"><I18nText id="common.loading" /></p>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger" data-testid="create-doc-error">{error}</p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="ghost" onClick={close} disabled={saving} data-testid="create-doc-cancel"><I18nText id="common.close" />{" "}</Button>
          <Button
            type="button"
            onClick={() => { void create(); }}
            disabled={saving || !content || targetProblem != null}
            data-testid="create-doc-submit"
          >
            {saving ? tr("common.creating") : tr("common.create_3aa914", { p0: String(name) })}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
