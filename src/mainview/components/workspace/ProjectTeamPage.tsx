import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { ProjectTeamSection } from "@/components/workspace/company/ProjectTeamSection";
import { AssignmentProposals } from "@/components/workspace/company/AssignmentProposals";
import { HiringProposals } from "@/components/workspace/company/HiringProposals";
import type { Project } from "../../../shared/types.ts";

interface Props {
  project: Project;
  onOpenEmployee: (id: string) => void;
  onOpenTeam: (projectPath: string) => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * The project's Team tab (FO-UX-SIMPLIFY02-M5). It only places the existing team,
 * hiring-proposal and assignment-proposal components (the same ones the Manager
 * aside renders, reading the same employee API): no second editor, list or state.
 * Opening this tab approves, assigns and hires nothing.
 */
export function ProjectTeamPage({ project, onOpenEmployee, onOpenTeam, onOpenTask }: Props) {
  useUILocale();
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-stack overflow-y-auto px-page pb-[calc(1.25rem+var(--shell-dock-clearance))] pt-5 [&>*]:shrink-0"
      data-testid="project-team-page"
    >
      <p className="text-xs text-muted-foreground"><I18nText id="m5.team.hint" /></p>
      <ProjectTeamSection projectPath={project.path} onOpenEmployee={onOpenEmployee} onOpenTeam={onOpenTeam} />
      <HiringProposals projectPath={project.path} onOpenEmployee={onOpenEmployee} />
      <AssignmentProposals projectPath={project.path} onOpenEmployee={onOpenEmployee} onOpenTask={onOpenTask} />
    </div>
  );
}
