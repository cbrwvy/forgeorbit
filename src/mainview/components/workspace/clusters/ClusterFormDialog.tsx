import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { clusterErrorText, clusterWriteBody, draftFromCluster, emptyClusterDraft, type ClusterDraft } from "@/lib/clusters";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Cluster } from "../../../../shared/clusters/types.ts";

interface Props {
  open: boolean;
  cluster: Cluster | null;
  onClose: () => void;
  onSaved: (cluster: Cluster) => void;
}

/**
 * Create or edit a cluster. The server validates the body. Duplicate display
 * names are allowed. This does not create a manager or any infrastructure.
 */
export function ClusterFormDialog({ open, cluster, onClose, onSaved }: Props) {
  useUILocale();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ClusterDraft>(emptyClusterDraft());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(cluster ? draftFromCluster(cluster) : emptyClusterDraft());
    setError(null);
    setSaving(false);
  }, [open, cluster]);

  const set = (key: keyof ClusterDraft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = clusterWriteBody(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const request = cluster
      ? api.updateCluster(cluster.id, parsed.body)
      : api.createCluster(parsed.body);
    void request.then(
      (saved) => {
        setSaving(false);
        onSaved(saved);
      },
      (err: unknown) => {
        setSaving(false);
        setError(clusterErrorText(err));
      },
    );
  };

  const colorPicker = /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : "#64748b";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="cluster-form-title"
      describedBy="cluster-form-hint"
      initialFocusRef={nameRef}
      className="max-w-lg"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <h2 id="cluster-form-title" className="text-base font-semibold">
          {cluster ? tr("common.edit_cluster") : tr("clusters.new_cluster")}
        </h2>
        <p id="cluster-form-hint" className="text-xs text-muted-foreground"><I18nText id="clusters.a_cluster_can_be_empty_creating_one_does" />{" "}</p>
        <Field label={tr("common.name")} htmlFor="cluster-name">
          <Input
            ref={nameRef}
            id="cluster-name"
            data-testid="cluster-name"
            value={draft.name}
            required
            maxLength={120}
            onChange={(event) => set("name")(event.target.value)}
          />
        </Field>
        <Field label={tr("common.description")} htmlFor="cluster-description">
          <textarea
            id="cluster-description"
            data-testid="cluster-description"
            value={draft.description}
            rows={3}
            maxLength={4000}
            onChange={(event) => set("description")(event.target.value)}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Field>
        <Field label={tr("clusters.slug")} htmlFor="cluster-slug" hint={tr("clusters.optional_leave_empty_for_none")}>
          <Input
            id="cluster-slug"
            data-testid="cluster-slug"
            value={draft.slug}
            placeholder="optional-slug"
            onChange={(event) => set("slug")(event.target.value)}
          />
        </Field>
        <Field label={tr("clusters.color")} htmlFor="cluster-color" hint={tr("clusters.optional_hex_such_as_336699")}>
          <div className="flex items-center gap-2">
            <Input
              id="cluster-color"
              data-testid="cluster-color"
              value={draft.color}
              placeholder="#336699"
              onChange={(event) => set("color")(event.target.value)}
            />
            <input
              type="color"
              aria-label={tr("clusters.pick_color")}
              value={colorPicker}
              onChange={(event) => set("color")(event.target.value)}
              className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent"
            />
          </div>
        </Field>
        <Field label={tr("clusters.icon")} htmlFor="cluster-icon" hint={tr("clusters.optional_short_id_such_as_layers")}>
          <Input
            id="cluster-icon"
            data-testid="cluster-icon"
            value={draft.icon}
            placeholder="layers"
            onChange={(event) => set("icon")(event.target.value)}
          />
        </Field>
        <Field label={tr("common.priority")} htmlFor="cluster-priority" hint={tr("clusters.optional_whole_number_empty_means_unset_not_zero")}>
          <Input
            id="cluster-priority"
            data-testid="cluster-priority"
            inputMode="numeric"
            value={draft.priority}
            placeholder={tr("common.unset")}
            onChange={(event) => set("priority")(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" data-testid="cluster-form-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}><I18nText id="common.cancel" />{" "}</Button>
          <Button type="submit" data-testid="cluster-save" disabled={saving}>
            {saving ? tr("common.saving_23e392") : cluster ? tr("common.save") : tr("common.create_cluster")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  useUILocale();
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
