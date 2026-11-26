import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import type { DocKind, ProjectDiscovery } from "../../../../shared/project-discovery.ts";
import { DOC_FILE_NAMES } from "../../../../shared/project-interview.ts";
import { existingDocPaths, parseProjectMeta, projectMetaKey } from "../../../../shared/project-wizard.ts";
import type { Project } from "../../../../shared/types.ts";
import { CreateProjectDocDialog } from "./CreateProjectDocDialog";

interface Loaded {
  discovery: ProjectDiscovery;
  existing: { idea: string | null; prd: string | null };
  description: string;
}

/**
 * IDEA and PRD for the open project, with a way to create a missing one
 * (FO-002.1). Read-only until the owner opens a create dialog. A project
 * without these documents is complete as it is: every workspace page works.
 */
export function ProjectDocsCard({ project }: { project: Project }) {
  useUILocale();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<DocKind | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([api.discoverProject({ path: project.path }), api.listPreferences()]).then(
      async ([discovery, prefs]) => {
        const meta = parseProjectMeta(prefs[projectMetaKey(project.path)]);
        const unconfirmed = (["idea", "prd"] as const).filter((kind) => meta[kind]);
        const confirmed = { idea: false, prd: false };
        if (unconfirmed.length > 0) {
          const { checks } = await api.checkProjectDocs({
            projectPath: project.path,
            files: unconfirmed.map((kind) => ({ kind, path: meta[kind]! })),
          });
          for (const check of checks) confirmed[check.kind] = check.state === "exists";
        }
        if (cancelled) return;
        setLoaded({
          discovery,
          existing: existingDocPaths(discovery.documentation, meta, confirmed),
          description: meta.description ?? "",
        });
      },
    ).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { cancelled = true; };
  }, [project.path]);

  useEffect(() => {
    setLoaded(null);
    return load();
  }, [load]);

  return (
    <section className="surface-solid overflow-hidden rounded-xl border" data-testid="project-docs-card" aria-labelledby="project-docs-title">
      <div className="flex items-center gap-2 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
        <FileText className="size-3.5 text-muted-foreground" aria-hidden />
        <h3 id="project-docs-title" className="text-sm font-medium"><I18nText id="projects.project_documents" /></h3>
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-xs" role="alert" data-testid="project-docs-error">
          <span className="min-w-0 flex-1 text-danger"><I18nText id="projects.couldn_t_read_the_project_documents" />{" "}{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { setLoaded(null); load(); }} data-testid="project-docs-retry"><I18nText id="projects.try_again" />{" "}</Button>
        </div>
      ) : !loaded ? (
        <p className="px-4 py-3 text-xs text-muted-foreground" data-testid="project-docs-loading"><I18nText id="projects.checking_documents" /></p>
      ) : (
        <>
          <ul>
            {(["idea", "prd"] as const).map((kind) => {
              const path = loaded.existing[kind];
              return (
                <li
                  key={kind}
                  className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 last:border-b-0"
                  data-testid={`project-doc-${kind}`}
                  data-state={path ? "exists" : "missing"}
                >
                  <span className="w-20 shrink-0 text-sm font-medium">{DOC_FILE_NAMES[kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={path ?? undefined} data-testid={`project-doc-${kind}-status`}>
                    {path ?? tr("common.not_created")}
                  </span>
                  {!path && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setCreating(kind)} data-testid={`project-doc-${kind}-create`}><I18nText id="common.create" />{" "}{kind === "idea" ? "IDEA" : "PRD"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {!loaded.existing.idea && !loaded.existing.prd && (
            <p className="border-t border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2 text-[11px] text-muted-foreground" data-testid="project-docs-optional"><I18nText id="projects.these_are_optional_the_manager_board_employees_and" />{" "}</p>
          )}
          {creating && (
            <CreateProjectDocDialog
              project={project}
              kind={creating}
              discovery={loaded.discovery}
              existing={loaded.existing}
              description={loaded.description}
              onClose={() => { setCreating(null); setLoaded(null); load(); }}
            />
          )}
        </>
      )}
    </section>
  );
}
