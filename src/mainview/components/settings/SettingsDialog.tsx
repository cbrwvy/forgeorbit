import { englishPluralSuffix, t as tr, t as translate, type TranslationKey } from "@/i18n/core";
import { staticLabel } from "@/i18n/presentation";

import { I18nText, useLocale, useLocale as useUILocale } from "@/i18n/react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyDensity, DENSITIES, readDensity, writeDensity, type Density } from "@/lib/density";
import { setShowTechnicalDetails, useShowTechnicalDetails } from "@/lib/technical-details-pref";
import { useNewTaskPinned, writeNewTaskPinned } from "@/lib/new-task-presentation";
import { scrollWithin } from "@/lib/scroll-within";
import { createPortal } from "react-dom";
import { BarChart3, ChevronLeft, Loader2, Minus, Monitor, Moon, Plus, Sun, Terminal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api, type AccountUsageDay, type AppBuildInfo, type HarnessesPayload, type HarnessInput } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import { AgentIcon } from "@/components/kanban/AgentIcon";
import { AgentProfileForm } from "@/components/kanban/AgentProfileFormDialog";
import { AgentProfilesSection } from "@/components/settings/AgentProfilesSection";
import { AccountsDashboard } from "@/components/accounts/AccountsDashboard";
import { ProviderRuntimeMatrix } from "@/components/settings/ProviderRuntimeMatrix";
import { AiRouterDashboard } from "@/components/router/AiRouterDashboard";
import { GitHubTokensSection } from "@/components/settings/GitHubTokensSection";
import { PipelinesSection } from "@/components/settings/PipelinesSection";
import { SettingsSubsection } from "@/components/settings/SettingsSubsection";
import { ProjectPermissionsPanel } from "@/components/permissions/ProjectPermissionsPanel";
import { SettingsSearch } from "@/components/settings/SettingsSearch";
import { AutonomyLayers } from "@/components/settings/AutonomyLayers";
import { AutonomyPolicyPanel } from "@/components/orchestration/AutonomyControlPanel";
import { OwnerTrustPanel, type OwnerReviewContext } from "@/components/orchestration/OwnerTrustPanel";
import { SelfImprovementPanel } from "@/components/orchestration/SelfImprovementPanel";
import { MissionControlPage } from "@/components/orchestration/MissionControlPage";
import type { ProjectSurfacePage } from "@/lib/workspace";
import { routerV2Api } from "@/lib/router-v2-api";
import type { SettingsIndexEntry } from "@/lib/settings-index";
import { SavedPromptsSection } from "@/components/settings/SavedPromptsSection";
import { useFontSize } from "@/components/font-size-provider";
import { useTheme } from "@/components/theme-provider";
import { isMacPlatform } from "@/lib/platform";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { ONBOARDING_DISMISSED_PREF } from "@/lib/getting-started";
import { FX_AUTO_RESUME_MAX, parseFxAutoResumeDelayInput } from "@/lib/fx-auto-resume-prefs";
import {
  ARCHIVED_HISTORY_RETENTION_PREF,
  formatBytes,
  formatDbStatsLine,
  formatRetentionValue,
  parseArchivedHistoryRetentionDays,
  retentionOptionLabel,
  retentionSelectOptions,
} from "@/lib/retention-prefs";
import { abbreviateHome, cn, formatTokens } from "@/lib/utils";
import { shortenPath } from "@/lib/path-display";
import { resolveTemplateInitialHome } from "@/lib/harness-template";
import { harnessEditorDirty } from "@/lib/harness-editor-dirty";
import {
  KEEP_MOUNTED_SECTIONS,
  SETTINGS_SECTIONS,
  sectionOfSubsection,
  type PrimarySectionId,
  type SubsectionId,
  activeSection,
  backFromSubview,
  initialView,
  isFormSubpage,
  openAgentEditor,
  openEditor,
  openSection,
  openTemplates,
  resolveEscape,
  type SettingsSectionId,
  type SettingsView,
} from "@/lib/settings-dialog-view";
import { BackupRecoverySection } from "@/components/settings/BackupRecoverySection";
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FX_AUTO_RESUME_MAX_DELAY_SEC,
  FX_AUTO_RESUME_MIN_DELAY_SEC,
  HARNESS_TEMPLATES,
  THEME_PREFERENCES,
  type AgentKind,
  type DbCompactResult,
  type DbStats,
  type DiscoveredAccount,
  type Harness,
  type HarnessTemplate,
  type ThemePreference,
} from "@/i18n/options";

// Computed once at module load, same convention as `isMacPlatform()` in
// `lib/platform.ts` (the single sniff) — the Settings → General font-size
// hint text names the platform-appropriate shortcut. The non-Mac string
// calls out "outside a terminal" because `font-size-provider.tsx`'s keydown
// handler lets a focused `.xterm` pane keep Ctrl+-/Ctrl+_ for readline's
// undo/literal bindings there.
const fontSizeHint = () => isMacPlatform()
  ? tr("common.and_also_work_anywhere_0_resets")
  : tr("common.ctrl_and_ctrl_also_work_anywhere_outside_a");

/** Icon shown per theme preference in the Settings → General picker. */
const THEME_PREFERENCE_ICON: Record<ThemePreference, typeof Monitor> = {
  auto: Monitor,
  dark: Moon,
  light: Sun,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Whether sent user messages pin to the top of the transcript. */
  stickyUserMessages: boolean;
  onStickyUserMessagesChange: (sticky: boolean) => void;
  /** Current fx auto-resume preference pair (`FX_AUTO_RESUME_PREF` /
   *  `FX_AUTO_RESUME_DELAY_PREF`, parsed via `parseFxAutoResumePrefs`) —
   *  see `docs/plans/fx-recovery-follow-ups.md` §3. */
  fxAutoResume: { enabled: boolean; delaySec: number };
  onFxAutoResumeChange: (next: { enabled: boolean; delaySec: number }) => void;
  /** Refresh agents/harnesses on the parent after CRUD operations. */
  onChange?: () => void;
  /** Resolved home dir from `GET /defaults` — used to expand `~` in templates. */
  homeDir: string;
  /** Active data dir from `GET /defaults` — substituted into `{dataDir}` in
   *  template `home` paths so new harnesses default under the running dir
   *  (the ForgeOrbit platform default, or an explicit development root). */
  dataDir: string;
  /** Section to land on when the dialog opens. Applied on every open
   *  transition (not just the first) — absent/undefined preserves today's
   *  behavior of always resetting to General. */
  initialSection?: SettingsSectionId;
  /** Agent profile to open straight on its edit subpage when the dialog
   *  opens (a deep link, e.g. "Edit in Settings" from a task's agent
   *  details). Wins over `initialSection`; absent/null falls back to it. */
  initialAgentProfileId?: string | null;
  /** Navigate the app-level `view` to the pipelines page/editor — see
   *  `PipelinesSection`'s `onOpenPipelines` prop. The caller closes this
   *  dialog in the same callback. */
  onOpenPipelines: (id: string | null, editing: boolean) => void;
  onOpenPortfolio?: () => void;
  /** Open Browser / Native Computer (they left the global rail in M3). The caller closes this dialog. */
  onOpenTool?: (tool: "browser" | "native-computer") => void;
  /** Subsection to scroll to on open (M4); the legacy section ids already imply one. */
  initialAnchor?: SubsectionId | null;
  /** The exact mission (and task) the Owner-confirmation panel was opened for (M4). */
  ownerContext?: OwnerReviewContext | null;
  /** Hand-offs to the pages that own the work. The caller closes this dialog. */
  onOpenAnalytics?: () => void;
  onOpenMissions?: () => void;
  onOpenWorktrees?: () => void;
  /** Leave Settings for a project page or a task. The caller closes this dialog. */
  onOpenProjectPage?: (path: string, page: ProjectSurfacePage) => void;
  onOpenTask?: (taskId: string) => void;
  /** Switch to Owner confirmation for one plan. Opening it confirms nothing. */
  onOpenMissionSettings?: (target: { section: "autonomy"; anchor: "autonomy_policy" | "owner_trust"; ownerContext?: OwnerReviewContext }) => void;
}

/**
 * Parse a textarea of `KEY=value` lines into a record. Blank lines and
 * comment lines (`# …`) are skipped; lines that don't fit `KEY=value` are
 * counted as ignored so the editor can warn the user (rather than silently
 * dropping a typo).
 */
function parseEnv(raw: string): { env: Record<string, string>; ignored: number } {
  const env: Record<string, string> = {};
  let ignored = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) { ignored++; continue; }
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1);
    if (!k) { ignored++; continue; }
    env[k] = v;
  }
  return { env, ignored };
}

/** Kinds still marked "experimental" in the UI — surfaced with the warning
 *  badge everywhere a harness/template kind is shown. Extend this list (not
 *  the individual call sites) as a kind graduates out of experimental. */
function isExperimentalKind(kind: AgentKind): boolean {
  return kind === "codex" || kind === "cursor" || kind === "gemini" || kind === "antigravity" || kind === "fx";
}

function stringifyEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function expandTilde(p: string | null, homeDir: string): string | null {
  if (!p) return p;
  if (!homeDir) return p;
  if (p.startsWith("~/")) return homeDir + p.slice(1);
  if (p === "~") return homeDir;
  return p;
}

/** Replace the `{dataDir}` placeholder in template paths with the active
 *  data dir resolved server-side. No-op for the `__edit` template (whose
 *  paths come from the DB and are already concrete). */
function resolveTemplate(t: HarnessTemplate, dataDir: string): HarnessTemplate {
  if (!t.home || !t.home.includes("{dataDir}")) return t;
  return { ...t, home: t.home.replaceAll("{dataDir}", dataDir) };
}

/** Bump the trailing number on `base` until it's not in `existing`. Used so
 *  picking the same template twice doesn't pre-fill a colliding id (the
 *  uniqueness check would catch it on save, but bumping up front avoids the
 *  papercut of having to manually rename every time). */
/**
 * Per-kind copy for the "Add harness" home-override field: the field label,
 * the slug used to build the suggested placeholder path, and the help text
 * explaining what env var the override sets. Table-driven rather than a
 * ternary chain because a binary claude/codex ternary can't represent every
 * kind's env var accurately — codex sets HOME+CODEX_HOME, cursor sets a
 * plain HOME with no dedicated var, gemini sets its own GEMINI_CLI_HOME.
 */
const HARNESS_HOME_COPY: Record<AgentKind, { label: string; slug: string; help: string }> = {
  "claude-code": {
    get label() { return tr("common.claude_config_dir_override_absolute_path_optional"); },
    slug: "claude-2",
    get help() { return tr("common.sets_claude_config_dir_on_spawn_claude_stores"); },
  },
  codex: {
    get label() { return tr("common.home_override_absolute_path_optional"); },
    slug: "codex-2",
    get help() { return tr("common.sets_home_and_codex_home_on_spawn_codex"); },
  },
  cursor: {
    get label() { return tr("common.home_override_absolute_path_optional"); },
    slug: "cursor-2",
    get help() { return tr("common.home_override_cursor_has_no_config_dir_env"); },
  },
  gemini: {
    get label() { return tr("common.gemini_cli_home_override_absolute_path_optional"); },
    slug: "gemini-2",
    get help() { return tr("common.sets_gemini_cli_home_on_spawn_gemini_stores"); },
  },
  antigravity: {
    get label() { return tr("common.home_override_absolute_path_optional"); },
    slug: "antigravity-2",
    get help() { return tr("common.home_override_antigravity_agy_stores_its_config_auth"); },
  },
  fx: {
    get label() { return tr("common.home_override_absolute_path_optional"); },
    slug: "fx-2",
    get help() { return tr("common.home_override_fx_has_no_dedicated_config_dir"); },
  },
};

function uniqueHarnessId(base: string, existing: Set<string>): string {
  if (!base || !existing.has(base)) return base;
  const m = base.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : `${base}-`;
  let n = m ? parseInt(m[2]!, 10) + 1 : 2;
  while (existing.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** If `err` is the server's "harness in use" 409 (which carries structured
 *  `taskIds` and/or `profileIds` lists — a harness delete is refused when
 *  either a task or an agent profile still references it, see
 *  `HarnessInUseError`), resolve those ids to names and return a
 *  human-readable description for the failure toast. Returns null if the
 *  error isn't that shape (or carries neither list) — caller falls back to
 *  the raw `error` message. */
async function describeHarnessInUse(err: unknown): Promise<string | null> {
  if (!(err instanceof ApiError)) return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  const rawTaskIds = (body as { taskIds?: unknown }).taskIds;
  const rawProfileIds = (body as { profileIds?: unknown }).profileIds;
  const taskIds = Array.isArray(rawTaskIds) ? rawTaskIds.filter((x): x is string => typeof x === "string") : [];
  const profileIds = Array.isArray(rawProfileIds)
    ? rawProfileIds.filter((x): x is string => typeof x === "string")
    : [];
  if (taskIds.length === 0 && profileIds.length === 0) return null;

  const segments: string[] = [];
  if (taskIds.length > 0) {
    let titles: string[];
    try {
      const tasks = await api.listTasks();
      const byId = new Map(tasks.map((t) => [t.id, t.title]));
      titles = taskIds.map((id) => byId.get(id) ?? `${id.slice(0, 8)}…`);
    } catch {
      // Listing tasks failed — fall back to id prefixes so the toast still
      // identifies *which* tasks are blocking, even if not by name.
      titles = taskIds.map((id) => `${id.slice(0, 8)}…`);
    }
    const noun = titles.length === 1 ? "task" : "tasks";
    segments.push(`${titles.length} ${noun}: ${titles.join(", ")}`);
  }
  if (profileIds.length > 0) {
    let names: string[];
    try {
      const profiles = await api.listAgentProfiles();
      const byId = new Map(profiles.map((p) => [p.id, p.name]));
      names = profileIds.map((id) => byId.get(id) ?? `${id.slice(0, 8)}…`);
    } catch {
      names = profileIds.map((id) => `${id.slice(0, 8)}…`);
    }
    const noun = names.length === 1 ? "agent" : "agents";
    segments.push(`${names.length} ${noun}: ${names.join(", ")}`);
  }
  return tr("common.in_use_by", { p0: String(segments.join(" and ")) });
}

/** The view the modal opens on: a deep-linked agent's edit subpage, else the
 *  requested section, else General. */
function entryView(
  initialSection: SettingsSectionId | undefined,
  initialAgentProfileId: string | null | undefined,
  initialAnchor?: SubsectionId | null,
): SettingsView {
  if (initialAgentProfileId) return openAgentEditor(initialAgentProfileId);
  if (initialSection) return openSection(initialSection, initialAnchor);
  return initialView();
}

const FALLBACK_APP_INFO: AppBuildInfo = {
  version: "?",
  buildNumber: null,
  macBundleVersion: null,
  sourceRevision: null,
  sourceTreeSHA256: null,
  sourceDirty: null,
  channel: null,
  identifier: null,
  localBuild: false,
  builtAt: null,
  migrationCeiling: null,
  updatesEnabled: false,
};

export function SettingsDialog({ open, onClose, stickyUserMessages, onStickyUserMessagesChange, fxAutoResume, onFxAutoResumeChange, onChange, homeDir, dataDir, initialSection, initialAgentProfileId, onOpenPipelines, onOpenPortfolio, onOpenTool, initialAnchor, ownerContext = null, onOpenWorktrees, onOpenProjectPage, onOpenTask, onOpenMissionSettings }: Props) {
  const { locale: uiLocale } = useUILocale();
  const [appInfo, setAppInfo] = useState<AppBuildInfo>({ ...FALLBACK_APP_INFO, version: "" });
  const version = appInfo.version;
  const [payload, setPayload] = useState<HarnessesPayload>({ harnesses: [], statuses: [] });
  const [defaultHarness, setDefaultHarness] = useState<string>("claude-code");
  const [tmuxSource, setTmuxSource] = useState<"system" | "bundled">("system");
  const [bundledTmuxAvailable, setBundledTmuxAvailable] = useState(false);
  // Default-on kill switch for spawning agents through the macOS "disclaim"
  // helper — see src/bun/disclaim.ts. Only the literal stored value "false"
  // turns it off; unset/anything-else reads as on, matching disclaimEnabled().
  const [disclaimSpawnedAgents, setDisclaimSpawnedAgents] = useState(true);
  const [view, setView] = useState<SettingsView>(() => entryView(initialSection, initialAgentProfileId, initialAnchor));
  // The view (and a per-open counter) must be correct on the very FIRST commit
  // after the modal opens: the dialog stays mounted while closed, and an
  // effect-driven reset would let that commit render the previous subpage —
  // mounting its autoFocus form (which Dialog's passive effect would then
  // record as the focus-restore target) before the reset landed. So the reset
  // is adjusted during render, on the props' change, React's "derive state
  // from props" pattern. `openCount` rides in the agent editor's `key` so a
  // reopen onto the SAME profile id still mounts a fresh form.
  const [entry, setEntry] = useState({ open, initialSection, initialAgentProfileId, initialAnchor });
  const [openCount, setOpenCount] = useState(0);
  if (
    entry.open !== open ||
    entry.initialSection !== initialSection ||
    entry.initialAgentProfileId !== initialAgentProfileId ||
    entry.initialAnchor !== initialAnchor
  ) {
    setEntry({ open, initialSection, initialAgentProfileId, initialAnchor });
    if (open) {
      setView(entryView(initialSection, initialAgentProfileId, initialAnchor));
      if (!entry.open) setOpenCount((n) => n + 1);
    }
  }
  // Mirrors `view` for use inside async callbacks (e.g. the Editor's
  // onSubmit) so they can tell, after an await, whether the user navigated
  // away in the meantime — see Fix 3 in the settings-sidebar review.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Whether the form subpage on screen (harness editor or agent editor) holds
  // unsaved edits — fed by each form's `onDirtyChange`, which reports `false`
  // again when the form unmounts. Read by `leaveSubpage`.
  const subpageDirtyRef = useRef(false);
  // The autonomy policy form lives in a kept-mounted section, so switching sections
  // never loses it; closing the dialog does, so that path asks first (see `leaveSubpage`).
  const autonomyDirtyRef = useRef(false);
  const onAutonomyDirtyChange = useCallback((dirty: boolean) => { autonomyDirtyRef.current = dirty; }, []);
  const leavingRef = useRef(false);
  // Bumped every time a harness editor view is opened. A save captures the
  // value at submit time, so its late resolution can tell whether the editor
  // that started it is still the one on screen (a reopened editor gets a new
  // token, even though `viewRef.current.kind` is "editor" again).
  const editorTokenRef = useRef(0);
  // Token of the editor whose save is in flight (null = none), so a save that
  // outlives its editor never marks a newly opened one busy.
  const [savingToken, setSavingToken] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Optimistic toggle map: harness id → the value the user *clicked toward*.
  // Lets the Switch animate the moment the user clicks even though the actual
  // mutation is gated behind a confirm dialog + network round-trip. Cleared
  // on confirm-success (refresh overwrites with the server's truth), on
  // cancel (revert), and on error (revert + surface the message).
  const [pendingToggle, setPendingToggle] = useState<Record<string, boolean>>({});
  const confirm = useConfirm();

  const refresh = async () => {
    const [info, data, prefs, tmux] = await Promise.all([
      api.info().catch(() => FALLBACK_APP_INFO),
      api.listHarnesses().catch(() => ({ harnesses: [], statuses: [] })),
      api.listPreferences().catch((): Record<string, string> => ({})),
      api
        .getTmuxSource()
        .catch(() => ({ source: "system" as const, bundledAvailable: false, bundledPath: "", resolvedBin: "" })),
    ]);
    setAppInfo(info);
    setPayload(data);
    // The default-harness picker only lists *enabled* harnesses. If the
    // stored pref points at a now-disabled one, reconcile both local state
    // and the persisted pref to the first enabled fallback — otherwise the
    // `<Select>` value wouldn't match any `<option>` and the UI would
    // silently lie about what the stored default is.
    const stored = prefs["defaultHarness"] || "claude-code";
    const enabled = data.harnesses.filter((h) => h.enabled);
    const storedIsEnabled = enabled.some((h) => h.id === stored);
    if (!storedIsEnabled && enabled.length > 0) {
      const fallback = enabled[0]!.id;
      setDefaultHarness(fallback);
      void api.setPreference("defaultHarness", fallback).catch(() => {
        /* best-effort; the next refresh will retry. */
      });
    } else {
      setDefaultHarness(stored);
    }
    setTmuxSource(tmux.source);
    setBundledTmuxAvailable(tmux.bundledAvailable);
    // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
    setDisclaimSpawnedAgents(prefs["disclaimSpawnedAgents"] !== "false");
  };

  const onPickTmuxSource = async (source: "system" | "bundled") => {
    setTmuxSource(source);
    try {
      await api.setTmuxSource(source);
      onChange?.();
    } catch {
      /* revert? next open re-fetches truth. */
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
    // The view itself is reset during render (see `entry` above), so a
    // half-filled editor never greets the user on the next open.
    subpageDirtyRef.current = false;
    setFormError(null);
    autonomyDirtyRef.current = false;
  }, [open, initialSection, initialAgentProfileId]);

  const statusByHarness = useMemo(() => {
    const map = new Map(payload.statuses.map((s) => [s.harnessId, s]));
    return map;
  }, [payload.statuses, uiLocale]);

  // A bundle import (Agents / Pipelines sections) can enable a harness as
  // part of its transaction — reload the Harnesses list here and the app's
  // header state, so the change shows without reopening Settings.
  const onBundleImported = (result: { enabledHarnesses: string[] }) => {
    if (result.enabledHarnesses.length === 0) return;
    void refresh();
    onChange?.();
  };

  const onDisclaimSpawnedAgentsChange = (enabled: boolean) => {
    setDisclaimSpawnedAgents(enabled);
    // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
    void api.setPreference("disclaimSpawnedAgents", String(enabled)).catch(() => {
      // Revert only if this failed write is still the latest selection —
      // mirrors App.tsx's onStickyUserMessagesChange guard so a subsequent
      // click can't be stomped by an older, now-resolving request.
      setDisclaimSpawnedAgents((current) => current === enabled ? !enabled : current);
    });
  };

  const onPickDefault = async (id: string) => {
    setDefaultHarness(id);
    try {
      await api.setPreference("defaultHarness", id);
      onChange?.();
    } catch {
      // Reverting on failure would just confuse the user — the next open
      // will re-fetch the truth. Silent best-effort is fine.
    }
  };

  const onDeleteHarness = async (h: Harness) => {
    const ok = await confirm(() => ({
      title: tr("common.delete_988654", { p0: String(h.label) }),
      description: tr("common.the_alias_will_be_removed_tasks_already_using"),
      confirmLabel: tr("common.delete"),
      variant: "destructive",
    }));
    if (!ok) return;
    try {
      await api.deleteHarness(h.id);
      await refresh();
      onChange?.();
    } catch (e) {
      // HarnessesSection doesn't render `formError` (only the Editor does),
      // so a failed delete would otherwise be invisible. Surface it as a toast.
      const message = e instanceof Error ? e.message : String(e);
      const description = await describeHarnessInUse(e) ?? message;
      toast.error(tr("common.couldn_t_delete", { p0: String(h.label) }), {
        description,
        duration: Infinity,
      });
    }
  };

  const onOpenTerminal = async (h: Harness) => {
    try {
      await api.openHarnessTerminal(h.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.error(tr("common.couldn_t_open_a_terminal_for", { p0: String(h.label) }), {
        description: message,
        duration: Infinity,
      });
    }
  };

  const clearPending = (id: string) =>
    setPendingToggle((m) => {
      if (!(id in m)) return m;
      const { [id]: _, ...rest } = m;
      return rest;
    });

  const onToggleEnabled = async (h: Harness) => {
    const next = !h.enabled;
    // Flip the optimistic value first so the Switch animates immediately.
    // We'll clear it on success (refresh has the truth) or revert on
    // cancel / error.
    setPendingToggle((m) => ({ ...m, [h.id]: next }));
    // Re-enable is a one-click action; disable needs a confirmation when
    // tasks are still running (they keep using the harness until they finish)
    // so the user isn't blind-sided by background activity.
    if (h.enabled) {
      let runningCount: number | null = null;
      try {
        const usage = await api.getHarnessUsage(h.id);
        runningCount = usage.runningTaskIds.length;
      } catch {
        // Leave runningCount as null and tell the user in the confirm body —
        // silently claiming "0 running" would be a lie if the probe fails.
      }
      const description = runningCount === null
        ? tr("common.couldn_t_check_whether_any_tasks_are_currently")
        : runningCount > 0
          ? tr("common.task_currently_running_will_keep_using_this_harness", { p0: String(runningCount), p1: String(runningCount === 1 ? "" : "s") })
          : tr("common.it_will_be_hidden_from_the_new_task");
      const ok = await confirm(() => ({
        title: tr("common.disable_fc1907", { p0: String(h.label) }),
        description,
        confirmLabel: tr("common.disable"),
        variant: "destructive",
      }));
      if (!ok) {
        clearPending(h.id);
        return;
      }
    }
    try {
      await api.setHarnessEnabled(h.id, next);
      await refresh();
      clearPending(h.id);
      onChange?.();
    } catch (e) {
      clearPending(h.id);
      const message = e instanceof Error ? e.message : String(e);
      toast.error(tr("common.couldn_t", { p0: String(next ? "enable" : "disable"), p1: String(h.label) }), {
        description: message,
        duration: Infinity,
      });
    }
  };

  const currentSection = activeSection(view);
  // Fixed shell (FO-PM01-UXFIX01): only this region scrolls. It starts at the top whenever the
  // section changes, or scrolls to the requested panel (a search hit or a legacy deep link).
  const contentRef = useRef<HTMLDivElement>(null);
  const viewAnchor = view.kind === "section" ? view.anchor ?? null : null;
  const contentKey = view.kind === "section" ? `section:${view.section}` : view.kind;
  const pendingControlRef = useRef<string | null>(null);
  const [jumpNonce, setJumpNonce] = useState(0);
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    if (!viewAnchor) { root.scrollTo({ top: 0 }); return; }
    const target = root.querySelector<HTMLElement>(`[data-settings-sub="${viewAnchor}"]`);
    if (!target) return;
    scrollWithin(root, target, "start");
    const selector = pendingControlRef.current;
    pendingControlRef.current = null;
    // Controls inside lazily loaded panels can appear a frame later; try a few times, then settle on the panel.
    let tries = 0;
    let frame = 0;
    const focusControl = () => {
      const control = selector ? target.querySelector<HTMLElement>(selector) : null;
      if (control) { control.focus({ preventScroll: true }); scrollWithin(root, control, "nearest"); return; }
      if (selector && tries++ < 8) { frame = requestAnimationFrame(focusControl); return; }
      target.focus({ preventScroll: true });
    };
    focusControl();
    return () => cancelAnimationFrame(frame);
  }, [contentKey, viewAnchor, jumpNonce]);

  // Panels that keep drafts stay mounted (hidden) once visited; others mount only while shown.
  const visitedRef = useRef<{ open: number; sections: Set<PrimarySectionId> }>({ open: -1, sections: new Set() });
  if (visitedRef.current.open !== openCount) visitedRef.current = { open: openCount, sections: new Set() };
  if (view.kind === "section") visitedRef.current.sections.add(view.section);
  const sectionShown = (id: PrimarySectionId) => view.kind === "section" && view.section === id;
  const sectionMounted = (id: PrimarySectionId) =>
    sectionShown(id) || (KEEP_MOUNTED_SECTIONS.includes(id) && visitedRef.current.sections.has(id));

  /** Search hit: open the section and panel, then focus the control. Guarded like any section change. */
  const jumpToSetting = (entry: SettingsIndexEntry) => {
    void leaveSubpage(() => {
      pendingControlRef.current = entry.control ?? null;
      setView(openSection(sectionOfSubsection(entry.anchor), entry.anchor));
      setJumpNonce((n) => n + 1);
    });
  };

  const showEditor = (harnessId: string | null, template: HarnessTemplate) => {
    editorTokenRef.current += 1;
    setView(openEditor(harnessId, template));
  };

  /** Every internal way of closing the modal (and handing off to another
   *  page) goes through here: drop the subpage back to General so a save
   *  resolving after the close finds no editor showing, then tell the parent.
   *  Opening again re-derives the view during render regardless, for closes
   *  the parent makes on its own. */
  const resetView = () => {
    setView(initialView());
    subpageDirtyRef.current = false;
  };
  const closeModal = () => {
    resetView();
    onClose();
  };

  /**
   * The one guard every way out of the current view goes through — header
   * Back, Escape/backdrop, a sidebar section click, the header X. On a form
   * subpage holding unsaved edits it asks "Discard unsaved changes?" and only
   * runs `proceed` on a yes; otherwise it runs it straight away. The forms'
   * own Cancel buttons and successful saves deliberately bypass it. `proceed`
   * must read `viewRef.current`, not the render's `view` — the view can change
   * while the confirm is open.
   */
  const leaveSubpage = async (proceed: () => void, opts?: { closing?: boolean }) => {
    const current = viewRef.current;
    const formDirty = isFormSubpage(current) && subpageDirtyRef.current;
    const policyDirty = !!opts?.closing && autonomyDirtyRef.current;
    if (formDirty || policyDirty) {
      if (leavingRef.current) return;
      leavingRef.current = true;
      let ok = false;
      try {
        ok = await confirm(() => ({
          title: formDirty ? tr("common.discard_unsaved_changes") : tr("settings.autonomy.discard_title"),
          description: !formDirty
            ? tr("settings.autonomy.discard_desc")
            : current.kind === "agent-editor"
              ? tr("common.your_edits_to_this_agent_will_be_lost")
              : tr("common.your_edits_to_this_harness_will_be_lost"),
          confirmLabel: tr("common.discard"),
          variant: "destructive",
        }));
      } finally {
        leavingRef.current = false;
      }
      if (!ok) return;
    }
    proceed();
  };

  /** Leave Settings for another page: guarded like closing, then reset and hand off. */
  const handOff = (go: (() => void) | undefined) => {
    if (!go) return;
    void leaveSubpage(() => { resetView(); go(); }, { closing: true });
  };

  /** Pop the current subpage to its section, or close the modal from a
   *  section view — what Escape and a backdrop click do. */
  const popOrClose = () => {
    const current = viewRef.current;
    if (resolveEscape(current) === "pop") {
      setView(backFromSubview(current));
      return;
    }
    closeModal();
  };

  /** Opens another subsection of Settings (a link, not a save). */
  const openAnchor = (anchor: SubsectionId) => () => void leaveSubpage(() => {
    setView(openSection(sectionOfSubsection(anchor), anchor));
    setJumpNonce((n) => n + 1);
  });

  const renderSection = (id: PrimarySectionId) => {
    switch (id) {
      case "general":
        return (
          <GeneralSection
            defaultHarness={defaultHarness}
            payload={payload}
            onPickDefault={onPickDefault}
            stickyUserMessages={stickyUserMessages}
            onStickyUserMessagesChange={onStickyUserMessagesChange}
            onClose={closeModal}
          />
        );
      case "providers":
        return (
          <>
            <SettingsSubsection id="harnesses" title={tr("common.harnesses")}>
              <HarnessesSection
                payload={payload}
                statusByHarness={statusByHarness}
                homeDir={homeDir}
                canAdd={!!dataDir}
                onAdd={() => setView(openTemplates())}
                onEdit={(h) =>
                  showEditor(h.id, {
                    id: "__edit",
                    label: h.label,
                    description: "",
                    kind: h.kind,
                    suggestedHarnessId: h.id,
                    home: h.home,
                    bin: h.bin,
                    env: h.env,
                  })
                }
                onDelete={onDeleteHarness}
                onToggleEnabled={onToggleEnabled}
                onOpenTerminal={onOpenTerminal}
                pendingToggle={pendingToggle}
              />
            </SettingsSubsection>
            <SettingsSubsection id="accounts" title={tr("common.accounts_resources_d23794")} titleHidden>
              <AccountsDashboard harnesses={payload.harnesses} onOpenPortfolio={onOpenPortfolio} onResourcesChanged={async () => { await refresh(); onChange?.(); }} />
              <div className="rounded-md border border-border/60 p-3" data-testid="settings-link-analytics">
                <p className="text-sm font-medium">{tr("settings.link.analytics")}</p>
                <p className="text-xs text-muted-foreground">{tr("settings.link.analytics_hint")}</p>
              </div>
            </SettingsSubsection>
            <SettingsSubsection id="ai_router" title={tr("routing_v2.title")} titleHidden>
              <AiRouterDashboard onOpenAccount={openAnchor("accounts")} />
            </SettingsSubsection>
          </>
        );
      case "plans":
        return (
          <SettingsSubsection id="execution_plans" title={tr("settings.sec.plans")} titleHidden>
            <MissionControlPage
              embedded
              onOpenProject={onOpenProjectPage ? (path, page) => handOff(() => onOpenProjectPage(path, page)) : undefined}
              onOpenTask={onOpenTask ? (id) => handOff(() => onOpenTask(id)) : undefined}
              onOpenSettings={onOpenMissionSettings}
            />
          </SettingsSubsection>
        );
      case "autonomy":
        return (
          <>
            <SettingsSubsection id="autonomy_layers" title={tr("settings.sub.autonomy_layers")}>
              <AutonomyLayers onOpenRouter={openAnchor("ai_router")} onOpenMissions={() => { setView(openSection("plans")); setJumpNonce((n) => n + 1); }} />
            </SettingsSubsection>
            <SettingsSubsection id="autonomy_policy" title={tr("autonomy.panel")}>
              <AutonomyPolicyPanel onDirtyChange={onAutonomyDirtyChange} />
            </SettingsSubsection>
            <SettingsSubsection id="project_permissions" title={tr("settings.sub.project_permissions")}>
              <ProjectPermissionsPanel />
            </SettingsSubsection>
            <SettingsSubsection id="owner_trust" title={tr("ownerTrust.title")} titleHidden>
              <OwnerTrustPanel context={ownerContext} />
            </SettingsSubsection>
          </>
        );
      case "tools":
        return (
          <>
            <SettingsSubsection id="tools" title={tr("settings.sub.tools")} hint={tr("settings.tools_hint")}>
              <div data-testid="settings-tools" className="space-y-3">
                {([
                  { id: "browser", testId: "workspace-browser", title: tr("settings.tools_browser"), hint: tr("settings.tools_browser_hint") },
                  { id: "native-computer", testId: "workspace-native-computer", title: tr("settings.tools_native"), hint: tr("settings.tools_native_hint") },
                ] as const).map((tool) => (
                  <div key={tool.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium">{tool.title}</p>
                      <p className="text-xs text-muted-foreground">{tool.hint}</p>
                    </div>
                    <Button type="button" size="sm" variant="outline" disabled={!onOpenTool} onClick={() => handOff(onOpenTool ? () => onOpenTool(tool.id) : undefined)} data-testid={tool.testId} aria-label={`${tr("settings.tools_open")}: ${tool.title}`}>
                      {tr("settings.tools_open")}
                    </Button>
                  </div>
                ))}
              </div>
            </SettingsSubsection>
            {/* Kept mounted with the section so an unsaved host/label/token draft survives switching sections. */}
            <SettingsSubsection id="git" title={tr("common.git_integration")}>
              <div className="space-y-4 text-sm">
                <GitHubTokensSection />
              </div>
            </SettingsSubsection>
            <SettingsSubsection id="tool_links" title={tr("settings.sub.tool_links")}>
              <div className="space-y-3">
                {([
                  { testId: "settings-open-worktrees", title: tr("settings.link.worktrees"), hint: tr("settings.link.worktrees_hint"), go: onOpenWorktrees },
                  { testId: "settings-open-pipelines-page", title: tr("settings.link.pipelines"), hint: tr("settings.link.pipelines_hint"), go: () => onOpenPipelines(null, false) },
                ]).map((link) => (
                  <div key={link.testId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium">{link.title}</p>
                      <p className="text-xs text-muted-foreground">{link.hint}</p>
                    </div>
                    <Button type="button" size="sm" variant="outline" disabled={!link.go} onClick={() => handOff(link.go)} data-testid={link.testId} aria-label={`${tr("settings.link.open")}: ${link.title}`}>
                      {tr("settings.link.open")}
                    </Button>
                  </div>
                ))}
              </div>
            </SettingsSubsection>
          </>
        );
      case "library":
        return (
          <>
            <SettingsSubsection id="prompts" title={tr("common.saved_prompts")}>
              <SavedPromptsSection />
            </SettingsSubsection>
            <SettingsSubsection id="agents" title={tr("common.agents")} hint={tr("settings.link.import_export_hint")}>
              {/* Unmounted while the editor subpage is open, as before M4; the Library section itself stays mounted. */}
              {view.kind === "section" && (
                <AgentProfilesSection
                  harnesses={payload.harnesses}
                  onAdd={() => setView(openAgentEditor(null))}
                  onEdit={(p) => setView(openAgentEditor(p.id))}
                  onDuplicate={(p) => setView(openAgentEditor(null, p.id))}
                  onImported={onBundleImported}
                />
              )}
            </SettingsSubsection>
            <SettingsSubsection id="pipelines" title={tr("common.pipelines")}>
              <PipelinesSection
                onOpenPipelines={(pid, editing) => {
                  // The parent closes the modal for this hand-off — reset the view too, like every other close.
                  handOff(() => onOpenPipelines(pid, editing));
                }}
                onImported={onBundleImported}
              />
            </SettingsSubsection>
          </>
        );
      case "advanced":
        return (
          <>
            <SettingsSubsection id="backup" title={tr("backup.title")} titleHidden>
              <BackupRecoverySection />
            </SettingsSubsection>
            <SettingsSubsection id="runtime" title={tr("settings.sub.runtime")} hint={tr("settings.runtime.hint")}>
              <RuntimeSettings
                fxAutoResume={fxAutoResume}
                onFxAutoResumeChange={onFxAutoResumeChange}
                tmuxSource={tmuxSource}
                bundledTmuxAvailable={bundledTmuxAvailable}
                onPickTmuxSource={onPickTmuxSource}
                disclaimSpawnedAgents={disclaimSpawnedAgents}
                onDisclaimSpawnedAgentsChange={onDisclaimSpawnedAgentsChange}
              />
            </SettingsSubsection>
            <SettingsSubsection id="data" title={tr("settings.sub.data")} hint={tr("settings.data.hint")}>
              <ArchivedHistorySection />
            </SettingsSubsection>
            <SettingsSubsection id="self_improvement" title={tr("selfImprove.title")} titleHidden>
              <SelfImprovementPanel />
            </SettingsSubsection>
            <SettingsSubsection id="diagnostics" title={tr("settings.sub.diagnostics")} hint={tr("settings.diag.hint")}>
              <DiagnosticsSettings info={appInfo} />
            </SettingsSubsection>
          </>
        );
      default: {
        const _exhaustive: never = id;
        void _exhaustive;
        return null;
      }
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => void leaveSubpage(popOrClose, { closing: resolveEscape(viewRef.current) === "close" })}
      className="flex h-[min(42rem,calc(100dvh-2rem))] max-h-none w-full max-w-4xl flex-col overflow-hidden p-0"
      labelledBy="settings-dialog-title"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 p-4 pb-3">
        <div className="flex items-center gap-2">
          {view.kind !== "section" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void leaveSubpage(() => setView(backFromSubview(viewRef.current)))}
              aria-label={tr("common.back")}
            >
              <ChevronLeft className="size-4" />
            </Button>
          )}
          <h2 id="settings-dialog-title" className="text-base font-semibold">
            {view.kind === "section" && tr("common.settings")}
            {view.kind === "templates" && tr("settings.add_harness")}
            {view.kind === "editor" && (view.harnessId ? tr("common.edit_harness") : tr("settings.add_harness"))}
            {view.kind === "agent-editor" && (view.profileId ? tr("common.edit_agent") : view.duplicateFromId ? tr("common.duplicate_agent") : tr("settings.add_agent"))}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">v{version}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void leaveSubpage(closeModal, { closing: true })}
            aria-label={tr("common.close")}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-b border-border/60 px-4 py-2">
        <SettingsSearch onSelect={jumpToSetting} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label={tr("settings.sec.nav")}
          className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-border/60 p-2 sm:w-52 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
        >
          {SETTINGS_SECTIONS.map((sec) => {
            const active = currentSection === sec.id;
            return (
              <Button
                key={sec.id}
                size="sm"
                variant={active ? "secondary" : "ghost"}
                className="w-auto shrink-0 justify-start sm:w-full sm:whitespace-normal sm:text-left"
                aria-current={active ? "page" : undefined}
                onClick={() => void leaveSubpage(() => setView(openSection(sec.id)))}
                data-testid={`settings-nav-${sec.id}`}
              >
                {sec.label}
              </Button>
            );
          })}
        </nav>

        <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pt-0 [scrollbar-gutter:stable]" data-testid="settings-content">
          {SETTINGS_SECTIONS.map((sec) => {
            if (!sectionMounted(sec.id)) return null;
            const shown = sectionShown(sec.id);
            return (
              <div key={sec.id} className={cn("space-y-4 pt-3 text-sm", !shown && "hidden")} data-testid={`settings-section-${sec.id}`}>
                <header className="space-y-0.5">
                  <h3 className="ds-page-title">{sec.label}</h3>
                  <p className="ds-meta">{tr(`settings.sec.${sec.id}.desc` as TranslationKey)}</p>
                </header>
                {renderSection(sec.id)}
              </div>
            );
          })}

          {view.kind === "templates" && (
            <TemplatePicker
              onPick={(t) => showEditor(null, resolveTemplate(t, dataDir))}
            />
          )}

          {view.kind === "agent-editor" && (
            <div data-testid="agent-profile-editor" className="pt-3 text-sm">
              <AgentProfileForm
                key={`${openCount}:${view.profileId ?? view.duplicateFromId ?? "new"}`}
                variant="page"
                autoFocus
                profileId={view.profileId}
                duplicateFromId={view.duplicateFromId}
                onDirtyChange={(dirty) => {
                  subpageDirtyRef.current = dirty;
                }}
                onCancel={() => setView(backFromSubview(viewRef.current))}
                onDuplicate={() => {
                  const current = viewRef.current;
                  if (current.kind !== "agent-editor" || !current.profileId) return;
                  const id = current.profileId;
                  void leaveSubpage(() => setView(openAgentEditor(null, id)));
                }}
                onSaved={() => {
                  // The user may have left (rail click, Escape-pop) while the
                  // save was in flight — only pop if this editor is still the
                  // one showing.
                  const current = viewRef.current;
                  if (
                    current.kind === "agent-editor" &&
                    current.profileId === view.profileId &&
                    current.duplicateFromId === view.duplicateFromId
                  ) {
                    setView(backFromSubview(current));
                  }
                }}
              />
            </div>
          )}

          {view.kind === "editor" && (
            <Editor
              template={view.template}
              isEdit={view.harnessId !== null}
              homeDir={homeDir}
              dataDir={dataDir}
              existingIds={new Set(payload.harnesses.map((h) => h.id))}
              busy={savingToken === editorTokenRef.current}
              error={formError}
              onDirtyChange={(dirty) => {
                subpageDirtyRef.current = dirty;
              }}
              onCancel={() => setView(backFromSubview(viewRef.current))}
              onSubmit={async (input) => {
                const token = editorTokenRef.current;
                // Still the editor instance that started this save — a rail
                // click / Escape-pop / close may have replaced it while the
                // round-trip was in flight, and a reopened editor is a
                // different instance even though its kind is "editor" again.
                const stillShowing = () =>
                  viewRef.current.kind === "editor" && editorTokenRef.current === token;
                setSavingToken(token);
                setFormError(null);
                try {
                  if (view.harnessId) {
                    await api.updateHarness(view.harnessId, {
                      label: input.label,
                      home: input.home,
                      bin: input.bin,
                      env: input.env,
                    });
                  } else {
                    await api.createHarness(input);
                  }
                  await refresh();
                  onChange?.();
                  // Only pop the view if the Editor that saved is still showing.
                  if (stillShowing()) setView(backFromSubview(viewRef.current));
                } catch (e) {
                  const message = e instanceof Error ? e.message : String(e);
                  if (stillShowing()) {
                    setFormError(message);
                  } else {
                    // Editor is unmounted — setFormError would target nothing
                    // and the failure would be silent. Surface it as a toast
                    // instead, mirroring the delete-failure toast above.
                    toast.error("Couldn't save harness", {
                      description: message,
                      duration: Infinity,
                    });
                  }
                } finally {
                  setSavingToken((t) => (t === token ? null : t));
                }
              }}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** `ApiError` for a refused Compact is a 409 whose message already is the
 *  server's `error` ("N task(s) running — stop or wait for them first"). */
function compactRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.body;
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return e.message;
}

/**
 * Settings → General "Archived task history": the retention age picker, the
 * database size line and the manual Compact button
 * (docs/plans/non-blocking-session-restore.md, decision F, task T11).
 *
 * Self-contained on purpose — it owns its own preference + stats fetches
 * (on mount, which is every time the General section opens), so nothing
 * threads through `SettingsDialog`'s `refresh()`. Compact is the one request
 * that deliberately freezes the core (`VACUUM`), so it runs behind a confirm
 * that states the estimate and then a blocking modal that can't be dismissed
 * until the request settles; `api.compactDb` suspends the app-level busy
 * banner for the duration, since this modal already explains the pause.
 */
function ArchivedHistorySection() {
  useUILocale();
  const confirm = useConfirm();
  const [days, setDays] = useState<number | null>(() => parseArchivedHistoryRetentionDays(undefined));
  const [loaded, setLoaded] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [stats, setStats] = useState<DbStats | null>(null);
  const [compacting, setCompacting] = useState<{ estimateSec: number } | null>(null);
  const [compactResult, setCompactResult] = useState<DbCompactResult | null>(null);
  const [compactRefused, setCompactRefused] = useState<string | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Sequence guard: a slow stats answer must never overwrite a newer one (the
  // post-compact refetch races the on-mount one when the section is reopened).
  const statsSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadStats = async (): Promise<DbStats | null> => {
    const seq = ++statsSeqRef.current;
    try {
      const fresh = await api.getDbStats();
      if (mountedRef.current && seq === statsSeqRef.current) setStats(fresh);
      return fresh;
    } catch {
      // Best-effort display line — an older core without `/db/stats` (or a
      // busy one) just leaves the previous line / none.
      return null;
    }
  };

  useEffect(() => {
    void api.listPreferences()
      .then((prefs) => {
        if (!mountedRef.current) return;
        setDays(parseArchivedHistoryRetentionDays(prefs[ARCHIVED_HISTORY_RETENTION_PREF]));
        setLoaded(true);
      })
      .catch(() => { if (mountedRef.current) setLoaded(true); });
    void loadStats();
  }, []);

  const onPickDays = (next: number | null) => {
    const previous = days;
    setDays(next);
    setPrefError(null);
    api.setPreference(ARCHIVED_HISTORY_RETENTION_PREF, formatRetentionValue(next))
      .then(() => { void loadStats(); })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        // Revert only if this failed write is still the latest selection.
        setDays((current) => (current === next ? previous : current));
        setPrefError(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  const onCompact = async () => {
    setCompactResult(null);
    setCompactRefused(null);
    setCompactError(null);
    // Fresh stats first: the estimate and the active-run count both go stale.
    const fresh = (await loadStats()) ?? stats;
    if (!mountedRef.current) return;
    const estimateSec = Math.max(1, Math.round(fresh?.compactEstimateSec ?? 0));
    const ok = await confirm(() => ({
      title: tr("common.compact_the_database"),
      description: (
        <><I18nText id="settings.rewrites_the_database_file_to_give_back_unused" />{" "}{fresh ? tr("common.about_reclaimable", { p0: String(formatBytes(fresh.reclaimableBytes)) }) : ""}<I18nText id="settings.this_takes_about" />{" "}{estimateSec}{" "}<I18nText id="settings.s_and_forgeorbit_won_t_respond_while_it" />{" "}</>
      ),
      confirmLabel: tr("common.compact"),
    }));
    if (!ok || !mountedRef.current) return;
    setCompacting({ estimateSec });
    try {
      const result = await api.compactDb();
      if (!mountedRef.current) return;
      setCompactResult(result);
      void loadStats();
    } catch (e) {
      if (!mountedRef.current) return;
      const refusal = compactRefusal(e);
      if (refusal !== null) setCompactRefused(refusal);
      else setCompactError(`Couldn't compact: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (mountedRef.current) setCompacting(null);
    }
  };

  return (
    <section className="space-y-1" data-testid="settings-archived-history">
      <label htmlFor="archived-history-retention" className="text-xs text-muted-foreground"><I18nText id="settings.archived_task_history" />{" "}</label>
      <Select
        id="archived-history-retention"
        data-testid="settings-archived-history-retention"
        value={days === null ? "off" : String(days)}
        disabled={!loaded}
        onChange={(e) => onPickDays(e.target.value === "off" ? null : Number(e.target.value))}
      >
        {retentionSelectOptions(days).map((d) => (
          <option key={d === null ? "off" : d} value={d === null ? "off" : String(d)}>
            {d === null ? tr("common.off_keep_everything") : tr("common.trim_after", { p0: String(retentionOptionLabel(d)) })}
          </option>
        ))}
      </Select>
      <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.large_tool_outputs_over_4_kb_in_tasks" />{" "}</p>
      {prefError && <p className="text-[length:var(--text-caption)] text-danger" data-testid="settings-archived-history-error">{prefError}</p>}
      {stats && (
        <p className="text-[length:var(--text-caption)] text-muted-foreground" data-testid="settings-db-stats">
          {formatDbStatsLine(stats)}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          data-testid="settings-db-compact"
          disabled={compacting !== null}
          onClick={() => { void onCompact(); }}
        ><I18nText id="settings.compact_database" />{" "}</Button>
        <span className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.reclaims_unused_space_pauses_forgeorbit_briefly" /></span>
      </div>
      {compactResult && (
        <p className="text-[length:var(--text-caption)] text-success" data-testid="settings-db-compact-result"><I18nText id="settings.compacted" />{" "}{formatBytes(compactResult.beforeBytes)} → {formatBytes(compactResult.afterBytes)}
        </p>
      )}
      {compactRefused && (
        <p className="text-[length:var(--text-caption)] text-warning" data-testid="settings-db-compact-refused">{compactRefused}</p>
      )}
      {compactError && <p className="text-[length:var(--text-caption)] text-danger" data-testid="settings-db-compact-error">{compactError}</p>}
      {/* Portaled to <body>: the blocking modal must sit above the Settings
          dialog regardless of that panel's stacking/overflow, like the
          confirm and bundle dialogs. `onClose` is a no-op — the core is
          frozen for the duration and there is nothing to dismiss to. */}
      {createPortal(
        <Dialog open={compacting !== null} onClose={() => {}} labelledBy="db-compacting-title" className="max-w-sm">
          <div className="flex items-start gap-3" data-testid="settings-db-compacting" role="status">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            <div className="space-y-1">
              <h2 id="db-compacting-title" className="text-sm font-medium"><I18nText id="settings.compacting" />{compacting?.estimateSec ?? 0}{" "}<I18nText id="common.s" />{" "}</h2>
              <p className="text-xs text-muted-foreground"><I18nText id="settings.forgeorbit_won_t_respond_until_this_finishes_please" />{" "}</p>
            </div>
          </div>
        </Dialog>,
        document.body,
      )}
    </section>
  );
}

function GeneralSection({
  payload,
  defaultHarness,
  onPickDefault,
  stickyUserMessages,
  onStickyUserMessagesChange,
  onClose,
}: {
  payload: HarnessesPayload;
  defaultHarness: string;
  onPickDefault: (id: string) => void;
  stickyUserMessages: boolean;
  onStickyUserMessagesChange: (sticky: boolean) => void;
  /** Closes the Settings dialog — used by "Show getting started guide" so the
   *  onboarding checklist underneath is visible after replaying it. */
  onClose: () => void;
}) {
  useUILocale();
  // Disabled harnesses are excluded from the default-harness picker so a
  // soft-deleted harness can't silently become the default for new tasks.
  const { locale, setLocale } = useLocale();
  const enabledHarnesses = payload.harnesses.filter((h) => h.enabled);
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const newTaskPinned = useNewTaskPinned();
  const [density, setDensityState] = useState<Density>(() => readDensity());
  const chooseDensity = (next: Density) => { setDensityState(next); writeDensity(next); applyDensity(next); };
  const { percent: fontSizePercent, increase: increaseFontSize, decrease: decreaseFontSize, reset: resetFontSize } = useFontSize();
  const canDecreaseFontSize = fontSizePercent > FONT_SIZE_MIN;
  const canIncreaseFontSize = fontSizePercent < FONT_SIZE_MAX;
  const canResetFontSize = fontSizePercent !== FONT_SIZE_DEFAULT;
  const [replayingOnboarding, setReplayingOnboarding] = useState(false);
  return (
    <div className="space-y-4 pt-3 text-sm">
      <SettingsSubsection id="appearance" title={tr("settings.sub.appearance")}>
        <div className="space-y-4">
      <section className="space-y-1" data-testid="language-setting">
        <label htmlFor="interface-language" className="text-xs text-muted-foreground">{translate("settings.language")}</label>
        <Select id="interface-language" value={locale} onChange={e => void setLocale(e.target.value as "en" | "ru")}>
          <option value="ru" lang="ru">Русский</option>
          <option value="en" lang="en">English</option>
        </Select>
        <p className="text-[length:var(--text-caption)] text-muted-foreground">{translate("settings.languageHint")}</p>
      </section>

      <section className="space-y-1">
        <label className="block text-xs text-muted-foreground"><I18nText id="settings.theme" /></label>
        <div id="settings-theme-group" role="group" aria-label={tr("settings.theme")} className="ds-tabs" data-testid="theme-picker">
          {THEME_PREFERENCES.map((t) => {
            const Icon = THEME_PREFERENCE_ICON[t.id];
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={themePreference === t.id}
                onClick={() => setThemePreference(t.id)}
                className={cn("ds-tab", themePreference === t.id && "glass-selected")}
                data-testid={`theme-${t.id}`}
              >
                <Icon className="size-3.5" />
                {staticLabel(t.label)}
              </button>
            );
          })}
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.auto_follows_your_system_s_appearance_and_switches" />{" "}</p>
      </section>

      <section className="space-y-1">
        <label className="block text-xs text-muted-foreground"><I18nText id="settings.density" /></label>
        <div id="settings-density-group" role="group" aria-label={tr("settings.density")} className="ds-tabs" data-testid="density-picker">
          {DENSITIES.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={density === d}
              onClick={() => chooseDensity(d)}
              className={cn("ds-tab", density === d && "glass-selected")}
              data-testid={`density-${d}`}
            >
              {d === "compact" ? tr("settings.density_compact") : d === "comfortable" ? tr("settings.density_comfortable") : tr("settings.density_default")}
            </button>
          ))}
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.density_hint" />{" "}</p>
      </section>

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="settings.font_size" /></label>
        <div id="settings-font-size-group" role="group" aria-label={tr("settings.font_size")} className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="w-8 px-0 aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label={tr("settings.decrease_font_size")}
            aria-disabled={!canDecreaseFontSize}
            onClick={() => {
              if (!canDecreaseFontSize) return;
              decreaseFontSize({ silent: true });
            }}
          >
            <Minus className="size-3.5" />
          </Button>
          <span role="status" aria-live="polite" className="w-10 text-center text-xs tabular-nums">
            {fontSizePercent}%
          </span>
          <Button
            size="sm"
            variant="outline"
            className="w-8 px-0 aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label={tr("settings.increase_font_size")}
            aria-disabled={!canIncreaseFontSize}
            onClick={() => {
              if (!canIncreaseFontSize) return;
              increaseFontSize({ silent: true });
            }}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
            aria-label={tr("settings.reset_font_size")}
            aria-disabled={!canResetFontSize}
            onClick={() => {
              if (!canResetFontSize) return;
              resetFontSize({ silent: true });
            }}
          ><I18nText id="common.reset" />{" "}</Button>
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground">{fontSizeHint()}</p>
      </section>

        </div>
      </SettingsSubsection>

      <SettingsSubsection id="preferences" title={tr("settings.sub.preferences")}>
        <div className="space-y-4">
      <section className="space-y-1">
        <label htmlFor="default-task-harness" className="text-xs text-muted-foreground"><I18nText id="settings.default_harness_for_new_tasks" /></label>
        <Select id="default-task-harness" value={defaultHarness} onChange={(e) => onPickDefault(e.target.value)}>
          {enabledHarnesses.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}{" "}
              {h.label.toLowerCase() !== h.kind ? `(${h.kind})` : ""}
            </option>
          ))}
        </Select>
      </section>

      <section className="flex items-start justify-between gap-3" data-testid="new-task-pin-setting">
        <div className="min-w-0 space-y-1">
          <label htmlFor="new-task-pinned" className="text-xs text-muted-foreground"><I18nText id="settings.new_task_pinned" /></label>
          <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.new_task_pinned_hint" /></p>
        </div>
        <Switch id="new-task-pinned" checked={newTaskPinned} onCheckedChange={(checked) => writeNewTaskPinned(checked)} aria-label={tr("settings.new_task_pinned")} />
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="sticky-user-messages" className="text-xs text-muted-foreground"><I18nText id="settings.sticky_user_messages" />{" "}</label>
          <Switch
            id="sticky-user-messages"
            checked={stickyUserMessages}
            onCheckedChange={onStickyUserMessagesChange}
            aria-label={tr("settings.sticky_user_messages")}
          />
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.keep_your_latest_sent_message_visible_while_its" />{" "}</p>
      </section>

      <section className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="common.getting_started" /></label>
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="settings-replay-onboarding"
            disabled={replayingOnboarding}
            onClick={async () => {
              if (replayingOnboarding) return;
              setReplayingOnboarding(true);
              // Await the write before closing — App re-reads preferences on
              // close, so a fire-and-forget PUT can lose the race against
              // that GET and silently discard the replay.
              await api.setPreference(ONBOARDING_DISMISSED_PREF, "false").catch(() => {
                // Best-effort, matching the theme/defaultHarness write idiom
                // above — the checklist will simply not reappear if this
                // silently fails, which is a minor papercut, not a hard
                // error worth surfacing.
              });
              setReplayingOnboarding(false);
              onClose();
            }}
          ><I18nText id="settings.show_getting_started_guide" />{" "}</Button>
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.bring_back_the_onboarding_checklist" />{" "}</p>
      </section>

      <section className="space-y-0.5 border-t border-border/50 pt-3">
        <p className="text-xs font-medium text-foreground"><I18nText id="settings.forgeorbit_your_agents_one_orbit" /></p>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.open_source_mit_based_on_agetor" />{" "}</p>
      </section>
        </div>
      </SettingsSubsection>
    </div>
  );
}

function RuntimeSettings({
  fxAutoResume,
  onFxAutoResumeChange,
  tmuxSource,
  bundledTmuxAvailable,
  onPickTmuxSource,
  disclaimSpawnedAgents,
  onDisclaimSpawnedAgentsChange,
}: {
  fxAutoResume: { enabled: boolean; delaySec: number };
  onFxAutoResumeChange: (next: { enabled: boolean; delaySec: number }) => void;
  tmuxSource: "system" | "bundled";
  bundledTmuxAvailable: boolean;
  onPickTmuxSource: (source: "system" | "bundled") => void;
  disclaimSpawnedAgents: boolean;
  onDisclaimSpawnedAgentsChange: (enabled: boolean) => void;
}) {
  useUILocale();
  // Local text mirror of `fxAutoResume.delaySec` so the field can hold an
  // in-progress keystroke without round-tripping through the preferences store
  // on every keystroke. Committed (clamped) on blur or Enter; resynced when the
  // prop changes from outside.
  const [fxDelayInput, setFxDelayInput] = useState(String(fxAutoResume.delaySec));
  useEffect(() => {
    setFxDelayInput(String(fxAutoResume.delaySec));
  }, [fxAutoResume.delaySec]);
  const commitFxDelay = () => {
    const clamped = parseFxAutoResumeDelayInput(fxDelayInput);
    setFxDelayInput(String(clamped));
    if (clamped !== fxAutoResume.delaySec) {
      onFxAutoResumeChange({ ...fxAutoResume, delaySec: clamped });
    }
  };
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <label htmlFor="tmux-source" className="text-xs text-muted-foreground"><I18nText id="settings.tmux_for_claude_code" /></label>
        <Select
          id="tmux-source"
          value={tmuxSource}
          onChange={(e) => onPickTmuxSource(e.target.value as "system" | "bundled")}
        >
          <option value="system"><I18nText id="settings.system_tmux_from_path" /></option>
          <option value="bundled" disabled={!bundledTmuxAvailable}>
            {bundledTmuxAvailable
              ? tr("common.bundled_tmux_shipped_with_forgeorbit")
              : tr("common.bundled_tmux_not_available_in_this_build")}
          </option>
        </Select>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.claude_code_runs_through_a_tmux_session_per" />{" "}</p>
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="disclaim-spawned-agents" className="text-xs text-muted-foreground"><I18nText id="settings.isolate_agent_permissions_from_forgeorbit_macos" />{" "}</label>
          <Switch
            id="disclaim-spawned-agents"
            checked={disclaimSpawnedAgents}
            // keep in sync with DISCLAIM_PREF_KEY in src/bun/disclaim.ts
            onCheckedChange={onDisclaimSpawnedAgentsChange}
            aria-label={tr("settings.isolate_agent_permissions_from_forgeorbit_macos")}
          />
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.spawned_agents_ask_for_macos_permissions_under_their" />{" "}</p>
      </section>

      <section className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="fx-auto-resume" className="text-xs text-muted-foreground"><I18nText id="settings.auto_resume_fx_after_a_rate_limit" />{" "}</label>
          <Switch
            id="fx-auto-resume"
            data-testid="settings-fx-auto-resume"
            checked={fxAutoResume.enabled}
            onCheckedChange={(enabled) => onFxAutoResumeChange({ ...fxAutoResume, enabled })}
            aria-label={tr("settings.auto_resume_fx_after_a_rate_limit")}
          />
        </div>
        <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.when_fx_pauses_after_repeated_gateway_429s_forgeorbit" />{" "}{FX_AUTO_RESUME_MAX}{" "}<I18nText id="settings.times_per_pause" />{" "}</p>
        <div className="flex items-center justify-between gap-4 pt-1">
          <label htmlFor="fx-auto-resume-delay" className="text-xs text-muted-foreground"><I18nText id="settings.auto_resume_delay_seconds" />{" "}</label>
          <Input
            id="fx-auto-resume-delay"
            data-testid="settings-fx-auto-resume-delay"
            type="number"
            min={FX_AUTO_RESUME_MIN_DELAY_SEC}
            max={FX_AUTO_RESUME_MAX_DELAY_SEC}
            step={10}
            className="w-24"
            disabled={!fxAutoResume.enabled}
            value={fxDelayInput}
            onChange={(e) => setFxDelayInput(e.target.value)}
            onBlur={commitFxDelay}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              commitFxDelay();
              e.currentTarget.blur();
            }}
          />
        </div>
      </section>

    </div>
  );
}

function formatDiagBuild(info: AppBuildInfo): string {
  if (info.buildNumber == null) return "—";
  return info.macBundleVersion ? `${info.buildNumber} (${info.macBundleVersion})` : String(info.buildNumber);
}

function formatDiagChannel(info: AppBuildInfo): string {
  if (!info.channel) return "—";
  return info.localBuild
    ? tr("settings.diag.channel_local", { channel: info.channel })
    : info.channel;
}

export function DiagnosticsSettings({ info }: { info: AppBuildInfo }) {
  useUILocale();
  const showTechnicalDetails = useShowTechnicalDetails();
  return (
    <div className="space-y-4">
      <section className="flex items-start justify-between gap-3" data-testid="technical-details-setting">
        <div className="min-w-0 space-y-1">
          <label htmlFor="show-technical-details" className="text-xs text-muted-foreground"><I18nText id="settings.tech_details" /></label>
          <p className="text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.tech_details_hint" /></p>
        </div>
        <Switch id="show-technical-details" checked={showTechnicalDetails} onCheckedChange={(checked) => setShowTechnicalDetails(checked)} aria-label={tr("settings.tech_details")} />
      </section>

      <div className="space-y-1.5">
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-version">
          <span>{tr("settings.diag.version")}</span>
          <span className="font-mono">{info.version || "—"}</span>
        </p>
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-build">
          <span>{tr("settings.diag.build")}</span>
          <span className="font-mono">{formatDiagBuild(info)}</span>
        </p>
        <p className="flex items-start justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-revision">
          <span className="shrink-0">{tr("settings.diag.revision")}</span>
          <span className="font-mono select-all break-all text-right">{info.sourceRevision || "—"}</span>
        </p>
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-migration-ceiling">
          <span>{tr("settings.diag.migration_ceiling")}</span>
          <span className="font-mono">{info.migrationCeiling || "—"}</span>
        </p>
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-channel">
          <span>{tr("settings.diag.channel")}</span>
          <span className="font-mono">{formatDiagChannel(info)}</span>
        </p>
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground" data-testid="settings-diag-updates">
          <span>{tr("settings.diag.updates")}</span>
          <span className="font-mono">{info.updatesEnabled ? tr("settings.diag.updates_enabled") : tr("settings.diag.updates_disabled")}</span>
        </p>
      </div>
    </div>
  );
}

function HarnessesSection({
  payload,
  statusByHarness,
  homeDir,
  canAdd,
  onAdd,
  onEdit,
  onDelete,
  onToggleEnabled,
  onOpenTerminal,
  pendingToggle,
}: {
  payload: HarnessesPayload;
  statusByHarness: Map<string, HarnessesPayload["statuses"][number]>;
  homeDir: string;
  /** False while `dataDir` is still loading from `GET /defaults`. Adding a
   *  harness with an unresolved data dir would persist a broken HOME path
   *  (`/harnesses/claude-2` instead of `<dataDir>/harnesses/claude-2`). */
  canAdd: boolean;
  onAdd: () => void;
  onEdit: (h: Harness) => void;
  onDelete: (h: Harness) => void;
  onToggleEnabled: (h: Harness) => void;
  /** Open a new Terminal.app window with this harness's env loaded so the
   *  user can authenticate or inspect it (e.g. `claude /login`). */
  onOpenTerminal: (h: Harness) => void;
  /** Optimistic toggle state — keyed by harness id, value is what the user
   *  clicked toward. Lets the Switch animate before the confirm/round-trip
   *  resolves. Missing keys mean "use the server's `h.enabled`". */
  pendingToggle: Record<string, boolean>;
}) {
  useUILocale();
  // Which harness's account-usage panel is expanded (at most one at a time).
  // Local to this section: the table fetches on expand, and the scan behind
  // it stats every transcript file — never fetched with the list.
  const [usageOpenFor, setUsageOpenFor] = useState<string | null>(null);
  return (
    <div className="space-y-4 pt-3 text-sm">
      <ProviderRuntimeMatrix reports={payload.runtimeReadiness ?? []} />
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted-foreground"><I18nText id="common.harnesses" /></label>
          <Button
            variant="outline"
            size="sm"
            onClick={onAdd}
            disabled={!canAdd}
            title={canAdd ? undefined : tr("common.loading_defaults")}
          >
            <Plus className="mr-1 size-3.5" />{" "}<I18nText id="settings.add_harness" />{" "}</Button>
        </div>
        <div className="space-y-1.5">
          {payload.providerDiagnostics?.map((diagnostic) => (
            <div key={diagnostic.id} data-testid={`provider-diagnostic-${diagnostic.id}`} className="space-y-1.5 rounded-md border border-border/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{diagnostic.label}</span>
                {diagnostic.version && <span className="text-xs text-muted-foreground">{diagnostic.version}</span>}
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">{tr("providers.execution_blocked")}</span>
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">{tr("providers.installed")}</dt>
                <dd>{diagnostic.installed ? (diagnostic.version ?? tr("providers.yes")) : tr("providers.no")}</dd>
                <dt className="text-muted-foreground">{tr("providers.authentication")}</dt>
                <dd>{tr(`providers.auth.${diagnostic.authentication}` as TranslationKey)}</dd>
                <dt className="text-muted-foreground">{tr("providers.models")}</dt>
                <dd>{tr(`providers.models.${diagnostic.modelDiscovery}` as TranslationKey)}</dd>
                <dt className="text-muted-foreground">{tr("providers.runtime")}</dt>
                <dd>{tr("providers.runtime.no")}</dd>
                <dt className="text-muted-foreground">{tr("providers.kernel")}</dt>
                <dd>{tr(`providers.kernel.${diagnostic.kernelContainment}` as TranslationKey)}</dd>
                <dt className="text-muted-foreground">{tr("providers.executable")}</dt>
                <dd>{tr("providers.no")}</dd>
                <dt className="text-muted-foreground">{tr("providers.inference")}</dt>
                <dd>{tr("providers.not_verified")}</dd>
                <dt className="text-muted-foreground">{tr("providers.sandbox")}</dt>
                <dd>{tr(`providers.sandbox.${diagnostic.sandboxCompatibility}` as TranslationKey)}</dd>
                <dt className="text-muted-foreground">{tr("providers.account")}</dt>
                <dd>{tr(`providers.account.${diagnostic.accountBinding}` as TranslationKey)}</dd>
                <dt className="text-muted-foreground">{tr("providers.quota")}</dt>
                <dd>{tr("providers.auth.unknown")}</dd>
                <dt className="text-muted-foreground">{tr("providers.modes")}</dt>
                <dd>{tr("providers.modes.blocked")}</dd>
                <dt className="text-muted-foreground">{tr("providers.last")}</dt>
                <dd>{tr(`providers.last.${diagnostic.lastOutcome}` as TranslationKey)}</dd>
              </dl>
              <p className="text-xs">{tr(diagnostic.id === "cursor" ? "providers.cursor.detail" : "providers.deepseek.detail")}</p>
            </div>
          ))}
          {payload.installations?.map((installation) => (
            <div key={installation.id} data-testid="deepseek-installation" className="space-y-2 rounded-md border border-border/60 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{installation.label}</span>
                {installation.version && <span className="text-xs text-muted-foreground">{installation.version}</span>}
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{tr(`deepseek.${installation.status}`)}</span>
              </div>
              {installation.path && <p className="break-all text-xs text-muted-foreground">{installation.path}</p>}
              <p>{tr("deepseek.blocker")}</p>
              {installation.executionPolicy?.status === "blocked" && <p className="text-xs" data-testid="deepseek-policy-blocker">{tr("deepseek.filesystem_blocker")}</p>}
              <p className="text-xs text-muted-foreground">{tr("deepseek.unknown")}</p>
              <p className="text-xs text-muted-foreground">{tr("deepseek.discovery")}</p>
            </div>
          ))}
          {payload.harnesses.map((h) => {
            const status = statusByHarness.get(h.id);
            const available = status?.available ?? false;
            return (
              <div
                key={h.id}
                className={cn(
                  "space-y-1.5 rounded-md border border-border/60 px-3 py-2",
                  !h.enabled && "opacity-60",
                )}
              >
              <div className="flex items-center gap-2">
                <AgentIcon kind={h.kind} className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{h.label}</span>
                    {h.isBuiltin && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[length:var(--text-caption)] uppercase text-muted-foreground"><I18nText id="settings.built_in" />{" "}</span>
                    )}
                    {!h.enabled && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[length:var(--text-caption)] uppercase text-muted-foreground"><I18nText id="common.disabled" />{" "}</span>
                    )}
                    {isExperimentalKind(h.kind) && (
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-warning"><I18nText id="settings.experimental" />{" "}</span>
                    )}
                    {status?.loggedIn === false && (
                      <span
                        className="rounded bg-warning/15 px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-warning"
                        title={status.authHelp ?? tr("common.not_logged_in")}
                      ><I18nText id="settings.not_logged_in" />{" "}</span>
                    )}
                    <span
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        available ? "bg-success-solid" : "bg-danger-solid",
                      )}
                      title={status?.reason ?? status?.path ?? ""}
                    />
                  </div>
                  <div
                    className="truncate text-[length:var(--text-caption)] text-muted-foreground"
                    title={h.home ? `HOME=${abbreviateHome(h.home, homeDir)}` : undefined}
                  >
                    {h.id} · {h.kind}
                    {status?.version && <> · {status.version}</>}
                    {h.home && <> · HOME={shortenPath(h.home, homeDir, 2)}</>}
                  </div>
                  {status?.loggedIn === false && status.authHelp && (
                    <div className="truncate text-[length:var(--text-caption)] text-warning" title={status.authHelp}>
                      {status.authHelp}
                    </div>
                  )}
                </div>
                <Switch
                  checked={pendingToggle[h.id] ?? h.enabled}
                  onCheckedChange={() => onToggleEnabled(h)}
                  aria-label={h.enabled ? tr("common.disable_bd1da7", { p0: String(h.label) }) : tr("common.enable", { p0: String(h.label) })}
                />
                {/* claude-code only: no other kind has a local usage source
                    wired yet, and the route 400s for them. */}
                {h.kind === "claude-code" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setUsageOpenFor((cur) => (cur === h.id ? null : h.id))}
                    aria-label={tr("common.token_usage_for", { p0: String(usageOpenFor === h.id ? tr("common.hide") : tr("common.show")), p1: String(h.label) })}
                    aria-expanded={usageOpenFor === h.id}
                    title={tr("settings.token_usage_this_account_s_local_30_day")}
                  >
                    <BarChart3 className="size-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => onOpenTerminal(h)}
                  aria-label={tr("common.open_in_terminal", { p0: String(h.label) })}
                  title={tr("settings.open_in_terminal_load_this_harness_s_env")}
                >
                  <Terminal className="size-4" />
                </Button>
                {!h.isBuiltin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onEdit(h)}><I18nText id="common.edit" />{" "}</Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onDelete(h)}
                      aria-label={tr("common.delete_0ae262", { p0: String(h.label) })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
              {usageOpenFor === h.id && <AccountUsageTable harnessId={h.id} />}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * Per-day, per-model token rollup for one harness's account — fetched on
 * expand, not with the list, since the scan behind it stats every transcript
 * file. Numbers come from the account's local JSONL history, so they include
 * CLI sessions outside agetor (the budget shown is the account's).
 */
function AccountUsageTable({ harnessId }: { harnessId: string }) {
  useUILocale();
  const [days, setDays] = useState<AccountUsageDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setError(null);
    api.getAccountUsage(harnessId)
      .then((p) => { if (!cancelled) setDays(p.days); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [harnessId]);

  if (error) {
    return <p className="px-1 text-[length:var(--text-caption)] text-danger">{error}</p>;
  }
  if (days === null) {
    return <p className="px-1 text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.loading_usage" /></p>;
  }
  if (days.length === 0) {
    return (
      <p className="px-1 text-[length:var(--text-caption)] text-muted-foreground"><I18nText id="settings.no_local_usage_history_for_this_account_last" />{" "}</p>
    );
  }
  return (
    <div className="max-h-48 overflow-auto rounded-md border border-border/40 bg-muted/20">
      <table className="w-full text-[length:var(--text-caption)]">
        <thead className="sticky top-0 bg-muted/80 text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium"><I18nText id="common.day" /></th>
            <th className="px-2 py-1 text-left font-medium"><I18nText id="common.model" /></th>
            <th className="px-2 py-1 text-right font-medium"><I18nText id="settings.in" /></th>
            <th className="px-2 py-1 text-right font-medium"><I18nText id="settings.out" /></th>
            <th className="px-2 py-1 text-right font-medium"><I18nText id="settings.cache_w_r" /></th>
            <th className="px-2 py-1 text-right font-medium"><I18nText id="settings.msgs" /></th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={`${d.day}:${d.model}`} className="border-t border-border/30">
              <td className="px-2 py-1 font-mono">{d.day}</td>
              <td className="max-w-40 truncate px-2 py-1">{d.model}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.inputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">{formatTokens(d.outputTokens)}</td>
              <td className="px-2 py-1 text-right font-mono">
                {formatTokens(d.cacheWriteTokens)}/{formatTokens(d.cacheReadTokens)}
              </td>
              <td className="px-2 py-1 text-right font-mono">{d.messageCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Turn a discovered account into a pre-filled editor template. The email
 *  lands in the label so two claude harnesses stay distinguishable in every
 *  picker; the config dir becomes the harness home verbatim. */
function discoveredToTemplate(a: DiscoveredAccount): HarnessTemplate {
  return {
    id: `__discovered:${a.configDir}`,
    label: tr("common.claude", { p0: String(a.email) }),
    description: "",
    kind: "claude-code",
    suggestedHarnessId: a.suggestedHarnessId,
    home: a.configDir,
    bin: null,
    env: {},
  };
}

function TemplatePicker({ onPick }: { onPick: (t: HarnessTemplate) => void }) {
  useUILocale();
  // Existing logged-in Claude config dirs no harness points at yet. Loaded
  // on open; a failed probe degrades to the static templates only.
  const [discovered, setDiscovered] = useState<DiscoveredAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.discoverAccounts()
      .then((p) => { if (!cancelled) setDiscovered(p.accounts); })
      .catch(() => { /* static templates still work */ });
    return () => { cancelled = true; };
  }, []);
  return (
    <div className="space-y-2 pt-3">
      <p className="text-xs text-muted-foreground"><I18nText id="settings.pick_a_starting_point_you_can_edit_every" />{" "}</p>
      {discovered.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-muted-foreground"><I18nText id="settings.detected_accounts" />{" "}</p>
          {discovered.map((a) => (
            <button
              key={a.configDir}
              type="button"
              onClick={() => onPick(discoveredToTemplate(a))}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-left",
                "hover:border-primary/60 hover:bg-accent/50",
              )}
            >
              <AgentIcon kind="claude-code" className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium"><I18nText id="settings.existing_claude_account" />{" "}{a.email}
                </div>
                <div className="truncate text-[length:var(--text-caption)] text-muted-foreground">
                  {a.configDir}
                  {a.billingType && <> · {a.billingType}</>}
                  {" "}<I18nText id="settings.already_logged_in_no_setup_needed" />{" "}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="space-y-1.5">
        {HARNESS_TEMPLATES.map((t) => {
          const experimental = isExperimentalKind(t.kind);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className={cn(
                "flex w-full items-start gap-3 rounded-md border border-border/60 px-3 py-2 text-left",
                "hover:border-primary/60 hover:bg-accent/50",
              )}
            >
              {experimental && (
                <span className="mt-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-warning"><I18nText id="settings.experimental_3dc9f5" />{" "}</span>
              )}
              <AgentIcon kind={t.kind} className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{staticLabel(t.label)}</div>
                <div className="text-[length:var(--text-caption)] text-muted-foreground">{t.description}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Editor({
  template,
  isEdit,
  homeDir,
  dataDir,
  existingIds,
  busy,
  error,
  onDirtyChange,
  onCancel,
  onSubmit,
}: {
  template: HarnessTemplate;
  isEdit: boolean;
  homeDir: string;
  dataDir: string;
  existingIds: Set<string>;
  busy: boolean;
  error: string | null;
  /** Reports whether any field differs from what the form opened with;
   *  reports `false` again on unmount. */
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSubmit: (input: HarnessInput) => void;
}) {
  const { locale: uiLocale } = useUILocale();
  // When creating from a template, pre-bump the suggested id past any
  // already-taken slug (claude-2 → claude-3 …) so two clicks of "Additional
  // Claude Code" don't both default to the same id. If `home` ends with the
  // original suggested id, rewrite its trailing segment so the suggested
  // HOME stays in sync. Editing an existing harness skips this so the row's
  // own id passes through unchanged.
  const initialState = useMemo(() => {
    if (isEdit) {
      return {
        id: template.suggestedHarnessId,
        home: template.home ? abbreviateHome(template.home, homeDir) : "",
      };
    }
    const uniqId = uniqueHarnessId(template.suggestedHarnessId, existingIds);
    const home = resolveTemplateInitialHome(template, uniqId);
    return { id: uniqId, home: home ? abbreviateHome(home, homeDir) : "" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiLocale]);
  const [id, setId] = useState(initialState.id);
  const [label, setLabel] = useState(template.label);
  const [kind, setKind] = useState<AgentKind>(template.kind);
  const [home, setHome] = useState(initialState.home);
  const [bin, setBin] = useState(template.bin ?? "");
  const [envText, setEnvText] = useState(stringifyEnv(template.env));
  const [localError, setLocalError] = useState<string | null>(null);

  // Dirty = any field differs from what the state above was seeded with. All
  // six are seeded synchronously, so a plain value diff is exact.
  const [initialDraft] = useState(() => ({
    id: initialState.id,
    label: template.label,
    kind: template.kind as string,
    home: initialState.home,
    bin: template.bin ?? "",
    envText: stringifyEnv(template.env),
  }));
  // While a save is in flight the edits are being persisted, not discarded —
  // report clean so leaving mid-save doesn't ask "Discard unsaved changes?".
  // A failed save flips `busy` back and the form reads dirty again.
  const dirty = harnessEditorDirty({ id, label, kind, home, bin, envText }, initialDraft) && !busy;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current(false), []);

  // Parse once per render so we can warn about ignored lines below the
  // textarea. Cheap — the env block is tiny.
  const parsedEnv = useMemo(() => parseEnv(envText), [envText, uiLocale]);

  const submit = () => {
    setLocalError(null);
    const trimmedId = id.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmedId)) {
      setLocalError("id must be a slug — lowercase letters, digits, `_` or `-`, starting with a letter or digit");
      return;
    }
    if (!isEdit && existingIds.has(trimmedId)) {
      setLocalError(`a harness with id "${trimmedId}" already exists`);
      return;
    }
    if (!label.trim()) {
      setLocalError("label is required");
      return;
    }
    const homeTrim = home.trim();
    const homeAbs = expandTilde(homeTrim || null, homeDir);
    if (homeAbs && !homeAbs.startsWith("/")) {
      setLocalError("HOME must be an absolute path (use `/...` or `~/...`)");
      return;
    }
    const binTrim = bin.trim();
    if (binTrim && !binTrim.startsWith("/")) {
      setLocalError("bin must be an absolute path");
      return;
    }
    onSubmit({
      id: trimmedId,
      kind,
      label: label.trim(),
      home: homeAbs,
      bin: binTrim || null,
      env: parsedEnv.env,
    });
  };

  return (
    <div className="space-y-3 pt-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground"><I18nText id="settings.id_slug" /></label>
          <Input
            {...IDENTIFIER_INPUT_PROPS}
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit || busy}
            placeholder="claude-work"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground"><I18nText id="settings.label" /></label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            placeholder={tr("settings.claude_work_634785")}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="settings.harness_type" /></label>
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
          {(["claude-code", "codex", "cursor", "gemini", "antigravity", "fx"] as AgentKind[]).map((k) => {
            const experimental = isExperimentalKind(k);
            return (
              <Button
                key={k}
                size="sm"
                variant={kind === k ? "default" : "outline"}
                onClick={() => setKind(k)}
                disabled={isEdit || busy}
                className="justify-start"
              >
                <AgentIcon kind={k} className="mr-1.5 size-3.5" />
                {k}
                {experimental && (
                  <span className="ml-1.5 rounded bg-warning/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-warning"><I18nText id="settings.exp" />{" "}</span>
                )}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {HARNESS_HOME_COPY[kind].label}
        </label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          value={home}
          onChange={(e) => setHome(e.target.value)}
          disabled={busy}
          placeholder={
            dataDir
              ? abbreviateHome(`${dataDir}/harnesses/${HARNESS_HOME_COPY[kind].slug}`, homeDir)
              : undefined
          }
        />
        <p className="text-[length:var(--text-caption)] leading-snug text-muted-foreground">
          {HARNESS_HOME_COPY[kind].help}
          {" "}<I18nText id="settings.leave_empty_to_share_the_default_account" />{" "}</p>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="settings.bin_override_absolute_path_optional" /></label>
        <Input
          {...IDENTIFIER_INPUT_PROPS}
          value={bin}
          onChange={(e) => setBin(e.target.value)}
          disabled={busy}
          placeholder="/opt/homebrew/bin/claude"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="settings.env_vars_one_key_value_per_line" /></label>
        <Textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          disabled={busy}
          rows={3}
          className="font-mono text-xs"
        />
        {parsedEnv.ignored > 0 && (
          <p className="text-[length:var(--text-caption)] leading-snug text-warning">
            {parsedEnv.ignored}{" "}<I18nText id="common.line" />{parsedEnv.ignored === 1 ? "" : englishPluralSuffix()}{" "}<I18nText id="settings.ignored_each_entry_needs" />{" "}<code className="font-mono">KEY=value</code>.
          </p>
        )}
      </div>

      {(localError || error) && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-danger">
          {localError || error}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" onClick={onCancel} disabled={busy}><I18nText id="common.cancel" />{" "}</Button>
        <Button onClick={submit} disabled={busy}>
          {isEdit ? tr("common.save") : tr("settings.add_harness")}
        </Button>
      </div>
    </div>
  );
}
