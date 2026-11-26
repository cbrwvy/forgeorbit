import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  INFRASTRUCTURE_ENVIRONMENTS,
  INFRASTRUCTURE_ENVIRONMENT_LABELS,
  INFRASTRUCTURE_STATUSES,
  INFRASTRUCTURE_TYPES,
  INFRASTRUCTURE_TYPE_LABELS,
  infrastructureStatusLabel,
  parseInfrastructureCreate,
  parseInfrastructureUpdate,
  type InfrastructureResource,
  type InfrastructureStatus,
} from "@/i18n/infrastructure";

interface Draft {
  name: string;
  resourceType: string;
  provider: string;
  description: string;
  hostname: string;
  ipAddress: string;
  environment: string;
  environmentCustom: string;
  region: string;
  costAmount: string;
  currency: string;
  status: InfrastructureStatus;
  notes: string;
}

const EMPTY: Draft = {
  name: "",
  resourceType: "",
  provider: "",
  description: "",
  hostname: "",
  ipAddress: "",
  environment: "",
  environmentCustom: "",
  region: "",
  costAmount: "",
  currency: "",
  status: "not-verified",
  notes: "",
};

function fromResource(resource: InfrastructureResource): Draft {
  return {
    name: resource.name,
    resourceType: resource.resourceType,
    provider: resource.provider ?? "",
    description: resource.description,
    hostname: resource.hostname ?? "",
    ipAddress: resource.ipAddress ?? "",
    environment: resource.environment ?? "",
    environmentCustom: resource.environmentCustom ?? "",
    region: resource.region ?? "",
    costAmount: resource.costAmount ?? "",
    currency: resource.currency ?? "",
    status: resource.status,
    notes: resource.notes,
  };
}

function infrastructureErrorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return tr("common.couldn_t_reach_the_infrastructure_inventory");
}

function payload(draft: Draft): Record<string, unknown> {
  return {
    name: draft.name,
    resourceType: draft.resourceType,
    provider: draft.provider || null,
    description: draft.description,
    hostname: draft.hostname || null,
    ipAddress: draft.ipAddress || null,
    environment: draft.environment || null,
    environmentCustom: draft.environment === "custom" ? draft.environmentCustom || null : null,
    region: draft.region || null,
    costAmount: draft.costAmount || null,
    currency: draft.currency || null,
    status: draft.status,
    notes: draft.notes,
  };
}

interface Props {
  open: boolean;
  resource: InfrastructureResource | null;
  clusterId?: string;
  clusterName?: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create or edit a declared infrastructure record. The server checks the
 * body again. Saving does not contact the resource.
 */
export function ResourceFormDialog({ open, resource, clusterId, clusterName, onClose, onSaved }: Props) {
  useUILocale();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(resource ? fromResource(resource) : EMPTY);
    setError(null);
    setSaving(false);
  }, [open, resource]);

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const body = payload(draft);
    if (resource) {
      const parsed = parseInfrastructureUpdate(body);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setSaving(true);
      void api.updateInfrastructure(resource.id, parsed.value as unknown as Record<string, unknown>).then(
        () => {
          setSaving(false);
          onSaved();
        },
        (err: unknown) => {
          setSaving(false);
          setError(infrastructureErrorText(err));
        },
      );
      return;
    }
    const parsed = parseInfrastructureCreate({
      ...body,
      clusterIds: clusterId ? [clusterId] : [],
      projectPaths: [],
    });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    void api.createInfrastructure(parsed.value as unknown as Record<string, unknown>).then(
      () => {
        setSaving(false);
        onSaved();
      },
      (err: unknown) => {
        setSaving(false);
        setError(infrastructureErrorText(err));
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="resource-form-title" describedBy="resource-form-hint" initialFocusRef={nameRef} className="max-w-lg">
      <form onSubmit={onSubmit} className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto pr-1">
        <h2 id="resource-form-title" className="text-base font-semibold">{resource ? tr("common.edit_resource") : tr("projects.new_resource")}</h2>
        <p id="resource-form-hint" className="text-xs text-muted-foreground"><I18nText id="projects.this_records_what_you_type_it_does_not" />{" "}{clusterName ? tr("common.the_new_record_is_assigned_to_without_copying", { p0: String(clusterName) }) : ""}
        </p>
        <Field label={tr("common.name")} htmlFor="resource-form-name">
          <Input id="resource-form-name" ref={nameRef} data-testid="resource-form-name" value={draft.name} onChange={(event) => set("name")(event.target.value)} required />
        </Field>
        <Field label={tr("projects.resource_type")} htmlFor="resource-form-type">
          <Select id="resource-form-type" testId="resource-form-type" value={draft.resourceType} onChange={set("resourceType")}>
            <option value=""><I18nText id="projects.choose_a_type" /></option>
            {INFRASTRUCTURE_TYPES.map((type) => (
              <option key={type} value={type}>{INFRASTRUCTURE_TYPE_LABELS[type]}</option>
            ))}
          </Select>
        </Field>
        <Field label={tr("common.provider")} htmlFor="resource-form-provider">
          <Input id="resource-form-provider" data-testid="resource-form-provider" value={draft.provider} onChange={(event) => set("provider")(event.target.value)} placeholder={tr("projects.optional")} />
        </Field>
        <Field label={tr("common.description")} htmlFor="resource-form-description">
          <textarea id="resource-form-description" data-testid="resource-form-description" className={areaClass} value={draft.description} onChange={(event) => set("description")(event.target.value)} rows={2} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={tr("projects.hostname")} htmlFor="resource-form-hostname">
            <Input id="resource-form-hostname" data-testid="resource-form-hostname" value={draft.hostname} onChange={(event) => set("hostname")(event.target.value)} placeholder={tr("projects.optional")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <Field label={tr("projects.ip_address")} htmlFor="resource-form-ip">
            <Input id="resource-form-ip" data-testid="resource-form-ip" value={draft.ipAddress} onChange={(event) => set("ipAddress")(event.target.value)} placeholder={tr("projects.optional")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={tr("common.environment")} htmlFor="resource-form-environment">
            <Select id="resource-form-environment" testId="resource-form-environment" value={draft.environment} onChange={set("environment")}>
              <option value=""><I18nText id="projects.not_recorded" /></option>
              {INFRASTRUCTURE_ENVIRONMENTS.map((environment) => (
                <option key={environment} value={environment}>{INFRASTRUCTURE_ENVIRONMENT_LABELS[environment]}</option>
              ))}
            </Select>
          </Field>
          {draft.environment === "custom" && (
            <Field label={tr("projects.custom_environment")} htmlFor="resource-form-custom">
              <Input id="resource-form-custom" data-testid="resource-form-custom" value={draft.environmentCustom} onChange={(event) => set("environmentCustom")(event.target.value)} />
            </Field>
          )}
        </div>
        <Field label={tr("projects.region")} htmlFor="resource-form-region">
          <Input id="resource-form-region" data-testid="resource-form-region" value={draft.region} onChange={(event) => set("region")(event.target.value)} placeholder={tr("projects.optional")} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={tr("projects.cost")} htmlFor="resource-form-cost">
            <Input id="resource-form-cost" data-testid="resource-form-cost" value={draft.costAmount} onChange={(event) => set("costAmount")(event.target.value)} placeholder={tr("projects.optional")} inputMode="decimal" />
          </Field>
          <Field label={tr("common.currency")} htmlFor="resource-form-currency">
            <Input id="resource-form-currency" data-testid="resource-form-currency" value={draft.currency} maxLength={3} onChange={(event) => set("currency")(event.target.value.toUpperCase())} placeholder={tr("projects.optional")} autoCapitalize="characters" />
          </Field>
        </div>
        <Field label={tr("common.status")} htmlFor="resource-form-status">
          <Select id="resource-form-status" testId="resource-form-status" value={draft.status} onChange={(value) => set("status")(value)}>
            {INFRASTRUCTURE_STATUSES.map((status) => (
              <option key={status} value={status}>{infrastructureStatusLabel(status)}</option>
            ))}
          </Select>
        </Field>
        <Field label={tr("common.notes")} htmlFor="resource-form-notes">
          <textarea id="resource-form-notes" data-testid="resource-form-notes" className={areaClass} value={draft.notes} onChange={(event) => set("notes")(event.target.value)} rows={3} />
        </Field>
        {error && <p role="alert" data-testid="resource-form-error" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}><I18nText id="common.cancel" /></Button>
          <Button type="submit" data-testid="resource-form-save" disabled={saving}>{saving ? tr("common.saving_23e392") : tr("common.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  useUILocale();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

function Select({
  id,
  testId,
  value,
  onChange,
  children,
}: {
  id: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  useUILocale();
  return (
    <select id={id} data-testid={testId} className={selectClass} value={value} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
}

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const areaClass = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
