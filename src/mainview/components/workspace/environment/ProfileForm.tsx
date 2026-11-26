import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState, type ReactNode } from "react";
import { useWorkspaceDraft } from "../WorkspaceDrafts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  draftFromProfile,
  emptyDraft,
  profileFromDraft,
  splitArgLines,
  splitServiceNames,
  type ComposeSuggestion,
  type ProfileDraft,
  type PublicLaunchProfile,
} from "@/i18n/environment";
import type { LaunchProfile } from "../../../../shared/environment/types.ts";

interface Props {
  projectPath: string;
  existing: PublicLaunchProfile | null;
  suggestions: ComposeSuggestion[];
  onCancel: () => void;
  onSave: (profile: LaunchProfile) => Promise<void>;
}

export function ProfileForm({ projectPath, existing, suggestions, onCancel, onSave }: Props) {
  useUILocale();
  const key = `profile:${projectPath}:${existing?.id ?? "new"}`;
  const [draft, setDraft, discardDraft] = useWorkspaceDraft<ProfileDraft>(`${key}:draft`, () =>
    existing ? draftFromProfile(existing) : emptyDraft(projectPath, suggestions.length > 0 ? "docker-compose" : "local-process"),
  );
  const [argsText, setArgsText, discardArgs] = useWorkspaceDraft(`${key}:args`, () => (existing ? draftFromProfile(existing).args.join("\n") : ""));
  const [servicesText, setServicesText, discardServices] = useWorkspaceDraft(`${key}:services`, () =>
    existing && existing.launch.kind === "docker-compose" ? existing.launch.services.join(", ") : "",
  );
  const [inheritText, setInheritText, discardInherit] = useWorkspaceDraft(`${key}:inherit`, () => (existing ? draftFromProfile(existing).inherit.join("\n") : ""));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const discard = () => { discardDraft(); discardArgs(); discardServices(); discardInherit(); };
  const patch = (partial: Partial<ProfileDraft>) => setDraft((current) => ({ ...current, ...partial }));

  const save = () => {
    const next: ProfileDraft = {
      ...draft,
      args: splitArgLines(argsText),
      services: splitServiceNames(servicesText),
      inherit: inheritText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
    };
    const validated = profileFromDraft(projectPath, next);
    if (!validated.ok) {
      setError(validated.errors.map((issue) => issue.message).join(" "));
      return;
    }
    setSaving(true);
    setError(null);
    void onSave(validated.profile).then(discard).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    });
  };

  return (
    <form
      className="surface-solid flex flex-col gap-4 rounded-xl border p-4"
      data-testid="profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("common.name")}>
          <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} data-testid="profile-name" required />
        </Field>
        <Field label={tr("common.kind")}>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={draft.kind}
            data-testid="profile-kind"
            onChange={(event) => patch({ kind: event.target.value === "docker-compose" ? "docker-compose" : "local-process" })}
          >
            <option value="local-process"><I18nText id="common.local_process" /></option>
            <option value="docker-compose"><I18nText id="common.docker_compose" /></option>
          </select>
        </Field>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="environment-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.file}
              type="button"
              className="glass-nav-item rounded-md border px-2 py-1 text-xs"
              data-testid="environment-suggestion"
              data-file={suggestion.file}
              onClick={() => {
                patch({
                  kind: "docker-compose",
                  composeFile: suggestion.file,
                  services: suggestion.services,
                });
                setServicesText(suggestion.services.join(", "));
              }}
            ><I18nText id="environment.use" />{" "}{suggestion.file}
            </button>
          ))}
        </div>
      )}

      {draft.kind === "docker-compose" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("common.compose_file")}>
            <Input value={draft.composeFile} onChange={(event) => patch({ composeFile: event.target.value })} data-testid="profile-compose-file" />
          </Field>
          <Field label={tr("common.compose_project_name")}>
            <Input value={draft.projectName} onChange={(event) => patch({ projectName: event.target.value })} data-testid="profile-project-name" />
          </Field>
          <Field label={tr("common.services")}>
            <Input
              value={servicesText}
              onChange={(event) => setServicesText(event.target.value)}
              placeholder={tr("environment.leave_empty_for_every_service")}
              data-testid="profile-services"
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("common.executable")}>
              <Input
                value={draft.executable}
                onChange={(event) => patch({ executable: event.target.value })}
                placeholder="bun"
                data-testid="profile-executable"
              />
            </Field>
            <Field label={tr("common.working_directory")}>
              <Input value={draft.cwd} onChange={(event) => patch({ cwd: event.target.value })} data-testid="profile-cwd" />
            </Field>
          </div>
          <Field label={tr("environment.arguments_one_per_line")}>
            <textarea
              className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
              value={argsText}
              onChange={(event) => setArgsText(event.target.value)}
              placeholder={"run\ndev"}
              data-testid="profile-args"
            />
          </Field>
          <Field label={tr("environment.environment_variables_to_inherit")}>
            <textarea
              className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
              value={inheritText}
              onChange={(event) => setInheritText(event.target.value)}
              placeholder={"PORT\nNODE_ENV"}
              data-testid="profile-inherit"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("common.stop_signal")}>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={draft.signal}
                data-testid="profile-signal"
                onChange={(event) => patch({ signal: event.target.value === "SIGINT" ? "SIGINT" : "SIGTERM" })}
              >
                <option value="SIGTERM">SIGTERM</option>
                <option value="SIGINT">SIGINT</option>
              </select>
            </Field>
            <Field label={tr("common.grace_ms")}>
              <Input
                type="number"
                min={100}
                max={120000}
                value={draft.graceMs}
                onChange={(event) => patch({ graceMs: Number(event.target.value) })}
                data-testid="profile-grace"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.processGroup}
              onChange={(event) => patch({ processGroup: event.target.checked })}
              data-testid="profile-process-group"
            /><I18nText id="environment.stop_the_process_group" />{" "}</label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.killAfterGrace}
              onChange={(event) => patch({ killAfterGrace: event.target.checked })}
              data-testid="profile-kill-after-grace"
            /><I18nText id="common.force_quit_after_the_grace_period" />{" "}</label>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("common.health_url")}>
          <Input value={draft.httpUrl} onChange={(event) => patch({ httpUrl: event.target.value })} placeholder="http://127.0.0.1:3000/" data-testid="profile-http-url" />
        </Field>
        <Field label={tr("common.tcp_port")}>
          <Input value={draft.tcpPort} onChange={(event) => patch({ tcpPort: event.target.value })} placeholder="3000" data-testid="profile-tcp-port" />
        </Field>
        <Field label={tr("common.website")}>
          <Input value={draft.websiteUrl} onChange={(event) => patch({ websiteUrl: event.target.value })} placeholder="http://localhost:3000/" data-testid="profile-website" />
        </Field>
        <Field label="API">
          <Input value={draft.apiUrl} onChange={(event) => patch({ apiUrl: event.target.value })} placeholder="http://127.0.0.1:3000/" data-testid="profile-api" />
        </Field>
        <Field label={tr("environment.admin")}>
          <Input value={draft.adminUrl} onChange={(event) => patch({ adminUrl: event.target.value })} data-testid="profile-admin" />
        </Field>
        <Field label={tr("common.documentation")}>
          <Input value={draft.docsUrl} onChange={(event) => patch({ docsUrl: event.target.value })} data-testid="profile-docs" />
        </Field>
      </div>

      {error && <p className="text-sm text-destructive" data-testid="profile-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving} data-testid="profile-save"><I18nText id="environment.save_profile" />{" "}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { discard(); onCancel(); }} data-testid="profile-cancel"><I18nText id="common.cancel" />{" "}</Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  useUILocale();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
