import { t as tr } from "@/i18n/core";
import { useLocale as useUILocale } from "@/i18n/react";
import { FolderGit2, FolderPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { CloneProjectDialog } from "@/components/kanban/CloneProjectDialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ProjectStats, WorkspaceTask } from "@/lib/workspace";
import { PageHeader } from "./PageHeader";
import { ProjectDirectoryList } from "./WorkspaceOverview";
import type { Cluster } from "../../../shared/clusters/types.ts";
import type { Project } from "../../../shared/types.ts";

interface Props {
  projects: readonly Project[];
  summaries: ReadonlyMap<string, ProjectStats<WorkspaceTask>>;
  homeDir: string;
  onOpenProject: (path: string) => void;
  onOpenCluster: (id: string) => void;
  onOpenGroups: () => void;
  onAddFolder: () => void;
  onProjectsChanged: () => void;
}

/**
 * Projects directory (FO-UX-SIMPLIFY02-M3): every registered project, then the
 * groups (clusters) they are organized into. The portfolio analysis and the
 * full group directory are the two other tabs of this destination.
 */
export function ProjectsDirectory({ projects, summaries, homeDir, onOpenProject, onOpenCluster, onOpenGroups, onAddFolder, onProjectsChanged }: Props) {
  useUILocale();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [clusters, setClusters] = useState<Cluster[] | "loading" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    void api.listClusters().then(
      (result) => { if (!cancelled) setClusters(result.clusters); },
      () => { if (!cancelled) setClusters("failed"); },
    );
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="projects-directory">
      <PageHeader title={tr("nav.projects")} titleTestId="projects-title" subtitle={tr("projectsDir.subtitle", { count: String(projects.length) })}>
        <Button type="button" size="sm" variant="outline" onClick={() => setCloneOpen(true)} data-testid="projects-clone">
          <FolderGit2 className="size-3.5" aria-hidden />{tr("common.clone_repository")}
        </Button>
        <Button type="button" size="sm" onClick={onAddFolder} data-testid="projects-add">
          <FolderPlus className="size-3.5" aria-hidden />{tr("common.add_project")}
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-stack px-4 pb-[calc(2rem+var(--shell-dock-clearance))] sm:px-page">
        <ProjectDirectoryList projects={projects} summaries={summaries} homeDir={homeDir} onOpenProject={onOpenProject} onAddFolder={onAddFolder} />

        <section className="flex flex-col gap-2" data-testid="projects-groups" aria-labelledby="projects-groups-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="projects-groups-heading" className="text-sm font-semibold">{tr("projectsDir.groups")}</h2>
              <p className="text-[length:var(--text-secondary)] text-muted-foreground">{tr("projectsDir.groups_hint")}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onOpenGroups} data-testid="projects-open-groups">{tr("projectsDir.manage_groups")}</Button>
          </div>
          {clusters === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">{tr("common.loading")}</p>
          ) : clusters === "failed" ? (
            <p role="status" className="text-sm text-muted-foreground" data-testid="projects-groups-failed">{tr("projectsDir.groups_failed")}</p>
          ) : clusters.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="projects-groups-empty">{tr("projectsDir.groups_empty")}</p>
          ) : (
            <ul className="surface-solid overflow-hidden rounded-xl border">
              {clusters.map((cluster) => (
                <li key={cluster.id} className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] last:border-b-0">
                  <button type="button" className="glass-nav-item flex w-full items-center gap-3 px-4 py-row text-left" data-testid="projects-group" data-cluster-id={cluster.id} onClick={() => onOpenCluster(cluster.id)}>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{cluster.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{tr("projectsDir.group_projects", { count: String(cluster.projectCount) })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <CloneProjectDialog open={cloneOpen} onClose={() => setCloneOpen(false)} onCloned={() => onProjectsChanged()} />
    </div>
  );
}
