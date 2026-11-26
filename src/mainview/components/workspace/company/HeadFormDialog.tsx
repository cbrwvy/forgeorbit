import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { employeeErrorText, headBody } from "@/lib/employees";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Employee } from "../../../../shared/employees/types.ts";
import { Field, TEXTAREA_CLASS } from "./bits";

interface Props {
  open: boolean;
  head: Employee | null;
  onClose: () => void;
  onSaved: (head: Employee, created: boolean) => void;
}

/**
 * Appoint or edit the Head of Project Management. The owner types the name;
 * it is never generated. The Head stays the Head: this form cannot change the
 * position, and it does not touch the portfolio manager's chat or runtime.
 */
export function HeadFormDialog({ open, head, onClose, onSaved }: Props) {
  useUILocale();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(head?.name ?? "");
    setDescription(head?.description ?? "");
    setError(null);
    setSaving(false);
  }, [open, head]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = headBody({ name, description });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    void api.setHeadEmployee(parsed.body as { name: string; description?: string }).then(
      (result) => {
        setSaving(false);
        onSaved(result.employee, result.created);
      },
      (err: unknown) => {
        setSaving(false);
        setError(employeeErrorText(err));
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="head-form-title" describedBy="head-form-hint" initialFocusRef={nameRef} className="max-w-lg">
      <form onSubmit={onSubmit} className="flex flex-col gap-3" data-testid="head-form">
        <h2 id="head-form-title" className="text-base font-semibold">
          {head ? tr("common.edit_head_of_project_management") : tr("common.appoint_head_of_project_management")}
        </h2>
        <p id="head-form-hint" className="text-xs text-muted-foreground"><I18nText id="employees.you_choose_the_name_it_is_not_generated" />{" "}</p>
        <Field label={tr("common.name")} htmlFor="head-name">
          <Input ref={nameRef} id="head-name" data-testid="head-name" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={tr("common.description")} htmlFor="head-description">
          <textarea id="head-description" data-testid="head-description" className={TEXTAREA_CLASS} rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error && <p role="alert" data-testid="head-form-error" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}><I18nText id="common.cancel" /></Button>
          <Button type="submit" data-testid="head-save" disabled={saving}>
            {saving ? tr("common.saving_23e392") : head ? tr("common.save") : tr("employees.appoint_head")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
