import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { defaultComposeProjectName, splitArgLines, splitServiceNames, type ProfileDraft } from "@/i18n/environment";
import {
  COMPOSE_NAME_NOTE,
  MAKE_STOP_WARNING,
  isMakeDraft,
  type LaunchSuggestion,
} from "../../../../shared/wizard-launch.ts";

interface Props {
  projectPath: string;
  suggestions: LaunchSuggestion[];
  note: string;
  choice: string;
  draft: ProfileDraft | null;
  onChoose: (choiceId: string) => void;
  onDraft: (draft: ProfileDraft) => void;
}

export function LaunchProfileStep({ projectPath, suggestions, note, choice, draft, onChoose, onDraft }: Props) {
  useUILocale();
  return (
    <div className="space-y-3" data-testid="wizard-launch" data-choice={choice} data-suggestions={suggestions.length}>
      <div className="space-y-1">
        <h3 className="text-sm font-medium"><I18nText id="projects.development_environment" /></h3>
        <p className="text-[11px] text-muted-foreground" data-testid="wizard-launch-note">{note}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium"><I18nText id="projects.detected_development_environments" /></legend>
        <Option
          checked={choice === "skip"}
          label={tr("projects.skip_for_now")}
          detail="Add the project without a launch profile. Fine for projects that don't run code. You can create one later on the Environment page."
          testId="wizard-launch-skip"
          onSelect={() => onChoose("skip")}
        />
        {suggestions.map((suggestion) => (
          <Option
            key={suggestion.id}
            checked={choice === suggestion.id}
            label={suggestion.title}
            detail={suggestion.detail}
            testId="wizard-launch-option"
            suggestionId={suggestion.id}
            onSelect={() => onChoose(suggestion.id)}
          />
        ))}
        <Option
          checked={choice === "manual"}
          label={tr("projects.configure_manually")}
          detail="Set the executable and arguments yourself. Nothing is run from this step."
          testId="wizard-launch-manual"
          onSelect={() => onChoose("manual")}
        />
      </fieldset>

      {choice !== "skip" && draft && (
        <LaunchEditor
          key={`${choice}:${draft.id}`}
          projectPath={projectPath}
          draft={draft}
          warning={isMakeDraft(draft) ? MAKE_STOP_WARNING : null}
          onDraft={onDraft}
        />
      )}
    </div>
  );
}

function Option({
  checked,
  label,
  detail,
  testId,
  suggestionId,
  onSelect,
}: {
  checked: boolean;
  label: string;
  detail: string;
  testId: string;
  suggestionId?: string;
  onSelect: () => void;
}) {
  useUILocale();
  return (
    <label
      className={cn(
        "glass-nav-item flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2",
        checked && "glass-selected",
      )}
      data-testid={testId}
      data-id={suggestionId}
    >
      <input
        type="radio"
        name="wizard-launch-choice"
        className="mt-0.5"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block break-words text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

function LaunchEditor({
  projectPath,
  draft,
  warning,
  onDraft,
}: {
  projectPath: string;
  draft: ProfileDraft;
  warning: string | null;
  onDraft: (draft: ProfileDraft) => void;
}) {
  useUILocale();
  const [argsText, setArgsText] = useState(draft.args.join("\n"));
  const [servicesText, setServicesText] = useState(draft.services.join(", "));
  const patch = (partial: Partial<ProfileDraft>) => onDraft({ ...draft, ...partial });

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="wizard-launch-editor">
      <p className="text-[11px] text-muted-foreground"><I18nText id="projects.check_this_draft_before_you_continue_confirm_saves" />{" "}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={tr("projects.profile_name")} htmlFor="wizard-launch-name">
          <Input
            id="wizard-launch-name"
            data-testid="wizard-launch-name"
            value={draft.name}
            autoComplete="off"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <Field label={tr("common.kind")} htmlFor="wizard-launch-kind">
          <select
            id="wizard-launch-kind"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            data-testid="wizard-launch-kind"
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value === "docker-compose" ? "docker-compose" : "local-process";
              patch({
                kind,
                ...(kind === "docker-compose" && draft.projectName.trim() === ""
                  ? { projectName: defaultComposeProjectName(projectPath) }
                  : {}),
                ...(kind === "docker-compose" && draft.composeFile.trim() === ""
                  ? { composeFile: "compose.yaml" }
                  : {}),
              });
            }}
          >
            <option value="local-process"><I18nText id="common.local_process" /></option>
            <option value="docker-compose"><I18nText id="common.docker_compose" /></option>
          </select>
        </Field>
      </div>

      <Field label={tr("common.working_directory")} htmlFor="wizard-launch-cwd" hint={tr("projects.must_stay_inside_the_project_folder")}>
        <Input
          id="wizard-launch-cwd"
          data-testid="wizard-launch-cwd"
          value={draft.cwd}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => patch({ cwd: event.target.value })}
        />
      </Field>

      {draft.kind === "docker-compose" ? (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground" data-testid="wizard-launch-compose-note">{staticLabel(COMPOSE_NAME_NOTE)}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={tr("common.compose_file")} htmlFor="wizard-launch-compose-file">
              <Input
                id="wizard-launch-compose-file"
                data-testid="wizard-launch-compose-file"
                value={draft.composeFile}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => patch({ composeFile: event.target.value })}
              />
            </Field>
            <Field label={tr("common.compose_project_name")} htmlFor="wizard-launch-project-name">
              <Input
                id="wizard-launch-project-name"
                data-testid="wizard-launch-project-name"
                value={draft.projectName}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => patch({ projectName: event.target.value })}
              />
            </Field>
          </div>
          <Field
            label={tr("common.services")}
            htmlFor="wizard-launch-services"
            hint={draft.services.length === 0
              ? tr("common.none_detected_leave_this_blank_to_include_every")
              : tr("common.detected_from_the_compose_file_edit_the_list")}
          >
            <Input
              id="wizard-launch-services"
              data-testid="wizard-launch-services"
              value={servicesText}
              autoComplete="off"
              spellCheck={false}
              placeholder={tr("projects.web_worker")}
              onChange={(event) => {
                setServicesText(event.target.value);
                patch({ services: splitServiceNames(event.target.value) });
              }}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground"><I18nText id="projects.stop_strategy_docker_compose_stop_forgeorbit_only_stops" /></p>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label={tr("common.executable")} htmlFor="wizard-launch-executable" hint={tr("projects.a_program_name_or_an_absolute_path_not")}>
            <Input
              id="wizard-launch-executable"
              data-testid="wizard-launch-executable"
              value={draft.executable}
              autoComplete="off"
              spellCheck={false}
              placeholder="bun"
              onChange={(event) => patch({ executable: event.target.value })}
            />
          </Field>
          <Field label={tr("projects.arguments")} htmlFor="wizard-launch-args" hint={tr("projects.one_argument_per_line_they_are_passed_as")}>
            <Textarea
              id="wizard-launch-args"
              data-testid="wizard-launch-args"
              value={argsText}
              rows={3}
              className="min-h-0 font-mono text-xs"
              spellCheck={false}
              onChange={(event) => {
                setArgsText(event.target.value);
                patch({ args: splitArgLines(event.target.value) });
              }}
            />
          </Field>
          <div data-testid="wizard-launch-argv" className="break-words text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground"><I18nText id="projects.command" />{" "}</span>
            <span data-testid="wizard-launch-argv-executable">{draft.executable || tr("common.executable_not_set")}</span>
            {draft.args.map((arg, index) => (
              <span key={`${index}:${arg}`} data-testid="wizard-launch-argv-arg"> {arg}</span>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={tr("common.stop_signal")} htmlFor="wizard-launch-signal">
              <select
                id="wizard-launch-signal"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                data-testid="wizard-launch-signal"
                value={draft.signal}
                onChange={(event) => patch({ signal: event.target.value === "SIGINT" ? "SIGINT" : "SIGTERM" })}
              >
                <option value="SIGTERM">SIGTERM</option>
                <option value="SIGINT">SIGINT</option>
              </select>
            </Field>
            <Field label={tr("common.grace_ms")} htmlFor="wizard-launch-grace">
              <Input
                id="wizard-launch-grace"
                type="number"
                min={100}
                max={120000}
                data-testid="wizard-launch-grace"
                value={draft.graceMs}
                onChange={(event) => patch({ graceMs: Number(event.target.value) })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.processGroup}
              data-testid="wizard-launch-process-group"
              onChange={(event) => patch({ processGroup: event.target.checked })}
            /><I18nText id="projects.signal_the_process_group" />{" "}</label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.killAfterGrace}
              data-testid="wizard-launch-kill-after-grace"
              onChange={(event) => patch({ killAfterGrace: event.target.checked })}
            /><I18nText id="common.force_quit_after_the_grace_period" />{" "}</label>
          {warning && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning" data-testid="wizard-launch-warning">
              {warning}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={tr("common.health_url")} htmlFor="wizard-launch-http" hint={tr("projects.optional_leave_blank_when_you_don_t_know")}>
          <Input
            id="wizard-launch-http"
            data-testid="wizard-launch-http"
            value={draft.httpUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:3000/"
            onChange={(event) => patch({ httpUrl: event.target.value })}
          />
        </Field>
        <Field label={tr("common.tcp_port")} htmlFor="wizard-launch-tcp" hint={tr("projects.optional_loopback_only_and_only_if_you_set")}>
          <Input
            id="wizard-launch-tcp"
            data-testid="wizard-launch-tcp"
            value={draft.tcpPort}
            autoComplete="off"
            inputMode="numeric"
            placeholder="3000"
            onChange={(event) => patch({ tcpPort: event.target.value })}
          />
        </Field>
        <Field label={tr("common.website")} htmlFor="wizard-launch-website">
          <Input
            id="wizard-launch-website"
            data-testid="wizard-launch-website"
            value={draft.websiteUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:3000/"
            onChange={(event) => patch({ websiteUrl: event.target.value })}
          />
        </Field>
        <Field label="API" htmlFor="wizard-launch-api">
          <Input
            id="wizard-launch-api"
            data-testid="wizard-launch-api"
            value={draft.apiUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:3000/"
            onChange={(event) => patch({ apiUrl: event.target.value })}
          />
        </Field>
      </div>
    </div>
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
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
