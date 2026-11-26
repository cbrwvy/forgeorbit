import type { AnalyticsFilter, ForecastSelection, PricingTerms } from "../../shared/usage-analytics.ts";
import type { HandsoffEvent, HandsoffRun } from "../../shared/handsoff.ts";
export interface HandsoffTaskView { run: HandsoffRun | null; events: HandsoffEvent[] }
export interface HandsoffPolicyView {
  projectPath: string;
  policy: import("../../shared/handsoff.ts").HandsoffPolicy;
  revision: number;
  activatedAt: number | null;
  workingCopy: boolean;
  available: { harnessId: string; harnessLabel: string; accountKey: string; accountLabel: string; role: "developer" | "reviewer" }[];
  authorization: import("../../shared/handsoff-authorization.ts").HandsoffAuthorizationView;
}
import type { AppBuildInfo } from "../../shared/release-version.ts";
export type { AppBuildInfo };
import type { analytics, taskBreakdown, usageSelectors } from "../../bun/usage-analytics/analytics.ts";
import type { analyticsRecords } from "../../bun/usage-analytics/records.ts";
import type { estimateVersions, forecast } from "../../bun/usage-analytics/forecast.ts";
import type { quotaHistory, ResourceKey, savePricing, usageResources } from "../../bun/usage-analytics/resources.ts";
import type { ExecutorPreferences, RecommendationResponse } from "../../shared/execution/executor-routing.ts";
import type { ProjectLifecycleActionResult, ProjectLifecycleSnapshot } from "../../shared/project-lifecycle.ts";
import { apiErrorText } from "@/i18n/presentation";
import type { ActivityQueryFilter, ActivityEventsResponse, ActivityEvent } from "../../shared/activity/types.ts";
import type { BrowserObservation, BrowserSessionView } from "../../shared/browser/types.ts";
import type {
  NativeAction,
  NativeActionClaim,
  NativeApplicationRecord,
  NativeObservation,
  NativePermissionStatus,
  NativeProcessIdentity,
  NativeSessionView,
  NativeWindowRecord,
} from "../../shared/native-computer/types.ts";
import type { ProfessionalTurn, TurnHistory } from "../../shared/execution/turn.ts";
import type { HeadPortfolioBinding } from "../../shared/head-portfolio-binding.ts";
import type {
  CatalogFilter,
  CatalogManifestSummary,
  DivisionMeta,
  RoleTemplate,
  RoleTemplateSummary,
} from "../../shared/catalog/types.ts";
import type {
  AssignProfessionalRoleRequest,
  EmployeeProfessionalProfile,
  EmployeePromptRevision,
  EmployeePromptRevisionSummary,
  UpdateProfessionalPromptRequest,
} from "../../shared/employees/profile-types.ts";
import type {
  ApproveHiringProposalRequest,
  HiringProposal,
  HiringProposalEvent,
  HiringProposalSummary,
  RejectHiringProposalRequest,
  RunbookDetail,
  RunbookSummary,
  UpdateHiringProposalRequest,
} from "../../shared/hiring/types.ts";
import type { DocKind, ProjectDiscovery } from "../../shared/project-discovery.ts";
import type { EnvironmentCommandResult, EnvironmentIndex } from "@/i18n/environment";
import type { EstimationRecord, EstimationSettings } from "../../shared/estimation/settings.ts";
import type { ClusterAggregate } from "../../shared/clusters/aggregate.ts";
import type { Cluster, ClusterDetails, ClusterProject } from "../../shared/clusters/types.ts";
import type { Employee, EmployeeDetails, OrganizationTree, ProjectTeam } from "../../shared/employees/types.ts";
import type { AssignmentProposal, AssignmentProposalEvent, ProposalSummary } from "../../shared/assignments/proposals.ts";
import type { AssignmentCandidate, AssignmentRouterHandoff, TaskAssignment, TaskAssignmentEvent } from "../../shared/assignments/types.ts";
import type {
  ClusterInfrastructureView,
  InfrastructureResource,
  ProjectEnvironmentDeclaration,
} from "../../shared/infrastructure/model.ts";
import type {
  KnowledgeDocument,
  KnowledgeOwnerRef,
  KnowledgeRevisionInfo,
  KnowledgeScope,
  KnowledgeSearchHit,
} from "../../shared/knowledge/document.ts";
import type { BrainKind, BrainMemory, BrainMemorySummary, BrainIndexStatus, BrainScopeKind, BrainStatusValue } from "../../shared/brain/document.ts";
import type {
  BrainContextAccess,
  BrainContextGrant,
  BrainContextPreview,
  BrainContextRequest,
  BrainContextTarget,
  BrainEligibleResult,
  BrainTransmission,
} from "../../shared/brain/context.ts";
import type {
  KnowledgeContextGrant,
  KnowledgeContextPreview,
  KnowledgeContextTarget,
  KnowledgeEligibleResult,
  KnowledgeSelectionInput,
  KnowledgeTransmission,
} from "../../shared/knowledge/context.ts";
import type { PortfolioAnalysis, PortfolioSnapshotInput } from "../../shared/portfolio/index.ts";
import type {
  DelegationView,
  PortfolioDecision,
  PortfolioManagerMessage,
  PortfolioManagerState,
  PortfolioPlan,
} from "../../shared/portfolio-manager.ts";
import type { HeadPmCoordinationSnapshot } from "../../shared/head-pm-coordination.ts";
import type { HeadPmInitiativeView } from "../../shared/head-pm-initiative.ts";
import type { StructuredDependency } from "../../shared/estimation/project-adapter.ts";
import type { EnvironmentLogs, LaunchProfile, UrlAvailability } from "../../shared/environment/types.ts";
import type {
  DraftsReply,
  InterviewDrafts,
  InterviewIsolation,
  InterviewMessage,
  InterviewRequest,
  InterviewState,
  QuestionReply,
  SectionReply,
} from "../../shared/project-interview.ts";
import type {
  ContextSource,
  ManagerConfig,
  ManagerDecision,
  ManagerState,
  ProposalItemEdit,
  TaskProposal,
} from "../../shared/project-manager.ts";
import type { ExecutionConfig, ExecutionResult, ExecutionView } from "../../shared/project-execution.ts";
import type { PlanView } from "../../shared/task-plan.ts";
import type { QueueView } from "../../shared/task-queue.ts";
import type { AutonomyPreview } from "../../shared/autonomy.ts";
import type { BatchEventRow, BatchPolicy, BatchView, TaskPriority, TaskSchedulingView } from "../../shared/task-scheduling.ts";
import { TASK_EVENTS_REPLAY_META_EVENT, type AccessMode, type AgentKind, type AgentProfile, type AgentStatus, type AppEvent, type BranchInfo, type BranchNamingConfig, type ColumnId, type DbCompactResult, type DbStats, type DiscoveredAccount, type GitHubAssigneesResult, type GitHubCheckRun, type GitHubChecksResult, type GitHubComment, type GitHubCommentsResult, type GitHubCommitStatus, type GitHubCommitStatusResult, type GitHubDiscussion, type GitHubDiscussionCategory, type GitHubDiscussionComment, type GitHubDiscussionDetail, type GitHubDiscussionsResult, type GitHubIssueThreadResult, type GitHubItemKind, type GitHubItemState, type GitHubLabelsResult, type GitHubLinkedIssue, type GitHubLinkedIssuesResult, type GitHubListItem, type GitHubListResult, type GitHubMilestonesResult, type GitHubNotification, type GitHubNotificationsResult, type GitHubProjectField, type GitHubProjectItem, type GitHubProjectItemsResult, type GitHubProjectV2, type GitHubProjectsV2Result, type GitHubPullCommit, type GitHubPullCommitsResult, type GitHubPullDefaultsResult, type GitHubPullLineComment, type GitHubPullMergeMethod, type GitHubPullMergeResult, type GitHubPullMergeability, type GitHubPullReviewCommentsResult, type GitHubPullReviewEvent, type GitHubPullReviewThreadsResult, type GitHubReactionContent, type GitHubReactionSubject, type GitHubReactionSummary, type GitHubReactionsResult, type GitHubRelease, type GitHubReleasesResult, type GitHubRepoLabel, type GitHubRepoMilestone, type GitHubRepoPermissions, type GitHubSubIssue, type GitHubSubIssuesResult, type GitHubTag, type GitHubTagsResult, type GitHubWorkflow, type GitHubWorkflowRun, type GitHubWorkflowRunsResult, type GitHubWorkflowsResult, type GitProvider, type GlobalEvent, type Handoff, type Harness, type HarnessQuota, type HarnessStatus, type HarnessUsage, type Isolation, type Pipeline, type PipelineInput, type Project, type RetentionPassResult, type Run, type RunEvent, type SavedPrompt, type Subagent, type Task, type TaskDiff, type TaskEventsReplayMeta, type TaskGitStatus, type TaskReference, type TaskTeardownPreview, type TaskType, type TerminalTab, type UpdateStatus, type WorktreeGitStatus, type WorktreeInfo, type WorktreeTeardownResult } from "../../shared/types.ts";

import type {
  BundleExportResponse,
  BundlePickResponse,
  BundleSaveResponse,
  BundleSelection,
} from "../../shared/bundle.ts";
import type {
  BackupHistoryResponse,
  BackupOperationView,
  BackupPickPurpose,
  BackupProfileInfo,
  BackupRestorePreview,
  BackupSnapshotSummary,
} from "../../shared/backup.ts";
import type {
  ProfileActivationCandidateResponse,
  ProfileActivationPrepareResponse,
  ProfileActivationRelinkResponse,
  ProfileActivationRelaunchResponse,
  ProfileActivationStatusResponse,
} from "../../shared/profile-activation.ts";
import type { BundleImportOptions, BundleImportPlan, BundleImportResponse } from "../../shared/bundle-import.ts";
import { ApiTransitError, fetchWithRecovery } from "./net-retry.ts";
import { configureCoreBusy, suspendCoreBusy, trackRequest } from "./core-busy.ts";
import { createAccountApi } from "./account-api.ts";
import { createModelRouterApi } from "./model-router-api.ts";
import type { PreflightResult } from "../../shared/execution/preflight.ts";
import type { EmployeeRunReviewResponse, PreflightBody } from "./employee-execution.ts";
import type { EmployeeRunView } from "../../shared/execution/run.ts";

export interface UpdateSnapshot {
  status: UpdateStatus;
  version: string | null;
  error: string | null;
  lastCheckedAt: number | null;
}

// Re-exported from shared so existing `import { type BranchInfo } from "@/lib/api"`
// callers (BranchPicker) keep working while the single definition lives in
// src/shared/types.ts (server + webview share one wire shape).
export type { BranchInfo, BranchNamingConfig };
export type {
  GitHubCheckRun,
  GitHubChecksResult,
  GitHubComment,
  GitHubCommentsResult,
  GitHubCommitStatus,
  GitHubCommitStatusResult,
  GitHubIssueThreadResult,
  GitHubItemKind,
  GitHubItemState,
  GitProvider,
  GitHubAssigneesResult,
  GitHubDiscussion,
  GitHubDiscussionCategory,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubDiscussionsResult,
  GitHubLabelsResult,
  GitHubRepoLabel,
  GitHubMilestonesResult,
  GitHubRepoMilestone,
  GitHubLinkedIssue,
  GitHubLinkedIssuesResult,
  GitHubListItem,
  GitHubListResult,
  GitHubNotification,
  GitHubNotificationsResult,
  GitHubPullCommit,
  GitHubPullCommitsResult,
  GitHubPullDefaultsResult,
  GitHubPullLineComment,
  GitHubPullMergeability,
  GitHubPullMergeMethod,
  GitHubPullReviewCommentsResult,
  GitHubPullReviewThreadsResult,
  GitHubPullMergeResult,
  GitHubPullReviewEvent,
  GitHubProjectField,
  GitHubProjectItem,
  GitHubProjectItemsResult,
  GitHubProjectV2,
  GitHubProjectsV2Result,
  GitHubReactionContent,
  GitHubReactionsResult,
  GitHubReactionSubject,
  GitHubReactionSummary,
  GitHubRelease,
  GitHubReleasesResult,
  GitHubRepoPermissions,
  GitHubSubIssue,
  GitHubSubIssuesResult,
  GitHubTag,
  GitHubTagsResult,
  GitHubWorkflow,
  GitHubWorkflowRun,
  GitHubWorkflowRunsResult,
  GitHubWorkflowsResult,
};
export { commitPushPrompt } from "@/i18n/options";

/** Where a command/extension comes from. `plugin` entries are contributed by an
 *  enabled Claude Code plugin and are namespaced `<plugin>:<name>`; `builtin`
 *  entries are baked into the harness binary (e.g. /init, /review). */
export type EntrySource = "user" | "project" | "plugin" | "builtin";

export interface AvailableCommand {
  name: string;
  description: string;
  source: EntrySource;
  kind: "command" | "skill";
}

/** An MCP server / skill / plugin surfaced by the prompt-top picker.
 *  `insert` is the token dropped into the textarea (`/name` for skills,
 *  `@name` for MCP servers and plugins). */
export interface AvailableExtension {
  name: string;
  insert: string;
  description: string;
  source: EntrySource;
  kind: "mcp" | "skill" | "plugin";
}

/** Per-kind model id list from the CLI's own catalog discovery — kept fresh
 *  by the boot sweep, the periodic 15-minute re-probe, harness-status
 *  transitions, and a manual refresh (`refreshAgentModels`), not just at
 *  boot. For fx (account-scoped catalogs), this kind-level map reflects the
 *  built-in harness only — see `HarnessModelMap` for the per-harness list a
 *  multi-account setup needs. */
export interface AgentModelMap {
  "claude-code": { id: string; label?: string; efforts?: string[] }[];
  "codex": { id: string; label?: string; efforts?: string[] }[];
  "cursor": { id: string; label?: string; efforts?: string[] }[];
  "gemini": { id: string; label?: string; efforts?: string[] }[];
  "antigravity": { id: string; label?: string; efforts?: string[] }[];
  "fx": { id: string; label?: string; efforts?: string[] }[];
}

/** Per-harness model id list from `GET /agent-models/harnesses` — one entry
 *  per *enabled* harness (every kind, not just fx; non-fx harnesses carry
 *  their kind's list so callers have a single lookup keyed by harness id,
 *  which is what `task.agent` / the New Task form's `agent` state hold).
 *  `ready` is false until the boot discovery sweep has resolved at least
 *  once — before that, `byHarness` may be incomplete or empty. `efforts`
 *  carries the CLI-discovered per-model reasoning-effort ids (codex only
 *  today; see `discoveredEffortsFor` in `src/shared/model-options.ts`). */
export interface HarnessModelMap {
  ready: boolean;
  byHarness: Record<string, { id: string; label?: string; efforts?: string[] }[]>;
}

/** Pending multi-question card from claude's built-in AskUserQuestion tool
 *  (scraper-sourced). */
export interface PendingAskQuestions {
  kind: "ask_questions";
  id: string;
  taskId: string;
  runId: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string; preview?: string }>;
  }>;
  createdAt: number;
}

/** Modal the tmux pane scraper detected — typically a plan-mode safety
 *  dialog or another REPL prompt the PreToolUse hook system never sees.
 *  Each `choices[i].key` is the literal keystroke the server will
 *  `tmux send-keys` on click. */
export interface PendingTmuxPrompt {
  kind: "tmux_prompt";
  id: string;
  taskId: string;
  runId: string;
  paneText: string;
  choices: Array<{ key: string; label: string }>;
  fingerprint: string;
  createdAt: number;
  /** True when the scraper couldn't parse this modal into choices (footer-
   *  gated fallback or stuck-turn watchdog) — `choices` is always `[]` in
   *  that case. The RunPanel renders an "Open in Terminal" fallback card
   *  instead of choice buttons. */
  unparsable?: boolean;
}

/** The ACP tool call an fx permission request is asking about — mirrors
 *  `FxPermissionToolCall` on the server (`src/bun/interactions.ts`). Only
 *  `toolCallId` is guaranteed; `title`/`kind`/`rawInput` are rendered
 *  generically when absent. */
export interface FxPermissionToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
}

/** One selectable option fx offered. `kind` is a hint from ACP's
 *  `PermissionOptionKind` (`allow_once` | `allow_always` | `reject_once` |
 *  `reject_always`) but kept as a plain optional string since fx documents
 *  additional session-scoped kinds beyond those four — the card renders
 *  fx's own `name` verbatim rather than hardcoding a fixed set. */
export interface FxPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/** Pending fx ACP `session/request_permission` call (real in-process
 *  awaiter — unlike the two scraper-sourced kinds above, resolving this
 *  directly unblocks fx's turn; there is no pane and no keystroke leg).
 *  Mirrors `FxPermissionRequest` on the server. */
export interface PendingFxPermission {
  kind: "fx_permission";
  id: string;
  taskId: string;
  runId: string;
  createdAt: number;
  toolCall: FxPermissionToolCall;
  options: FxPermissionOption[];
  /** The agetor mode (`auto` | `ask`) that caused this request to surface
   *  as a card — `yolo` auto-allows and never reaches here. */
  mode: "auto" | "ask";
}

export type PendingInteraction =
  | PendingAskQuestions
  | PendingTmuxPrompt
  | PendingFxPermission;

/** One stored per-host git credential, as surfaced to the webview. The store
 *  is shared across GitHub/GitLab/Bitbucket — `host` may be a plain provider
 *  domain (github.com, gitlab.com, bitbucket.org) or a raw ssh alias host
 *  (e.g. github-work.com, bitbucket-work.com). The raw credential is never
 *  returned — `tokenPreview` is a redacted tail (e.g. "…abcd"). Routes keep
 *  the `/github/tokens` path and the `GitHub` type-name prefix for
 *  backwards compatibility with existing stored tokens; the type name is
 *  legacy naming only, not a GitHub-only shape. */
export interface GitHubTokenInfo {
  host: string;
  label: string | null;
  tokenPreview: string;
}

/** Response shape for the (misleadingly-named, back-compat) `/github/tokens`
 *  routes, which actually serve credentials for any supported git host —
 *  GitHub, GitLab, and Bitbucket. `detectedHosts` are the distinct raw
 *  remote hosts (including ssh aliases, across all three providers) seen
 *  across registered project dirs — used to suggest hosts that don't have a
 *  token yet. */
export interface GitHubTokensResult {
  tokens: GitHubTokenInfo[];
  detectedHosts: string[];
}

// Read api port + token, preferring globals injected by the Bun side via
// BrowserWindow's `preload` option — that path works under the native
// views:// scheme, which rejects URLs carrying a fragment or query.
// Fall back to URL hash for the Vite HMR path, which loads from a plain
// http:// URL where the hash payload still works.
declare global {
  interface Window { __AGETOR?: { port: string; token: string; theme?: string; fontSize?: number | string } }
}
// Guard `window` access for the test runtime (`bun test` runs this module
// outside a browser). Production paths always have a real window, so the
// `?? undefined` fallback never trips at runtime in the app.
const _win = typeof window !== "undefined" ? window : undefined;
const injected = _win?.__AGETOR;
const params = new URLSearchParams(
  ((_win?.location.hash || _win?.location.search) ?? "").replace(/^[#?]/, ""),
);
const API_PORT = injected?.port ?? params.get("api") ?? "4317";
const API_TOKEN = injected?.token ?? params.get("token") ?? "";
const BASE = `http://127.0.0.1:${API_PORT}`;

// Point the busy-banner watchdog at this core before the first request. It
// only ever probes the unauthenticated `/health` route and never aborts or
// retries a tracked request (docs/plans/non-blocking-session-restore.md).
configureCoreBusy({ base: BASE });

/** Error thrown for any non-2xx API response. Carries the parsed JSON body
 *  so callers can read structured fields (e.g. the `taskIds` list returned
 *  by `DELETE /harnesses/:id` when the harness is still in use) instead of
 *  re-parsing the message string. */
function brainContextQuery(target: BrainContextTarget, access?: BrainContextAccess, q?: string): string {
  const query = new URLSearchParams();
  query.set("managerKind", target.kind);
  if (target.kind === "project") query.set("projectPath", target.projectPath);
  if (access) {
    query.set("mode", access.mode);
    if (access.mode === "projects" && access.inheritCompany) query.set("inherit", "company");
    for (const path of access.projectPaths) query.append("scope", path);
  }
  if (q) query.set("q", q);
  return query.toString();
}

function brainContextBody(
  target: BrainContextTarget,
  access: BrainContextAccess,
  memories: BrainContextRequest["memories"],
  extra?: { previewKey: string; confirm: true },
): string {
  return JSON.stringify({
    managerKind: target.kind,
    ...(target.kind === "project" ? { projectPath: target.projectPath } : {}),
    mode: access.mode,
    ...(access.mode === "projects" ? { projectPaths: access.projectPaths, inheritCompany: access.inheritCompany } : {}),
    memories,
    ...extra,
  });
}

function contextTarget(target: KnowledgeContextTarget): { managerKind: string; projectPath?: string } {
  return target.kind === "project" ? { managerKind: "project", projectPath: target.projectPath } : { managerKind: "portfolio" };
}

function contextQuery(target: KnowledgeContextTarget, owner?: KnowledgeOwnerRef): string {
  const query = new URLSearchParams();
  query.set("managerKind", target.kind);
  if (target.kind === "project") query.set("projectPath", target.projectPath);
  if (owner) {
    query.set("ownerKind", owner.kind);
    query.set("ownerId", owner.id);
  }
  return query.toString();
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly diagnostic: string;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.diagnostic = message;
    Object.defineProperty(this, "message", { configurable: true, get: () => apiErrorText(status, body, message) });
  }
}

function j<T>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
): Promise<T> {
  // The whole request — fetch AND body parse — is registered with the
  // core-busy watchdog, so a response that was accepted but never finishes
  // (a blocked Bun main thread) counts as pending and can raise the banner.
  return trackRequest(jRequest<T>(path, init, opts));
}

async function jRequest<T>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
): Promise<T> {
  // fetchWithRecovery absorbs transient socket-layer rejections (WebKit's
  // bare "Load failed" — see net-retry.ts) via a health-gated single retry
  // before giving up; it throws a truthful error when the server really is
  // unreachable. HTTP error statuses still fall through to the !res.ok
  // handling below unchanged. `opts.retry: false` (set by a handful of
  // non-idempotent callers below) still probes health for the error
  // message but never re-issues the request.
  const res = await fetchWithRecovery({ fetchImpl: fetch, base: BASE }, path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${API_TOKEN}`,
      ...(init?.headers ?? {}),
    },
  }, opts);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in body && body.error)
      ? String(body.error)
      : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

/** `j` for the bundle routes, whose callers read fields off the answer:
 *  a 2xx whose body didn't parse as a JSON object (`j` resolves `null` for
 *  an unparsable one) is an answer the request lost on the way back, so it
 *  throws `ApiTransitError` — which the dialogs already word as "the
 *  connection dropped" and treat as "it may have run" — instead of letting
 *  a caller dereference `null` after an import that did commit. */
async function bundleJ<T extends object>(
  path: string,
  init?: RequestInit,
  opts?: { retry?: boolean },
): Promise<T> {
  const body = await j<unknown>(path, init, opts);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiTransitError(`request to ${path} returned an unreadable answer`);
  }
  return body as T;
}

/**
 * Run a request that is EXPECTED to block the core's main thread with the busy
 * banner suspended for its lifetime, so "Agetor is busy" never shows as a false
 * alarm: `compactDb` (VACUUM) and every request that opens a native Open panel
 * — Electrobun's `openFileDialog` is a synchronous FFI call, so the core is
 * blocked for as long as the user keeps the panel up (the server brackets
 * those calls with a `native file dialog` lag label for the same reason).
 */
export async function withCoreBusySuspended<T>(request: () => Promise<T>): Promise<T> {
  const release = suspendCoreBusy();
  try {
    return await request();
  } finally {
    release();
  }
}

export interface AppDefaults { home: string; cwd: string; dataDir: string }

/** One page of older task events, as returned by `GET /tasks/:id/events/page`
 *  (the "Load earlier" backward-paging cursor). Ascending order (oldest
 *  first), same shape as the SSE stream's events plus `id` — the real
 *  `run_events` row id, which the SSE stream never carries (see
 *  `TaskEventsReplayMeta`) but this paging route does, since it's exactly
 *  what the next `beforeId` needs. */
export interface TaskEventsPage {
  events: (RunEvent & { id: number })[];
  earliestId: number | null;
  hasMore: boolean;
}

/** One previously-sent message, as returned by
 *  `GET /tasks/:id/messages/history` — drives `MessageHistoryPicker`. Newest
 *  first, already coarsely deduped server-side (client still re-dedups after
 *  its own slash-command-XML/refs-block cleaning — see that component). */
export interface SentMessageItem {
  id: number;
  text: string;
  ts: number;
  taskId: string;
  taskTitle: string;
  project: string;
  agent: string;
}

export interface HarnessesPayload {
  harnesses: Harness[];
  statuses: HarnessStatus[];
  installations?: import("../../shared/harness-installation").HarnessInstallation[];
  providerDiagnostics?: import("../../shared/provider-readiness").ProviderDiagnostic[];
  runtimeReadiness?: import("../../shared/provider-runtime/readiness").RuntimeReadiness[];
}
/** One day × model row of an account's local token rollup. */
export interface AccountUsageDay {
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messageCount: number;
}
export interface AccountUsagePayload { configDir: string; days: AccountUsageDay[] }
export interface HarnessInput {
  id: string;
  kind: AgentKind;
  label: string;
  home: string | null;
  bin: string | null;
  env: Record<string, string>;
}

/** Body shape for `POST /agent-profiles` / `PATCH /agent-profiles/:id` — see
 *  `docs/plans/agent-profiles.md` §3 for the full contract. `harness` is a
 *  harness id (same semantics as `Task.agent` / `createTask`'s `agent`).
 *  `effort`/`mode` follow the task PATCH guard's null-clear-only philosophy;
 *  `skills` are bare names (no leading `/`), normalized server-side. */
export interface AgentProfileInput {
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  mode: string | null;
  fast: boolean;
  maxMode: boolean;
  instructions: string;
  skills: string[];
}

/** Body for `POST /agent-profiles/:id/duplicate` — omitted fields are copied
 *  from the source; `copyTasks` also re-creates its live tasks on the copy. */
export interface DuplicateAgentProfileInput extends Partial<AgentProfileInput> {
  copyTasks?: boolean;
}

export interface DuplicateAgentProfileResult {
  profile: AgentProfile;
  copiedTasks: Task[];
  taskCopyErrors: { sourceTaskId: string; error: string }[];
}

export const api = {
  ownerTrustStatus: () => j<{
    channel: string;
    available: boolean;
    executionReady: boolean;
    code: string;
    reason: string;
    state?: string;
    expectedProductionBundleId?: string;
    blockingReason?: string;
    secureEnclave?: string;
    secureEnclaveEnrolled?: boolean;
    enrollmentState?: string;
    userAuthenticationAvailable?: boolean;
    userAuthenticated?: boolean;
    providerExecutionEligible?: boolean;
    application: { bundleId: string | null; trustClass: string; adhoc: boolean; signed: boolean; teamId?: string | null; certSha256?: string | null };
    helper?: { ok: boolean; code: string; identifier: string | null; path: string | null };
    operation?: {
      projectPath: string;
      taskId: string;
      taskTitle: string;
      missionId: string;
      missionTitle: string;
      providerId: string;
      modelId: string;
      accountId: string;
      employeeRole: string;
      employeeJobTitle: string;
      mode: string;
      workspace: string;
      filesystem: string;
      terminalAllowed: boolean;
      browserAllowed: boolean;
      computerUseAllowed: boolean;
      gitRead: boolean;
      gitPublish: boolean;
      deploymentAllowed: boolean;
      scope: string;
      expiresAt: number;
      knownCost: string;
      costCoverage: string;
      externalProcess: boolean;
      cancellationAvailable: boolean;
    } | null;
    externalProcessWillStart: boolean;
  }>("/api/owner-trust/status"),
  ownerTrustReview: (body: { locale?: "en" | "ru" }) =>
    j<{ ok: boolean; code: string; reason: string; executionReady: boolean }>("/api/owner-trust/review", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  ownerTrustApprove: (body: { challengeId?: string; approved?: boolean }) =>
    j<{ ok: boolean; code: string; reason: string; executionReady: boolean }>("/api/owner-trust/approve", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  usageQuotaHistory: (quotaId: string, before: number | null = null) => j<ReturnType<typeof quotaHistory>>(
    `/api/usage-analytics/quota-history?quotaId=${encodeURIComponent(quotaId)}${before === null ? "" : "&before=" + before}`),
  usageResources: () => j<ReturnType<typeof usageResources>>("/api/usage-analytics/resources"),
  usageSelectors: () => j<ReturnType<typeof usageSelectors>>("/api/usage-analytics/selectors"),
  usageAnalytics: (filter: AnalyticsFilter, view?: { timeZone?: string; grain?: string }) => {
    const query = new URLSearchParams(Object.entries(filter).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : String(value)]]));
    if (view?.timeZone) query.set("timeZone", view.timeZone);
    if (view?.grain) query.set("grain", view.grain);
    return j<ReturnType<typeof analytics>>(`/api/usage-analytics/analytics?${query}`);
  },
  usageRecords: (filter: AnalyticsFilter) => {
    const query = new URLSearchParams(Object.entries(filter).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : String(value)]]));
    return j<ReturnType<typeof analyticsRecords>>(`/api/usage-analytics/records?${query}`);
  },
  /** Ask the core to write the export for this scope into Downloads: a blob download does nothing in the packaged WKWebView. */
  usageExportSave: (filter: AnalyticsFilter, view: { timeZone?: string; grain?: string; format: "csv" | "json"; report: "tasks" | "models" | "runs" }) => {
    const query = new URLSearchParams(Object.entries(filter).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : String(value)]]));
    if (view.timeZone) query.set("timeZone", view.timeZone);
    if (view.grain) query.set("grain", view.grain);
    query.set("format", view.format);
    query.set("report", view.report);
    return j<{ path: string; filename: string }>(`/api/usage-analytics/export/save?${query}`, { method: "POST" }, { retry: false });
  },
  usageAdjustment: (body: { taskId: string; runId?: string | null; amount: number; currency: string; note: string; supersedes?: number | null }) =>
    j<import("../../bun/usage-analytics/adjustments.ts").CostAdjustment>(
      "/api/usage-analytics/adjustments", { method: "POST", body: JSON.stringify(body) }, { retry: false },
    ),
  usageTask: (taskId: string) => j<NonNullable<ReturnType<typeof taskBreakdown>> & { revisions: ReturnType<typeof estimateVersions> }>(
    `/api/usage-analytics/task?taskId=${encodeURIComponent(taskId)}`,
  ),
  usageFallbackProposal: (body: { taskId: string; optionKey: string }) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>(
      "/api/usage-analytics/fallback-proposal", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  usageForecast: (selection: ForecastSelection) => j<ReturnType<typeof forecast>>(
    "/api/usage-analytics/forecast", { method: "POST", body: JSON.stringify(selection) },
  ),
  usagePricing: (input: PricingTerms & ResourceKey) => j<ReturnType<typeof savePricing>>(
    "/api/usage-analytics/pricing", { method: "POST", body: JSON.stringify(input) }, { retry: false },
  ),

  listActivity: (filter: ActivityQueryFilter = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return j<ActivityEventsResponse>(`/activity?${query}`, { signal });
  },
  getActivity: (id: string, signal?: AbortSignal) => j<{ event: ActivityEvent }>(`/activity/${encodeURIComponent(id)}`, { signal }),
  accountCore: createAccountApi(j),
  modelRouter: createModelRouterApi(j),
  // FO-010E1. Read-only calculation: no run, no task change, no process.
  professionalTurns: (runId: string, signal?: AbortSignal) =>
    j<TurnHistory>(`/employee-execution/runs/${encodeURIComponent(runId)}/turns`, { signal }),
  professionalTurnReview: (runId: string, body: { prompt: string; idempotencyKey: string }) =>
    j<{ turn: ProfessionalTurn; replayed: boolean }>(`/employee-execution/runs/${encodeURIComponent(runId)}/turn-reviews`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  professionalTurnSubmit: (id: string, body: { revision: number; idempotencyKey: string; confirm: true; acknowledgeUsage: true }) =>
    j<{ turn: ProfessionalTurn; replayed: boolean }>(`/employee-execution/turns/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  professionalTurnCancel: (id: string, revision: number) =>
    j<{ turn: ProfessionalTurn }>(`/employee-execution/turns/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ revision }) }, { retry: false }),
  employeeExecutionPreflight: (body: PreflightBody, signal?: AbortSignal) =>
    j<{ preflight: PreflightResult }>("/employee-execution/preflight", { method: "POST", body: JSON.stringify(body), signal }, { retry: false }),
  // FO-ORCH01. Read-only executor options and Owner routing preferences. Nothing here starts or applies a run.
  employeeExecutionRecommendations: (body: PreflightBody & { role?: import("../../shared/model-router/account-eligibility.ts").ResourceRole; mode?: string }, signal?: AbortSignal) =>
    j<RecommendationResponse>("/employee-execution/recommendations", { method: "POST", body: JSON.stringify(body), signal }, { retry: false }),
  getExecutorPreferences: () => j<{ preferences: ExecutorPreferences }>("/employee-execution/executor-preferences"),
  putExecutorPreferences: (preferences: ExecutorPreferences) =>
    j<{ preferences: ExecutorPreferences }>("/employee-execution/executor-preferences", { method: "PUT", body: JSON.stringify(preferences) }, { retry: false }),
  listAllocationPlans: (scopeRef: string) =>
    j<{ plans: import("../../shared/allocation/types.ts").AllocationPlanView[] }>(`/allocation-plans?scopeRef=${encodeURIComponent(scopeRef)}`),
  getAllocationPlan: (id: string) => j<import("../../shared/allocation/types.ts").AllocationPlanView>(`/allocation-plans/${encodeURIComponent(id)}`),
  proposeProjectAllocationPlan: (body: { projectPath: string; taskIds: string[]; title?: string; reviewerHarnessId?: string; reviewerModel?: string; reviewerMode?: string }) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>("/allocation-plans/project", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  recalculateAllocationPlan: (id: string, reviewer?: { reviewerHarnessId?: string; reviewerModel?: string; reviewerMode?: string }) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>(`/allocation-plans/${encodeURIComponent(id)}/recalculate`, { method: "POST", body: JSON.stringify(reviewer ?? {}) }, { retry: false }),
  approveAllocationPlan: (id: string, planDigest: string) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>(`/allocation-plans/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ planDigest }) }, { retry: false }),
  applyAllocationPlan: (id: string, approvedDigest: string) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>(`/allocation-plans/${encodeURIComponent(id)}/apply`, { method: "POST", body: JSON.stringify({ approvedDigest }) }, { retry: false }),
  patchAllocationPlanTaskResource: (id: string, taskId: string, optionId: string) =>
    j<import("../../shared/allocation/types.ts").AllocationPlanView>(`/allocation-plans/${encodeURIComponent(id)}/task-resource`, { method: "PATCH", body: JSON.stringify({ taskId, optionId }) }, { retry: false }),
  getAllocationPlanPolicy: () => j<{ policy: import("../../shared/allocation/types.ts").AllocationPlanPolicy }>("/allocation-plans/policy"),
  putAllocationPlanPolicy: (policy: import("../../shared/allocation/types.ts").AllocationPlanPolicy) =>
    j<{ policy: import("../../shared/allocation/types.ts").AllocationPlanPolicy }>("/allocation-plans/policy", { method: "PUT", body: JSON.stringify(policy) }, { retry: false }),
  getRouterV2Config: (scopeId = "global") =>
    j<{ policy: import("../../shared/router-v2/types.ts").ProjectRouterPolicyConfig }>(`/api/router-v2/config?scopeId=${encodeURIComponent(scopeId)}`),
  saveRouterV2Config: (policy: import("../../shared/router-v2/types.ts").ProjectRouterPolicyConfig) =>
    j<{ ok: boolean; policy: import("../../shared/router-v2/types.ts").ProjectRouterPolicyConfig }>("/api/router-v2/config", { method: "POST", body: JSON.stringify(policy) }, { retry: false }),
  evaluateRouterV2Task: (body: { requirements: import("../../shared/router-v2/types.ts").TaskRequirementsInput; policyOverride?: Partial<import("../../shared/router-v2/types.ts").ProjectRouterPolicyConfig> }) =>
    j<{ selected: import("../../shared/router-v2/types.ts").CandidateEvaluation | null; eligible: import("../../shared/router-v2/types.ts").CandidateEvaluation[]; ineligible: import("../../shared/router-v2/types.ts").CandidateEvaluation[]; all: import("../../shared/router-v2/types.ts").CandidateEvaluation[] }>("/api/router-v2/evaluate", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  proposeRouterV2Plan: (body: { projectTasks: { projectPath: string; taskIds: string[] }[]; policyOverride?: Partial<import("../../shared/router-v2/types.ts").ProjectRouterPolicyConfig> }) =>
    j<{ plan: import("../../shared/router-v2/types.ts").MultiProjectAllocationPlan }>("/api/router-v2/plans/propose", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  applyRouterV2Plan: (body: { plan: import("../../shared/router-v2/types.ts").MultiProjectAllocationPlan; approvedDigest: string }) =>
    j<{ success: boolean; appliedCount: number; errors: string[] }>("/api/router-v2/plans/apply", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  getRouterV2History: (limit = 50) =>
    j<{ history: import("../../shared/router-v2/types.ts").RoutingDecisionRecord[] }>(`/api/router-v2/history?limit=${limit}`),
  getInfraAutoSnapshot: () => j<import("../../shared/infra-auto/model.ts").InfraSnapshot>("/infra-auto/snapshot"),
  setInfraAutoControl: (body: { paused?: boolean; cancelled?: boolean }) =>
    j<{ paused: boolean; cancelled: boolean }>("/infra-auto/control", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  getOrchestrationMissions: (filter?: { status?: string; clusterId?: string }) => {
    const params = new URLSearchParams();
    if (filter?.status) params.set("status", filter.status);
    if (filter?.clusterId) params.set("clusterId", filter.clusterId);
    const qs = params.toString();
    return j<{ missions: import("../../shared/orchestration/types.ts").MissionRecord[] }>(`/api/orchestration/missions${qs ? `?${qs}` : ""}`);
  },
  missionResourceOptions: (id: string, taskId: string, role: "developer" | "reviewer") =>
    j<{ options: ReturnType<typeof import("../../bun/orchestration/mission-replan.ts").missionResourceOptions> }>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/resource-options?${new URLSearchParams({ taskId, role })}`),
  missionResourceProposals: (id: string) =>
    j<ReturnType<typeof import("../../bun/orchestration/mission-replan.ts").missionResourceProposals>>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/resource-proposals`),
  prepareMissionResourceProposal: (id: string, input: import("../../bun/orchestration/mission-replan.ts").ReplanInput) =>
    j<ReturnType<typeof import("../../bun/orchestration/mission-replan.ts").prepareMissionResourceProposal>>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/resource-proposals`, { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  settleMissionResourceProposal: (id: string, proposal: { id: string; digest: string }, decision: "approve" | "reject") =>
    j<ReturnType<typeof import("../../bun/orchestration/mission-replan.ts").settleMissionResourceProposal>>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/resource-proposals`,
      { method: "PATCH", body: JSON.stringify({ id: proposal.id, digest: proposal.digest, decision, confirm: true }) }, { retry: false }),
  approveObjectiveMission: (id: string, digest: string) =>
    j<{ mission: import("../../shared/orchestration/types.ts").MissionRecord }>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/approve-objective`,
      { method: "POST", body: JSON.stringify({ digest, confirm: true }) }, { retry: false }),
  confirmObjectiveLaunch: (id: string, taskId: string, operationId: string, locale: string) =>
    j<{ ok: boolean }>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/confirm-launch`,
      { method: "POST", headers: { "accept-language": locale }, body: JSON.stringify({ taskId, operationId, confirm: true }) }, { retry: false }),
  retryMissionQuotaWait: (id: string, taskId: string, refusalId: string) =>
    j<{ ok: boolean }>(
      `/api/orchestration/missions/${encodeURIComponent(id)}/confirm-launch`,
      { method: "POST", body: JSON.stringify({ taskId, refusalId, confirm: true }) }, { retry: false }),
  getOrchestrationMission: (id: string) =>
    j<{ mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}`),
  prepareOrchestrationMission: (body: unknown) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>("/api/orchestration/missions/prepare", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  authorizeOrchestrationMission: (id: string, digest: string) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}/authorize`, { method: "POST", body: JSON.stringify({ digest }) }, { retry: false }),
  startOrchestrationMission: (id: string) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" }, { retry: false }),
  pauseOrchestrationMission: (id: string, reason?: string) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}/pause`, { method: "POST", body: JSON.stringify({ reason }) }, { retry: false }),
  resumeOrchestrationMission: (id: string) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }, { retry: false }),
  cancelOrchestrationMission: (id: string, reason?: string) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord }>(`/api/orchestration/missions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }, { retry: false }),
  getOrchestrationReservations: (missionId?: string) =>
    j<{ reservations: import("../../shared/orchestration/types.ts").MissionReservation[] }>(`/api/orchestration/reservations${missionId ? `?missionId=${encodeURIComponent(missionId)}` : ""}`),
  getOrchestrationDependencies: (missionId: string) =>
    j<{ dependencies: import("../../shared/orchestration/types.ts").MissionTaskDependency[] }>(`/api/orchestration/dependencies/${encodeURIComponent(missionId)}`),
  autonomyStatus: () =>
    j<{
      emergency: { active: boolean; reason: string | null; outstanding: string[]; leftRunning?: number };
      policies: Array<{ id: string; revision: number; status: string; mode: string; digest: string; body: import("../../shared/autonomy-policy.ts").AutonomyPolicyBody }>;
      decisions: Array<{ id: string; policyId: string | null; revision: number | null; action: string; verdict: string; reason: string; taskId: string | null }>;
      enforcement: { supervised: boolean; autonomousActive: boolean; fullAutonomyActive: boolean };
      bindings?: Array<{ missionId: string; mode: string; outcome: string; activationId: string }>;
      activations?: Array<{ id: string; status: string; expiresAt: number }>;
    }>("/api/autonomy/status"),
  practicalCycleStatus: (missionId?: string) =>
    j<{
      limits: { testConcurrency: number; timeoutMs: number; maxOutputBytes: number };
      attempts: Array<{
        id: string;
        taskId: string;
        status: string;
        exitCode: number | null;
        summary: string | null;
        failureKind: string | null;
        command: string;
        sourceFingerprint: string;
        evidenceDigest: string | null;
        isolation: string;
        isolationReason: string | null;
        policyId: string;
        policyRevision: number;
        provider: string | null;
        model: string | null;
        accountId: string | null;
        instructionSha: string | null;
        executionMode: string | null;
        implementationExecution: string | null;
        reworkEpoch: number;
        workspacePath: string;
      }>;
      briefs: Array<{ taskId: string; epoch: number; kind: string; brief: string }>;
    }>(`/api/autonomy/practical-cycle${missionId ? `?missionId=${encodeURIComponent(missionId)}` : ""}`),
  createAutonomyPolicy: (body: unknown) =>
    j<{ ok: boolean; policy: { id: string; revision: number; status: string; digest: string; mode: string } }>("/api/autonomy/policies", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  prepareAutonomyMission: (body: unknown) =>
    j<{ ok: boolean; mission: import("../../shared/orchestration/types.ts").MissionRecord; policyId: string; revision: number }>("/api/autonomy/missions/prepare", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  activateAutonomyPolicy: (id: string, revision?: number) =>
    j<{ ok: boolean }>(`/api/autonomy/policies/${encodeURIComponent(id)}/activate`, { method: "POST", body: JSON.stringify({ revision }) }, { retry: false }),
  pauseAutonomyPolicy: (id: string) =>
    j<{ ok: boolean }>(`/api/autonomy/policies/${encodeURIComponent(id)}/pause`, { method: "POST", body: "{}" }, { retry: false }),
  resumeAutonomyPolicy: (id: string) =>
    j<{ ok: boolean }>(`/api/autonomy/policies/${encodeURIComponent(id)}/resume`, { method: "POST", body: "{}" }, { retry: false }),
  revokeAutonomyPolicy: (id: string) =>
    j<{ ok: boolean }>(`/api/autonomy/policies/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" }, { retry: false }),
  emergencyStopAutonomy: (reason: string) =>
    j<{ ok: boolean; outstanding: string[]; status?: { emergency: { leftRunning?: number } } }>("/api/autonomy/emergency-stop", { method: "POST", body: JSON.stringify({ reason }) }, { retry: false }),
  clearEmergencyStop: () =>
    j<{ ok: boolean }>("/api/autonomy/emergency-stop/clear", { method: "POST", body: "{}" }, { retry: false }),
  selfImprovementStatus: () =>
    j<{
      control: { enabled: boolean; paused: boolean; stopped: boolean; consecutiveNoGain: number };
      budget: { candidatesUsed: number; candidatesMax: number; activationAttempts: number; activationMax: number; quota: "unknown" };
      candidates: Array<{
        id: string;
        status: string;
        role: string;
        projectPath: string | null;
        risk: string;
        decision: string | null;
        currentContent: string;
        proposedContent: string | null;
        diffText: string | null;
        hypothesis: string | null;
        decisionReason: string | null;
        evidence: unknown[];
        metrics: {
          baselineErrors?: number;
          candidateErrors?: number;
          attribution?: string;
          quota?: string;
          execution?: string;
          inferenceCompleted?: boolean;
          generation?: string;
          evaluationKind?: string;
          sampleSize?: { fixtures: number; training: number; heldOut: number };
          baselineVersion?: number;
          candidateVersion?: number;
        } | null;
      }>;
      activeVersions: Array<{ artifactKey: string; version: number; role: string; scope: string; projectPath: string | null }>;
      launches: Array<{ runId: string; taskId: string; projectPath: string; role: string; snapshotSha: string; versions: Array<{ artifactKey: string; version: number }> }>;
      regressions: Array<{ id: string; role: string; decisionReason: string | null }>;
      autonomy: { permitting: number; lowRisk: number };
    }>("/api/self-improvement/status"),
  setSelfImprovementControl: (body: { enabled?: boolean; paused?: boolean; stopped?: boolean }) =>
    j<{ ok: boolean }>("/api/self-improvement/control", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  discoverSelfImprovements: () =>
    j<{ ok: boolean; candidates: unknown[] }>("/api/self-improvement/discover", { method: "POST", body: "{}" }, { retry: false }),
  prepareSelfImprovement: (id: string) =>
    j<{ ok: boolean }>(`/api/self-improvement/candidates/${encodeURIComponent(id)}/prepare`, { method: "POST", body: "{}" }, { retry: false }),
  evaluateSelfImprovement: (id: string, body: { provider?: string; model?: string; policyTest?: boolean }) =>
    j<{ ok: boolean; candidate: { decision?: string | null; decisionReason?: string | null } }>(`/api/self-improvement/candidates/${encodeURIComponent(id)}/evaluate`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  selfImprovementAction: (id: string, action: "approve" | "reject" | "activate" | "rollback" | "retain") =>
    j<{ ok: boolean }>(`/api/self-improvement/candidates/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }, { retry: false }),
  // FO-010E2. The review records one pending record and starts nothing; only
  // the owner's explicit confirmation of that record starts the task.
  employeeExecutionReview: (body: PreflightBody, signal?: AbortSignal) =>
    j<EmployeeRunReviewResponse>("/employee-execution/reviews", { method: "POST", body: JSON.stringify(body), signal }, { retry: false }),
  employeeExecutionStart: (id: string, body: { revision: number; confirm: true; acknowledgeUsage?: boolean; acknowledgeUnconfirmed?: boolean; acknowledgeFullAccess?: boolean }) =>
    j<{ attempt: EmployeeRunView; replayed: boolean }>(`/employee-execution/attempts/${encodeURIComponent(id)}/start`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  employeeExecutionCancel: (id: string, revision: number) =>
    j<{ attempt: EmployeeRunView }>(`/employee-execution/attempts/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ revision }) }, { retry: false }),
  employeeExecutionAttempt: (id: string, signal?: AbortSignal) =>
    j<{ attempt: EmployeeRunView }>(`/employee-execution/attempts/${encodeURIComponent(id)}`, { signal }),
  employeeExecutionReconcile: (id: string, signal?: AbortSignal) =>
    j<{ attempt: EmployeeRunView; outcome: string; confirmedRun: { id: string; status: string } | null }>(`/employee-execution/attempts/${encodeURIComponent(id)}/reconcile`, { method: "POST", body: "{}", signal }, { retry: false }),
  employeeExecutionAttempts: (filter: ({ taskId: string } | { employeeId: string }) & { limit?: number; before?: string }, signal?: AbortSignal) =>
    j<{ attempts: EmployeeRunView[] }>(`/employee-execution/attempts?${new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, { signal }),
  employeeWorkSummary: (employeeId: string, signal?: AbortSignal) =>
    j<{ summary: import("../../shared/execution/employee-summary.ts").EmployeeWorkSummary }>(`/employee-execution/summary?employeeId=${encodeURIComponent(employeeId)}`, { signal }),
  defaults: () => j<AppDefaults>("/defaults"),
  info: () => j<AppBuildInfo>("/info"),
  /** Toggle the window's macOS "zoom" state. Wired up to double-click on
   *  the app bar in App.tsx because Electrobun's drag region doesn't
   *  implement the native title-bar double-click gesture. */
  toggleWindowZoom: () =>
    j<{ ok: boolean; skipped?: string }>("/window/toggle-zoom", { method: "POST" }),
  /** Ask the main process to raise + focus the app window. A WKWebView's own
   *  `window.focus()` can't activate the host NSApplication, so every "bring
   *  agetor to front" affordance (toast clicks, etc.) has to round-trip
   *  through here instead. Best-effort UI polish: swallows failures behind a
   *  console.warn rather than throwing into a React event handler. */
  focusWindow: (): Promise<void> =>
    j<{ ok: true }>("/window/focus", { method: "POST" })
      .then(() => undefined)
      .catch((e) => { console.warn("[agetor] focusWindow failed", e); }),
  getUpdateStatus: () => j<UpdateSnapshot>("/updates/status"),
  checkForUpdate: () => j<UpdateSnapshot>("/updates/check", { method: "POST" }),
  applyUpdate: () => j<{ ok: true }>("/updates/apply", { method: "POST" }),
  listAgents: () => j<AgentStatus[]>("/agents"),
  listHarnesses: () => j<HarnessesPayload>("/harnesses"),
  createHarness: (input: HarnessInput) =>
    j<Harness>("/harnesses", { method: "POST", body: JSON.stringify(input) }),
  updateHarness: (id: string, patch: Partial<Omit<HarnessInput, "id" | "kind">>) =>
    j<Harness>(`/harnesses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteHarness: (id: string) =>
    j<void>(`/harnesses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setHarnessEnabled: (id: string, enabled: boolean) =>
    j<Harness>(`/harnesses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  getHarnessUsage: (id: string) =>
    j<HarnessUsage>(`/harnesses/${encodeURIComponent(id)}/usage`),
  /** Persisted quota/usage snapshots for every harness — seeds the topbar
   *  usage tracker on boot (`GET /usage`, distinct from `getHarnessUsage`
   *  above, which is unrelated task-count blast radius). Live updates
   *  arrive afterwards via the `harness_usage` `AppEvent` on
   *  `subscribeAppEvents`. */
  getAllUsage: () => j<HarnessQuota[]>("/usage"),
  /** Force a fresh quota fetch for one harness, bypassing the poller's
   *  cadence floor — the popover's manual Refresh button. */
  refreshHarnessUsage: (id: string) =>
    j<HarnessQuota>(`/harnesses/${encodeURIComponent(id)}/usage/refresh`, { method: "POST" }),
  /** Claude config dirs with a logged-in account that no harness points at
   *  yet — the Add-harness picker's "use an existing account" entries. */
  discoverAccounts: () => j<{ accounts: DiscoveredAccount[] }>("/harness-discovery"),
  /** Daily per-model token rollup for a claude-code harness's account. */
  getAccountUsage: (id: string) =>
    j<AccountUsagePayload>(`/harnesses/${encodeURIComponent(id)}/account-usage`),
  openHarnessTerminal: (id: string) =>
    j<{ ok: true }>(`/harnesses/${encodeURIComponent(id)}/open-terminal`, {
      method: "POST",
    }),
  listSavedPrompts: () => j<SavedPrompt[]>("/saved-prompts"),
  createSavedPrompt: (input: { name: string; content: string }) =>
    j<SavedPrompt>("/saved-prompts", { method: "POST", body: JSON.stringify(input) }),
  updateSavedPrompt: (id: string, patch: { name?: string; content?: string }) =>
    j<SavedPrompt>(`/saved-prompts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteSavedPrompt: (id: string) =>
    j<{ ok: true }>(`/saved-prompts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAgentProfiles: () => j<AgentProfile[]>("/agent-profiles"),
  getAgentProfile: (id: string) => j<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`),
  createAgentProfile: (input: AgentProfileInput) =>
    j<AgentProfile>("/agent-profiles", { method: "POST", body: JSON.stringify(input) }),
  duplicateAgentProfile: (id: string, input: DuplicateAgentProfileInput) =>
    // retry: false — a replay would create another copy.
    j<DuplicateAgentProfileResult>(
      `/agent-profiles/${encodeURIComponent(id)}/duplicate`,
      { method: "POST", body: JSON.stringify(input) },
      { retry: false },
    ),
  updateAgentProfile: (id: string, patch: Partial<AgentProfileInput>) =>
    j<AgentProfile>(`/agent-profiles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteAgentProfile: (id: string) =>
    j<void>(`/agent-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Detach a task from its bound agent profile — the values it copied stay
   *  on the task row, but the four dropdowns (+ cursor fast/max) unlock.
   *  404 unknown task, 409 archived. */
  detachTaskAgentProfile: (taskId: string) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/agent-profile`, { method: "DELETE" }),
  listPipelines: () => j<Pipeline[]>("/pipelines"),
  getPipeline: (id: string) => j<Pipeline>(`/pipelines/${encodeURIComponent(id)}`),
  createPipeline: (input: PipelineInput) =>
    // retry: false — a replay would create a duplicate pipeline (409 on
    // the name clash it collides with, but no reason to risk it).
    j<Pipeline>("/pipelines", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  updatePipeline: (id: string, patch: Partial<PipelineInput>) =>
    j<Pipeline>(`/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deletePipeline: (id: string) =>
    j<void>(`/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  // ── Agents + Pipelines bundle (docs/plans/agents-pipelines-import-export.md K4) ──
  /** The canonical bundle text for a selection, plus its counts and
   *  export-time warnings. Read-only, so a replay is harmless. */
  exportBundle: (selection: BundleSelection) =>
    bundleJ<BundleExportResponse>("/bundle/export", { method: "POST", body: JSON.stringify(selection) }),
  /** Save the export to ~/Downloads (revealed in Finder) or a folder picked
   *  in the native panel. `retry: false` — a replay would write a second,
   *  numbered copy (or open a second panel). Only the folder target opens a
   *  panel, so only it suspends the busy banner. */
  saveBundle: (selection: BundleSelection, target: "downloads" | "folder") => {
    const request = () =>
      bundleJ<BundleSaveResponse>(
        "/bundle/export/save",
        { method: "POST", body: JSON.stringify({ ...selection, target }) },
        { retry: false },
      );
    return target === "folder" ? withCoreBusySuspended(request) : request();
  },
  /** Choose file: the native Open panel, filtered to .json. `retry: false` —
   *  a replay would open the panel twice. */
  pickBundleFile: () =>
    withCoreBusySuspended(() =>
      bundleJ<BundlePickResponse>("/bundle/pick-file", { method: "POST", body: "{}" }, { retry: false }),
    ),
  /** Dry run: what importing `text` would create, rename and bind. `signal`
   *  lets the import dialog drop a preview it no longer wants (the dialog
   *  closed or got new text) instead of waiting for it to land. */
  previewBundleImport: (text: string, options: BundleImportOptions, signal?: AbortSignal) =>
    bundleJ<BundleImportPlan>("/bundle/import/preview", { method: "POST", body: JSON.stringify({ text, options }), signal }),
  /** Commit an import — all or nothing. 409 `{ error, plan }` when blocked,
   *  or when the re-plan no longer matches the previewed `planFingerprint`.
   *  `retry: false` — a replay after a lost response would import twice. */
  importBundle: (text: string, options: BundleImportOptions, planFingerprint: string) =>
    bundleJ<BundleImportResponse>(
      "/bundle/import",
      { method: "POST", body: JSON.stringify({ text, options, planFingerprint }) },
      { retry: false },
    ),
  /** A pipeline TASK's live run: the parent task plus every hidden step
   *  task belonging to it (`GET /tasks/:id/pipeline`) — what
   *  `PipelineRunView` needs in one round-trip. 404 unknown task, 400 the
   *  task isn't a pipeline task. */
  getPipelineRun: (taskId: string) =>
    j<{ task: Task; steps: Task[] }>(`/tasks/${encodeURIComponent(taskId)}/pipeline`),
  /** Manually advance a blocked (or just-settled) pipeline execution: start
   *  `nextStepIds`, or `null` to finish the run here. `handoff` seeds the
   *  synthetic handoff recorded for this manual transition (e.g. a
   *  free-text purpose/summary typed in the Advance form); `fromTaskId`
   *  disambiguates which blocked execution is being advanced when more than
   *  one is blocked at once. `retry: false` — a replay would double-start
   *  the next step(s). */
  advancePipeline: (
    taskId: string,
    body: { nextStepIds: string[] | null; handoff?: Partial<Handoff>; fromTaskId?: string },
  ) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/pipeline/advance`, {
      method: "POST",
      body: JSON.stringify(body),
    }, { retry: false }),
  /** Retry the pipeline's current blocked/cancelled execution. `taskId`
   *  disambiguates which blocked step task to retry when several are
   *  blocked at once; omit to retry the run's only/most-recent block.
   *  `retry: false` — a replay would double-spawn the retry. */
  retryPipeline: (taskId: string, body?: { taskId?: string }) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/pipeline/retry`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }, { retry: false }),
  /** Stop every active execution of a pipeline run and return the parent
   *  task to `ready` (state `cancelled`) — mirrors Stop on an ordinary
   *  task. `retry: false` to match every other cancel-shaped mutation. */
  cancelPipeline: (taskId: string) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/pipeline/cancel`, { method: "POST" }, { retry: false }),
  /** Restart a finished pipeline run (`done`/`cancelled`/`blocked`) from its
   *  start step, discarding the prior run's history — a fresh execution of
   *  the same parent task. Mirrors `startPipelineRun`'s own return shape
   *  (same as `/tasks/:id/start`'s bounded-spawn-await shape, item 16) —
   *  NOT a `Task`: the route hands back the server result verbatim.
   *  `retry: false` to match every other run-mutating pipeline route. */
  restartPipeline: (taskId: string) =>
    j<{ runId: string; pending?: true }>(`/tasks/${encodeURIComponent(taskId)}/pipeline/restart`, { method: "POST" }, { retry: false }),
  listAgentModels: () => j<AgentModelMap>("/agent-models"),
  /** Per-harness model catalog (fx account-scoped, one entry per enabled
   *  harness) — see `HarnessModelMap`. */
  listHarnessModels: () => j<HarnessModelMap>("/agent-models/harnesses"),
  /** Force a fresh discovery probe. Omit `harnessId` to refresh every
   *  enabled harness; pass one to refresh just that harness (the picker's
   *  manual ↻ button). Always returns the unchanged kind-level map — refetch
   *  `listHarnessModels()` separately for the per-harness view. */
  refreshAgentModels: (harnessId?: string) =>
    j<AgentModelMap>(
      harnessId ? `/agent-models?harness=${encodeURIComponent(harnessId)}` : "/agent-models",
      { method: "POST" },
    ),
  listProjects: (signal?: AbortSignal) => j<Project[]>("/projects", { signal }),
  relinkProject: (oldPath: string, newPath: string) =>
    j<{ ok: boolean; oldPath: string; newPath: string; reboundBrainMemories: number }>(
      "/projects/relink",
      { method: "POST", body: JSON.stringify({ oldPath, newPath }) },
      { retry: false },
    ),
  getProjectLifecycle: (path: string, signal?: AbortSignal) =>
    j<{ lifecycle: ProjectLifecycleSnapshot }>(`/projects/lifecycle?path=${encodeURIComponent(path)}`, { signal }),
  stopProject: (path: string, reason?: string) =>
    j<ProjectLifecycleActionResult>(
      "/projects/lifecycle/stop",
      { method: "POST", body: JSON.stringify(reason ? { path, reason } : { path }) },
      { retry: false },
    ),
  startProject: (path: string) =>
    j<ProjectLifecycleActionResult>(
      "/projects/lifecycle/start",
      { method: "POST", body: JSON.stringify({ path }) },
      { retry: false },
    ),
  getOwnerActions: () => j<import("../../shared/owner-actions.ts").OwnerActionsPayload>("/owner-actions"),
  getHandsoffOverview: () => j<import("../../shared/handsoff.ts").HandsoffOverview>("/handsoff/overview"),
  getHandsoffQueue: (projectPath?: string) =>
    projectPath
      ? j<import("../../shared/smart-queue.ts").SmartQueueProjectSummary>(`/handsoff/queue?projectPath=${encodeURIComponent(projectPath)}`)
      : j<import("../../shared/smart-queue.ts").SmartQueueOverview>("/handsoff/queue"),
  getHandsoffPolicy: (projectPath: string) =>
    j<HandsoffPolicyView>(`/handsoff/policy?projectPath=${encodeURIComponent(projectPath)}`),
  saveHandsoffPolicy: (projectPath: string, policy: Partial<import("../../shared/handsoff.ts").HandsoffPolicy>) =>
    j<HandsoffPolicyView>("/handsoff/policy", { method: "PUT", body: JSON.stringify({ projectPath, policy }) }, { retry: false }),
  getHandsoffAuthorization: (projectPath: string) =>
    j<import("../../shared/handsoff-authorization.ts").HandsoffAuthorizationView>(`/handsoff/authorization?projectPath=${encodeURIComponent(projectPath)}`),
  /** Opens the native Owner confirmation and waits for the Owner. The busy banner is suspended while it is open. */
  authorizeHandsoff: (projectPath: string, body: { hours: number; launches: number; locale: "en" | "ru" }) =>
    withCoreBusySuspended(() =>
      j<import("../../shared/handsoff-authorization.ts").HandsoffAuthorizationView>("/handsoff/authorization", { method: "POST", body: JSON.stringify({ projectPath, ...body }) }, { retry: false })),
  revokeHandsoffAuthorization: (projectPath: string) =>
    j<import("../../shared/handsoff-authorization.ts").HandsoffAuthorizationView>("/handsoff/authorization", { method: "DELETE", body: JSON.stringify({ projectPath }) }, { retry: false }),
  submitHandsoff: (taskId: string) =>
    j<HandsoffTaskView>("/handsoff/submit", { method: "POST", body: JSON.stringify({ taskId }) }, { retry: false }),
  getHandsoffTask: (taskId: string) => j<HandsoffTaskView>(`/handsoff/tasks/${encodeURIComponent(taskId)}`),
  retryHandsoff: (runId: string) => j<HandsoffTaskView>(`/handsoff/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" }, { retry: false }),
  resumeHandsoff: (runId: string) => j<HandsoffTaskView>(`/handsoff/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" }, { retry: false }),
  cancelHandsoff: (runId: string) => j<HandsoffTaskView>(`/handsoff/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }, { retry: false }),
  listRecurringTemplates: (projectPath?: string) =>
    j<{ templates: import("../../shared/recurring-tasks.ts").RecurringTemplateView[] }>(
      `/recurring/templates${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`,
    ),
  getRecurringTemplate: (id: string) =>
    j<{
      template: import("../../shared/recurring-tasks.ts").RecurringTemplateView;
      history: import("../../shared/recurring-tasks.ts").RecurringOccurrenceHistoryItem[];
    }>(`/recurring/templates/${encodeURIComponent(id)}`),
  createRecurringTemplate: (input: import("../../shared/recurring-tasks.ts").CreateRecurringTemplateInput) =>
    j<{
      template: import("../../shared/recurring-tasks.ts").RecurringTemplateView;
      generatedTaskIds: string[];
    }>("/recurring/templates", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  updateRecurringTemplate: (id: string, patch: import("../../shared/recurring-tasks.ts").UpdateRecurringTemplateInput) =>
    j<{ template: import("../../shared/recurring-tasks.ts").RecurringTemplateView }>(
      `/recurring/templates/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      { retry: false },
    ),
  pauseRecurringTemplate: (id: string) =>
    j<{ template: import("../../shared/recurring-tasks.ts").RecurringTemplateView }>(
      `/recurring/templates/${encodeURIComponent(id)}/pause`,
      { method: "POST" },
      { retry: false },
    ),
  resumeRecurringTemplate: (id: string) =>
    j<{ template: import("../../shared/recurring-tasks.ts").RecurringTemplateView; generatedTaskIds: string[] }>(
      `/recurring/templates/${encodeURIComponent(id)}/resume`,
      { method: "POST" },
      { retry: false },
    ),
  stopRecurringTemplate: (id: string) =>
    j<{ template: import("../../shared/recurring-tasks.ts").RecurringTemplateView }>(
      `/recurring/templates/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
      { retry: false },
    ),
  triggerRecurringTemplate: (id: string) =>
    j<{
      template: import("../../shared/recurring-tasks.ts").RecurringTemplateView;
      occurrence: import("../../shared/recurring-tasks.ts").RecurringOccurrence;
      taskId: string;
    }>(`/recurring/templates/${encodeURIComponent(id)}/trigger`, { method: "POST" }, { retry: false }),
  getRecurringTemplateHistory: (id: string, limit = 100) =>
    j<{
      template: import("../../shared/recurring-tasks.ts").RecurringTemplateView;
      history: import("../../shared/recurring-tasks.ts").RecurringOccurrenceHistoryItem[];
    }>(`/recurring/templates/${encodeURIComponent(id)}/history?limit=${limit}`),
  convertTaskToRecurring: (
    taskId: string,
    input: Omit<import("../../shared/recurring-tasks.ts").CreateRecurringTemplateInput, "projectPath" | "title" | "prompt" | "urgency" | "taskType" | "templateConfig"> & {
      title?: string;
      prompt?: string;
      urgency?: number;
      taskType?: TaskType;
      templateConfig?: import("../../shared/recurring-tasks.ts").RecurringTemplateTaskConfig;
    },
  ) =>
    j<{
      template: import("../../shared/recurring-tasks.ts").RecurringTemplateView;
      generatedTaskIds: string[];
    }>(`/recurring/tasks/${encodeURIComponent(taskId)}/convert`, { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  reconcileRecurring: (projectPath?: string) =>
    j<{ generatedTaskIds: string[]; skippedCount: number; submittedCount: number }>(
      "/recurring/reconcile",
      { method: "POST", body: JSON.stringify(projectPath ? { projectPath } : {}) },
      { retry: false },
    ),
  getProjectPermissions: (projectPath?: string) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionsPayload>(`/project-permissions${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`),
  getProjectTestPreview: (taskId: string) =>
    j<import("../../shared/project-permissions.ts").ProjectTestPreview>(`/project-permissions/tasks/${encodeURIComponent(taskId)}`),
  getProjectTestEvidence: (taskId: string) =>
    j<import("../../shared/project-test-evidence.ts").ProjectTestEvidence>(`/project-permissions/tasks/${encodeURIComponent(taskId)}/evidence`),
  requestProjectTest: (taskId: string, reviewed: { projectPath: string; commandFingerprint: string; sourceFingerprint: string }) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionRequest>("/project-permissions/requests", { method: "POST", body: JSON.stringify({ taskId, reviewed }) }, { retry: false }),
  setProjectPermissionDefault: (projectPath: string, mode: "ask" | "deny") =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionsPayload>("/project-permissions/default", { method: "PUT", body: JSON.stringify({ projectPath, mode }) }, { retry: false }),
  setProjectWorkspaceDevelopment: (projectPath: string, enabled: boolean) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionsPayload & { project: Project }>("/project-permissions/workspace-development", { method: "PUT", body: JSON.stringify({ projectPath, enabled }) }, { retry: false }),
  addProjectPermissionRule: (projectPath: string, command: string) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionsPayload>("/project-permissions/rules", { method: "POST", body: JSON.stringify({ projectPath, command }) }, { retry: false }),
  revokeProjectPermissionRule: (id: string) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionRule>(`/project-permissions/rules/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  approveProjectPermission: (id: string, body: { projectPath: string; commandFingerprint: string }) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionRequest>(`/project-permissions/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  denyProjectPermission: (id: string) =>
    j<import("../../shared/project-permissions.ts").ProjectPermissionRequest>(`/project-permissions/requests/${encodeURIComponent(id)}/deny`, { method: "POST" }, { retry: false }),
  getPortfolioAnalysis: () =>
    j<{
      analysis: PortfolioAnalysis;
      snapshot: PortfolioSnapshotInput;
      adapterWarnings: string[];
      capturedAtMs: number;
      accountResources: import("./account-api.ts").AccountResources;
    }>("/portfolio/analysis"),
  listClusters: (opts?: { archived?: boolean; slug?: string }) => {
    const query = new URLSearchParams();
    if (opts?.archived) query.set("archived", "true");
    if (opts?.slug) query.set("slug", opts.slug);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return j<{ company: { id: string; name: string }; clusters: Cluster[] }>(`/clusters${suffix}`);
  },
  createCluster: (body: Record<string, unknown>) =>
    j<Cluster>("/clusters", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  getCluster: (id: string) => j<ClusterDetails>(`/clusters/${encodeURIComponent(id)}`),
  updateCluster: (id: string, body: Record<string, unknown>) =>
    j<Cluster>(`/clusters/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }, { retry: false }),
  archiveCluster: (id: string) =>
    j<Cluster>(`/clusters/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  listUnassignedProjects: () => j<ClusterProject[]>("/clusters/unassigned-projects"),
  resolveClusterMembership: (projectPath: string) =>
    j<ClusterProject & { cluster: Cluster | null }>(`/clusters/membership?path=${encodeURIComponent(projectPath)}`),
  listClusterProjects: (id: string) => j<ClusterProject[]>(`/clusters/${encodeURIComponent(id)}/projects`),
  assignClusterProject: (id: string, projectPath: string) =>
    j<ClusterProject>(`/clusters/${encodeURIComponent(id)}/projects`, {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }, { retry: false }),
  moveClusterProject: (id: string, projectPath: string) =>
    j<ClusterProject>(`/clusters/${encodeURIComponent(id)}/projects/move`, {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }, { retry: false }),
  unassignClusterProject: (id: string, projectPath: string) =>
    j<ClusterProject>(
      `/clusters/${encodeURIComponent(id)}/projects?path=${encodeURIComponent(projectPath)}`,
      { method: "DELETE" },
      { retry: false },
    ),
  getClusterSummary: (id: string) =>
    j<{ cluster: Cluster; aggregate: ClusterAggregate }>(`/clusters/${encodeURIComponent(id)}/summary`),
  // FO-010A employee identity API. Identity and organization only: none of
  // these calls starts an agent, picks a model, or touches an account.
  listEmployees: (opts?: { projectPath?: string; kind?: string; status?: string; archived?: boolean }) => {
    const query = new URLSearchParams();
    if (opts?.projectPath) query.set("projectPath", opts.projectPath);
    if (opts?.kind) query.set("kind", opts.kind);
    if (opts?.status) query.set("status", opts.status);
    if (opts?.archived) query.set("archived", "true");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return j<{ employees: Employee[] }>(`/employees${suffix}`);
  },
  getEmployee: (id: string, signal?: AbortSignal) => j<EmployeeDetails>(`/employees/${encodeURIComponent(id)}`, { signal }),
  createEmployee: (body: Record<string, unknown>) =>
    j<Employee>("/employees", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  updateEmployee: (id: string, body: Record<string, unknown>) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }, { retry: false }),
  regenerateEmployeeName: (id: string) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}/regenerate-name`, { method: "POST", body: "{}" }, { retry: false }),
  assignEmployee: (id: string, projectPath: string) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}/assign`, { method: "POST", body: JSON.stringify({ projectPath }) }, { retry: false }),
  unassignEmployee: (id: string) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}/unassign`, { method: "POST", body: "{}" }, { retry: false }),
  archiveEmployee: (id: string) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  unarchiveEmployee: (id: string) =>
    j<Employee>(`/employees/${encodeURIComponent(id)}/unarchive`, { method: "POST", body: "{}" }, { retry: false }),
  getHeadEmployee: () => j<{ head: Employee | null }>("/employees/head"),
  setHeadEmployee: (body: { name: string; description?: string }) =>
    j<{ employee: Employee; created: boolean }>("/employees/head", { method: "PUT", body: JSON.stringify(body) }, { retry: false }),
  getOrganization: () => j<OrganizationTree>("/employees/organization"),
  getProjectTeam: (projectPath: string) =>
    j<ProjectTeam>(`/employees/project-team?projectPath=${encodeURIComponent(projectPath)}`),
  getCatalogRoles: (params?: { search?: string; division?: string }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.division) query.set("division", params.division);
    const qs = query.toString();
    return j<{
      roles: RoleTemplateSummary[];
      total: number;
      allTotal: number;
      divisions: DivisionMeta[];
      divisionsMetadata: Record<string, { label: string; icon: string; color: string }>;
      countsByDivision: Record<string, number>;
    }>(`/catalog/roles${qs ? `?${qs}` : ""}`);
  },
  getCatalogRole: (slug: string) =>
    j<{ role: RoleTemplate }>(`/catalog/roles/${encodeURIComponent(slug)}`),
  getCatalogDivisions: () =>
    j<{ divisions: DivisionMeta[] }>("/catalog/divisions"),
  getCatalogManifest: () =>
    j<{ manifest: CatalogManifestSummary }>("/catalog/manifest"),
  getEmployeeProfessionalProfile: (employeeId: string) =>
    j<{ profile: EmployeeProfessionalProfile | null }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile`),
  assignEmployeeProfessionalRole: (employeeId: string, body: AssignProfessionalRoleRequest) =>
    j<{ profile: EmployeeProfessionalProfile }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile`, { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  updateEmployeeProfessionalPrompt: (employeeId: string, body: UpdateProfessionalPromptRequest) =>
    j<{ profile: EmployeeProfessionalProfile }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile`, { method: "PUT", body: JSON.stringify(body) }, { retry: false }),
  resetEmployeeProfessionalPrompt: (employeeId: string, expectedRevision: number) =>
    j<{ profile: EmployeeProfessionalProfile }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile/reset`, { method: "POST", body: JSON.stringify({ expectedRevision }) }, { retry: false }),
  getEmployeePromptRevisions: (employeeId: string) =>
    j<{ revisions: EmployeePromptRevisionSummary[] }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile/revisions`),
  listRunbooks: () =>
    j<{ runbooks: RunbookSummary[] }>("/catalog/runbooks"),
  getRunbook: (slug: string) =>
    j<{ runbook: RunbookDetail }>(`/catalog/runbooks/${encodeURIComponent(slug)}`),
  listHiringProposals: (filter: { projectPath?: string; status?: string; catalogRoleSlug?: string } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);
    const suffix = query.toString();
    return j<{ proposals: HiringProposal[] }>(`/hiring-proposals${suffix ? `?${suffix}` : ""}`);
  },
  getHiringProposalSummary: () =>
    j<HiringProposalSummary>("/hiring-proposals/summary"),
  getHiringProposal: (id: string) =>
    j<{ proposal: HiringProposal }>(`/hiring-proposals/${encodeURIComponent(id)}`),
  getHiringProposalHistory: (id: string) =>
    j<{ proposal: HiringProposal; events: HiringProposalEvent[] }>(`/hiring-proposals/${encodeURIComponent(id)}/history`),
  createHiringProposal: (body: {
    projectPath: string;
    roleSlug: string;
    proposedName?: string;
    professionalTitle?: string;
    promptMarkdown?: string;
    justification: string;
    competencies?: string[];
    relatedTasks?: string[];
  }) =>
    j<{ proposal: HiringProposal }>("/hiring-proposals", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  approveHiringProposal: (id: string, body: ApproveHiringProposalRequest) =>
    j<{ proposal: HiringProposal; employee: Employee; alreadyApplied: boolean }>(
      `/hiring-proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  rejectHiringProposal: (id: string, body: RejectHiringProposalRequest) =>
    j<{ proposal: HiringProposal; alreadyApplied: boolean }>(
      `/hiring-proposals/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  updateHiringProposal: (id: string, body: UpdateHiringProposalRequest) =>
    j<{ proposal: HiringProposal }>(
      `/hiring-proposals/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      { retry: false },
    ),
  withdrawHiringProposal: (id: string, expectedRevision: number, note?: string) =>
    j<{ proposal: HiringProposal }>(
      `/hiring-proposals/${encodeURIComponent(id)}/withdraw`,
      { method: "POST", body: JSON.stringify({ expectedRevision, note }) },
      { retry: false },
    ),
  getEmployeePromptRevision: (employeeId: string, revision: number) =>
    j<{ revision: EmployeePromptRevision }>(`/employees/${encodeURIComponent(employeeId)}/professional-profile/revisions/${revision}`),
  listInfrastructure: (opts?: {
    q?: string;
    type?: string;
    clusterId?: string;
    projectPath?: string;
    environment?: string;
    provider?: string;
    archived?: "true" | "false" | "all";
  }) => {
    const query = new URLSearchParams();
    if (opts?.q) query.set("q", opts.q);
    if (opts?.type) query.set("type", opts.type);
    if (opts?.clusterId) query.set("clusterId", opts.clusterId);
    if (opts?.projectPath) query.set("projectPath", opts.projectPath);
    if (opts?.environment) query.set("environment", opts.environment);
    if (opts?.provider) query.set("provider", opts.provider);
    if (opts?.archived) query.set("archived", opts.archived);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return j<{ resources: InfrastructureResource[]; truncated: boolean }>(`/infrastructure/resources${suffix}`);
  },
  createInfrastructure: (body: Record<string, unknown>) =>
    j<InfrastructureResource>("/infrastructure/resources", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  getInfrastructure: (id: string) => j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}`),
  updateInfrastructure: (id: string, body: Record<string, unknown>) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }, { retry: false }),
  archiveInfrastructure: (id: string) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}/archive`, { method: "POST" }, { retry: false }),
  restoreInfrastructure: (id: string) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}/restore`, { method: "POST" }, { retry: false }),
  linkInfrastructureCluster: (id: string, clusterId: string) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}/clusters`, {
      method: "POST",
      body: JSON.stringify({ clusterId }),
    }, { retry: false }),
  unlinkInfrastructureCluster: (id: string, clusterId: string) =>
    j<InfrastructureResource>(
      `/infrastructure/resources/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}`,
      { method: "DELETE" },
      { retry: false },
    ),
  linkInfrastructureProject: (id: string, projectPath: string) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}/projects`, {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }, { retry: false }),
  unlinkInfrastructureProject: (id: string, projectPath: string) =>
    j<InfrastructureResource>(
      `/infrastructure/resources/${encodeURIComponent(id)}/projects?projectPath=${encodeURIComponent(projectPath)}`,
      { method: "DELETE" },
      { retry: false },
    ),
  linkInfrastructureEnvironment: (id: string, body: { projectPath: string; environment: string; customLabel?: string }) =>
    j<InfrastructureResource>(`/infrastructure/resources/${encodeURIComponent(id)}/environment-links`, {
      method: "POST",
      body: JSON.stringify(body),
    }, { retry: false }),
  unlinkInfrastructureEnvironment: (id: string, body: { projectPath: string; environment: string; customLabel?: string }) => {
    const query = new URLSearchParams({ projectPath: body.projectPath, environment: body.environment });
    if (body.customLabel) query.set("customLabel", body.customLabel);
    return j<InfrastructureResource>(
      `/infrastructure/resources/${encodeURIComponent(id)}/environment-links?${query.toString()}`,
      { method: "DELETE" },
      { retry: false },
    );
  },
  listProjectEnvironments: (projectPath: string) =>
    j<{ environments: ProjectEnvironmentDeclaration[] }>(
      `/infrastructure/project-environments?projectPath=${encodeURIComponent(projectPath)}`,
    ),
  declareProjectEnvironment: (body: { projectPath: string; environment: string; customLabel?: string }) =>
    j<ProjectEnvironmentDeclaration>("/infrastructure/project-environments", {
      method: "POST",
      body: JSON.stringify(body),
    }, { retry: false }),
  removeProjectEnvironment: (body: { projectPath: string; environment: string; customLabel?: string }) => {
    const query = new URLSearchParams({ projectPath: body.projectPath, environment: body.environment });
    if (body.customLabel) query.set("customLabel", body.customLabel);
    return j<{ removed: true }>(`/infrastructure/project-environments?${query.toString()}`, { method: "DELETE" }, { retry: false });
  },
  getClusterInfrastructure: (id: string) =>
    j<ClusterInfrastructureView>(`/infrastructure/clusters/${encodeURIComponent(id)}`),
  listDeploymentRequests: (projectPath?: string) => {
    const suffix = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : "";
    return j<{ requests: import("../../shared/deployment-request/types.ts").DeploymentRequestRecord[] }>(
      `/deployment-requests${suffix}`,
    );
  },
  createDeploymentRequest: (body: {
    projectPath: string;
    clusterId: string;
    environment: "staging" | "production";
    revision: string;
    requestedByRole: "owner" | "project-manager" | "head-of-pm";
  }) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      "/deployment-requests",
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  approveDeploymentRequest: (id: string, body: { approvalDigest: string; confirmProduction?: boolean }) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  rejectDeploymentRequest: (id: string, body: { approvalDigest: string }) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  patchDeploymentRequest: (
    id: string,
    body: { clusterId?: string; environment?: "staging" | "production"; revision?: string },
  ) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      { retry: false },
    ),
  listDeploymentStagingIntegrations: (projectPath?: string) => {
    const suffix = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : "";
    return j<{ integrations: import("../../shared/deployment-request/integration.ts").StagingIntegrationRecord[] }>(
      `/deployment-staging-integrations${suffix}`,
    );
  },
  createDeploymentStagingIntegration: (body: {
    clusterId: string;
    projectPath: string;
    integrationType: "external-staging-v1" | "forgeorbit-fake-staging-v1";
    integrationLabel: string;
    projectSlug: string;
    entrypointRef: string;
    realExecutionConfigured?: boolean;
    realExecutionEnabled?: boolean;
  }) =>
    j<import("../../shared/deployment-request/integration.ts").StagingIntegrationRecord>(
      "/deployment-staging-integrations",
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  authorizeDeploymentExecution: (id: string, body: { executionAuthDigest: string; confirmOwner?: boolean }) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}/authorize-execution`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  executeDeploymentStaging: (id: string) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}/execute`,
      { method: "POST", body: JSON.stringify({}) },
      { retry: false },
    ),
  getDeploymentManualHandoff: (id: string) =>
    j<import("../../shared/deployment-request/owner-authorization.ts").DeploymentManualHandoff>(
      `/deployment-requests/${encodeURIComponent(id)}/manual-handoff`,
    ),
  cancelDeploymentExecution: (id: string) =>
    j<import("../../shared/deployment-request/types.ts").DeploymentRequestRecord>(
      `/deployment-requests/${encodeURIComponent(id)}/cancel-execution`,
      { method: "POST", body: "{}" },
      { retry: false },
    ),
  // FO-010C. Organizational assignment only: these calls do not start a task
  // or ask the model router for a recommendation.
  getTaskAssignment: (taskId: string) =>
    j<{ assignment: TaskAssignment | null; routerHandoff: AssignmentRouterHandoff }>(
      `/task-assignments/task?taskId=${encodeURIComponent(taskId)}`,
    ),
  listEmployeeTaskAssignments: (employeeId: string) =>
    j<{ assignments: TaskAssignment[]; routerHandoff: AssignmentRouterHandoff }>(
      `/task-assignments?employeeId=${encodeURIComponent(employeeId)}`,
    ),
  listProjectTaskAssignments: (projectPath: string) =>
    j<{ projectPath: string; assignments: TaskAssignment[]; routerHandoff: AssignmentRouterHandoff }>(
      `/task-assignments/project?projectPath=${encodeURIComponent(projectPath)}`,
    ),
  taskAssignmentHistory: (scope: { taskId?: string; employeeId?: string; projectPath?: string }) => {
    const query = new URLSearchParams();
    if (scope.taskId) query.set("taskId", scope.taskId);
    else if (scope.employeeId) query.set("employeeId", scope.employeeId);
    else if (scope.projectPath) query.set("projectPath", scope.projectPath);
    return j<{ events: TaskAssignmentEvent[]; truncated: boolean; routerHandoff: AssignmentRouterHandoff }>(
      `/task-assignments/history?${query.toString()}`,
    );
  },
  taskAssignmentCandidates: (employeeId: string) =>
    j<{ tasks: AssignmentCandidate[]; truncated: boolean; routerHandoff: AssignmentRouterHandoff }>(
      `/task-assignments/candidates?employeeId=${encodeURIComponent(employeeId)}`,
    ),
  assignTaskToEmployee: (taskId: string, employeeId: string) =>
    j<{ assignment: TaskAssignment; created: boolean; routerHandoff: AssignmentRouterHandoff }>(
      "/task-assignments",
      { method: "POST", body: JSON.stringify({ taskId, employeeId }) },
      { retry: false },
    ),
  reassignTask: (taskId: string, employeeId: string, expectedRevision: number) =>
    j<{ assignment: TaskAssignment; routerHandoff: AssignmentRouterHandoff }>(
      "/task-assignments/reassign",
      { method: "POST", body: JSON.stringify({ taskId, employeeId, expectedRevision }) },
      { retry: false },
    ),
  unassignTask: (taskId: string, expectedRevision: number) =>
    j<{ assignment: TaskAssignment; routerHandoff: AssignmentRouterHandoff }>(
      "/task-assignments/unassign",
      { method: "POST", body: JSON.stringify({ taskId, expectedRevision }) },
      { retry: false },
    ),
  // FO-010D. Proposals are suggestions awaiting the owner. Approving one
  // assigns through the FO-010C core and still starts nothing.
  listAssignmentProposals: (filter: { projectPath?: string; status?: string; taskId?: string; employeeId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value);
    const suffix = query.toString();
    return j<{ proposals: AssignmentProposal[]; truncated: boolean }>(`/assignment-proposals${suffix ? `?${suffix}` : ""}`, { signal });
  },
  getAssignmentProposalSummary: () => j<ProposalSummary>("/assignment-proposals/summary"),
  assignmentProposalHistory: (id: string) =>
    j<{ events: AssignmentProposalEvent[]; truncated: boolean }>(`/assignment-proposals/${encodeURIComponent(id)}/history`),
  assignmentExecutorReview: (id: string) => j<{ review: import("../../shared/execution/executor-routing.ts").AssignmentExecutorReview }>(`/assignment-proposals/${encodeURIComponent(id)}/recommendations`),
  approveAssignmentProposal: (id: string, body: { expectedRevision: number; expectedAssignmentRevision: number | null; allowReassign: boolean; routingReviewToken?: string }) =>
    j<{ proposal: AssignmentProposal; alreadyApplied: boolean }>(
      `/assignment-proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(body) },
      { retry: false },
    ),
  rejectAssignmentProposal: (id: string, expectedRevision: number) =>
    j<{ proposal: AssignmentProposal; alreadyApplied: boolean }>(
      `/assignment-proposals/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
      { retry: false },
    ),
  cancelAssignmentProposal: (id: string, expectedRevision: number) =>
    j<{ proposal: AssignmentProposal; alreadyApplied: boolean }>(
      `/assignment-proposals/${encodeURIComponent(id)}/cancel`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
      { retry: false },
    ),
  listKnowledge: (owner: KnowledgeOwnerRef, opts?: { includeArchived?: boolean; category?: string; tag?: string; limit?: number }) => {
    const query = new URLSearchParams({ ownerKind: owner.kind, ownerId: owner.id });
    if (opts?.includeArchived) query.set("includeArchived", "true");
    if (opts?.category) query.set("category", opts.category);
    if (opts?.tag) query.set("tag", opts.tag);
    if (opts?.limit) query.set("limit", String(opts.limit));
    return j<{ documents: KnowledgeDocument[]; truncated: boolean }>(`/knowledge/documents?${query.toString()}`);
  },
  createKnowledge: (body: {
    ownerKind: KnowledgeOwnerRef["kind"];
    ownerId: string;
    title: string;
    description?: string;
    category?: string;
    tags?: string[];
    content?: string;
    sensitive?: boolean;
  }) => j<KnowledgeDocument>("/knowledge/documents", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  readKnowledge: (id: string, revision?: number) => {
    const query = revision ? `?revision=${revision}` : "";
    return j<KnowledgeDocument & { content: string; sha256: string }>(`/knowledge/documents/${encodeURIComponent(id)}${query}`);
  },
  updateKnowledge: (id: string, body: {
    expectedRevision: number;
    title?: string;
    description?: string;
    category?: string;
    tags?: string[];
    content?: string;
    sensitive?: boolean;
  }) => j<KnowledgeDocument>(`/knowledge/documents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }, { retry: false }),
  archiveKnowledge: (id: string, expectedRevision: number) =>
    j<KnowledgeDocument>(`/knowledge/documents/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }, { retry: false }),
  restoreKnowledge: (id: string, expectedRevision: number) =>
    j<KnowledgeDocument>(`/knowledge/documents/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }, { retry: false }),
  deleteKnowledge: (id: string, expectedRevision: number) =>
    j<{ deleted: true; id: string }>(`/knowledge/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision, confirm: "delete" }),
    }, { retry: false }),
  exportKnowledge: (id: string) =>
    j<{ filename: string; markdown: string; revision: number; document: KnowledgeDocument }>(
      `/knowledge/documents/${encodeURIComponent(id)}/export`,
    ),
  knowledgeRevisions: (id: string) =>
    j<{ revisions: KnowledgeRevisionInfo[] }>(`/knowledge/documents/${encodeURIComponent(id)}/revisions`),
  listBrain: (query: {
    scopeKind: BrainScopeKind;
    projectPath?: string;
    q?: string;
    limit?: number;
    status?: BrainStatusValue;
    inheritCompany?: boolean;
  }) => {
    const params = new URLSearchParams({ scopeKind: query.scopeKind, status: query.status ?? "active" });
    if (query.projectPath) params.set("projectPath", query.projectPath);
    if (query.q) params.set("q", query.q);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.inheritCompany) params.set("inherit", "company");
    return j<{ memories: BrainMemorySummary[]; truncated: boolean; inheritance: { applied: boolean; rule: string } }>(`/brain/memories?${params.toString()}`);
  },
  createBrain: (body: { scopeKind: BrainScopeKind; projectPath?: string; title: string; kind: BrainKind; content: string; requestId?: string }) =>
    j<BrainMemory>("/brain/memories", { method: "POST", body: JSON.stringify(body) }, { retry: false }),
  readBrain: (id: string) => j<BrainMemory>(`/brain/memories/${encodeURIComponent(id)}`),
  updateBrain: (id: string, body: { expectedRevision: number; title?: string; kind?: BrainKind; content?: string }) =>
    j<BrainMemory>(`/brain/memories/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }, { retry: false }),
  archiveBrain: (id: string, expectedRevision: number) =>
    j<BrainMemory>(`/brain/memories/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }, { retry: false }),
  searchBrainSemantic: (query: { scopeKind: BrainScopeKind; projectPath?: string; q: string; mode?: import("../../shared/brain/embeddings.ts").SearchMode; status?: BrainStatusValue; inheritCompany?: boolean; limit?: number }) => {
    const params = new URLSearchParams({ scopeKind: query.scopeKind, status: query.status ?? "active", q: query.q });
    if (query.projectPath) params.set("projectPath", query.projectPath);
    if (query.mode) params.set("mode", query.mode);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.inheritCompany) params.set("inherit", "company");
    return j<{ results: import("../../shared/brain/embeddings.ts").SemanticSearchResult[]; mode: import("../../shared/brain/embeddings.ts").SearchMode; total: number }>(`/brain/memories/search?${params.toString()}`);
  },
  brainRelated: (id: string) =>
    j<{ related: import("../../shared/brain/embeddings.ts").RelatedMemoryItem[] }>(`/brain/memories/${encodeURIComponent(id)}/related`),
  listBrainCandidates: (query: { status?: string; scopeKind?: string; projectPath?: string; sourceEventKind?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.scopeKind) params.set("scopeKind", query.scopeKind);
    if (query.projectPath) params.set("projectPath", query.projectPath);
    if (query.sourceEventKind) params.set("sourceEventKind", query.sourceEventKind);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return j<{ candidates: import("../../shared/brain/extraction.ts").BrainExtractionCandidate[] }>(`/brain/candidates${suffix}`);
  },
  readBrainCandidate: (id: string) =>
    j<import("../../shared/brain/extraction.ts").BrainExtractionCandidate>(`/brain/candidates/${encodeURIComponent(id)}`),
  editBrainCandidate: (id: string, body: { title?: string; kind?: BrainKind; content?: string }) =>
    j<import("../../shared/brain/extraction.ts").BrainExtractionCandidate>(`/brain/candidates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }, { retry: false }),
  approveBrainCandidate: (id: string, body?: { title?: string; kind?: BrainKind; content?: string }) =>
    j<{ candidate: import("../../shared/brain/extraction.ts").BrainExtractionCandidate; memory: BrainMemory }>(
      `/brain/candidates/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(body ?? {}) },
      { retry: false },
    ),
  rejectBrainCandidate: (id: string, reason?: string) =>
    j<import("../../shared/brain/extraction.ts").BrainExtractionCandidate>(
      `/brain/candidates/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify({ reason }) },
      { retry: false },
    ),
  brainEmbeddingStatus: () =>
    j<import("../../shared/brain/embeddings.ts").EmbeddingEngineStatus>("/brain/embeddings/status"),
  rebuildBrainEmbeddings: () =>
    j<{ total: number; embedded: number; failed: number }>("/brain/embeddings/rebuild", { method: "POST" }, { retry: false }),
  brainStatus: () => j<BrainIndexStatus>("/brain/status"),
  listMemoryProposals: (query: { status?: string; managerKind?: string; sourceProjectPath?: string; messageId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.managerKind) params.set("managerKind", query.managerKind);
    if (query.sourceProjectPath) params.set("sourceProjectPath", query.sourceProjectPath);
    if (query.messageId) params.set("messageId", query.messageId);
    const queryText = params.toString();
    const suffix = queryText ? `?${queryText}` : "";
    return j<{ proposals: import("../../shared/brain/proposals.ts").MemoryProposal[] }>(`/brain/proposals${suffix}`);
  },
  readMemoryProposal: (id: string) =>
    j<import("../../shared/brain/proposals.ts").MemoryProposal>(`/brain/proposals/${encodeURIComponent(id)}`),
  editMemoryProposal: (id: string, body: { expectedRevision: number; title?: string; kind?: BrainKind; content?: string }) =>
    j<import("../../shared/brain/proposals.ts").MemoryProposal>(`/brain/proposals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }, { retry: false }),
  approveMemoryProposal: (id: string, expectedRevision: number) =>
    j<{ proposal: import("../../shared/brain/proposals.ts").MemoryProposal; memory: BrainMemory; replayed: boolean }>(
      `/brain/proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
      { retry: false },
    ),
  rejectMemoryProposal: (id: string, expectedRevision: number, reason?: string) =>
    j<import("../../shared/brain/proposals.ts").MemoryProposal>(`/brain/proposals/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, ...(reason ? { reason } : {}) }),
    }, { retry: false }),
  brainContextEligible: (target: BrainContextTarget, access: BrainContextAccess, q?: string) =>
    j<BrainEligibleResult>(`/brain/context/eligible?${brainContextQuery(target, access, q)}`),
  brainContextPreview: (target: BrainContextTarget, access: BrainContextAccess, memories: BrainContextRequest["memories"]) =>
    j<BrainContextPreview>("/brain/context/preview", {
      method: "POST",
      body: brainContextBody(target, access, memories),
    }, { retry: false }),
  brainContextApprove: (target: BrainContextTarget, access: BrainContextAccess, memories: BrainContextRequest["memories"], previewKey: string) =>
    j<BrainContextGrant>("/brain/context/grants", {
      method: "POST",
      body: brainContextBody(target, access, memories, { previewKey, confirm: true }),
    }, { retry: false }),
  brainContextRevoke: (target: BrainContextTarget, grantId: string) =>
    j<{ revoked: boolean }>(`/brain/context/grants/${encodeURIComponent(grantId)}?${brainContextQuery(target)}`, { method: "DELETE" }, { retry: false }),
  brainContextTransmissions: (target: BrainContextTarget) =>
    j<{ transmissions: BrainTransmission[] }>(`/brain/context/transmissions?${brainContextQuery(target)}`),
  createBrowserSession: () =>
    j<BrowserSessionView>("/browser/sessions", { method: "POST", body: "{}" }, { retry: false }),
  browserSession: (id: string) => j<BrowserSessionView>(`/browser/sessions/${encodeURIComponent(id)}`),
  navigateBrowser: (id: string, url: string) =>
    j<BrowserSessionView>(`/browser/sessions/${encodeURIComponent(id)}/navigate`, { method: "POST", body: JSON.stringify({ url }) }, { retry: false }),
  browserObservation: (id: string) => j<BrowserObservation>(`/browser/sessions/${encodeURIComponent(id)}/observation`),
  openBrowserLink: (id: string, linkId: string, observationId: string) =>
    j<BrowserSessionView>(`/browser/sessions/${encodeURIComponent(id)}/links/${encodeURIComponent(linkId)}/open`, {
      method: "POST",
      body: JSON.stringify({ observationId }),
    }, { retry: false }),
  backBrowser: (id: string) =>
    j<BrowserSessionView>(`/browser/sessions/${encodeURIComponent(id)}/back`, { method: "POST", body: "{}" }, { retry: false }),
  closeBrowserSession: (id: string) =>
    j<BrowserSessionView>(`/browser/sessions/${encodeURIComponent(id)}/close`, { method: "POST", body: "{}" }, { retry: false }),
  listBrowserSessions: () => j<{ sessions: BrowserSessionView[] }>("/browser/sessions"),
  createBrowserAgentGrant: (input: { managerKind: "head-of-pm" | "project-manager"; projectPath?: string; sessionId: string }) =>
    j<import("../../shared/browser/agent.ts").BrowserAgentGrantView>("/browser/agent-grants", {
      method: "POST",
      body: JSON.stringify(input),
    }, { retry: false }),
  revokeBrowserAgentGrant: (grantId: string, managerKind: "head-of-pm" | "project-manager", projectPath?: string) => {
    const query = new URLSearchParams({ managerKind });
    if (projectPath) query.set("projectPath", projectPath);
    return j<{ revoked: boolean }>(`/browser/agent-grants/${encodeURIComponent(grantId)}?${query}`, { method: "DELETE" }, { retry: false });
  },
  browserScreenshot: async (id: string): Promise<Blob> => {
    const res = await fetchWithRecovery({ fetchImpl: fetch, base: BASE }, `/browser/sessions/${encodeURIComponent(id)}/screenshot`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    }, { retry: false });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : `${res.status}`;
      throw new ApiError(message, res.status, body);
    }
    return res.blob();
  },
  nativeComputerPermissions: () => j<NativePermissionStatus>("/native-computer/permissions"),
  openNativeComputerSettings: (kind: "accessibility" | "screen-recording") =>
    j<NativePermissionStatus>("/native-computer/permissions/open", { method: "POST", body: JSON.stringify({ kind }) }, { retry: false }),
  nativeComputerApplications: () => j<{ applications: NativeApplicationRecord[]; truncated: boolean }>("/native-computer/applications"),
  nativeComputerWindows: (identity: NativeProcessIdentity) =>
    j<{ windows: NativeWindowRecord[]; truncated: boolean }>("/native-computer/windows", { method: "POST", body: JSON.stringify(identity) }, { retry: false }),
  createNativeComputerSession: (identity: NativeProcessIdentity, windowId: number) =>
    j<NativeSessionView>("/native-computer/sessions", { method: "POST", body: JSON.stringify({ bundleId: identity.bundleId, executablePath: identity.executablePath, pid: identity.pid, startSec: identity.startSec, startUsec: identity.startUsec, windowId }) }, { retry: false }),
  nativeComputerSession: (id: string) => j<NativeSessionView>(`/native-computer/sessions/${encodeURIComponent(id)}`),
  nativeComputerObservation: (id: string) =>
    j<NativeObservation>(`/native-computer/sessions/${encodeURIComponent(id)}/observation`),
  refreshNativeComputerObservation: (id: string) =>
    j<NativeObservation>(`/native-computer/sessions/${encodeURIComponent(id)}/observation`, { method: "POST", body: "{}" }, { retry: false }),
  requestNativeComputerAction: (id: string, input: NativeProcessIdentity & { windowId: number; observationId: string; elementId: string; action?: NativeAction; direction?: "up" | "down"; increment?: number; text?: string }) => {
    const { windowId, observationId, elementId, action = "press_accessible_button", direction, increment, text } = input;
    return j<NativeActionClaim>(`/native-computer/sessions/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, bundleId: input.bundleId, executablePath: input.executablePath, pid: input.pid, startSec: input.startSec, startUsec: input.startUsec, windowId, observationId, elementId, ...(direction ? { direction } : {}), ...(increment !== undefined ? { increment } : {}), ...(text !== undefined ? { text } : {}) }),
    }, { retry: false });
  },
  confirmNativeComputerAction: (id: string, claimId: string, identity: NativeProcessIdentity, windowId: number) =>
    j<NativeActionClaim>(`/native-computer/sessions/${encodeURIComponent(id)}/actions/${encodeURIComponent(claimId)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ confirm: true, bundleId: identity.bundleId, executablePath: identity.executablePath, pid: identity.pid, startSec: identity.startSec, startUsec: identity.startUsec, windowId }),
    }, { retry: false }),
  closeNativeComputerSession: (id: string) =>
    j<NativeSessionView>(`/native-computer/sessions/${encodeURIComponent(id)}/close`, { method: "POST", body: "{}" }, { retry: false }),
  listNativeComputerSessions: () => j<{ sessions: NativeSessionView[]; lastInterrupted?: NativeSessionView | null }>("/native-computer/sessions"),
  createNativeAgentGrant: (input: { managerKind: "head-of-pm" | "project-manager"; projectPath?: string; sessionId: string }) =>
    j<import("../../shared/native-computer/agent.ts").NativeAgentGrantView>("/native-computer/agent-grants", {
      method: "POST",
      body: JSON.stringify(input),
    }, { retry: false }),
  revokeNativeAgentGrant: (grantId: string, managerKind: "head-of-pm" | "project-manager", projectPath?: string) => {
    const query = new URLSearchParams({ managerKind });
    if (projectPath) query.set("projectPath", projectPath);
    return j<{ revoked: boolean }>(`/native-computer/agent-grants/${encodeURIComponent(grantId)}?${query}`, { method: "DELETE" }, { retry: false });
  },
  nativeComputerScreenshot: async (id: string): Promise<Blob> => {
    const res = await fetchWithRecovery({ fetchImpl: fetch, base: BASE }, `/native-computer/sessions/${encodeURIComponent(id)}/screenshot`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
    }, { retry: false });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : `${res.status}`;
      throw new ApiError(message, res.status, body);
    }
    return res.blob();
  },
  searchKnowledge: (opts: { q: string; owner?: KnowledgeOwnerRef; projectPath?: string; includeArchived?: boolean; category?: string; tag?: string; limit?: number }) => {
    const query = new URLSearchParams({ q: opts.q });
    if (opts.owner) {
      query.set("ownerKind", opts.owner.kind);
      query.set("ownerId", opts.owner.id);
    }
    if (opts.projectPath) query.set("projectPath", opts.projectPath);
    if (opts.includeArchived) query.set("includeArchived", "true");
    if (opts.category) query.set("category", opts.category);
    if (opts.tag) query.set("tag", opts.tag);
    if (opts.limit) query.set("limit", String(opts.limit));
    return j<{ hits: KnowledgeSearchHit[]; truncated: boolean }>(`/knowledge/search?${query.toString()}`);
  },
  knowledgeScope: (projectPath: string) =>
    j<KnowledgeScope>(`/knowledge/scope?projectPath=${encodeURIComponent(projectPath)}`),
  // Knowledge context for managers (FO-011E). Choosing and previewing send
  // nothing; only a confirmed grant, spent by one manager message, does.
  knowledgeContextEligible: (target: KnowledgeContextTarget, owner?: KnowledgeOwnerRef) =>
    j<KnowledgeEligibleResult>(`/knowledge/context/eligible?${contextQuery(target, owner)}`),
  knowledgeContextPreview: (target: KnowledgeContextTarget, documents: KnowledgeSelectionInput[]) =>
    j<KnowledgeContextPreview>("/knowledge/context/preview", {
      method: "POST",
      body: JSON.stringify({ ...contextTarget(target), documents }),
    }, { retry: false }),
  knowledgeContextApprove: (target: KnowledgeContextTarget, documents: KnowledgeSelectionInput[], previewKey: string) =>
    j<KnowledgeContextGrant>("/knowledge/context/grants", {
      method: "POST",
      body: JSON.stringify({ ...contextTarget(target), documents, previewKey, confirm: true }),
    }, { retry: false }),
  knowledgeContextRevoke: (target: KnowledgeContextTarget, grantId: string) =>
    j<{ revoked: boolean }>(`/knowledge/context/grants/${encodeURIComponent(grantId)}?${contextQuery(target)}`, { method: "DELETE" }, { retry: false }),
  knowledgeContextTransmissions: (target: KnowledgeContextTarget) =>
    j<{ transmissions: KnowledgeTransmission[] }>(`/knowledge/context/transmissions?${contextQuery(target)}`),
  knowledgeEffectivePreview: (projectPath: string) =>
    j<{ preview: import("../../shared/knowledge/effective.ts").EffectiveKnowledgePreview; note: string }>(
      `/knowledge/effective?projectPath=${encodeURIComponent(projectPath)}`,
    ),
  getKnowledgeInheritanceSettings: (projectPath: string) =>
    j<{ settings: import("../../shared/knowledge/effective.ts").KnowledgeInheritanceSettings }>(
      `/knowledge/inheritance?projectPath=${encodeURIComponent(projectPath)}`,
    ),
  patchKnowledgeInheritanceSettings: (projectPath: string, body: { acceptCompany?: boolean; acceptCluster?: boolean }) =>
    j<{ settings: import("../../shared/knowledge/effective.ts").KnowledgeInheritanceSettings }>(
      `/knowledge/inheritance?projectPath=${encodeURIComponent(projectPath)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      { retry: false },
    ),
  patchKnowledgeDocumentInherit: (documentId: string, inheritToProjects: boolean) =>
    j<KnowledgeDocument>(`/knowledge/documents/${encodeURIComponent(documentId)}/inherit`, {
      method: "PATCH",
      body: JSON.stringify({ inheritToProjects }),
    }, { retry: false }),
  getEnvironment: (projectPath: string) =>
    j<EnvironmentIndex>(`/projects/environment?path=${encodeURIComponent(projectPath)}`),
  getProjectEstimation: (projectPath: string) =>
    j<EstimationRecord>(`/projects/estimation?path=${encodeURIComponent(projectPath)}`),
  getProjectEstimationDependencies: (projectPath: string) =>
    j<{ structuredDependencies: StructuredDependency[] }>(
      `/projects/estimation/dependencies?path=${encodeURIComponent(projectPath)}`,
    ),
  saveProjectEstimation: (projectPath: string, settings: EstimationSettings) =>
    j<EstimationRecord>("/projects/estimation", {
      method: "PUT",
      body: JSON.stringify({ path: projectPath, settings }),
    }, { retry: false }),
  createEnvironmentProfile: (projectPath: string, profile: LaunchProfile) =>
    j<EnvironmentCommandResult>("/projects/environment", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, profile }),
    }, { retry: false }),
  updateEnvironmentProfile: (projectPath: string, profileId: string, profile: LaunchProfile) =>
    j<EnvironmentCommandResult>(`/projects/environment/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      body: JSON.stringify({ path: projectPath, profile }),
    }, { retry: false }),
  deleteEnvironmentProfile: (projectPath: string, profileId: string) =>
    j<EnvironmentCommandResult>(
      `/projects/environment/${encodeURIComponent(profileId)}?path=${encodeURIComponent(projectPath)}`,
      { method: "DELETE" },
      { retry: false },
    ),
  environmentAction: (projectPath: string, profileId: string, action: "start" | "stop" | "restart" | "refresh") =>
    j<EnvironmentCommandResult>(
      `/projects/environment/${encodeURIComponent(profileId)}/${action}?path=${encodeURIComponent(projectPath)}`,
      { method: "POST" },
      { retry: false },
    ),
  environmentLogs: (projectPath: string, profileId: string, service?: string) => {
    const query = new URLSearchParams({ path: projectPath });
    if (service) query.set("service", service);
    return j<EnvironmentLogs>(
      `/projects/environment/${encodeURIComponent(profileId)}/logs?${query.toString()}`,
    );
  },
  environmentUrls: (projectPath: string, profileId: string) =>
    j<{ urls: UrlAvailability[] }>(
      `/projects/environment/${encodeURIComponent(profileId)}/urls?path=${encodeURIComponent(projectPath)}`,
    ),
  /** Read-only scan for the project wizard. Does not register or create. */
  discoverProject: (input: { path: string; folderName?: string }) =>
    j<ProjectDiscovery>("/projects/discover", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Register a folder. The wizard sets `rejectDuplicate` and, for a new
   * leaf, `createDirectory`. Other callers keep the idempotent upsert.
   * `retry: false` — a replay after a created directory would 409.
   */
  registerProject: (input: {
    path: string;
    name?: string;
    rejectDuplicate?: boolean;
    createDirectory?: boolean;
  }) =>
    j<Project>("/projects", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  // Global portfolio manager (FO-008C). Sending a message is the only call
  // that runs its agent; approving a delegation runs the target project's
  // manager once. Every write is `retry: false` so a replay can't start a
  // second paid turn or send a delegation twice.
  getHeadPortfolioBinding: () => j<HeadPortfolioBinding>("/portfolio-manager/head-binding"),
  changeHeadPortfolioBinding: (employeeId: string | null, revision: number) =>
    j<HeadPortfolioBinding>("/portfolio-manager/head-binding", { method: "PUT", body: JSON.stringify({ employeeId, revision, confirm: true }) }, { retry: false }),
  getPortfolioManager: () => j<PortfolioManagerState>("/portfolio-manager"),
  savePortfolioManagerConfig: (config: ManagerConfig) =>
    j<ManagerConfig>("/portfolio-manager/config", { method: "PUT", body: JSON.stringify({ config }) }, { retry: false }),
  portfolioManagerContext: () =>
    j<{ sources: ContextSource[]; projectCount: number; listedProjects: number }>("/portfolio-manager/context"),
  getHeadPmCoordination: () => j<HeadPmCoordinationSnapshot>("/portfolio-manager/coordination"),
  getHeadAuto: (id: string) => j<import("../../shared/head-pm-auto.ts").HeadAutoView>(`/head-pm/initiatives/${encodeURIComponent(id)}/coordination`),
  prepareHeadAuto: (id: string, batchIds: string[]) => j<import("../../shared/head-pm-auto.ts").HeadAutoView>(`/head-pm/initiatives/${encodeURIComponent(id)}/coordination`, { method: "POST", body: JSON.stringify({ batchIds }) }, { retry: false }),
  actHeadAuto: (id: string, action: string, digest?: string) => j<import("../../shared/head-pm-auto.ts").HeadAutoView>(`/head-pm/initiatives/${encodeURIComponent(id)}/coordination/${action}`, { method: "POST", body: JSON.stringify({ digest }) }, { retry: false }),
  listHeadPmInitiatives: () => j<HeadPmInitiativeView[]>("/head-pm/initiatives"),
  getHeadPmInitiative: (id: string) => j<HeadPmInitiativeView>(`/head-pm/initiatives/${encodeURIComponent(id)}`),
  cancelHeadPmInitiative: (id: string) =>
    j<HeadPmInitiativeView>(`/head-pm/initiatives/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  linkHeadPmInitiativeBatch: (id: string, projectPath: string, batchId: string) =>
    j<HeadPmInitiativeView>(
      `/head-pm/initiatives/${encodeURIComponent(id)}/contributions/${encodeURIComponent(projectPath)}/link-batch`,
      { method: "POST", body: JSON.stringify({ batchId }) },
      { retry: false },
    ),
  patchHeadPmInitiativeProposal: (id: string, body: { title?: string; goal?: string; description?: string; contributions?: unknown[] }) =>
    j<import("../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal>(
      `/head-pm/initiative-proposals/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(body) },
      { retry: false },
    ),
  approveHeadPmInitiativeProposal: (id: string) =>
    j<{ proposal: import("../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal; initiativeId: string; alreadyCreated: boolean }>(
      `/head-pm/initiative-proposals/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
      { retry: false },
    ),
  rejectHeadPmInitiativeProposal: (id: string) =>
    j<import("../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal>(
      `/head-pm/initiative-proposals/${encodeURIComponent(id)}/reject`,
      { method: "POST" },
      { retry: false },
    ),
  dismissHeadPmInitiativeProposal: (id: string) =>
    j<import("../../shared/head-pm-initiative-proposal.ts").HeadPmInitiativeProposal>(
      `/head-pm/initiative-proposals/${encodeURIComponent(id)}/dismiss`,
      { method: "POST" },
      { retry: false },
    ),
  sendPortfolioMessage: (input: { objectiveProjectPaths?: string[]; nativeGrantId?: string; scope?: import("../../shared/head-pm-scope.ts").HeadScope; text?: string; retryMessageId?: string; knowledgeGrantId?: string; brainGrantId?: string; browserGrantId?: string; allowMemoryProposals?: boolean; allowCompanyMemoryProposals?: boolean; memoryProposalProjectPaths?: string[] }) =>
    j<{ turn: Omit<ManagerTurn, "projectPath">; message: PortfolioManagerMessage }>("/portfolio-manager/messages", {
      method: "POST",
      body: JSON.stringify(input),
    }, { retry: false }),
  settleHeadBoardProposal: (id: string, decision: "approve" | "reject", executionPermission?: import("../../shared/execution/workspace-grant.ts").TaskStagingGrant, resourceDigest?: string) =>
    j<import("../../shared/head-pm-scope.ts").HeadBoardProposal>(`/head-pm/board-proposals/${encodeURIComponent(id)}/${decision}`, {
      method: "POST", body: JSON.stringify({ confirm: true, executionPermission, resourceDigest }),
    }, { retry: false }),
  getPortfolioTurn: (id: string) => j<Omit<ManagerTurn, "projectPath"> & { missionId?: string }>(`/portfolio-manager/turns/${encodeURIComponent(id)}`),
  cancelPortfolioTurn: (id: string) =>
    j<{ cancelled: boolean }>(`/portfolio-manager/turns/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  setPortfolioPlanStatus: (planId: string, status: "accept" | "dismiss") =>
    j<PortfolioPlan>(`/portfolio-manager/plans/${encodeURIComponent(planId)}/${status}`, { method: "POST" }, { retry: false }),
  approveDelegation: (delegationId: string, revision: number) =>
    j<{ delegation: DelegationView; alreadySent: boolean }>(
      `/portfolio-manager/delegations/${encodeURIComponent(delegationId)}/approve`,
      { method: "POST", body: JSON.stringify({ revision }) },
      { retry: false },
    ),
  rejectDelegation: (delegationId: string) =>
    j<DelegationView>(`/portfolio-manager/delegations/${encodeURIComponent(delegationId)}/reject`, { method: "POST" }, { retry: false }),
  addPortfolioDecision: (text: string, source: "owner" | "manager") =>
    j<PortfolioDecision>("/portfolio-manager/decisions", {
      method: "POST",
      body: JSON.stringify({ text, source }),
    }, { retry: false }),
  deletePortfolioDecision: (id: string) =>
    j<{ deleted: boolean }>(`/portfolio-manager/decisions/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  // Project manager (FO-005A). Sending a message is the only call that
  // runs an agent; `retry: false` on every write so a replay can't start a
  // second paid turn or approve twice.
  getManager: (projectPath: string, signal?: AbortSignal) =>
    j<ManagerState>(`/project-manager?path=${encodeURIComponent(projectPath)}`, { signal }),
  saveManagerConfig: (projectPath: string, config: ManagerConfig) =>
    j<ManagerConfig>("/project-manager/config", {
      method: "PUT",
      body: JSON.stringify({ path: projectPath, config }),
    }, { retry: false }),
  managerContext: (projectPath: string) =>
    j<{ sources: ContextSource[] }>(`/project-manager/context?path=${encodeURIComponent(projectPath)}`),
  getManagerTurn: (id: string) => j<ManagerTurn>(`/project-manager/turns/${encodeURIComponent(id)}`),
  cancelManagerTurn: (id: string) =>
    j<{ cancelled: boolean }>(`/project-manager/turns/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  saveProposalEdits: (projectPath: string, proposalId: string, revision: number, items: ProposalItemEdit[]) =>
    j<TaskProposal>(`/project-manager/proposals/${encodeURIComponent(proposalId)}`, {
      method: "PATCH",
      body: JSON.stringify({ path: projectPath, revision, items }),
    }, { retry: false }),
  approveProposal: (projectPath: string, proposalId: string, revision: number, items: ProposalItemEdit[]) =>
    j<{ proposal: TaskProposal; created: string[]; alreadyApproved: boolean }>(
      `/project-manager/proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: "POST", body: JSON.stringify({ path: projectPath, revision, items }) },
      { retry: false },
    ),
  rejectProposal: (projectPath: string, proposalId: string) =>
    j<TaskProposal>(`/project-manager/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  addManagerDecision: (projectPath: string, text: string, source: "owner" | "manager") =>
    j<ManagerDecision>("/project-manager/decisions", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, text, source }),
    }, { retry: false }),
  deleteManagerDecision: (projectPath: string, id: string) =>
    j<{ deleted: boolean }>(
      `/project-manager/decisions/${encodeURIComponent(id)}?path=${encodeURIComponent(projectPath)}`,
      { method: "DELETE" },
      { retry: false },
    ),
  // Supervised execution (FO-005B). Preparing and checking never call a
  // model. Only `approveExecution` starts an agent, and it is `retry: false`
  // like every write here: a replayed approval is answered by the core with
  // the run that already started, never a second one.
  listExecutions: (projectPath: string) =>
    j<ExecutionView[]>(`/project-manager/executions?path=${encodeURIComponent(projectPath)}`),
  getExecution: (projectPath: string, id: string) =>
    j<ExecutionView>(`/project-manager/executions/${encodeURIComponent(id)}?path=${encodeURIComponent(projectPath)}`),
  prepareExecution: (projectPath: string, taskId: string) =>
    j<{ execution: ExecutionView; existing: boolean }>("/project-manager/executions", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, taskId }),
    }, { retry: false }),
  updateExecution: (projectPath: string, id: string, revision: number, config: Partial<ExecutionConfig>) =>
    j<ExecutionView>(`/project-manager/executions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ path: projectPath, revision, config }),
    }, { retry: false }),
  recheckExecution: (projectPath: string, id: string) =>
    j<ExecutionView>(`/project-manager/executions/${encodeURIComponent(id)}/check`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  approveExecution: (projectPath: string, id: string, revision: number, acknowledgeUsage: boolean, acknowledgeFullAccess = false) =>
    j<{ execution: ExecutionView; alreadyStarted: boolean }>(`/project-manager/executions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, revision, acknowledgeUsage, acknowledgeFullAccess }),
    }, { retry: false }),
  dismissExecution: (projectPath: string, id: string) =>
    j<ExecutionView>(`/project-manager/executions/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  executionResult: (projectPath: string, id: string) =>
    j<ExecutionResult>(`/project-manager/executions/${encodeURIComponent(id)}/result?path=${encodeURIComponent(projectPath)}`),
  reviewExecution: (projectPath: string, id: string, action: "accept" | "return" | "fix" | "stop", text?: string) =>
    j<ExecutionView>(`/project-manager/executions/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, action, ...(text ? { text } : {}) }),
    }, { retry: false }),
  // Structured scheduling and execution batches (FO-005C). The core owns
  // every rule (cycles, approval scope, policy, what may start); these are
  // thin calls. Every write is `retry: false`: a replayed Start or Approve
  // is answered idempotently by the core, never repeated blindly here.
  getTaskPlan: (projectPath: string, proposalId: string) =>
    j<PlanView>(`/project-manager/plans/${encodeURIComponent(proposalId)}?path=${encodeURIComponent(projectPath)}`),
  verifyTaskPlan: (projectPath: string, proposalId: string, planKey: string) =>
    j<{ fresh: true; plan: PlanView }>(`/project-manager/plans/${encodeURIComponent(proposalId)}/verify`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, planKey }),
    }, { retry: false }),
  // Controlled execution queue (FO-ORCH05): the Owner's order and pause/stop.
  // Nothing here starts a run; "next" only names the task to review.
  getPlanQueue: (projectPath: string, proposalId: string) =>
    j<{ queue: QueueView | null }>(`/project-manager/plans/${encodeURIComponent(proposalId)}/queue?path=${encodeURIComponent(projectPath)}`),
  savePlanQueue: (projectPath: string, proposalId: string, body: { taskIds: string[]; planKey: string; revision?: number }) =>
    j<{ queue: QueueView }>(`/project-manager/plans/${encodeURIComponent(proposalId)}/queue`, {
      method: "PUT",
      body: JSON.stringify({ path: projectPath, ...body }),
    }, { retry: false }),
  setPlanQueueStatus: (projectPath: string, queueId: string, action: "pause" | "resume" | "stop", revision: number) =>
    j<{ queue: QueueView }>(`/project-manager/queues/${encodeURIComponent(queueId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, revision }),
    }, { retry: false }),
  nextPlanQueueTask: (projectPath: string, queueId: string, revision: number, planKey: string) =>
    j<{ next: NonNullable<QueueView["next"]>; queue: QueueView }>(`/project-manager/queues/${encodeURIComponent(queueId)}/next`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, revision, planKey }),
    }, { retry: false }),
  /** Owner opt-in to keep the next task's review prepared. Read-only; confirms and starts nothing. */
  setPlanQueueAutoPrepare: (projectPath: string, queueId: string, enabled: boolean, revision: number) =>
    j<{ queue: QueueView; changed: boolean }>(`/project-manager/queues/${encodeURIComponent(queueId)}/auto-prepare`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, enabled, revision }),
    }, { retry: false }),
  /** Hand queue tasks to a new Execution Batch draft (FO-ORCH07). Creates a draft only; nothing starts. */
  prepareQueueBatch: (projectPath: string, queueId: string, body: { revision: number; planKey: string; taskIds?: string[] }) =>
    j<{ batch: BatchView; queue: QueueView; alreadyPrepared: boolean }>(`/project-manager/queues/${encodeURIComponent(queueId)}/batch`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, ...body }),
    }, { retry: false }),
  listScheduling: (projectPath: string) =>
    j<{ tasks: TaskSchedulingView[] }>(`/project-manager/scheduling?path=${encodeURIComponent(projectPath)}`),
  updateScheduling: (projectPath: string, taskId: string, change: { priority?: TaskPriority; dependsOn?: string[] }) =>
    j<{ task: TaskSchedulingView; affectsBatches: string[] }>(`/project-manager/tasks/${encodeURIComponent(taskId)}/scheduling`, {
      method: "PUT",
      body: JSON.stringify({ path: projectPath, ...change }),
    }, { retry: false }),
  listBatches: (projectPath: string) =>
    j<BatchView[]>(`/project-manager/batches?path=${encodeURIComponent(projectPath)}`),
  getBatch: (projectPath: string, id: string) =>
    j<BatchView>(`/project-manager/batches/${encodeURIComponent(id)}?path=${encodeURIComponent(projectPath)}`),
  batchEvents: (projectPath: string, id: string) =>
    j<{ events: BatchEventRow[] }>(`/project-manager/batches/${encodeURIComponent(id)}/events?path=${encodeURIComponent(projectPath)}`),
  createBatch: (projectPath: string, taskIds: string[], title?: string, policy?: Partial<BatchPolicy>) =>
    j<BatchView>("/project-manager/batches", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, taskIds, ...(title ? { title } : {}), ...(policy ? { policy } : {}) }),
    }, { retry: false }),
  createBatchFromProposal: (projectPath: string, proposalId: string) =>
    j<BatchView>(`/project-manager/proposals/${encodeURIComponent(proposalId)}/batch`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  updateBatch: (
    projectPath: string,
    id: string,
    revision: number,
    change: { taskIds?: string[]; title?: string; policy?: Partial<BatchPolicy>; configs?: Record<string, Partial<ExecutionConfig>> },
  ) =>
    j<BatchView>(`/project-manager/batches/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ path: projectPath, revision, ...change }),
    }, { retry: false }),
  previewBatch: (projectPath: string, id: string) =>
    j<BatchView>(`/project-manager/batches/${encodeURIComponent(id)}/preview`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  approveBatch: (
    projectPath: string,
    id: string,
    revision: number,
    previewKey: string,
    acknowledgedHarnessIds: string[],
    queue?: { acknowledgeFullAccess?: string[]; authorizationMinutes?: number },
  ) =>
    j<{ batch: BatchView; alreadyApproved: boolean }>(`/project-manager/batches/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, revision, previewKey, acknowledgedHarnessIds, ...(queue ?? {}) }),
    }, { retry: false }),
  batchAction: (projectPath: string, id: string, action: "start" | "pause" | "resume" | "cancel" | "stop-runs") =>
    j<BatchView | { batch: BatchView }>(`/project-manager/batches/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  /** Read-only: what a bounded autonomous grant would bind (FO-ORCH08). */
  previewAutonomy: (projectPath: string, id: string) =>
    j<AutonomyPreview>(`/project-manager/batches/${encodeURIComponent(id)}/autonomy/preview`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  /** The Owner's explicit grant. `retry: false`: a replay must never create a second grant. */
  grantAutonomy: (
    projectPath: string,
    id: string,
    body: { previewKey: string; maxRuns: number; maxParallelism: number; ttlMinutes: number; acknowledgeUnknownQuota: boolean },
  ) =>
    j<{ batch: BatchView }>(`/project-manager/batches/${encodeURIComponent(id)}/autonomy`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath, confirm: true, ...body }),
    }, { retry: false }),
  revokeAutonomy: (projectPath: string, id: string) =>
    j<{ batch: BatchView; alreadyEnded: boolean }>(`/project-manager/batches/${encodeURIComponent(id)}/autonomy/revoke`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  releaseBatchTask: (projectPath: string, id: string, taskId: string) =>
    j<BatchView>(`/project-manager/batches/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/release`, {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    }, { retry: false }),
  // FO-AUTO02: bounded multi-task employee + QC orchestration.
  listOrchestratedBatches: (projectPath: string) =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView[]>(
      `/project-manager/orchestrated-batches?path=${encodeURIComponent(projectPath)}`,
    ),
  getOrchestratedBatch: (projectPath: string, id: string) =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView>(
      `/project-manager/orchestrated-batches/${encodeURIComponent(id)}?path=${encodeURIComponent(projectPath)}`,
    ),
  createOrchestratedBatch: (projectPath: string, taskIds: string[], title?: string) =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView>("/project-manager/orchestrated-batches", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, taskIds, ...(title ? { title } : {}) }),
    }, { retry: false }),
  approveOrchestratedBatch: (
    projectPath: string,
    id: string,
    body: import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchApproveBody,
  ) =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView>(
      `/project-manager/orchestrated-batches/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify({ path: projectPath, ...body }) },
      { retry: false },
    ),
  orchestratedBatchAction: (projectPath: string, id: string, action: "start" | "pause" | "resume" | "cancel") =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView>(
      `/project-manager/orchestrated-batches/${encodeURIComponent(id)}/${action}`,
      { method: "POST", body: JSON.stringify({ path: projectPath }) },
      { retry: false },
    ),
  authorizeOrchestratedPhase: (
    projectPath: string,
    id: string,
    body: { taskId: string; phase: "developer" | "reviewer"; implementationRunId?: string },
  ) =>
    j<import("../../shared/pm-orchestrated-batch.ts").OrchestratedBatchView>(
      `/project-manager/orchestrated-batches/${encodeURIComponent(id)}/phase-grants`,
      { method: "POST", body: JSON.stringify({ path: projectPath, ...body }) },
      { retry: false },
    ),
  /**
   * Start one AI interview turn (FO-003). Returns at once; poll
   * `getInterviewTurn` for the reply. `retry: false` — a replay would start a
   * second paid turn.
   */
  startInterviewTurn: (input: InterviewTurnInput) =>
    j<InterviewTurn>("/project-interviews/turns", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  /** Local CLI probes only (no model call): the flags an interview turn on
   *  this harness runs with and what they don't prevent. */
  interviewPreflight: (input: { harness: string; model: string; effort: string | null }) =>
    j<{ harness: { id: string; label: string; kind: string }; isolation: InterviewIsolation }>(
      "/project-interviews/preflight",
      { method: "POST", body: JSON.stringify(input) },
    ),
  getInterviewTurn: (id: string) => j<InterviewTurn>(`/project-interviews/turns/${encodeURIComponent(id)}`),
  cancelInterviewTurn: (id: string) =>
    j<{ cancelled: boolean }>(`/project-interviews/turns/${encodeURIComponent(id)}`, { method: "DELETE" }, { retry: false }),
  loadInterviewDraft: (projectPath: string) =>
    j<{ state: InterviewState | null }>(`/project-interviews/draft?path=${encodeURIComponent(projectPath)}`),
  saveInterviewDraft: (state: InterviewState) =>
    j<{ ok: true }>("/project-interviews/draft", { method: "PUT", body: JSON.stringify({ state }) }),
  deleteInterviewDraft: (projectPath: string) =>
    j<{ deleted: boolean }>(`/project-interviews/draft?path=${encodeURIComponent(projectPath)}`, { method: "DELETE" }),
  /** Read-only: whether each accepted draft's path is free. */
  checkProjectDocs: (input: { projectPath: string; files: { kind: DocKind; path: string }[] }) =>
    j<{ projectExists: boolean; checks: DocTargetCheck[] }>("/project-interviews/check-docs", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Create accepted drafts in a registered project. Never overwrites. */
  writeProjectDocs: (input: { projectPath: string; files: { kind: DocKind; path: string; content: string }[] }) =>
    j<{ results: DocWriteResult[] }>(
      "/project-interviews/write-docs",
      { method: "POST", body: JSON.stringify(input) },
      { retry: false },
    ),
  /** The native folder panel; registers the pick as a project. */
  pickProject: (startingFolder?: string) =>
    withCoreBusySuspended(() =>
      j<{ project: Project | null }>("/projects/pick", {
        method: "POST",
        body: JSON.stringify({ startingFolder }),
      }),
    ),
  deleteProject: (p: string) =>
    j<void>("/projects", { method: "DELETE", body: JSON.stringify({ path: p }) }),
  cloneProject: (input: {
    url: string;
    provider?: GitProvider;
    dest?: string;
    eli5?: boolean;
    agent?: string;
    mode?: string;
    model?: string;
    effort?: string | null;
    fast?: boolean;
    maxMode?: boolean;
    agentProfileId?: string;
    /** Client-minted uuid so the caller can subscribe to this clone's
     *  `clone_progress` AppEvents (via `subscribeCloneProgress`) BEFORE
     *  awaiting this call, and so `cancelClone` can name the right one.
     *  The server mints its own when omitted and echoes it back either way. */
    cloneId?: string;
  }) =>
    // retry: false — a replay after a lost response would re-enter the route
    // against a destination the first attempt already filled (502 "already
    // exists") while that clone and its explainer task are live, or race a
    // second `git clone` into the same directory.
    j<{ project: Project; provider: GitProvider; eli5TaskId: string | null; eli5Error: string | null; cloneId: string }>(
      "/projects/clone",
      { method: "POST", body: JSON.stringify(input) },
      { retry: false },
    ),
  /** Kill the in-flight `git clone` behind `cloneId` (the id passed to, or
   *  echoed back by, `cloneProject`). Resolves `{ ok: true }` on success; the
   *  held `cloneProject` call then rejects with an `ApiError` whose
   *  `.status === 409` and whose `.body` carries `{ cancelled: true }` —
   *  `CloneProjectDialog` checks that shape to tell a user-initiated cancel
   *  apart from a real clone failure. Throws (`ApiError`, `.status === 404`)
   *  when nothing was in flight for that id — the clone may have just
   *  finished on its own, which callers should treat as a benign race, not
   *  a failure to report. */
  cancelClone: (cloneId: string) =>
    j<{ ok: true }>(`/projects/clone/${encodeURIComponent(cloneId)}`, { method: "DELETE" }),
  /** Per-project branch nomenclature. GET resolves to built-in defaults when the
   *  project has no stored config, so the form always gets a usable shape. */
  getProjectBranchConfig: (p: string) =>
    j<BranchNamingConfig>(`/projects/settings?path=${encodeURIComponent(p)}`),
  setProjectBranchConfig: (p: string, config: BranchNamingConfig) =>
    j<Project>("/projects/settings", {
      method: "PUT",
      body: JSON.stringify({ path: p, config }),
    }),
  listProjectRules: (p: string) =>
    j<{ rules: import("../../shared/types.ts").ProjectRule[]; version: string }>(
      `/projects/rules?path=${encodeURIComponent(p)}`,
    ),
  createProjectRule: (p: string, body: { name: string; body: string; enabled?: boolean }) =>
    j<{ rule: import("../../shared/types.ts").ProjectRule; rules: import("../../shared/types.ts").ProjectRule[]; version: string }>(
      "/projects/rules",
      { method: "POST", body: JSON.stringify({ path: p, ...body }) },
    ),
  updateProjectRule: (p: string, ruleId: string, patch: { name?: string; body?: string; enabled?: boolean; sortOrder?: number }) =>
    j<{ rule: import("../../shared/types.ts").ProjectRule; rules: import("../../shared/types.ts").ProjectRule[]; version: string }>(
      `/projects/rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify({ path: p, ...patch }) },
    ),
  deleteProjectRule: (p: string, ruleId: string) =>
    j<{ rules: import("../../shared/types.ts").ProjectRule[]; version: string }>(
      `/projects/rules/${encodeURIComponent(ruleId)}?path=${encodeURIComponent(p)}`,
      { method: "DELETE" },
    ),
  getRunExecution: (runId: string) => j<import("../../shared/run-execution.ts").RunExecution>(`/runs/${encodeURIComponent(runId)}/execution`),
  /** Existing read-only preview; never starts a test or requests authorization. */
  getTaskComputerWorkflow: (id: string) =>
    j<{ review: import("../../shared/task-computer-workflow.ts").TaskComputerReview | null; used: boolean; run: import("../../shared/task-computer-workflow.ts").TaskComputerRun | null }>(
      `/tasks/${encodeURIComponent(id)}/computer-workflow`),
  saveTaskComputerWorkflow: (id: string, scope: import("../../shared/task-computer-workflow.ts").TaskComputerScope | null) =>
    j<{ review: import("../../shared/task-computer-workflow.ts").TaskComputerReview | null; used: boolean; run: import("../../shared/task-computer-workflow.ts").TaskComputerRun | null }>(
      `/tasks/${encodeURIComponent(id)}/computer-workflow`, { method: "PUT", body: JSON.stringify(scope) }, { retry: false }),
  getTaskComputerScreenshot: (id: string, runId: string) =>
    j<{ image: string }>(`/tasks/${encodeURIComponent(id)}/computer-workflow/screenshot/${encodeURIComponent(runId)}`),
  getTaskQcEvidence: (taskId: string) =>
    j<import("./manager-outcome").OutcomeTestEvidence>(`/tasks/${encodeURIComponent(taskId)}/qc-evidence`),
  getTaskQc: (taskId: string) =>
    j<{ state: import("../../shared/types.ts").TaskQcState; reviews: import("../../shared/types.ts").TaskQcReview[]; timeLimitSeconds?: number | null }>(
      `/tasks/${encodeURIComponent(taskId)}/qc`,
    ),
  getTaskWorkspace: (taskId: string) =>
    j<{ workspace: import("../../shared/task-workspace.ts").TaskWorkspaceView | null }>(
      `/task-workspace?taskId=${encodeURIComponent(taskId)}`,
    ).then((body) => body.workspace),
  prepareTaskWorkspace: (body: { taskId: string; outputPaths?: string[]; dependencyPaths?: string[]; includePaths?: string[]; writeScope?: "explicit-outputs" | "working-copy" }) =>
    j<{ workspace: import("../../shared/task-workspace.ts").TaskWorkspaceView }>(
      "/task-workspace/prepare",
      { method: "POST", body: JSON.stringify(body) },
    ).then((result) => result.workspace),
  abandonTaskWorkspace: (taskId: string) =>
    j<{ workspace: import("../../shared/task-workspace.ts").TaskWorkspaceView }>(
      "/task-workspace/abandon",
      { method: "POST", body: JSON.stringify({ taskId }) },
    ).then((result) => result.workspace),
  publishTaskWorkspace: (body: { taskId: string; approve: true; paths: string[] }) =>
    j<{ workspace: import("../../shared/task-workspace.ts").TaskWorkspaceView }>(
      "/task-workspace/publish",
      { method: "POST", body: JSON.stringify(body) },
    ).then((result) => result.workspace),
  runTaskWorkspaceCheck: (taskId: string, command: string) =>
    j<{ check: import("../../shared/working-copy-checks.ts").WorkingCopyCheckRecord; workspace: import("../../shared/task-workspace.ts").TaskWorkspaceView | null }>(
      "/task-workspace/check",
      { method: "POST", body: JSON.stringify({ taskId, command }) },
      { retry: false },
    ),
  getTaskSupervisedLive: (taskId: string) =>
    j<import("../../shared/supervised-live-workflow.ts").SupervisedLiveView & {
      taskId: string;
      implementer: { employeeId: string; name: string } | null;
      implementation: { harness: string; model: string | null };
      latestEmployeeRunPhase: import("../../shared/execution/run.ts").EmployeeRunPhase | null;
      qc: { state: import("../../shared/types.ts").TaskQcState; reviews: import("../../shared/types.ts").TaskQcReview[] };
      usesFakeDriver: boolean;
    }>(`/tasks/${encodeURIComponent(taskId)}/supervised-workflow`),
  getTaskOrchestratedWorkflow: (taskId: string) =>
    j<import("../../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowView>(
      `/tasks/${encodeURIComponent(taskId)}/orchestrated-workflow`,
    ),
  approveOrchestratedWorkflow: (taskId: string, body: import("../../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowApproveBody) =>
    j<import("../../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowView>(
      `/tasks/${encodeURIComponent(taskId)}/orchestrated-workflow`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  cancelOrchestratedWorkflow: (taskId: string) =>
    j<import("../../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowView>(
      `/tasks/${encodeURIComponent(taskId)}/orchestrated-workflow/cancel`,
      { method: "POST" },
    ),
  resumeOrchestratedWorkflow: (taskId: string) =>
    j<import("../../shared/pm-orchestrated-workflow.ts").OrchestratedWorkflowView>(
      `/tasks/${encodeURIComponent(taskId)}/orchestrated-workflow/resume`,
      { method: "POST" },
    ),
  prepareTaskQcReview: (
    taskId: string,
    body: { reviewerHarness: string; reviewerModel?: string; reviewerEmployeeId?: string; reviewerRoleSlug?: string },
  ) =>
    j<{
      review: import("../../shared/types.ts").TaskQcReview;
      promptPreview: string;
      blockedReason: string | null;
    }>(`/tasks/${encodeURIComponent(taskId)}/qc/reviews`, { method: "POST", body: JSON.stringify(body) }),
  /** The Owner's one-time authorization of one additional review round. It starts nothing. */
  authorizeQcExtension: (taskId: string, expectedRound: number) =>
    j<{ state: import("../../shared/types.ts").TaskQcState; replayed: boolean }>(`/tasks/${encodeURIComponent(taskId)}/qc/extension`, {
      method: "POST",
      body: JSON.stringify({ confirm: true, expectedRound }),
    }),
  startTaskQcReview: (taskId: string, reviewId: string) =>
    j<{ runId: string }>(`/tasks/${encodeURIComponent(taskId)}/qc/reviews/${encodeURIComponent(reviewId)}/start`, {
      method: "POST",
    }, { retry: false }),
  getQcRecovery: (taskId: string) =>
    j<import("../../shared/qc-recovery.ts").QcRecoveryView>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery`),
  prepareQcRecovery: (taskId: string, body: { reviewerHarness: string; reviewerModel: string; reviewerEffort?: string; reviewerMode?: string; validMinutes?: number; purpose?: "process-failure" | "evidence-refresh" }) =>
    j<import("../../shared/qc-recovery.ts").QcRecoveryGrant>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  reconcileQcRecovery: (taskId: string) =>
    j<import("../../shared/qc-recovery.ts").QcRecoveryView>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery/reconcile`, { method: "POST" }),
  approveQcRecovery: (taskId: string, grantId: string) =>
    j<import("../../shared/qc-recovery.ts").QcRecoveryGrant>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery/${encodeURIComponent(grantId)}/approve`, { method: "POST" }),
  startQcRecovery: (taskId: string, grantId: string) =>
    j<{ runId: string }>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery/${encodeURIComponent(grantId)}/start`, { method: "POST" }, { retry: false }),
  cancelQcRecovery: (taskId: string, grantId: string) =>
    j<import("../../shared/qc-recovery.ts").QcRecoveryGrant>(`/tasks/${encodeURIComponent(taskId)}/qc-recovery/${encodeURIComponent(grantId)}/cancel`, { method: "POST" }),
  prepareReviewTest: (taskId: string, body: { acknowledgeRisk: true; validMinutes?: number; purpose?: "first-review" | "evidence-refresh" }) =>
    j<import("../../shared/review-evidence.ts").ReviewTestAuthorization>(`/tasks/${encodeURIComponent(taskId)}/qc-evidence/test-authorization`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  approveReviewTest: (taskId: string, authId: string) =>
    j<import("../../shared/review-evidence.ts").ReviewTestAuthorization>(`/tasks/${encodeURIComponent(taskId)}/qc-evidence/test-authorization/${encodeURIComponent(authId)}/approve`, { method: "POST" }),
  executeReviewTest: (taskId: string, authId: string) =>
    j<{ authorization: import("../../shared/review-evidence.ts").ReviewTestAuthorization; bundle: import("../../shared/review-evidence.ts").ReviewEvidenceBundle }>(`/tasks/${encodeURIComponent(taskId)}/qc-evidence/test-authorization/${encodeURIComponent(authId)}/execute`, { method: "POST" }),
  cancelReviewTest: (taskId: string, authId: string) =>
    j<import("../../shared/review-evidence.ts").ReviewTestAuthorization>(`/tasks/${encodeURIComponent(taskId)}/qc-evidence/test-authorization/${encodeURIComponent(authId)}/cancel`, { method: "POST" }),
  acknowledgeTaskQcOwner: (taskId: string) =>
    j<{ state: import("../../shared/types.ts").TaskQcState; task: import("../../shared/types.ts").Task | null }>(
      `/tasks/${encodeURIComponent(taskId)}/qc/ack-owner`,
      { method: "POST" },
    ),
  /** Open a native file/folder picker and return the chosen references.
   *  WKWebView never exposes `File.path`, so this native panel is the only
   *  reliable way to turn a user pick into an absolute path. Returns `[]` on
   *  cancel. `isDirectory` follows `mode`. */
  pickRefs: (mode: "files" | "folder", startingFolder?: string) =>
    withCoreBusySuspended(() =>
      j<{ refs: TaskReference[] }>("/refs/pick", {
        method: "POST",
        body: JSON.stringify({ mode, startingFolder }),
      }),
    ).then((r) => r.refs),
  /** Resolve absolute paths (pulled from a drag/drop's file:// URLs) into
   *  references — the server stats each for directory-ness and drops any
   *  that no longer exist. */
  resolveRefs: (paths: string[]) =>
    j<{ refs: TaskReference[] }>("/refs/resolve", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }).then((r) => r.refs),
  /** Recover the real paths of the drag/drop that just ended, off the macOS
   *  drag pasteboard — WKWebView exposes no `file://` URLs on a drop, so this
   *  is the fallback for non-image files/folders dragged from Finder. The
   *  server stats each (directory-ness correct, nonexistent dropped). */
  dragRefs: () =>
    j<{ refs: TaskReference[] }>("/refs/drag", { method: "POST" }).then((r) => r.refs),
  listBranches: (dir: string) =>
    j<BranchInfo[]>(`/projects/branches?path=${encodeURIComponent(dir)}`),
  /** `git fetch --all --prune` on the project so newly pushed remote branches
   *  show up in the branch picker. Resolves once the fetch completes; the
   *  caller re-lists branches afterwards. */
  gitFetch: (dir: string) =>
    j<{ ok: true }>("/projects/fetch", {
      method: "POST",
      body: JSON.stringify({ path: dir }),
    }),
  /** Fast-forward a single local `branch` to its upstream (the picker's Git Pull
   *  button). The caller re-lists branches afterwards so the behind indicator
   *  refreshes. Rejects (ApiError) on divergence, missing upstream, or network
   *  failure — the git stderr rides along as the error message. */
  gitPull: (dir: string, branch: string) =>
    j<{ ok: true }>("/projects/pull", {
      method: "POST",
      body: JSON.stringify({ path: dir, branch }),
    }),
  /** Push a local `branch` to its remote and set upstream (the New PR composer's
   *  Push button) so a local-only branch can be opened as a pull request.
   *  Rejects (ApiError) on a rejected push, missing remote, or network failure —
   *  the git stderr rides along as the error message. */
  gitPush: (dir: string, branch: string) =>
    j<{ ok: true; remote?: string }>("/projects/push", {
      method: "POST",
      body: JSON.stringify({ path: dir, branch }),
    }),
  listGitHubItems: (input: {
    path: string;
    kind: GitHubItemKind;
    state: GitHubItemState;
    query?: string;
    labels?: string[];
    assignee?: string;
    createdByMe?: boolean;
    assignedToMe?: boolean;
    reviewRequested?: boolean;
    searchQuery?: string;
    page?: number;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
  }) => {
    const q = new URLSearchParams({
      path: input.path,
      kind: input.kind,
      state: input.state,
    });
    if (input.query) q.set("q", input.query);
    if (input.labels && input.labels.length > 0) q.set("labels", input.labels.join(","));
    if (input.assignee) q.set("assignee", input.assignee);
    if (input.createdByMe) q.set("createdByMe", "1");
    if (input.assignedToMe) q.set("assignedToMe", "1");
    if (input.reviewRequested) q.set("reviewRequested", "1");
    if (input.searchQuery) q.set("searchQuery", input.searchQuery);
    if (input.page) q.set("page", String(input.page));
    if (input.sort) q.set("sort", input.sort);
    if (input.direction) q.set("direction", input.direction);
    return j<GitHubListResult>(`/github/items?${q.toString()}`);
  },
  /** Multi-repo aggregation (G8/F15) — "All repositories" in the GitHub
   *  dialog. Same filters as `listGitHubItems`, fanned out server-side across
   *  every path with a GitHub remote and merged into one list; each item
   *  carries its own repo's path as `sourcePath`. `page`/"Load more" aren't
   *  supported — the aggregate result always covers the first page per repo. */
  listGitHubItemsAcrossRepos: (input: {
    paths: string[];
    kind: GitHubItemKind;
    state: GitHubItemState;
    query?: string;
    labels?: string[];
    assignee?: string;
    createdByMe?: boolean;
    assignedToMe?: boolean;
    reviewRequested?: boolean;
    searchQuery?: string;
    sort?: "created" | "updated" | "comments";
    direction?: "asc" | "desc";
  }) =>
    j<GitHubListResult>("/github/items-aggregate", {
      method: "POST",
      body: JSON.stringify({
        paths: input.paths,
        kind: input.kind,
        state: input.state,
        q: input.query,
        labels: input.labels,
        assignee: input.assignee,
        createdByMe: input.createdByMe,
        assignedToMe: input.assignedToMe,
        reviewRequested: input.reviewRequested,
        searchQuery: input.searchQuery,
        sort: input.sort,
        direction: input.direction,
      }),
    }),
  getGitHubRepoPermissions: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<{ ok: true } & GitHubRepoPermissions>(`/github/repo-permissions?${q.toString()}`);
  },
  getGitHubPullDiff: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<TaskDiff>(`/github/pull-diff?${q.toString()}`);
  },
  getGitHubPullDetail: (path: string, number: number) => {
    const q = new URLSearchParams({ path, number: String(number) });
    return j<{ ok: true; item: GitHubListItem }>(`/github/pull-detail?${q.toString()}`);
  },
  /** A single issue plus its full comment thread — powers every "create a
   *  task from this issue" entry point (dialog, New Task form paste-URL).
   *  `opts.includeComments: false` (the "View issue" prefill's use case, which
   *  only needs the item) appends `includeComments=false` to skip the
   *  server's comments fetch; omitted (the default `true`) sends no query
   *  param at all, matching every other optional-flag param in this file. */
  getGitHubIssueThread: (path: string, number: number, opts?: { includeComments?: boolean }) => {
    const q = new URLSearchParams({ path, number: String(number) });
    if (opts?.includeComments === false) q.set("includeComments", "false");
    return j<{ ok: true } & GitHubIssueThreadResult>(`/github/issue-thread?${q.toString()}`);
  },
  getGitHubPullChecks: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubChecksResult>(`/github/pull-checks?${q.toString()}`);
  },
  getGitHubPullMergeability: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullMergeability>(`/github/pull-mergeability?${q.toString()}`);
  },
  updateGitHubPullBranch: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string }>("/github/pull-update-branch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopenGitHubPull: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/pull-reopen", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubPullDraft: (input: { path: string; number: number; draft: boolean }) =>
    j<{ ok: true; draft: boolean; message?: string }>("/github/pull-draft", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubPullAutoMerge: (input: { path: string; number: number; enable: boolean; mergeMethod?: GitHubPullMergeMethod }) =>
    j<{ ok: true; autoMergeEnabled: boolean; message?: string }>("/github/pull-auto-merge", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubPullCommits: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullCommitsResult>(`/github/pull-commits?${q.toString()}`);
  },
  getGitHubPullLinkedIssues: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubLinkedIssuesResult>(`/github/pull-linked-issues?${q.toString()}`);
  },
  getGitHubPullDefaults: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubPullDefaultsResult>(`/github/pull-defaults?${q.toString()}`);
  },
  // `kind` ("pulls"|"issues") lets GitLab/Bitbucket route to the right
  // notes/comments endpoint (their APIs split MR/PR comments from issue
  // comments, unlike GitHub's single endpoint) — see git-host.ts's
  // `ListCommentsInput` doc comment. Optional/additive: omitted, the server
  // defaults to "pulls" (GitHub ignores it entirely).
  listGitHubComments: (input: { path: string; number: number; kind?: GitHubItemKind }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    if (input.kind) q.set("kind", input.kind);
    return j<GitHubCommentsResult>(`/github/comments?${q.toString()}`);
  },
  createGitHubComment: (input: { path: string; number: number; body: string; kind?: GitHubItemKind }) =>
    // retry: false — a replay would post a duplicate PR/issue comment.
    j<{ comment: GitHubComment }>("/github/comments", {
      method: "POST",
      body: JSON.stringify(input),
    }, { retry: false }),
  getGitHubViewer: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<{ ok: true; login: string }>(`/github/viewer?${q.toString()}`);
  },
  // Provider detection (T4, docs/plans/multi-provider-git-modal.md) — call
  // before the other GitHub* helpers to learn which provider (GitHub/GitLab/
  // Bitbucket) a project's git remote resolves to.
  getProviderInfo: (path: string) => {
    const q = new URLSearchParams({ path });
    return j<{ ok: true; provider: GitProvider; owner: string; name: string; host: string; remoteHost: string }>(
      `/github/provider-info?${q.toString()}`,
    );
  },
  listGitHubLabels: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubLabelsResult>(`/github/labels?${q.toString()}`);
  },
  createGitHubLabel: (input: { path: string; name: string; color: string; description?: string }) =>
    j<{ ok: true; label: GitHubRepoLabel }>("/github/labels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubLabel: (input: { path: string; name: string; newName?: string; color?: string; description?: string }) =>
    j<{ ok: true; label: GitHubRepoLabel }>("/github/label-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubLabel: (input: { path: string; name: string }) =>
    j<{ ok: true; message?: string }>("/github/label-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubAssignees: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubAssigneesResult>(`/github/assignees?${q.toString()}`);
  },
  listGitHubMilestones: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubMilestonesResult>(`/github/milestones?${q.toString()}`);
  },
  createGitHubMilestone: (input: { path: string; title: string; description?: string; dueOn?: string }) =>
    j<{ ok: true; milestone: GitHubRepoMilestone }>("/github/milestones", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubMilestone: (input: {
    path: string;
    number: number;
    title?: string;
    description?: string;
    dueOn?: string | null;
    state?: "open" | "closed";
  }) =>
    j<{ ok: true; milestone: GitHubRepoMilestone }>("/github/milestone-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubMilestone: (input: { path: string; number: number }) =>
    j<{ ok: true; message?: string }>("/github/milestone-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubReleases: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubReleasesResult>(`/github/releases?${q.toString()}`);
  },
  createGitHubRelease: (input: {
    path: string;
    tagName: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    targetCommitish?: string;
  }) =>
    j<{ ok: true; release: GitHubRelease }>("/github/releases", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubRelease: (input: {
    path: string;
    id: number;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    tagName?: string;
  }) =>
    j<{ ok: true; release: GitHubRelease }>("/github/release-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubRelease: (input: { path: string; id: number }) =>
    j<{ ok: true; message?: string }>("/github/release-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubTags: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubTagsResult>(`/github/tags?${q.toString()}`);
  },
  listGitHubWorkflowRuns: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubWorkflowRunsResult>(`/github/workflow-runs?${q.toString()}`);
  },
  listGitHubWorkflows: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubWorkflowsResult>(`/github/workflows?${q.toString()}`);
  },
  rerunGitHubWorkflowRun: (input: { path: string; runId: number; failedOnly?: boolean }) =>
    j<{ ok: true; message: string }>("/github/workflow-rerun", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancelGitHubWorkflowRun: (input: { path: string; runId: number }) =>
    j<{ ok: true; message: string }>("/github/workflow-cancel", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  dispatchGitHubWorkflow: (input: { path: string; workflowId: number; ref: string; inputs?: Record<string, string> }) =>
    j<{ ok: true; message: string }>("/github/workflow-dispatch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubCommitStatus: (input: { path: string; ref: string }) => {
    const q = new URLSearchParams({ path: input.path, ref: input.ref });
    return j<GitHubCommitStatusResult>(`/github/commit-status?${q.toString()}`);
  },
  updateGitHubComment: (input: { path: string; commentId: number; kind: "issue" | "review"; body: string }) =>
    j<{ ok: true; comment: GitHubComment }>("/github/comment-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubComment: (input: { path: string; commentId: number; kind: "issue" | "review" }) =>
    j<{ ok: true; message?: string }>("/github/comment-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubPullLineComment: (input: {
    path: string;
    number: number;
    body: string;
    filePath: string;
    line: number;
    side: "LEFT" | "RIGHT";
  }) =>
    j<{ comment: GitHubPullLineComment }>("/github/pull-line-comment", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubPullReviewComments: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullReviewCommentsResult>(`/github/pull-review-comments?${q.toString()}`);
  },
  getGitHubPullReviewThreads: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({
      path: input.path,
      number: String(input.number),
    });
    return j<GitHubPullReviewThreadsResult>(`/github/pull-review-threads?${q.toString()}`);
  },
  setGitHubReviewThreadResolved: (input: { path: string; threadId: string; resolved: boolean }) =>
    j<{ ok: true; resolved: boolean; message?: string }>("/github/review-thread-resolve", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  replyGitHubPullLineComment: (input: { path: string; number: number; commentId: number; body: string }) =>
    j<{ comment: GitHubPullLineComment }>("/github/pull-line-comment-reply", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reviewGitHubPull: (input: {
    path: string;
    number: number;
    event: GitHubPullReviewEvent;
    body?: string;
    comments?: { path: string; line: number; side: "LEFT" | "RIGHT"; body: string }[];
  }) =>
    j<{ ok: true; message?: string }>("/github/pull-review", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  mergeGitHubPull: (input: {
    path: string;
    number: number;
    method: GitHubPullMergeMethod;
    title?: string;
    message?: string;
  }) =>
    j<GitHubPullMergeResult>("/github/pull-merge", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  closeGitHubPull: (input: { path: string; number: number; comment?: string }) =>
    j<{ ok: true; message?: string; item?: GitHubListResult["items"][number]; commentPosted?: boolean }>("/github/pull-close", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubPull: (input: {
    path: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    draft?: boolean;
    reviewers?: string[];
    /** When set, the server persists the created PR's URL onto this task
     *  (`tasks.pr_url`) atomically with creation — see `Task.prUrl`. */
    taskId?: string;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/pull-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createGitHubIssue: (input: {
    path: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    milestone?: number | null;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/issue-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateGitHubIssue: (input: {
    path: string;
    number: number;
    kind?: GitHubItemKind;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    labels?: string[];
    assignees?: string[];
    milestone?: number | null;
  }) =>
    j<{ ok: true; message?: string; item: GitHubListResult["items"][number] }>("/github/issue-update", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubIssueLock: (input: { path: string; number: number; locked: boolean; lockReason?: string }) =>
    j<{ ok: true; locked: boolean; message?: string }>("/github/issue-lock", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubIssuePinned: (input: { path: string; number: number; pinned: boolean }) =>
    j<{ ok: true; pinned: boolean; message?: string }>("/github/issue-pin", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubIssuePinned: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<{ ok: true; pinned: boolean }>(`/github/issue-pinned?${q.toString()}`);
  },
  listGitHubSubIssues: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<GitHubSubIssuesResult>(`/github/sub-issues?${q.toString()}`);
  },
  addGitHubSubIssue: (input: { path: string; number: number; childNumber: number }) =>
    j<{ ok: true; subIssue: GitHubSubIssue; message?: string }>("/github/sub-issue-add", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeGitHubSubIssue: (input: { path: string; number: number; childId: number }) =>
    j<{ ok: true; message?: string }>("/github/sub-issue-remove", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  transferGitHubIssue: (input: { path: string; number: number; targetRepo: string }) =>
    j<{ ok: true; url: string; message?: string }>("/github/issue-transfer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubProjectsV2: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubProjectsV2Result>(`/github/projects?${q.toString()}`);
  },
  getGitHubProjectItems: (input: { path: string; projectId: string }) => {
    const q = new URLSearchParams({ path: input.path, projectId: input.projectId });
    return j<GitHubProjectItemsResult>(`/github/project-items?${q.toString()}`);
  },
  addGitHubProjectItem: (input: { path: string; projectId: string; contentNumber: number; contentKind: "issue" | "pr" }) =>
    j<{ ok: true; itemId: string }>("/github/project-item-add", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeGitHubProjectItem: (input: { path: string; projectId: string; itemId: string }) =>
    j<{ ok: true; message?: string }>("/github/project-item-remove", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubProjectItemStatus: (input: { path: string; projectId: string; itemId: string; fieldId: string; optionId: string }) =>
    j<{ ok: true; message?: string }>("/github/project-item-status", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubDiscussions: (input: { path: string }) => {
    const q = new URLSearchParams({ path: input.path });
    return j<GitHubDiscussionsResult>(`/github/discussions?${q.toString()}`);
  },
  getGitHubDiscussion: (input: { path: string; number: number }) => {
    const q = new URLSearchParams({ path: input.path, number: String(input.number) });
    return j<{ ok: true; detail: GitHubDiscussionDetail }>(`/github/discussion?${q.toString()}`);
  },
  createGitHubDiscussion: (input: { path: string; categoryId: string; title: string; body: string }) =>
    j<{ ok: true; number: number; url: string }>("/github/discussion-create", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  addGitHubDiscussionComment: (input: { path: string; discussionId: string; body: string }) =>
    j<{ ok: true; commentId: string }>("/github/discussion-comment", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setGitHubDiscussionAnswer: (input: { path: string; commentId: string; answer: boolean }) =>
    j<{ ok: true; isAnswer: boolean }>("/github/discussion-answer", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubDiscussion: (input: { path: string; discussionId: string }) =>
    j<{ ok: true; message?: string }>("/github/discussion-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteGitHubDiscussionComment: (input: { path: string; commentId: string }) =>
    j<{ ok: true; message?: string }>("/github/discussion-comment-delete", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  requestGitHubPullReviewers: (input: { path: string; number: number; reviewers: string[]; teamReviewers?: string[] }) =>
    j<{ ok: true; message?: string }>("/github/pull-reviewers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyGitHubSuggestion: (input: { path: string; number: number; commentId: number }) =>
    j<{ ok: true; message: string }>("/github/pull-apply-suggestion", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listGitHubReactions: (input: { path: string; subject: GitHubReactionSubject; viewer?: string }) => {
    const q = new URLSearchParams({
      path: input.path,
      subjectType: input.subject.type,
      subjectId: String(input.subject.id),
    });
    if (input.viewer) q.set("viewer", input.viewer);
    return j<GitHubReactionsResult>(`/github/reactions?${q.toString()}`);
  },
  addGitHubReaction: (input: { path: string; subject: GitHubReactionSubject; content: GitHubReactionContent }) =>
    j<{ ok: true; reactionId: number; content: GitHubReactionContent }>("/github/reaction-add", {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        content: input.content,
      }),
    }),
  removeGitHubReaction: (input: { path: string; subject: GitHubReactionSubject; reactionId: number }) =>
    j<{ ok: true }>("/github/reaction-remove", {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        reactionId: input.reactionId,
      }),
    }),
  listGitHubNotifications: (input: { path: string; all?: boolean }) => {
    const q = new URLSearchParams({ path: input.path, all: input.all ? "true" : "false" });
    return j<GitHubNotificationsResult>(`/github/notifications?${q.toString()}`);
  },
  markGitHubNotificationRead: (input: { path: string; threadId: string }) =>
    j<{ ok: true }>("/github/notification-read", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  markAllGitHubNotificationsRead: (input: { path: string }) =>
    j<{ ok: true; message: string }>("/github/notifications-read-all", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getGitHubThreadSubscription: (input: { path: string; threadId: string }) => {
    const q = new URLSearchParams({ path: input.path, threadId: input.threadId });
    return j<{ ok: true; subscribed: boolean; ignored: boolean }>(`/github/thread-subscription?${q.toString()}`);
  },
  setGitHubThreadSubscription: (input: { path: string; threadId: string; ignored: boolean }) =>
    j<{ ok: true; subscribed: boolean; ignored: boolean }>("/github/thread-subscription", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unsubscribeGitHubThread: (input: { path: string; threadId: string }) =>
    j<{ ok: true }>("/github/thread-unsubscribe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Stored per-host git credentials (GitHub, GitLab, and Bitbucket all
   *  share this store) + hosts detected across registered projects — drives
   *  the "Git host tokens" Settings section. Route path kept as
   *  `/github/tokens` for back-compat with existing stored credentials. */
  listGitHubTokens: () => j<GitHubTokensResult>("/github/tokens"),
  /** Upsert the credential for `input.host`. Returns the refreshed list —
   *  never the raw token. */
  setGitHubToken: (input: { host: string; token: string; label?: string | null }) =>
    j<GitHubTokensResult>("/github/tokens", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteGitHubToken: (host: string) =>
    j<{ ok: true }>(`/github/tokens/${encodeURIComponent(host)}`, { method: "DELETE" }),
  getTmuxSource: () =>
    j<{
      source: "system" | "bundled";
      bundledAvailable: boolean;
      bundledPath: string;
      resolvedBin: string;
    }>("/tmux-source"),
  setTmuxSource: (source: "system" | "bundled") =>
    j<{ ok: true; source: "system" | "bundled" }>("/tmux-source", {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
  listPreferences: () => j<Record<string, string>>("/preferences"),
  setPreference: (key: string, value: string) =>
    j<void>(`/preferences/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  /** `GET /db/stats` — file/WAL size, reclaimable bytes, the Compact estimate
   *  and the archived-history retention bookkeeping (Settings → General). */
  getDbStats: () => j<DbStats>("/db/stats"),
  /** `POST /db/compact` — `VACUUM` + WAL truncate. Blocks the core for the
   *  whole duration (the request itself is the freeze), so it suspends the
   *  busy banner for its lifetime; the Settings modal owns the user-facing
   *  "Agetor won't respond" copy. Refused with a 409 `ApiError` (message =
   *  the server's "N task(s) running — …" text, body carries
   *  `activeRunCount`) while any run is active. `retry: false` — never
   *  replayed. */
  compactDb: (): Promise<DbCompactResult> =>
    withCoreBusySuspended(() => j<DbCompactResult>("/db/compact", { method: "POST" }, { retry: false })),
  /** `POST /db/retention/run` — runs one archived-history retention pass now.
   *  400 when the preference is `off`, 409 while a pass is already running
   *  (both thrown as `ApiError`). `retry: false`. */
  runRetentionPass: () =>
    j<RetentionPassResult>("/db/retention/run", { method: "POST" }, { retry: false }),
  listAgentCapabilities: (opts: { agent: string; workdir?: string | null; branch?: string }) => {
    // Slash commands/skills + MCP/skill/plugin extensions in one fetch. `agent`
    // is a harness id (built-ins use id-equals-kind, so "claude-code" / "codex"
    // still works). The server resolves to the harness via getByIdOrKind and
    // reads from the harness's own home when set. `workdir` is optional — the
    // server always includes user-level entries + plugins even without one
    // (project-level commands/skills only exist once a workdir is known);
    // omitted/empty means "no workdir" rather than an empty-string one, same
    // convention as `listProjectFiles`'s `ref`.
    const q = new URLSearchParams({ agent: opts.agent });
    if (opts.workdir) q.set("workdir", opts.workdir);
    if (opts.branch) q.set("branch", opts.branch);
    return j<{ commands: AvailableCommand[]; extensions: AvailableExtension[] }>(
      `/agent-discovery?${q.toString()}`,
    );
  },
  /** File/directory listing for the `@` file-reference popover and
   *  highlighter — `GET /files/index`. Two modes, chosen by whether `ref` is
   *  given: with a `ref`, the server resolves tracked files at that ref via
   *  `git ls-tree` (the shape a not-yet-created worktree will have once it's
   *  materialized); without one, it resolves the live working tree via
   *  `git ls-files` (tracked + untracked, minus ignored/deleted). `ref` is
   *  omitted from the request entirely when blank/null so the server always
   *  sees "no ref" rather than an empty-string one. `truncated` is true when
   *  the listing hit the server's file-count cap.
   *
   *  `q` switches to server-side search mode (monorepo fallback past the 20k
   *  display cap): when set — the empty string counts, `null`/`undefined`
   *  omit the param entirely — the server ranks files + derived directories
   *  over the ENTIRE listing with the shared `filterFileEntries` scorer and
   *  returns up to `limit` (server default 50) matches; `truncated` then
   *  reports the internal 250k scan cap instead of the 20k display cap. See
   *  `searchProjectFiles` (`use-project-files.ts`), the `@` popover's
   *  consumer of this mode. */
  listProjectFiles: (scope: { dir: string; ref?: string | null; q?: string | null; limit?: number }) => {
    const params = new URLSearchParams({ dir: scope.dir });
    if (scope.ref) params.set("ref", scope.ref);
    if (scope.q != null) params.set("q", scope.q);
    if (scope.limit != null) params.set("limit", String(scope.limit));
    return j<{ files: string[]; truncated: boolean }>(`/files/index?${params.toString()}`);
  },
  listTasks: () => j<Task[]>("/tasks"),
  /** Single task by id, fresh from the server (bypasses the 2s board poll's
   *  staleness). Used to re-check a task's persisted draft right after the
   *  panel seeds from a possibly-stale polled object — see RunPanel's
   *  pristine-adopt seeding. 404s (task deleted) surface as ApiError. */
  getTask: (id: string, signal?: AbortSignal) => j<Task>(`/tasks/${encodeURIComponent(id)}`, { signal }),
  createTask: (input: {
    title: string;
    prompt: string;
    /** Harness id — see `listHarnesses()`. Built-in ids are `claude-code` / `codex`. */
    agent: string;
    workdir: string;
    isolation: Isolation;
    accessMode?: AccessMode;
    baseRef?: string;
    /** Explicit branch name for worktree isolation. Overrides the project's
     *  nomenclature; the server validates it and makes it unique. */
    branch?: string;
    /** Check the worktree out on this pre-existing branch (e.g. a PR's head
     *  branch) instead of minting a fresh one. Requires worktree isolation. */
    existingBranch?: string;
    mode?: string | null;
    model?: string | null;
    effort?: string | null;
    fast?: boolean;
    maxMode?: boolean;
    /** Initial column. Defaults to "backlog" if omitted. */
    column?: ColumnId;
    references?: TaskReference[];
    taskType?: TaskType;
    /** URL of the issue this task is created from — validated and same-repo
     *  checked server-side (`createTask`); powers "View issue" and the
     *  PR-body `Closes #N` prefill. */
    issueUrl?: string;
    /** Full markdown snapshot of the issue + its comment thread, written to
     *  a per-task file and attached as a reference. Only meaningful
     *  alongside `issueUrl`. */
    issueSnapshot?: string;
    /** Id of an {@link AgentProfile} to launch from — the server resolves it
     *  and overrides `agent`/`model`/`effort`/`mode`/`fast`/`maxMode` from the
     *  profile (body-provided values for those fields are ignored); 400 on an
     *  unknown id. */
    agentProfileId?: string | null;
    /** Id of a {@link Pipeline} to launch this task as the parent run of —
     *  mutually exclusive with `agentProfileId` (400 when both are sent).
     *  See `docs/plans/pipelines.md` D1. */
    pipelineId?: string;
    /** Kanban urgency 1 (Minimal) .. 5 (Critical); the server defaults to 3 (Normal). */
    urgency?: import("../../shared/board-order.ts").Urgency;
    /** Earliest UTC instant (ISO-8601) at which automatic execution may start this task, or null for immediate availability. */
    availableFromUtc?: string | null;
  }) =>
    // retry: false — a replay would create a duplicate task + branch.
    j<Task>("/tasks", { method: "POST", body: JSON.stringify(input) }, { retry: false }),
  updateTask: (id: string, patch: Partial<Task>) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  moveTask: (id: string, column: ColumnId) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ column }) }),
  /** Changes only the Kanban urgency; the card lands at the end of its new urgency group. */
  setTaskUrgency: (id: string, urgency: import("../../shared/board-order.ts").Urgency) =>
    j<Task>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ urgency }) }, { retry: false }),
  /** Sets or clears the earliest UTC execution availability timestamp without touching urgency, status, rank, or grants. */
  setTaskAvailability: (id: string, availableFromUtc: string | null, expectedUpdatedAt?: number) =>
    j<Task>(
      `/tasks/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(expectedUpdatedAt !== undefined ? { availableFromUtc, expectedUpdatedAt } : { availableFromUtc }),
      },
      { retry: false },
    ),
  /** Moves one task inside its own project + column + urgency group (idempotent; the server enforces the boundary). */
  reorderTask: (id: string, body: { expectedColumn: ColumnId; expectedUrgency: import("../../shared/board-order.ts").Urgency; placement: import("../../shared/board-order.ts").Placement }) =>
    j<{ task: Task; order: string[]; rowsWritten: number; renumbered: boolean }>(`/tasks/${id}/reorder`, { method: "POST", body: JSON.stringify(body) }),
  admitTaskToInbox: (id: string) =>
    j<Task>(`/tasks/${id}/admit-inbox`, { method: "POST" }, { retry: false }),
  deleteTask: (id: string) => j<void>(`/tasks/${id}`, { method: "DELETE" }),
  // `pending: true` (optional): the server returned before the agent spawn
  // finished; the run row already exists (task-details-blank-while-session-restores.md §3.1).
  startTask: (id: string) => j<{ runId: string; pending?: true }>(`/tasks/${id}/start`, { method: "POST" }),
  getTaskLaunchDiagnostics: (id: string) =>
    j<import("../../shared/execution/access-mode.ts").AccessDiagnostics>(`/tasks/${encodeURIComponent(id)}/launch-diagnostics`),
  previewLaunchDiagnostics: (input: {
    accessMode?: AccessMode;
    harnessId?: string;
    mode?: string | null;
    isolation?: Isolation;
    workdir?: string;
    branch?: string | null;
    isPipeline?: boolean;
  }) => j<import("../../shared/execution/access-mode.ts").AccessDiagnostics>("/launch-diagnostics", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  /** `force: true` bypasses the done-column gate (still rejects an active
   *  run) — used by the Worktrees page's "Archive & delete" flow to archive
   *  a stale worktree's task regardless of its current column. `stopRun:
   *  true` additionally stops any in-flight run/background agents before
   *  archiving — required (server-enforced) to archive a running/blocked
   *  task at all; the caller is expected to confirm with the user first.
   *  `forceWorktree: true` discards uncommitted changes in the worktree's
   *  checkout during teardown (never the branch, commits, or run/AI
   *  history) — also part of the Worktrees page's "Archive & delete", after
   *  the caller has warned the user. `awaitTeardown: true` makes the
   *  request block until the worktree removal has actually finished (no
   *  timeout is set server-side), and the response then carries a
   *  `teardown` outcome describing whether the directory is really gone —
   *  omit it and the archive returns immediately with teardown deferred to
   *  a background queue, as before. Omitting all four flags sends no body,
   *  matching the original archive-from-`done` callers unchanged.
   *
   *  `retry: false` only when `awaitTeardown` is set — matching
   *  `createTask`/`sendRunInput`'s idiom above. The route sets an unbounded
   *  server timeout and blocks on the *entire* per-workdir teardown FIFO
   *  (every same-repo teardown queued ahead of this one), which can run well
   *  past WKWebView's own request timeout even though the operation is
   *  succeeding server-side. A default retry on that timeout would silently
   *  re-issue a second, non-idempotent archive against a task the user may
   *  have already resumed (re-running `dropSession`/`killTerminalsForTask`,
   *  re-queuing a second worktree teardown behind the first). The
   *  fire-and-forget archive (no `awaitTeardown`, e.g. the kanban button)
   *  returns fast and keeps the default retry — it isn't the non-idempotent
   *  hazard this guards against. */
  archiveTask: (
    id: string,
    opts?: { force?: boolean; stopRun?: boolean; forceWorktree?: boolean; awaitTeardown?: boolean },
  ) =>
    j<Task & { teardown?: WorktreeTeardownResult }>(`/tasks/${id}/archive`, {
      method: "POST",
      ...(opts?.force || opts?.stopRun || opts?.forceWorktree || opts?.awaitTeardown
        ? {
            body: JSON.stringify({
              force: !!opts.force,
              stopRun: !!opts.stopRun,
              forceWorktree: !!opts.forceWorktree,
              awaitTeardown: !!opts.awaitTeardown,
            }),
          }
        : {}),
    }, opts?.awaitTeardown ? { retry: false } : undefined),
  unarchiveTask: (id: string) => j<Task>(`/tasks/${id}/unarchive`, { method: "POST" }),

  /** Every git worktree materialized on disk under `dataDir/worktrees/`,
   *  cross-referenced against the tasks table. Drives the Worktrees page. */
  listWorktrees: () => j<WorktreeInfo[]>("/worktrees"),
  /** Removes an orphaned worktree directory (no owning task row) — a
   *  task-backed worktree is torn down via `archiveTask(id, { force: true })`
   *  instead, since deleting it destroys the ticket. */
  deleteWorktree: (id: string) => j<void>(`/worktrees/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** On-demand live dirty/ahead/merged status for a single worktree — not part
   *  of the bulk listing above (that stays fs+DB-only to avoid a subprocess
   *  fan-out per poll). Fetched per row by the Worktrees page. */
  getWorktreeGitStatus: (id: string) =>
    j<WorktreeGitStatus>(`/worktrees/${encodeURIComponent(id)}/git-status`),

  // Terminal tabs. State is in-memory on the bun side; the live byte stream
  // runs over the WebSocket whose URL `terminalSocketUrl` builds.
  listTerminals: (taskId: string) => j<TerminalTab[]>(`/tasks/${taskId}/terminals`),
  createTerminal: (taskId: string) =>
    j<TerminalTab>(`/tasks/${taskId}/terminals`, { method: "POST" }),
  closeTerminal: (id: string) => j<void>(`/terminals/${id}`, { method: "DELETE" }),
  /** ws:// URL for a terminal's duplex stream. EventSource-style token in the
   *  query string since WebSockets can't set the Authorization header. */
  terminalSocketUrl: (id: string) =>
    `ws://127.0.0.1:${API_PORT}/terminals/${encodeURIComponent(id)}/ws?token=${encodeURIComponent(API_TOKEN)}`,
  listRuns: (taskId: string, signal?: AbortSignal) => j<Run[]>(`/tasks/${encodeURIComponent(taskId)}/runs`, { signal }),
  /** Backward page of a task's persisted events, older than `beforeId`
   *  (exclusive) — drives the run panel's "Load earlier" affordance once the
   *  bounded SSE replay window (`EVENTS_REPLAY_LIMIT`) has been exhausted.
   *  `beforeId` is required by the route; `limit` defaults server-side to
   *  `EVENTS_REPLAY_LIMIT` when omitted. */
  fetchTaskEventsPage: (taskId: string, beforeId: number, limit?: number) => {
    const q = new URLSearchParams({ beforeId: String(beforeId) });
    if (limit) q.set("limit", String(limit));
    return j<TaskEventsPage>(`/tasks/${taskId}/events/page?${q.toString()}`);
  },
  /** Past sent messages across every task and harness, newest first — backs
   *  `MessageHistoryPicker`'s "insert a past message" dropdown. `taskId` only
   *  selects which task's endpoint is called (and gates 404-on-unknown-task);
   *  it does not scope the returned payload. */
  fetchMessageHistory: (taskId: string, limit?: number) => {
    const q = limit ? `?${new URLSearchParams({ limit: String(limit) }).toString()}` : "";
    return j<{ messages: SentMessageItem[] }>(`/tasks/${taskId}/messages/history${q}`);
  },
  /** Background/sub agents tracked for a task — drives the run panel's
   *  read-only per-subagent tab strip. Polled like `listRuns`; live deltas
   *  also arrive on the task SSE as `stream: "subagent"` events. */
  listSubagents: (taskId: string) => j<Subagent[]>(`/tasks/${taskId}/subagents`),
  /** Everything the task's worktree changed vs its pinned base. Empty `files`
   *  + a `note` when there's no worktree or no diff. */
  getTaskDiff: (taskId: string) => j<TaskDiff>(`/tasks/${taskId}/diff`),
  getTaskGitStatus: (taskId: string) =>
    j<TaskGitStatus>(`/tasks/${taskId}/git-status`),
  /** Which branches deleting the task would remove (`task.branch`, plus the
   *  branch a drifted worktree is actually on), after the default-branch /
   *  PR-head / held-by-another-task exclusions — read before the delete
   *  confirm so the dialog can name them. Read-only. */
  getTaskTeardownPreview: (taskId: string) =>
    j<TaskTeardownPreview>(`/tasks/${encodeURIComponent(taskId)}/teardown-preview`),
  cancelRun: (runId: string) =>
    j<{ cancelled: boolean; termination: import("../../shared/run-termination.ts").RunTermination | null }>(`/runs/${runId}/cancel`, { method: "POST" }),
  // Mirrors the orchestrator's `SendInputResult` (src/bun/orchestrator.ts) —
  // keep the two in sync. `withheld`/`savedToBacklog` are only ever present
  // alongside `delivered: false`: they distinguish "claude is showing a
  // modal, so the message was withheld and re-stashed into the backlog tray"
  // from an ordinary delivery failure (run/task not found, worktree restore
  // failure, …), which carries neither flag.
  sendRunInput: (runId: string, line: string) =>
    // retry: false — a replay would paste a duplicate message into a live
    // agent tmux session.
    j<
      // `unresolvedRefs` = raw `@` tokens the server-side expansion left
      // verbatim. The webview deliberately doesn't render it post-send —
      // PromptComposer's inline warning covers it pre-send.
      // `pending: true` (optional): the server returned before the agent spawn
      // finished; the run row already exists (task-details-blank-while-session-restores.md §3.1).
      | { delivered: true; runId: string; unresolvedRefs?: string[]; pending?: true }
      | { delivered: false; reason: string; withheld?: boolean; savedToBacklog?: boolean }
    >(
      `/runs/${runId}/input`,
      { method: "POST", body: JSON.stringify({ line }) },
      { retry: false },
    ),
  /** Bumps the task's read watermark to its latest assistant event, clearing
   *  `task.unread`. Called on opening/switching/closing the run panel — see
   *  App.tsx's `selected`-tracking effect. Returns the full updated Task so
   *  the caller can reconcile it into board state immediately (optimistic —
   *  don't wait for the next poll). Idempotent; safe to fire-and-forget. */
  markTaskSeen: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/seen`, { method: "POST" }),
  /** Re-flags a task's read watermark as unread — the board's task context
   *  menu's "Mark as unread" entry, restoring `task.unread`'s "New messages"
   *  dot. No-op (server-side) when the task has no assistant messages yet
   *  (`task.hasAssistantMessages` is the client-side gate for showing the
   *  menu entry at all). Returns the full updated Task so the caller can
   *  merge only the `unread` field back into board state, same as
   *  `markTaskSeen`. */
  markTaskUnread: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/seen`, { method: "DELETE" }),

  // Messages backlog — saved, not-yet-sent draft messages parked on a task.
  // Every mutation returns the full updated Task so the caller can re-sync.
  addBacklogItem: (taskId: string, input: { text: string; references?: TaskReference[] }) =>
    j<Task>(`/tasks/${taskId}/backlog`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateBacklogItem: (
    taskId: string,
    itemId: string,
    patch: { text?: string; references?: TaskReference[] },
  ) =>
    j<Task>(`/tasks/${taskId}/backlog/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteBacklogItem: (taskId: string, itemId: string) =>
    j<Task>(`/tasks/${taskId}/backlog/${itemId}`, { method: "DELETE" }),
  /** Replace the backlog order with `order` (item ids, desired sequence). */
  reorderBacklog: (taskId: string, order: string[]) =>
    j<Task>(`/tasks/${taskId}/backlog`, {
      method: "PUT",
      body: JSON.stringify({ order }),
    }),

  // Cursor plans — detected `createPlanToolCall` records on `task.plans`.
  // Every mutation returns the full updated Task so the caller can re-sync.
  /** Persist (or clear, with `null`) unapproved edits to a pending plan.
   *  Rejected (400) once the plan is no longer `pending`. */
  savePlanEdit: (taskId: string, planId: string, editedContent: string | null) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: JSON.stringify({ editedContent }),
    }),
  /** Approve a pending plan: the server writes the effective content
   *  (edited ?? original) to a `.plan.md` file in the task's worktree and
   *  auto-sends an approval message that resumes the agent.
   *  `retry: false` — like `sendRunInput`, a replay would re-send a
   *  duplicate approval message to a live agent session. */
  approvePlan: (taskId: string, planId: string) =>
    j<Task>(`/tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planId)}/approve`, {
      method: "POST",
    }, { retry: false }),

  /** Resume a PAUSED fx model response (Vercel AI Gateway rate-limit
   *  recovery — see `resumeFxRecovery` in orchestrator.ts). Sends no new
   *  prompt; fx continues from its own checkpoint. `retry: false` — like
   *  `approvePlan`, a replay would spawn a second continue-recovery run
   *  against a checkpoint the first request already consumed. Rejected
   *  (400/404/409) via the thrown `ApiError` when the task isn't fx, is
   *  archived, has no resumable paused response, or already has a turn
   *  in flight. */
  resumeFxRecovery: (taskId: string) =>
    j<{ ok: true; runId: string }>(`/tasks/${encodeURIComponent(taskId)}/fx-resume`, {
      method: "POST",
    }, { retry: false }),

  /** Cancel a pending fx auto-resume timer (`task.fxRecovery.autoResume`)
   *  without touching the pause itself — the paused response stays paused,
   *  resumable only via a manual `resumeFxRecovery` from here on. `retry:
   *  false` — like `resumeFxRecovery`, a replay against an already-cancelled
   *  (or already-fired) timer should surface as a real 400/404, not be
   *  silently retried. */
  cancelFxAutoResume: (taskId: string) =>
    j<{ ok: true }>(`/tasks/${encodeURIComponent(taskId)}/fx-auto-resume`, {
      method: "DELETE",
    }, { retry: false }),

  // Composer draft — the single unsent text+refs autosaved from the task
  // details modal. Every mutation returns the full updated Task.
  setTaskDraft: (taskId: string, draft: { text: string; references: TaskReference[] }) =>
    j<Task>(`/tasks/${taskId}/draft`, {
      method: "PUT",
      body: JSON.stringify(draft),
    }),
  clearTaskDraft: (taskId: string) =>
    j<Task>(`/tasks/${taskId}/draft`, { method: "DELETE" }),
  /**
   * Open a file or directory with the OS default app. `path` may be absolute
   * or, when `taskId` is supplied, relative to the task's cwd
   * (worktreePath ?? workdir).
   */
  openPath: (input: { path: string; taskId?: string }) =>
    j<{ opened: boolean; path: string }>(`/open-path`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * Reveal a file or directory in the Finder (`open -R`), same abs-or-
   * task-relative + existsSync contract as `openPath`. macOS-only — the
   * `POST /reveal-path` route (landing alongside this in the same branch)
   * answers 501 under the headless backend, same as `/open-path`.
   */
  revealPath: (input: { path: string; taskId?: string }) =>
    j<{ revealed: boolean; path: string }>(`/reveal-path`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * Open an http(s) or mailto URL in the OS default browser. The webview is
   * sandboxed; `target="_blank"` does nothing, so anchor clicks need to
   * round-trip through the Bun main process to reach `Utils.openExternal`.
   */
  openExternal: (url: string) =>
    j<{ opened: boolean; url: string }>(`/open-external`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  /**
   * Open the claude-code task's tmux session in a new Terminal.app window.
   * Returns the session name on success. Server-side checks the session is
   * actually live and that the task uses a claude-code harness.
   */
  openTmux: (taskId: string) =>
    j<{ ok: true; sessionName: string }>(`/tasks/${taskId}/open-tmux`, {
      method: "POST",
    }),

  /** Absolute URL for an inline `<img>` thumbnail of a referenced image path.
   *  `<img>` can't set an Authorization header any more than EventSource can,
   *  so the token rides along as a query param exactly like
   *  `subscribeRun`/`subscribeTask`'s `?token=`. `GET /files/preview`
   *  responds 401 with a missing/bad token, 400 for a non-absolute or
   *  non-image path, 404 when the path doesn't exist (or isn't a regular
   *  file), and 200 with the raw image bytes otherwise; callers handle the
   *  error cases via the `<img>` element's own `onError`. */
  filePreviewUrl: (path: string): string =>
    `${BASE}/files/preview?path=${encodeURIComponent(path)}&token=${encodeURIComponent(API_TOKEN)}`,

  /** Absolute URL for a task's worktree-diff binary blob (old or new side of
   *  a binary file), for `<img src>` use in `BinaryFilePreview`. Same
   *  `?token=` pattern as `filePreviewUrl` — `<img>` can't set an
   *  `Authorization` header. Backed by `GET /tasks/:id/diff/blob`, which
   *  resolves `side: "old"` via `git show <baseRef>:<path>` and `side:
   *  "new"` from the on-disk file in the task's cwd (worktree or workdir),
   *  mirroring what `getTaskDiff`'s underlying `git diff` compared. */
  taskDiffBlobUrl: (taskId: string, path: string, side: "old" | "new"): string =>
    `${BASE}/tasks/${taskId}/diff/blob?path=${encodeURIComponent(path)}&side=${side}&token=${encodeURIComponent(API_TOKEN)}`,

  /** Absolute URL for a GitHub PR's binary blob (old or new side), for
   *  `<img src>` use in `BinaryFilePreview`. Identifying params mirror
   *  `getGitHubPullDiff` (`path`, `number`) exactly, plus the blob-specific
   *  `filePath` (repo-relative file path — carried as a distinct param name
   *  from `path`, which is the local repo dir used to resolve the GitHub
   *  remote) and `side`. Backed by `GET /github/pull-blob`: the old side
   *  anchors at the PR's merge base (the `.diff` shown is a three-dot
   *  diff), the new side at the PR head sha. */
  pullBlobUrl: (opts: { path: string; number: number; filePath: string; side: "old" | "new" }): string => {
    const q = new URLSearchParams({
      path: opts.path,
      number: String(opts.number),
      filePath: opts.filePath,
      side: opts.side,
      token: API_TOKEN,
    });
    return `${BASE}/github/pull-blob?${q.toString()}`;
  },

  /** Fetch binary blob bytes via an `Authorization: Bearer` header — used
   *  for PDF panes, which go through `fetch`/pdf.js rather than an `<img>`
   *  tag. This function always authenticates via the header, same as every
   *  other `api.*` call; it doesn't rely on (or care about) a `?token=` in
   *  `url` even though `url` is typically one of `taskDiffBlobUrl`'s /
   *  `pullBlobUrl`'s outputs, which DO append one — those builders are
   *  shared with `<img src>` consumers, which can't set headers at all, so
   *  their URLs carry a token unconditionally. Throws an `Error` whose
   *  message distinguishes a missing blob ("missing", 404) from one over
   *  the server's size cap ("too-large", 413) from any other failure, so
   *  callers can render a matching empty state. */
  fetchBlobBytes: async (url: string): Promise<ArrayBuffer> => {
    const res = await fetch(url, {
      headers: { "authorization": `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error("missing");
      if (res.status === 413) throw new Error("too-large");
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return res.arrayBuffer();
  },
  /** Lightweight status probe for a blob URL, used to classify an `<img>`
   *  `onError` (SF-10) without downloading the — possibly large — body the
   *  way `fetchBlobBytes` does: the response is read only for its status,
   *  then its body is cancelled unread. Same three-way classification as
   *  `fetchBlobBytes`, as a return value instead of a thrown error since
   *  this is a best-effort classification, not a load path a caller awaits
   *  before rendering. */
  probeBlobStatus: async (url: string): Promise<"missing" | "too-large" | "ok" | "error"> => {
    try {
      const res = await fetch(url, { headers: { "authorization": `Bearer ${API_TOKEN}` } });
      void res.body?.cancel();
      if (res.status === 404) return "missing";
      if (res.status === 413) return "too-large";
      return res.ok ? "ok" : "error";
    } catch {
      return "error";
    }
  },

  /** Persist an in-memory image (clipboard paste or macOS floating-thumbnail
   *  drag) to disk and get back its absolute path. Bypasses `j()` because the
   *  body is raw bytes, not JSON. */
  uploadScreenshot: async (blob: Blob): Promise<{ path: string; basename: string }> => {
    const res = await fetch(`${BASE}/screenshots`, {
      method: "POST",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        "authorization": `Bearer ${API_TOKEN}`,
      },
      body: blob,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body && typeof body === "object" && "error" in body && body.error
        ? String((body as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return body as { path: string; basename: string };
  },

  /** Byte-copy fallback for a path-less non-image file (dropped or pasted)
   *  that has no recoverable original path — the server writes the raw bytes
   *  to `dataDir/attachments/` and returns the on-disk path. Bypasses `j()`
   *  because the body is raw bytes, not JSON; same shape as
   *  `uploadScreenshot`. */
  uploadAttachment: async (blob: Blob, name: string): Promise<{ path: string; basename: string }> => {
    const res = await fetch(`${BASE}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "content-type": blob.type || "application/octet-stream",
        "authorization": `Bearer ${API_TOKEN}`,
      },
      body: blob,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body && typeof body === "object" && "error" in body && body.error
        ? String((body as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return body as { path: string; basename: string };
  },

  /** Answer claude's AskUserQuestion (scraper-sourced). One entry per
   *  question in the original tool input, in the same order.
   *
   *  Mirrors `sendRunInput`'s shape for the custom/free-text answer path —
   *  that's the only branch capable of a withhold (dismissing the modal then
   *  delivering the answer as a follow-up turn via `sendInput`; the
   *  drive-a-numbered-modal path types keys straight into the open modal, no
   *  paste to withhold). `withheld`/`savedToBacklog`/`reason` are only ever
   *  present alongside `ok: false`, and only for that free-text path — see
   *  `/ask-questions/:id/answer` in server.ts. A request for a card that
   *  another request is still answering is refused 409 (thrown as `ApiError`). */
  answerAskQuestions: (id: string, body: { answers: Array<{ selected: string[]; custom?: string }> }) =>
    j<{
      ok: boolean;
      withheld?: boolean;
      savedToBacklog?: boolean;
      reason?: string;
      /** Which path delivered (or attempted) the answer: `"drive"` typed it into
       *  the live modal, `"message"` dismissed the modal and sent a follow-up. */
      delivery?: "drive" | "message";
    }>(
      `/ask-questions/${id}/answer`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  /** Answer a tmux-pane-scraped REPL prompt. `key` must be one of the
   *  keys advertised on the request — the server validates against the
   *  recorded set before injecting keystrokes via `tmux send-keys`. */
  answerTmuxPrompt: (id: string, body: { key: string } | { reject: true }) =>
    j<{ ok: boolean }>(`/tmux-prompts/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Answer an fx ACP permission request. `{ optionId }` must be one of the
   *  option ids the request advertised — the server validates against the
   *  recorded set before echoing it back into the ACP RPC reply.
   *  `{ cancel: true }` is the Stop/delete path. */
  answerFxPermission: (id: string, body: { optionId: string } | { cancel: true }) =>
    j<{ ok: boolean }>(`/fx-permissions/${id}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listPendingInteractions: (taskId: string) =>
    j<PendingInteraction[]>(`/tasks/${taskId}/interactions/pending`),
  /** Re-parse a run's events from claude's on-disk JSONL session
   *  transcript. Use when the persisted `run_events` rows pre-date the
   *  structured-event refactor (the legacy mapper truncated tool inputs
   *  at 500 chars, so the in-DB copy is missing the tail bytes). Returns
   *  an empty list + `reason` when the JSONL is gone or the run had no
   *  claude session id (e.g. codex runs).
   *
   *  `limit`, when passed, bounds the rebuild to the most recent `limit`
   *  mapped events (ascending) and the response carries `hasMore` — so an
   *  automatic/background rebuild doesn't silently replace the panel's
   *  bounded live window with an unbounded full-history dump. Omitted
   *  (the manual "Rebuild from session JSONL" button's case), the server
   *  returns the legacy full array with no `hasMore` field. */
  rebuildRunEvents: (runId: string, limit?: number) =>
    j<{ events: RunEvent[]; hasMore?: boolean; source?: string; reason?: string }>(
      `/runs/${runId}/rebuild-events${limit ? `?limit=${limit}` : ""}`,
    ),

  /** Fire a native macOS notification via the Bun process. Fire-and-forget
   *  — the OS handles display. When `taskId` is provided, the Bun side
   *  encodes it into an `agetor://task/<id>` deep-link so clicking the
   *  notification opens straight to that task, not just app focus. */
  notifyOS: (input: {
    title: string;
    body?: string;
    subtitle?: string;
    silent?: boolean;
    taskId?: string;
  }) =>
    j<{ ok: boolean }>("/notifications", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** App-wide lifecycle event stream. Live-only (no replay) — subscribers
   *  see events from the moment they connect. Used by the toast hook in
   *  App.tsx to surface success / error / pending-input across every task
   *  without subscribing per-task. */
  subscribeGlobalEvents(onEvent: (e: GlobalEvent) => void): () => void {
    const es = new EventSource(`${BASE}/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as GlobalEvent);
      } catch { /* ignore */ }
    };
    // Logged so a future debug session has a breadcrumb when toasts stop
    // arriving (typically: stale token, backend restart). EventSource
    // auto-reconnects, so this is informational — no UI surfacing.
    es.onerror = (e) => { console.warn("[agetor] global events stream error", e); };
    return () => es.close();
  },

  /** App-level event stream — carries `quit_request` (the main process
   *  sends it when the user hits Cmd+Q while runs are active), `open_task`
   *  (a native-notification deep-link click), `harness_usage` (a fresh
   *  usage/quota snapshot from the background poller or a force-refresh —
   *  see `getAllUsage`/`refreshHarnessUsage`), and `agent_models_changed`
   *  (the model-discovery scheduler re-probed one or more harnesses and at
   *  least one catalog changed — refetch `listAgentModels`/
   *  `listHarnessModels`). No type whitelist here: every `AppEvent` variant
   *  is forwarded to `onEvent` as-is, so a new variant needs no change in
   *  this function. Live-only (no replay). */
  /** `onOpen` fires on the first connect and on every automatic reconnect,
   *  so a caller can re-read state whose events may have been missed. */
  subscribeAppEvents(onEvent: (e: AppEvent) => void, onOpen?: () => void, onDisconnect?: () => void): () => void {
    const es = new EventSource(`${BASE}/app/events?token=${encodeURIComponent(API_TOKEN)}`);
    if (onOpen) es.onopen = () => onOpen();
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as AppEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { onDisconnect?.(); console.warn("[agetor] app events stream error", e); };
    return () => es.close();
  },

  /** Tell the main process to quit despite running tasks. Used by the
   *  QuitConfirmDialog after the user picks "Quit anyway". Fire-and-forget
   *  — the response races process exit. */
  forceQuit: () => j<{ ok: boolean }>("/app/force-quit", { method: "POST" }),

  subscribeRun(runId: string, onEvent: (e: RunEvent) => void): () => void {
    // EventSource can't set headers, so the server also accepts the token via query.
    const es = new EventSource(`${BASE}/runs/${runId}/events?token=${encodeURIComponent(API_TOKEN)}`);
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as RunEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { console.warn("[agetor] run events stream error", runId, e); };
    return () => es.close();
  },
  /** Unified task-level event stream: every run's events, merged in id
   *  order. Replaces per-run subscriptions for the run panel so the user
   *  sees the whole conversation as one scrollback.
   *
   *  `onReplayMeta`, when supplied, receives the named `replay_meta` frame the
   *  server sends as the FIRST frame of every (re)connect — the bounded
   *  replay window's earliest event id and whether older history exists
   *  (drives the run panel's "Load earlier" button). It's a *named* SSE
   *  event (`event: replay_meta`), invisible to `onmessage`, so registering
   *  the listener only when a caller asks for it costs nothing for callers
   *  that don't care. */
  subscribeTask(
    taskId: string,
    onEvent: (e: RunEvent) => void,
    onReplayMeta?: (meta: TaskEventsReplayMeta) => void,
  ): () => void {
    const es = new EventSource(`${BASE}/tasks/${taskId}/events?token=${encodeURIComponent(API_TOKEN)}`);
    if (onReplayMeta) {
      es.addEventListener(TASK_EVENTS_REPLAY_META_EVENT, (m: MessageEvent) => {
        try {
          onReplayMeta(JSON.parse(m.data) as TaskEventsReplayMeta);
        } catch { /* ignore malformed */ }
      });
    }
    es.onmessage = (m) => {
      try {
        const parsed = JSON.parse(m.data);
        if (parsed.type === "ping") return;
        onEvent(parsed as RunEvent);
      } catch { /* ignore */ }
    };
    es.onerror = (e) => { console.warn("[agetor] task events stream error", taskId, e); };
    return () => es.close();
  },

  // ── Backup & Recovery (FO-P2-004) ────────────────────────────────────────
  // Non-idempotent calls opt out of the transport retry: re-issuing a create,
  // restore or cancel after a dropped response could start a second operation.
  backupProfile: () => j<BackupProfileInfo>("/backup/profile"),
  pickBackupDestination: (purpose: BackupPickPurpose) =>
    j<{ path?: string; grantId?: string; cancelled?: boolean }>(
      "/backup/destinations/pick",
      { method: "POST", body: JSON.stringify({ purpose }) },
      { retry: false },
    ),
  createBackup: (grantId: string) =>
    j<{ operation: BackupOperationView }>(
      "/backup/create",
      { method: "POST", body: JSON.stringify({ grantId }) },
      { retry: false },
    ),
  verifyBackup: (snapshotPath: string) =>
    j<{ operation: BackupOperationView }>(
      "/backup/verify",
      { method: "POST", body: JSON.stringify({ snapshotPath }) },
      { retry: false },
    ),
  inspectBackup: (snapshotPath: string) =>
    j<{ snapshot: BackupSnapshotSummary }>("/backup/inspect", {
      method: "POST",
      body: JSON.stringify({ snapshotPath }),
    }),
  previewBackupRestore: (snapshotPath: string, verificationId?: string) =>
    j<BackupRestorePreview>("/backup/restore/preview", {
      method: "POST",
      body: JSON.stringify({ snapshotPath, verificationId }),
    }),
  restoreBackup: (input: {
    snapshotPath: string;
    grantId?: string;
    verificationId: string;
    destinationName?: string;
    managed?: boolean;
  }) =>
    j<{ operation: BackupOperationView }>(
      "/backup/restore",
      { method: "POST", body: JSON.stringify(input) },
      { retry: false },
    ),
  selectSnapshot: (path: string) =>
    j<{ path: string; cancelled: boolean }>(
      "/backup/snapshots/select",
      { method: "POST", body: JSON.stringify({ path }) },
      { retry: false },
    ),
  backupHistory: () => j<BackupHistoryResponse>("/backup/history"),
  addBackupLocation: (grantId: string) =>
    j<{ locations: string[] }>(
      "/backup/history/locations",
      { method: "POST", body: JSON.stringify({ grantId }) },
      { retry: false },
    ),
  backupOperations: () => j<{ operations: BackupOperationView[] }>("/backup/operations"),
  backupOperation: (operationId: string) =>
    j<{ operation: BackupOperationView }>(`/backup/operations/${encodeURIComponent(operationId)}`),
  cancelBackupOperation: (operationId: string) =>
    j<{ operation: BackupOperationView; cancellation: unknown }>(
      `/backup/operations/${encodeURIComponent(operationId)}/cancel`,
      { method: "POST", body: "{}" },
      { retry: false },
    ),

  profileActivationStatus: () => j<ProfileActivationStatusResponse>("/profile/activation"),
  inspectProfileActivationCandidate: (candidatePath: string) =>
    j<ProfileActivationCandidateResponse>("/profile/activation/candidate/inspect", {
      method: "POST",
      body: JSON.stringify({ candidatePath }),
    }),
  relinkCandidateProject: (candidatePath: string, oldPath: string, newPath: string) =>
    j<ProfileActivationRelinkResponse>("/profile/activation/candidate/relink", {
      method: "POST",
      body: JSON.stringify({ candidatePath, oldPath, newPath }),
    }),
  prepareProfileActivation: (candidatePath: string) =>
    j<ProfileActivationPrepareResponse>("/profile/activation/prepare", {
      method: "POST",
      body: JSON.stringify({ candidatePath, confirm: true }),
    }),
  prepareProfileRollback: () =>
    j<ProfileActivationPrepareResponse>("/profile/activation/rollback/prepare", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),
  relaunchForProfileTransition: () =>
    j<ProfileActivationRelaunchResponse>("/profile/activation/relaunch", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    }),
};

export interface ManagerTurn {
  id: string;
  projectPath: string;
  messageId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

export interface InterviewTurnInput {
  interviewId: string;
  harness: string;
  model: string;
  effort: string | null;
  fast?: boolean;
  maxMode?: boolean;
  request: InterviewRequest;
  project: {
    path: string;
    name: string;
    description: string;
    mode: "create" | "import";
    empty: boolean;
    stack: string;
    signals: string[];
    gitBranch: string | null;
    readmePath: string | null;
    ideaPath: string | null;
    prdPath: string | null;
    targets: { idea: string | null; prd: string | null };
  };
  messages: InterviewMessage[];
  drafts: InterviewDrafts;
  /** The `consentKey` of the isolation summary the user confirmed. */
  consent: string | null;
}

export type InterviewTurnResult =
  | { kind: "question"; reply: QuestionReply }
  | { kind: "drafts"; reply: DraftsReply }
  | { kind: "section"; reply: SectionReply };

export interface InterviewTurn {
  id: string;
  interviewId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  result: InterviewTurnResult | null;
  error: string | null;
  startedAt: number;
  settledAt: number | null;
}

export interface DocTargetCheck {
  kind: DocKind;
  path: string;
  state: "free" | "exists" | "invalid" | "outside";
  absolute: string | null;
  error: string | null;
}

export interface DocWriteResult {
  kind: DocKind;
  path: string;
  status: "created" | "failed";
  absolute: string | null;
  error: string | null;
}
