/**
 * FO-UX-SIMPLIFY02-M4: the searchable index of Settings.
 *
 * One entry per control (or small group of controls) that existed before the
 * restructure. An entry names the section + subsection that now hosts it, an
 * optional selector for the exact control to focus, and the translation keys
 * for its label and description. Search matches those labels and descriptions
 * only — never a stored value, token or credential.
 *
 * Pure: no DOM, no React. `t` is injected so tests can run in either locale.
 */
import type { TranslationKey } from "@/i18n/core";
import {
  sectionOfSubsection,
  SETTINGS_SECTIONS,
  SETTINGS_SUBSECTIONS,
  type PrimarySectionId,
  type SubsectionId,
} from "./settings-dialog-view";

export interface SettingsIndexEntry {
  /** Stable id; also the `data-testid` suffix of the result row. */
  id: string;
  anchor: SubsectionId;
  label: TranslationKey;
  description?: TranslationKey;
  /** Extra words people might type for this control (translation keys). */
  keywords?: TranslationKey[];
  /** CSS selector of the control to focus after the jump. */
  control?: string;
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  // General
  { id: "language", anchor: "appearance", label: "settings.language", description: "settings.languageHint", control: "#interface-language" },
  { id: "theme", anchor: "appearance", label: "settings.theme", description: "settings.auto_follows_your_system_s_appearance_and_switches", control: "#settings-theme-group button" },
  { id: "density", anchor: "appearance", label: "settings.density", description: "settings.density_hint", control: "#settings-density-group button" },
  { id: "font_size", anchor: "appearance", label: "settings.font_size", description: "settings.decrease_font_size", keywords: ["settings.increase_font_size", "settings.reset_font_size"], control: "#settings-font-size-group button" },
  { id: "default_tool", anchor: "preferences", label: "settings.default_harness_for_new_tasks", control: "#default-task-harness" },
  { id: "new_task_pinned", anchor: "preferences", label: "settings.new_task_pinned", description: "settings.new_task_pinned_hint", control: "#new-task-pinned" },
  { id: "sticky_messages", anchor: "preferences", label: "settings.sticky_user_messages", description: "settings.keep_your_latest_sent_message_visible_while_its", control: "#sticky-user-messages" },
  { id: "getting_started", anchor: "preferences", label: "common.getting_started", description: "settings.bring_back_the_onboarding_checklist", control: "[data-testid=\"settings-replay-onboarding\"]" },

  // AI providers and accounts
  { id: "harnesses", anchor: "harnesses", label: "common.harnesses", keywords: ["settings.sub.providers_keywords"] },
  { id: "accounts", anchor: "accounts", label: "common.accounts_resources_d23794", keywords: ["settings.sub.providers_keywords"] },
  { id: "subscriptions", anchor: "accounts", label: "accounts.subscription_management" },
  { id: "quota_sources", anchor: "accounts", label: "accounts.quota_dashboard", keywords: ["settings.quota_keywords"] },
  { id: "resource_availability", anchor: "accounts", label: "accounts.resource_availability" },
  { id: "execution_profiles", anchor: "accounts", label: "multiaccount.title" },
  { id: "router", anchor: "ai_router", label: "routing_v2.title" },
  { id: "router_preference", anchor: "ai_router", label: "routing_v2.autonomy_mode.label", description: "settings.layers.router_hint" },

  // Autonomy and safety
  { id: "layers", anchor: "autonomy_layers", label: "settings.sub.autonomy_layers", description: "settings.layers.hint" },
  { id: "autonomy_policy", anchor: "autonomy_policy", label: "autonomy.panel", control: "[data-testid=\"autonomy-control-panel\"]" },
  { id: "autonomy_projects", anchor: "autonomy_policy", label: "autonomy.projects", control: "[data-testid=\"autonomy-projects\"]" },
  { id: "autonomy_limits", anchor: "autonomy_policy", label: "autonomy.limits", control: "[data-testid=\"autonomy-workers\"]" },
  { id: "spending_budget", anchor: "autonomy_policy", label: "usage.spendBudget", description: "usage.hardSpend" },
  { id: "verified_quota", anchor: "autonomy_policy", label: "usage.verifiedQuota" },
  { id: "emergency_stop", anchor: "autonomy_policy", label: "autonomy.emergency", control: "[data-testid=\"autonomy-emergency\"]" },
  { id: "project_permissions", anchor: "project_permissions", label: "settings.sub.project_permissions", description: "perm.panel.hint", control: "[data-testid=\"perm-project-select\"]" },
  { id: "owner_trust", anchor: "owner_trust", label: "ownerTrust.title", description: "ownerTrust.review", control: "[data-testid=\"owner-trust-review\"]" },

  // Execution plans
  { id: "execution_plans", anchor: "execution_plans", label: "settings.sec.plans", description: "settings.plans.hint", keywords: ["nav.missions"], control: "[data-testid=\"mission-control-page\"]" },

  // Tools and access
  { id: "tools_browser", anchor: "tools", label: "settings.tools_browser", description: "settings.tools_browser_hint", control: "[data-testid=\"workspace-browser\"]" },
  { id: "tools_native", anchor: "tools", label: "settings.tools_native", description: "settings.tools_native_hint", control: "[data-testid=\"workspace-native-computer\"]" },
  { id: "git", anchor: "git", label: "common.git_integration" },
  { id: "worktrees", anchor: "tool_links", label: "settings.link.worktrees", description: "settings.link.worktrees_hint", control: "[data-testid=\"settings-open-worktrees\"]" },
  { id: "pipelines_page", anchor: "tool_links", label: "settings.link.pipelines", description: "settings.link.pipelines_hint", control: "[data-testid=\"settings-open-pipelines-page\"]" },

  // Library
  { id: "saved_prompts", anchor: "prompts", label: "common.saved_prompts" },
  { id: "agent_profiles", anchor: "agents", label: "common.agents" },
  { id: "pipelines", anchor: "pipelines", label: "common.pipelines" },
  { id: "import_export", anchor: "agents", label: "settings.link.import_export", description: "settings.link.import_export_hint" },

  // Advanced
  { id: "tmux", anchor: "runtime", label: "settings.tmux_for_claude_code", control: "#tmux-source" },
  { id: "disclaim", anchor: "runtime", label: "settings.isolate_agent_permissions_from_forgeorbit_macos", control: "#disclaim-spawned-agents" },
  { id: "fx_auto_resume", anchor: "runtime", label: "settings.auto_resume_fx_after_a_rate_limit", control: "#fx-auto-resume" },
  { id: "fx_auto_resume_delay", anchor: "runtime", label: "settings.auto_resume_delay_seconds", control: "#fx-auto-resume-delay" },
  { id: "archived_history", anchor: "data", label: "settings.archived_task_history", description: "settings.large_tool_outputs_over_4_kb_in_tasks", control: "#archived-history-retention" },
  { id: "compact_db", anchor: "data", label: "settings.compact_database", description: "settings.reclaims_unused_space_pauses_forgeorbit_briefly" },
  { id: "backup", anchor: "backup", label: "backup.title", description: "backup.intro" },
  { id: "self_improvement", anchor: "self_improvement", label: "selfImprove.title", control: "[data-testid=\"self-improvement-panel\"]" },
  { id: "technical_details", anchor: "diagnostics", label: "settings.tech_details", description: "settings.tech_details_hint", control: "#show-technical-details" },
  { id: "version_revision", anchor: "diagnostics", label: "settings.diag.version", keywords: ["settings.diag.build", "settings.diag.revision", "settings.diag.migration_ceiling", "settings.diag.channel", "settings.diag.updates"] },
];

export interface SettingsSearchResult {
  entry: SettingsIndexEntry;
  section: PrimarySectionId;
  label: string;
  sectionLabel: string;
  subsectionLabel: string;
}

type Translate = (key: TranslationKey) => string;

function normalize(text: string, locale: string): string {
  return text.toLocaleLowerCase(locale).normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Rank entries for a query. Every whitespace-separated token must occur in the
 * entry's label, description, keywords, or the names of its section and
 * subsection. A label hit outranks a description-only hit; ties keep index
 * order, so the result is stable. An empty query returns no results.
 */
export function searchSettings(
  query: string,
  t: Translate,
  locale = "en",
  index: readonly SettingsIndexEntry[] = SETTINGS_INDEX,
): SettingsSearchResult[] {
  const tokens = normalize(query, locale).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const ranked: Array<{ result: SettingsSearchResult; score: number; order: number }> = [];
  index.forEach((entry, order) => {
    const section = sectionOfSubsection(entry.anchor);
    const sectionLabel = SETTINGS_SECTIONS.find((s) => s.id === section)!.label;
    const subsectionLabel = SETTINGS_SUBSECTIONS.find((s) => s.id === entry.anchor)!.label;
    const label = t(entry.label);
    const labelText = normalize(label, locale);
    const descText = entry.description ? normalize(t(entry.description), locale) : "";
    const extra = normalize([...(entry.keywords ?? []).map(t), sectionLabel, subsectionLabel].join(" "), locale);
    let score = 0;
    for (const token of tokens) {
      if (labelText.includes(token)) score += 3;
      else if (descText.includes(token)) score += 2;
      else if (extra.includes(token)) score += 1;
      else return;
    }
    ranked.push({ result: { entry, section, label, sectionLabel, subsectionLabel }, score, order });
  });
  return ranked.sort((a, b) => b.score - a.score || a.order - b.order).map((r) => r.result);
}
