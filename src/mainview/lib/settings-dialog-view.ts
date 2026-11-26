import { t as tr } from "@/i18n/core";
import type { HarnessTemplate } from "../../shared/types.ts";

/**
 * FO-UX-SIMPLIFY02-M4: Settings has six sections. Each section is a stack of
 * panels ("subsections"); every setting that existed before lives in exactly
 * one subsection. The pre-M4 section ids (`harnesses`, `accounts`, …) are no
 * longer sidebar entries but stay valid as deep links: `resolveSection` maps
 * each to its new section plus the subsection to scroll to.
 */
export const SETTINGS_SECTIONS = [
  { id: "general", get label() { return tr("settings.sec.general"); } },
  { id: "providers", get label() { return tr("settings.sec.providers"); } },
  { id: "autonomy", get label() { return tr("settings.sec.autonomy"); } },
  { id: "plans", get label() { return tr("settings.sec.plans"); } },
  { id: "tools", get label() { return tr("settings.sec.tools"); } },
  { id: "library", get label() { return tr("settings.sec.library"); } },
  { id: "advanced", get label() { return tr("settings.sec.advanced"); } },
] as const;

export type PrimarySectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Pre-M4 sidebar ids, kept only as deep-link inputs. */
export const LEGACY_SECTION_IDS = ["harnesses", "accounts", "ai_router", "agents", "pipelines", "git", "prompts", "backup"] as const;
export type LegacySectionId = (typeof LEGACY_SECTION_IDS)[number];

/** Anything a caller may ask Settings to open on. */
export type SettingsSectionId = PrimarySectionId | LegacySectionId;

/** The panels inside the sections, in display order. */
export const SETTINGS_SUBSECTIONS = [
  { id: "appearance", section: "general", get label() { return tr("settings.sub.appearance"); } },
  { id: "preferences", section: "general", get label() { return tr("settings.sub.preferences"); } },
  { id: "harnesses", section: "providers", get label() { return tr("common.harnesses"); } },
  { id: "accounts", section: "providers", get label() { return tr("common.accounts_resources_d23794"); } },
  { id: "ai_router", section: "providers", get label() { return tr("routing_v2.title"); } },
  { id: "autonomy_layers", section: "autonomy", get label() { return tr("settings.sub.autonomy_layers"); } },
  { id: "autonomy_policy", section: "autonomy", get label() { return tr("autonomy.panel"); } },
  { id: "project_permissions", section: "autonomy", get label() { return tr("settings.sub.project_permissions"); } },
  { id: "owner_trust", section: "autonomy", get label() { return tr("ownerTrust.title"); } },
  { id: "execution_plans", section: "plans", get label() { return tr("settings.sec.plans"); } },
  { id: "tools", section: "tools", get label() { return tr("settings.sub.tools"); } },
  { id: "git", section: "tools", get label() { return tr("common.git_integration"); } },
  { id: "tool_links", section: "tools", get label() { return tr("settings.sub.tool_links"); } },
  { id: "prompts", section: "library", get label() { return tr("common.saved_prompts"); } },
  { id: "agents", section: "library", get label() { return tr("common.agents"); } },
  { id: "pipelines", section: "library", get label() { return tr("common.pipelines"); } },
  { id: "runtime", section: "advanced", get label() { return tr("settings.sub.runtime"); } },
  { id: "data", section: "advanced", get label() { return tr("settings.sub.data"); } },
  { id: "backup", section: "advanced", get label() { return tr("backup.title"); } },
  { id: "self_improvement", section: "advanced", get label() { return tr("selfImprove.title"); } },
  { id: "diagnostics", section: "advanced", get label() { return tr("settings.sub.diagnostics"); } },
] as const;

export type SubsectionId = (typeof SETTINGS_SUBSECTIONS)[number]["id"];

export function subsectionsOf(section: PrimarySectionId) {
  return SETTINGS_SUBSECTIONS.filter((s) => s.section === section);
}

export function sectionOfSubsection(id: SubsectionId): PrimarySectionId {
  return SETTINGS_SUBSECTIONS.find((s) => s.id === id)!.section;
}

/** Where each pre-M4 section id now lives — the old-to-new reachability map. */
export const LEGACY_SECTION_TARGETS: Record<LegacySectionId, { section: PrimarySectionId; anchor: SubsectionId }> = {
  harnesses: { section: "providers", anchor: "harnesses" },
  accounts: { section: "providers", anchor: "accounts" },
  ai_router: { section: "providers", anchor: "ai_router" },
  agents: { section: "library", anchor: "agents" },
  pipelines: { section: "library", anchor: "pipelines" },
  git: { section: "tools", anchor: "git" },
  prompts: { section: "library", anchor: "prompts" },
  backup: { section: "advanced", anchor: "backup" },
};

export function isPrimarySection(id: string): id is PrimarySectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === id);
}

/** Normalize any accepted section id (new or pre-M4) to a section + optional anchor. */
export function resolveSection(id: SettingsSectionId): { section: PrimarySectionId; anchor: SubsectionId | null } {
  if (isPrimarySection(id)) return { section: id, anchor: null };
  return LEGACY_SECTION_TARGETS[id];
}

/**
 * Sections that keep their panels mounted (hidden) after the first visit, so an
 * unsaved draft — the autonomy policy form, a token being typed, a saved prompt
 * being written — survives switching sections. Closing the dialog still asks
 * before discarding an unsaved policy draft (see `SettingsDialog`).
 */
export const KEEP_MOUNTED_SECTIONS: readonly PrimarySectionId[] = ["autonomy", "tools", "library"];

/**
 * Discriminated-union view state for the Settings dialog's content pane.
 * "section" is one of the six sections (optionally scrolled to a subsection),
 * "templates" is the Add-harness template picker, "editor" is the harness
 * create/edit form, and "agent-editor" is the agent-profile create/edit form
 * (`profileId` is null when creating; a null `profileId` with a
 * `duplicateFromId` means "create prefilled from that agent", while a set
 * `profileId` is always an edit with a null `duplicateFromId`). The sidebar
 * stays visible across all four kinds (see `activeSection`).
 */
export type SettingsView =
  | { kind: "section"; section: PrimarySectionId; anchor?: SubsectionId | null }
  | { kind: "templates" }
  | { kind: "editor"; harnessId: string | null; template: HarnessTemplate }
  | { kind: "agent-editor"; profileId: string | null; duplicateFromId: string | null };

/** The view shown every time the dialog opens — always General, no persistence. */
export function initialView(): SettingsView {
  return { kind: "section", section: "general" };
}

/** Navigate to a section (new or pre-M4 id), optionally to a subsection. */
export function openSection(id: SettingsSectionId, anchor?: SubsectionId | null): SettingsView {
  const target = resolveSection(id);
  const resolvedAnchor = anchor ?? target.anchor;
  return resolvedAnchor ? { kind: "section", section: target.section, anchor: resolvedAnchor } : { kind: "section", section: target.section };
}

/** Navigate to the Add-harness template picker. */
export function openTemplates(): SettingsView {
  return { kind: "templates" };
}

/** Navigate to the harness editor — `harnessId` is null when creating. */
export function openEditor(harnessId: string | null, template: HarnessTemplate): SettingsView {
  return { kind: "editor", harnessId, template };
}

/**
 * Navigate to the agent-profile editor — `profileId` is null when creating.
 * A null `profileId` with a `duplicateFromId` means "create prefilled from
 * that agent"; a set `profileId` is always an edit, so `duplicateFromId` is
 * forced to null in that case.
 */
export function openAgentEditor(
  profileId: string | null,
  duplicateFromId: string | null = null,
): SettingsView {
  return {
    kind: "agent-editor",
    profileId,
    duplicateFromId: profileId === null ? duplicateFromId : null,
  };
}

/**
 * Navigate back from a subview. The harness flows (templates, editor) are
 * reached from Providers → Harnesses and the agent editor from Library →
 * Agents, so back lands on that panel. A section view has nothing to pop and
 * returns itself.
 */
export function backFromSubview(view: SettingsView): SettingsView {
  switch (view.kind) {
    case "section":
      return view;
    case "templates":
    case "editor":
      return { kind: "section", section: "providers", anchor: "harnesses" };
    case "agent-editor":
      return { kind: "section", section: "library", anchor: "agents" };
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Which sidebar item should render as active for the current view. The
 * subviews have no sidebar entry of their own, so they highlight the section
 * they are reached from: templates/editor → Providers, agent-editor → Library.
 */
export function activeSection(view: SettingsView): PrimarySectionId {
  switch (view.kind) {
    case "section":
      return view.section;
    case "templates":
    case "editor":
      return "providers";
    case "agent-editor":
      return "library";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Resolve what Escape (or a backdrop click) should do given the current
 * view: pop the subpage back to its section (see `backFromSubview`), or
 * close the modal outright. Only a section view closes the modal — every
 * subpage pops first.
 */
export function resolveEscape(view: SettingsView): "pop" | "close" {
  switch (view.kind) {
    case "section":
      return "close";
    case "templates":
    case "editor":
    case "agent-editor":
      return "pop";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

/**
 * Whether the view is a form subpage that holds a draft — the harness editor
 * and the agent editor. Leaving one with unsaved edits needs a discard
 * confirm; the templates picker holds no draft, and a section view is not a
 * subpage at all.
 */
export function isFormSubpage(view: SettingsView): boolean {
  switch (view.kind) {
    case "editor":
    case "agent-editor":
      return true;
    case "section":
    case "templates":
      return false;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
