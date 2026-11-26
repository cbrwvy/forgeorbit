import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import type { ReactNode, RefObject } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { knownText } from "@/lib/known-text";
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  formatGit,
  formatStacks,
  type DocKind,
  type ProjectDiscovery,
} from "../../../../shared/project-discovery.ts";
import {
  reviewChanges,
  reviewRows,
  type PlannedDocWrite,
  type ReviewEnvironment,
  type WizardDraft,
} from "../../../../shared/project-wizard.ts";
import { DOC_FILE_NAMES, type InterviewPlan, type InterviewState } from "../../../../shared/project-interview.ts";
import type { DocTargetCheck, DocWriteResult } from "@/lib/api";

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
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Choice({
  checked,
  name,
  label,
  detail,
  testId,
  onSelect,
}: {
  checked: boolean;
  name: string;
  label: string;
  detail: string;
  testId: string;
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
    >
      <input
        type="radio"
        name={name}
        className="mt-0.5"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </label>
  );
}

export function ProjectStep({
  draft,
  nameRef,
  browsing,
  onChange,
  onNameTouched,
  onBrowse,
}: {
  draft: WizardDraft;
  nameRef: RefObject<HTMLInputElement | null>;
  browsing: boolean;
  onChange: (patch: Partial<WizardDraft>) => void;
  onNameTouched: () => void;
  onBrowse: () => void;
}) {
  useUILocale();
  const creating = draft.mode === "create";
  const newFolder = creating && draft.placement === "new-folder";
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium"><I18nText id="projects.how_should_this_project_be_added" /></legend>
        <Choice
          checked={draft.mode === "import"}
          name="wizard-mode"
          label={tr("projects.import_existing_project")}
          detail={knownText("Use a folder that is already on this Mac. Nothing in it will be changed.")}
          testId="wizard-mode-import"
          onSelect={() => onChange({ mode: "import" })}
        />
        <Choice
          checked={creating}
          name="wizard-mode"
          label={tr("projects.create_new_project")}
          detail={knownText("Start from an empty folder, or create a new folder in a place you choose.")}
          testId="wizard-mode-create"
          onSelect={() => onChange({ mode: "create" })}
        />
      </fieldset>

      {creating && (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium"><I18nText id="projects.where_should_it_live" /></legend>
          <Choice
            checked={draft.placement === "existing"}
            name="wizard-placement"
            label={tr("projects.use_an_empty_folder")}
            detail={tr("common.pick_a_folder_that_is_already_empty")}
            testId="wizard-placement-existing"
            onSelect={() => onChange({ placement: "existing" })}
          />
          <Choice
            checked={draft.placement === "new-folder"}
            name="wizard-placement"
            label={tr("projects.create_a_new_folder")}
            detail={tr("common.pick_the_parent_then_name_the_new_folder")}
            testId="wizard-placement-new-folder"
            onSelect={() => onChange({ placement: "new-folder" })}
          />
        </fieldset>
      )}

      <Field label={tr("projects.project_name")} htmlFor="wizard-name">
        <Input
          id="wizard-name"
          ref={nameRef}
          data-testid="wizard-name"
          value={draft.name}
          maxLength={PROJECT_NAME_MAX}
          autoComplete="off"
          onChange={(event) => {
            onNameTouched();
            onChange({ name: event.target.value });
          }}
        />
      </Field>

      <Field
        label={newFolder ? tr("common.parent_folder") : tr("common.project_folder")}
        htmlFor="wizard-directory"
        hint={tr("projects.a_full_path_browse_opens_the_folder_panel")}
      >
        <div className="flex gap-2">
          <Input
            id="wizard-directory"
            data-testid="wizard-directory"
            value={draft.directory}
            autoComplete="off"
            spellCheck={false}
            placeholder="/Users/you/Projects/orbit"
            onChange={(event) => onChange({ directory: event.target.value })}
          />
          <Button
            type="button"
            variant="outline"
            onClick={onBrowse}
            disabled={browsing}
            data-testid="wizard-browse"
          >
            <FolderOpen className="size-3.5" aria-hidden />
            {browsing ? tr("common.opening") : tr("common.browse")}
          </Button>
        </div>
      </Field>

      {newFolder && (
        <Field label={tr("projects.new_folder_name")} htmlFor="wizard-folder-name">
          <Input
            id="wizard-folder-name"
            data-testid="wizard-folder-name"
            value={draft.folderName}
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ folderName: event.target.value })}
          />
        </Field>
      )}

      <Field label={tr("common.description")} htmlFor="wizard-description" hint={tr("projects.optional_stored_in_forgeorbit_not_written_into_the")}>
        <Textarea
          id="wizard-description"
          data-testid="wizard-description"
          value={draft.description}
          maxLength={PROJECT_DESCRIPTION_MAX}
          rows={2}
          className="min-h-0"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </Field>
    </div>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }) {
  useUILocale();
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{knownText(label)}</span>
      <span className="min-w-0 truncate text-right" data-testid={testId} title={knownText(value)}>
        {knownText(value)}
      </span>
    </div>
  );
}

export function DiscoveryStep({ discovery }: { discovery: ProjectDiscovery }) {
  useUILocale();
  return (
    <div className="space-y-3" data-testid="wizard-discovery">
      <Fact label={tr("projects.stack")} value={formatStacks(discovery.stacks)} testId="wizard-stack" />
      <Fact label={tr("common.folder")} value={discovery.path} testId="wizard-discovery-path" />
      <Fact
        label="README"
        value={discovery.readmePath ? (discovery.titles[discovery.readmePath] ?? discovery.readmePath) : "Not found"}
        testId="wizard-readme"
      />
      <Fact label="AGENTS.md" value={discovery.agentsPath ?? "Not found"} testId="wizard-agents" />
      <Fact label="CLAUDE.md" value={discovery.claudePath ?? "Not found"} testId="wizard-claude" />
      {discovery.signals.length > 0 && (
        <ul className="space-y-1 text-[11px] text-muted-foreground" data-testid="wizard-signals">
          {discovery.signals.map((signal) => (
            <li key={signal}>{signal}</li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground"><I18nText id="projects.this_scan_only_reads_project_files_it_does" />{" "}</p>
    </div>
  );
}

function DocBlock({
  kind,
  title,
  discovery,
  selected,
  skipped,
  onSelect,
  onSkip,
  onChooseFile,
}: {
  kind: DocKind;
  title: string;
  discovery: ProjectDiscovery;
  selected: string | null;
  skipped: boolean;
  onSelect: (path: string | null) => void;
  onSkip: (skip: boolean) => void;
  onChooseFile: () => void;
}) {
  useUILocale();
  const standard = kind === "idea" ? discovery.documentation.idea : discovery.documentation.prd;
  const alternatives = discovery.documentation.alternatives.filter((hit) => hit.kind === kind);
  const heading = standard ? discovery.titles[standard.path] : selected ? discovery.titles[selected] : null;
  return (
    <section className="space-y-2 rounded-lg border border-border p-3" data-testid={`wizard-doc-${kind}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span
          className={cn(
            "text-[11px]",
            standard || selected ? "text-success" : skipped ? "text-muted-foreground" : "text-warning",
          )}
          data-testid={`wizard-doc-${kind}-status`}
        >
          {standard || selected ? tr("common.found") : skipped ? tr("common.skipped") : tr("common.missing")}
        </span>
      </div>
      {standard ? (
        <p className="text-xs text-muted-foreground" data-testid={`wizard-doc-${kind}-path`}>
          {standard.path}
          {heading ? ` — ${heading}` : ""}
        </p>
      ) : (
        <fieldset className="space-y-1">
          <legend className="sr-only">{title}</legend>
          {alternatives.map((hit) => (
            <label key={hit.path} className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`wizard-doc-${kind}`}
                value={hit.path}
                checked={selected === hit.path}
                data-testid="wizard-doc-alternative"
                data-kind={kind}
                data-path={hit.path}
                onChange={() => onSelect(hit.path)}
              />
              <span>
                {hit.path}
                {discovery.titles[hit.path] ? ` — ${discovery.titles[hit.path]}` : ""}
              </span>
            </label>
          ))}
          {alternatives.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name={`wizard-doc-${kind}`}
                value=""
                checked={!selected}
                onChange={() => onSelect(null)}
              /><I18nText id="projects.none_of_these" />{" "}</label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onChooseFile} data-testid={`wizard-doc-${kind}-choose`}><I18nText id="projects.choose_a_file" />{" "}</Button>
            {!selected && (skipped ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => onSkip(false)} data-testid={`wizard-doc-${kind}-unskip`}><I18nText id="projects.don_t_skip" />{" "}</Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => onSkip(true)} data-testid={`wizard-doc-${kind}-skip`}><I18nText id="projects.skip" />{" "}{title}
              </Button>
            ))}
          </div>
          {skipped && !selected && (
            <p className="text-[11px] text-muted-foreground" data-testid={`wizard-doc-${kind}-skipped-note`}><I18nText id="projects.skipped_nothing_is_created_now_you_can_create" />{" "}</p>
          )}
        </fieldset>
      )}
      {standard && alternatives.length > 0 && (
        <p className="text-[11px] text-muted-foreground"><I18nText id="projects.also_found" />{" "}{alternatives.map((hit) => hit.path).join(", ")}<I18nText id="projects.the_standard_path_is_kept" />{" "}</p>
      )}
    </section>
  );
}

export function DocsStep({
  discovery,
  draft,
  plan,
  interview,
  onSelect,
  onSkip,
  onSkipAll,
  onChooseFile,
  onOpenInterview,
}: {
  discovery: ProjectDiscovery;
  draft: WizardDraft;
  plan: InterviewPlan;
  interview: InterviewState | null;
  onSelect: (kind: DocKind, path: string | null) => void;
  onSkip: (kind: DocKind, skip: boolean) => void;
  onSkipAll: () => void;
  onChooseFile: (kind: DocKind) => void;
  onOpenInterview: () => void;
}) {
  useUILocale();
  const missingKinds = (["idea", "prd"] as const).filter((kind) => plan[kind].target != null);
  const draftsReady = missingKinds.filter((kind) => interview?.drafts[kind]?.trim());
  const inProgress = interview != null && (interview.messages.length > 0 || draftsReady.length > 0);
  const accepted = interview?.accepted === true && draftsReady.length > 0;
  const bothMissing = !plan.idea.existing && !plan.prd.existing && !(plan.idea.skipped && plan.prd.skipped);
  return (
    <div className="space-y-3" data-testid="wizard-docs" data-state={discovery.documentation.state}>
      <DocBlock
        kind="idea"
        title="IDEA.md"
        discovery={discovery}
        selected={draft.ideaPath}
        skipped={plan.idea.skipped}
        onSelect={(next) => onSelect("idea", next)}
        onSkip={(skip) => onSkip("idea", skip)}
        onChooseFile={() => onChooseFile("idea")}
      />
      <DocBlock
        kind="prd"
        title="PRD.md"
        discovery={discovery}
        selected={draft.prdPath}
        skipped={plan.prd.skipped}
        onSelect={(next) => onSelect("prd", next)}
        onSkip={(skip) => onSkip("prd", skip)}
        onChooseFile={() => onChooseFile("prd")}
      />
      <p className="text-[11px] text-muted-foreground" data-testid="wizard-docs-policy">
        {accepted
          ? tr("common.reviewed_drafts_are_created_when_you_confirm_existing")
          : tr("common.forgeorbit_will_not_create_or_overwrite_these_files")}
      </p>
      {bothMissing && (
        <div className="flex flex-wrap items-center gap-2" data-testid="wizard-docs-skip-block">
          <Button type="button" variant="outline" size="sm" onClick={onSkipAll} data-testid="wizard-docs-skip-all"><I18nText id="projects.skip_idea_prd" />{" "}</Button>
          <span className="text-[11px] text-muted-foreground"><I18nText id="projects.for_projects_that_manage_work_rather_than_build" />{" "}</span>
        </div>
      )}
      {plan.needed && (
        <section
          className="space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
          data-testid="wizard-docs-interview"
          aria-labelledby="wizard-docs-interview-title"
        >
          <h3 id="wizard-docs-interview-title" className="text-sm font-medium"><I18nText id="projects.create_project_documentation" /></h3>
          <p className="text-muted-foreground"><I18nText id="projects.missing" />{" "}{missingKinds.map((kind) => DOC_FILE_NAMES[kind]).join(tr("common.and"))}<I18nText id="projects.an_ai_agent_can_ask_you_a_few" />{" "}
            {missingKinds.length > 1 ? "them" : "it"}<I18nText id="projects.nothing_is_sent_until_you_start_and_nothing" />{" "}</p>
          {accepted && (
            <p className="text-success" data-testid="wizard-docs-drafts-accepted"><I18nText id="projects.will_create" />{" "}{draftsReady.map((kind) => interview?.targets[kind]).join(tr("common.and"))}.
            </p>
          )}
          {inProgress && !accepted && (
            <p className="text-muted-foreground" data-testid="wizard-docs-interview-progress">
              {draftsReady.length > 0 ? tr("common.drafts_are_ready_for_review") : tr("common.interview_in_progress")}
            </p>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onOpenInterview} data-testid="wizard-open-interview">
            <Sparkles className="size-3.5" aria-hidden />
            {inProgress ? tr("common.continue_ai_interview") : tr("common.start_ai_interview")}
          </Button>
        </section>
      )}
    </div>
  );
}

export function EnvironmentStep({ discovery }: { discovery: ProjectDiscovery }) {
  useUILocale();
  return (
    <div className="space-y-3" data-testid="wizard-environment">
      <Fact label="Git" value={formatGit(discovery.git)} testId="wizard-git" />
      <Fact label={tr("common.working_directory")} value={discovery.path} testId="wizard-workdir" />
      <Fact
        label={tr("projects.git_root")}
        value={discovery.git.toplevel ?? tr("common.none_dc937b")}
        testId="wizard-git-root"
      />
      <HintList
        title={tr("projects.suggested_launch")}
        empty="No launch command detected."
        testId="wizard-launch"
        itemTestId="wizard-launch-command"
        items={discovery.launch.map((hint) => hint.command)}
      />
      <HintList
        title={tr("projects.suggested_tests")}
        empty="No test tool detected."
        testId="wizard-tests"
        itemTestId="wizard-test-tool"
        items={discovery.testTools.map((hint) => hint.command)}
      />
      {discovery.manifests.makefilePath && (
        <HintList
          title={`Makefile targets (${discovery.manifests.makefilePath})`}
          empty="No targets found."
          testId="wizard-makefile"
          itemTestId="wizard-makefile-target"
          items={discovery.makefileTargets}
        />
      )}
      {discovery.manifests.composePath && (
        <div className="space-y-1" data-testid="wizard-compose">
          <p className="text-xs font-medium"><I18nText id="common.docker_compose" /></p>
          <p className="text-[11px] text-muted-foreground">
            {discovery.manifests.composePath}{" "}<I18nText id="projects.can_be_saved_as_a_launch_profile_on" />{" "}</p>
          {discovery.composeServices.length > 0 && (
            <ul className="text-[11px] text-muted-foreground">
              {discovery.composeServices.map((service) => (
                <li key={service} data-testid="wizard-compose-service">{service}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="wizard-no-commands"><I18nText id="projects.nothing_on_this_screen_is_run" />{" "}</p>
    </div>
  );
}

function HintList({
  title,
  empty,
  items,
  testId,
  itemTestId,
}: {
  title: string;
  empty: string;
  items: string[];
  testId: string;
  itemTestId: string;
}) {
  useUILocale();
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs font-medium">{title}</p>
      {items.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {items.map((item) => (
            <li key={item} data-testid={itemTestId}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const REVIEW_GROUPS: { id: string; title: string; labels: ReadonlySet<string> }[] = [
  { id: "project", get title() { return tr("common.project_985959"); }, labels: new Set([tr("common.name"), "Folder", "Description", "Stack"]) },
  { id: "documentation", get title() { return tr("common.documentation"); }, labels: new Set([tr("common.documentation")]) },
  { id: "git", get title() { return tr("common.git"); }, labels: new Set([tr("common.git")]) },
  { id: "environment", get title() { return tr("common.environment"); }, labels: new Set([tr("common.environment")]) },
];

export function ReviewStep({
  draft,
  discovery,
  docWrites,
  docChecks,
  docResults,
  environment,
}: {
  draft: WizardDraft;
  discovery: ProjectDiscovery;
  docWrites: PlannedDocWrite[];
  docChecks: DocTargetCheck[] | null;
  docResults: DocWriteResult[] | null;
  environment: ReviewEnvironment;
}) {
  useUILocale();
  const rows = reviewRows(draft, discovery, docWrites, environment);
  const changes = reviewChanges(draft, discovery, docWrites, environment);
  const blocked = (docChecks ?? []).filter((check) => check.state !== "free");
  return (
    <div className="space-y-3" data-testid="wizard-review">
      {REVIEW_GROUPS.map((group) => {
        const groupRows = rows.filter((row) => group.labels.has(row.label));
        if (groupRows.length === 0) return null;
        return (
          <section key={group.id} className="space-y-2" data-testid={`wizard-review-section-${group.id}`}>
            <h3 className="text-xs font-medium">{group.title}</h3>
            <dl className="space-y-2">
              {groupRows.map((row) => (
                <div key={row.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-sm">
                  <dt className="text-xs text-muted-foreground">{knownText(row.label)}</dt>
                  <dd className="min-w-0 break-words" data-testid={`wizard-review-${row.label.toLowerCase()}`}>{knownText(row.value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      <div>
        <p className="text-xs font-medium"><I18nText id="projects.what_will_change" /></p>
        <ul className="mt-1 space-y-1 text-[11px] text-muted-foreground">
          {changes.map((line) => (
            <li key={line} data-testid="wizard-change">{knownText(line)}</li>
          ))}
        </ul>
      </div>
      {blocked.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger" data-testid="wizard-doc-conflicts">
          {blocked.map((check) => (
            <li key={check.path}>{check.error ?? tr("common.can_t_be_created", { p0: String(check.path) })}{" "}<I18nText id="projects.change_the_path_in_the_interview_or_turn" /></li>
          ))}
        </ul>
      )}
      {docResults && (
        <ul className="space-y-1 rounded-lg border border-border px-3 py-2 text-[11px]" data-testid="wizard-doc-results">
          {docResults.map((result) => (
            <li
              key={result.path}
              className={result.status === "created" ? "text-success" : "text-danger"}
              data-testid="wizard-doc-result"
              data-status={result.status}
            >
              {result.status === "created" ? tr("common.created_f04822", { p0: String(result.path) }) : result.error ?? tr("common.couldn_t_create", { p0: String(result.path) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WarningList({ warnings }: { warnings: string[] }) {
  useUILocale();
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning" data-testid="wizard-warnings">
      {warnings.map((warning) => (
        <li key={warning} data-testid="wizard-warning">{knownText(warning)}</li>
      ))}
    </ul>
  );
}
