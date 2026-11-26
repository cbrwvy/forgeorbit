import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { api } from "@/lib/api";
import { employeeErrorText, isCurrentRequest } from "@/lib/employees";
import { subscribePortfolioRefresh } from "@/lib/portfolio-events";
import { Button } from "@/components/ui/button";
import type { ProjectTeam } from "../../../../shared/employees/types.ts";
import { StatusBadge } from "./bits";

interface Props {
  projectPath: string;
  onOpenEmployee: (id: string) => void;
  onOpenTeam: (projectPath: string) => void;
}

const SHOWN = 6;

/**
 * The project's Project Manager and employees, read from the employee API.
 * Reading never creates a manager or draws a name. A project can be moved
 * between clusters without touching anything shown here.
 */
export function ProjectTeamSection({ projectPath, onOpenEmployee, onOpenTeam }: Props) {
  useUILocale();
  const [team, setTeam] = useState<ProjectTeam | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    setTeam(null);
    let disposed = false;
    const load = () => {
      const requestId = ++requestRef.current;
      void api.getProjectTeam(projectPath).then(
        (loaded) => {
          if (disposed || !isCurrentRequest(requestId, requestRef.current)) return;
          setTeam(loaded);
          setError(null);
        },
        (err: unknown) => {
          if (disposed || !isCurrentRequest(requestId, requestRef.current)) return;
          setError(employeeErrorText(err));
        },
      );
    };
    load();
    const unsubscribe = subscribePortfolioRefresh(() => load());
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", load);
    };
  }, [projectPath]);

  return (
    <section className="surface-solid overflow-hidden rounded-xl border" aria-label={tr("employees.project_team")} data-testid="project-team">
      <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5">
        <h3 className="text-sm font-medium"><I18nText id="employees.team" /></h3>
        <Button type="button" variant="ghost" size="sm" data-testid="project-team-open" onClick={() => onOpenTeam(projectPath)}>
          <Users className="size-3.5" aria-hidden /><I18nText id="employees.open_in_company" />{" "}</Button>
      </div>
      {error ? (
        <p role="alert" data-testid="project-team-error" className="px-4 py-4 text-sm text-destructive">{error}</p>
      ) : !team ? (
        <p data-testid="project-team-loading" className="px-4 py-4 text-sm text-muted-foreground"><I18nText id="employees.loading_team" /></p>
      ) : (
        <div className="flex flex-col">
          {team.projectManager && (
            <div className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] px-4 py-2.5 last:border-b-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground"><I18nText id="headPm.unified.legacy" /></p>
              <button type="button" className="glass-nav-item mt-0.5 flex max-w-full items-center gap-2 rounded px-1 text-left" data-testid="project-team-manager" onClick={() => onOpenEmployee(team.projectManager!.id)}>
                <span className="truncate text-sm font-medium" title={team.projectManager.name}>{team.projectManager.name}</span>
                <StatusBadge employee={team.projectManager} />
              </button>
            </div>
          )}
          {team.employees.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="project-team-empty"><I18nText id="employees.no_employees_assigned_to_this_project" /></p>
          ) : (
            <ul>
              {team.employees.slice(0, SHOWN).map((employee) => (
                <li key={employee.id} className="border-b border-[hsl(var(--glass-border)/var(--glass-border-alpha))] last:border-b-0">
                  <button type="button" className="glass-nav-item flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left" data-testid="project-team-employee" data-employee-id={employee.id} onClick={() => onOpenEmployee(employee.id)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm" title={employee.name}>{employee.name}</span>
                      <span className="block truncate text-xs text-muted-foreground" title={employee.jobTitle}>{employee.jobTitle}</span>
                    </span>
                    <StatusBadge employee={employee} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {team.employees.length > SHOWN && (
            <p className="px-4 py-2 text-xs text-muted-foreground" data-testid="project-team-more"><I18nText id="employees.and" />{" "}{team.employees.length - SHOWN}{" "}<I18nText id="employees.more_in_company" /></p>
          )}
        </div>
      )}
    </section>
  );
}
