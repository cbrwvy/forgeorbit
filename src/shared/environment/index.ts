/**
 * Pure environment-manager vocabulary. Safe to import from either process.
 * The runtime lives in `src/bun/environment`.
 */

export {
  COMPOSE_LABEL_CONFIG,
  COMPOSE_LABEL_PROJECT,
  COMPOSE_LABEL_SERVICE,
  COMPOSE_LABEL_WORKDIR,
  FO_LABEL_MANAGED,
  FO_LABEL_PROFILE,
  FO_LABEL_TOKEN,
  classifyComposeProject,
  composeStartDecision,
  composeStopPermitted,
  containersStopped,
  splitConfigFiles,
  stripTrailingSlash,
} from "./compose-ownership.ts";
export type { ComposeClassification, ComposeContainerSnapshot, ComposeExpectation, ComposeStartDecision } from "./compose-ownership.ts";

export {
  PROCESS_GROUP_HELPER,
  argvUsesShellCommandFlag,
  commandProvesToken,
  commandRejection,
  directArgv,
  executableBasename,
  processGroupArgv,
} from "./command.ts";

export { assertLoopbackHost, isAllowedHealthHost, parseLoopbackHttpUrl } from "./health-policy.ts";
export type { HttpTarget } from "./health-policy.ts";

export {
  COMPOSE_PROJECT_PATTERN,
  DEFAULT_HTTP_OK_STATUSES,
  ENV_LIMITS,
  ENV_NAME_PATTERN,
  PROFILE_ID_PATTERN,
  RESERVED_ENV_NAMES,
  SERVICE_NAME_PATTERN,
  isLexicalInside,
  isSafeRelativeFile,
  validateLaunchProfile,
} from "./profile.ts";
export type { ProfileValidation, ValidationIssue } from "./profile.ts";

export { ENVIRONMENT_TRANSITIONS, canTransition, transitionRefusal } from "./state.ts";
export type { TransitionContext } from "./state.ts";

export {
  ENVIRONMENT_PHASES,
  URL_ROLES,
} from "./types.ts";
export type {
  ComposeOwnershipRecord,
  DockerComposeLaunch,
  EnvBinding,
  EnvErrorCode,
  EnvironmentKind,
  EnvironmentLogs,
  EnvironmentOperationResult,
  EnvironmentPhase,
  EnvironmentStatus,
  EnvironmentUrl,
  HealthCheck,
  HealthOutcome,
  LaunchProfile,
  LaunchSpec,
  LocalProcessLaunch,
  LogLine,
  ObservedRuntime,
  OwnershipClass,
  OwnershipRecord,
  PortExpectation,
  ProcessOwnershipRecord,
  RuntimeRecord,
  StopStrategy,
  StoredEnvironment,
  StructuredCommand,
  UrlAvailability,
  UrlAvailabilityStatus,
  UrlRole,
} from "./types.ts";

export { urlAvailability } from "./urls.ts";

export {
  DISPLAY_PHASES,
  PHASE_LABELS,
  blockingReason,
  defaultComposeProjectName,
  displayPhase,
  draftFromProfile,
  emptyDraft,
  environmentActions,
  literalEnvRejection,
  logMentionsService,
  openableLoopbackUrl,
  ownershipLabel,
  profileFromDraft,
  redactEnvironmentText,
  restoreRedactedEnv,
  selectDisplayedProfile,
  splitArgLines,
  splitServiceNames,
  toPublicProfile,
  websiteUrl,
} from "./present.ts";
export type {
  ComposeSuggestion,
  DisplayPhase,
  EnvironmentActions,
  EnvironmentCommandResult,
  EnvironmentIndex,
  EnvironmentProfileView,
  ProfileDraft,
  PublicEnvBinding,
  PublicLaunchProfile,
} from "./present.ts";
