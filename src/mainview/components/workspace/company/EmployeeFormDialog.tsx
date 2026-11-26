import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import {
  ROLE_CATEGORY_LABELS,
  draftFromEmployee,
  emptyEmployeeDraft,
  employeeErrorText,
  employeeUpdateBody,
  workerCreateBody,
  type EmployeeDraft,
} from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EXAMPLE_JOB_TITLES, ROLE_CATEGORIES, type Employee, type ProjectTeam } from "../../../../shared/employees/types.ts";
import { Field, TEXTAREA_CLASS } from "./bits";

interface Props {
  open: boolean;
  /** Null creates a worker. */
  employee: Employee | null;
  projects: Pick<ProjectTeam, "projectPath" | "projectName">[];
  defaultProjectPath?: string;
  onClose: () => void;
  onSaved: (employee: Employee, created: boolean) => void;
}

/**
 * Create a worker or edit the descriptive fields of an employee. The project
 * is changed with Assign / Unassign on the card, never here, and nothing in
 * this form picks a harness, account, model, or profile.
 */
export function EmployeeFormDialog({ open, employee, projects, defaultProjectPath = "", onClose, onSaved }: Props) {
  useUILocale();
  const firstRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<EmployeeDraft>(emptyEmployeeDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isWorker = employee == null || employee.kind === "worker";

  useEffect(() => {
    if (!open) return;
    setDraft(employee ? draftFromEmployee(employee) : emptyEmployeeDraft(defaultProjectPath));
    setError(null);
    setSaving(false);
  }, [open, employee, defaultProjectPath]);

  const set = <K extends keyof EmployeeDraft>(key: K, value: EmployeeDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = employee ? employeeUpdateBody(employee, draft) : workerCreateBody(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const request = employee ? api.updateEmployee(employee.id, parsed.body) : api.createEmployee(parsed.body);
    void request.then(
      (saved) => {
        setSaving(false);
        onSaved(saved, employee == null);
      },
      (err: unknown) => {
        setSaving(false);
        setError(employeeErrorText(err));
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="employee-form-title" describedBy="employee-form-hint" initialFocusRef={firstRef} className="max-w-lg">
      <form onSubmit={onSubmit} className="flex max-h-[80vh] flex-col gap-3 overflow-y-auto" data-testid="employee-form">
        <h2 id="employee-form-title" className="text-base font-semibold">
          {employee ? tr("common.edit_58bd1a", { p0: String(employee.name) }) : tr("common.new_ai_employee")}
        </h2>
        <p id="employee-form-hint" className="text-xs text-muted-foreground">
          {employee
            ? tr("common.a_job_title_is_a_label_it_does")
            : tr("common.creating_an_employee_adds_an_identity_record_it")}
        </p>
        <Field label={tr("common.name")} htmlFor="employee-name" hint={employee ? undefined : tr("common.optional_empty_draws_a_random_name_that_is")}>
          <Input ref={firstRef} id="employee-name" data-testid="employee-name" value={draft.name} maxLength={80} required={employee != null} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={tr("employees.display_name")} htmlFor="employee-display-name" hint={tr("employees.optional_shown_next_to_the_name")}>
          <Input id="employee-display-name" data-testid="employee-display-name" value={draft.displayName} maxLength={120} onChange={(e) => set("displayName", e.target.value)} />
        </Field>
        <Field label={tr("employees.job_title")} htmlFor="employee-job-title" hint={tr("employees.any_title_examples_are_suggestions_not_a_closed")}>
          <Input id="employee-job-title" data-testid="employee-job-title" list="employee-title-examples" value={draft.jobTitle} maxLength={120} required onChange={(e) => set("jobTitle", e.target.value)} />
        </Field>
        <datalist id="employee-title-examples">
          {EXAMPLE_JOB_TITLES.map((title) => <option key={title} value={title} />)}
        </datalist>
        {isWorker && (
          <Field label={tr("employees.role_category")} htmlFor="employee-role-category">
            <Select id="employee-role-category" data-testid="employee-role-category" value={draft.roleCategory} onChange={(e) => set("roleCategory", e.target.value)}>
              {ROLE_CATEGORIES.map((category) => <option key={category} value={category}>{ROLE_CATEGORY_LABELS[category]}</option>)}
            </Select>
          </Field>
        )}
        <Field label={tr("employees.specializations")} htmlFor="employee-specializations" hint={tr("employees.separate_with_commas_labels_only_not_verified_skills")}>
          <Input id="employee-specializations" data-testid="employee-specializations" value={draft.specializations} onChange={(e) => set("specializations", e.target.value)} />
        </Field>
        {!employee && (
          <Field label={tr("common.project_985959")} htmlFor="employee-project" hint={tr("employees.optional_assigning_a_project_does_not_start_anything")}>
            <Select id="employee-project" data-testid="employee-project" value={draft.projectPath} onChange={(e) => set("projectPath", e.target.value)}>
              <option value=""><I18nText id="common.no_project" /></option>
              {projects.map((project) => <option key={project.projectPath} value={project.projectPath}>{project.projectName}</option>)}
            </Select>
          </Field>
        )}
        <Field label={tr("employees.department")} htmlFor="employee-department" hint={tr("employees.optional")}>
          <Input id="employee-department" data-testid="employee-department" value={draft.department} maxLength={80} onChange={(e) => set("department", e.target.value)} />
        </Field>
        <Field label={tr("common.description")} htmlFor="employee-description">
          <textarea id="employee-description" data-testid="employee-description" className={TEXTAREA_CLASS} rows={3} maxLength={4000} value={draft.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <Field label={tr("common.notes")} htmlFor="employee-notes" hint={tr("employees.optional_private_notes")}>
          <textarea id="employee-notes" data-testid="employee-notes" className={TEXTAREA_CLASS} rows={2} maxLength={4000} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        {employee && employee.status !== "archived" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" data-testid="employee-paused" checked={draft.status === "inactive"} onChange={(e) => set("status", e.target.checked ? "inactive" : "active")} />
            <span><I18nText id="employees.paused_a_label_for_the_owner_nothing_is" /></span>
          </label>
        )}
        {error && <p role="alert" data-testid="employee-form-error" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}><I18nText id="common.cancel" /></Button>
          <Button type="submit" data-testid="employee-save" disabled={saving}>
            {saving ? tr("common.saving_23e392") : employee ? tr("common.save") : tr("common.create_employee")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
