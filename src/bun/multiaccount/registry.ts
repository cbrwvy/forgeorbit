/** FO-MULTIACCOUNT02. Builds execution profiles from AccountCore without reading credentials. */
import type { Database } from "bun:sqlite";
import { AccountCore } from "../account-core.ts";
import { activeProviderRefusalsForHarness } from "../provider-refusals.ts";
import { cachedCodexAuthentication, isCodexProfile } from "../codex-profiles.ts";
import { cachedClaudeAuthentication, isClaudeProfile } from "../claude-profiles.ts";
import { db, harnesses } from "../db.ts";
import { AccountCoreError } from "../account-core.ts";
import { AGENT_OPTIONS, type AgentKind } from "../../shared/types.ts";
import {
  EMPTY_EXECUTION_META,
  claudeLimitations,
  codexLimitations,
  subjectLabel,
  type AccountAnswerSnapshot,
  type AccountAttribution,
  type ExecutionMeta,
  type ExecutionModelEligibility,
  type ExecutionProfile,
  type ExecutionQuotaEvidence,
  type ProfileAuthentication,
  type ProjectAccountPreference,
} from "../../shared/accounts/execution-profile.ts";

const ACTIVE = "('reserved','starting','running','awaiting_qc','qc_running')";

function parseMeta(raw: string | null): ExecutionMeta {
  if (!raw) return { ...EMPTY_EXECUTION_META, models: [] };
  try {
    const value = JSON.parse(raw) as Partial<ExecutionMeta>;
    return {
      disabled: value.disabled === true,
      concurrencyLimit: integerLimit(value.concurrencyLimit),
      providerSharedLimit: integerLimit(value.providerSharedLimit),
      models: Array.isArray(value.models) ? value.models.filter(isModel) : [],
      configuredIdentity: typeof value.configuredIdentity === "string" ? value.configuredIdentity : null,
      lastVerifiedAt: typeof value.lastVerifiedAt === "number" ? value.lastVerifiedAt : null,
      lastAuthentication: isAuth(value.lastAuthentication) ? value.lastAuthentication : "unknown",
    };
  } catch {
    return { ...EMPTY_EXECUTION_META, models: [] };
  }
}

function integerLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 32 ? value : null;
}
function isAuth(value: unknown): value is ProfileAuthentication {
  return value === "unknown" || value === "authenticated" || value === "required" || value === "unavailable";
}
function isModel(value: unknown): value is ExecutionModelEligibility {
  if (!value || typeof value !== "object") return false;
  const row = value as ExecutionModelEligibility;
  return typeof row.id === "string" && (row.eligibility === "declared" || row.eligibility === "verified" || row.eligibility === "unknown") && Array.isArray(row.modes);
}

export function readExecutionMeta(database: Database, accountId: string): ExecutionMeta {
  const row = database.query<{ data: string }, [string]>("SELECT data FROM account_execution_meta WHERE account_id = ?").get(accountId);
  return parseMeta(row?.data ?? null);
}

export function writeExecutionMeta(database: Database, accountId: string, patch: unknown): ExecutionMeta {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new AccountCoreError("Invalid execution metadata.");
  const value = patch as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["disabled", "concurrencyLimit", "providerSharedLimit", "models", "configuredIdentity"].includes(key))) {
    throw new AccountCoreError("Execution metadata cannot store secrets, verified subjects, or authentication material.");
  }
  const current = readExecutionMeta(database, accountId);
  const next: ExecutionMeta = { ...current, models: current.models };
  if (value.disabled !== undefined) {
    next.disabled = value.disabled === true;
    const account = new AccountCore(database).getAccount(accountId);
    const harnessId = account.codexProfile?.harnessId ?? account.claudeProfile?.harnessId;
    if (harnessId) database.run("UPDATE harnesses SET enabled = ? WHERE id = ?", [next.disabled ? 0 : 1, harnessId]);
  }
  if (value.concurrencyLimit !== undefined) next.concurrencyLimit = value.concurrencyLimit == null ? null : integerLimit(value.concurrencyLimit) ?? (() => { throw new AccountCoreError("Invalid concurrency limit."); })();
  if (value.providerSharedLimit !== undefined) next.providerSharedLimit = value.providerSharedLimit == null ? null : integerLimit(value.providerSharedLimit) ?? (() => { throw new AccountCoreError("Invalid provider concurrency limit."); })();
  if (value.configuredIdentity !== undefined) {
    if (value.configuredIdentity == null) next.configuredIdentity = null;
    else if (typeof value.configuredIdentity !== "string" || value.configuredIdentity.length > 160 || /(?:Bearer\s|sk-|access_token|session_cookie)/i.test(value.configuredIdentity)) throw new AccountCoreError("Invalid configured identity.");
    else next.configuredIdentity = value.configuredIdentity.trim();
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length > 50 || value.models.some((row) => !isModel(row))) throw new AccountCoreError("Invalid model eligibility.");
    next.models = value.models as ExecutionModelEligibility[];
  }
  database.run(
    "INSERT INTO account_execution_meta(account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data",
    [accountId, JSON.stringify(next)],
  );
  return next;
}

export function noteAuthenticationCheck(database: Database, accountId: string, authentication: ProfileAuthentication, at: number): void {
  const current = readExecutionMeta(database, accountId);
  const next = { ...current, lastAuthentication: authentication, lastVerifiedAt: at };
  database.run(
    "INSERT INTO account_execution_meta(account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data",
    [accountId, JSON.stringify(next)],
  );
}

export function listProjectAccountPreferences(database: Database): ProjectAccountPreference[] {
  return database.query<{ project_path: string; role: string; account_id: string; updated_at: number }, []>(
    "SELECT project_path, role, account_id, updated_at FROM project_account_preferences ORDER BY project_path, role",
  ).all().map((row) => ({ projectPath: row.project_path, role: row.role, accountId: row.account_id, updatedAt: row.updated_at }));
}

export function setProjectAccountPreference(database: Database, input: { projectPath: string; role: string; accountId: string | null }, now = Date.now()): ProjectAccountPreference | null {
  const projectPath = input.projectPath.trim();
  const role = input.role.trim().toLowerCase();
  if (!projectPath || projectPath.length > 1024 || !role || role.length > 40) throw new AccountCoreError("Invalid project preference.");
  if (input.accountId == null) {
    database.run("DELETE FROM project_account_preferences WHERE project_path = ? AND role = ?", [projectPath, role]);
    return null;
  }
  const core = new AccountCore(database, () => now);
  const account = core.listAccounts().find((row) => row.id === input.accountId);
  if (!account) throw new AccountCoreError("Account profile not found.", 404);
  database.run(
    `INSERT INTO project_account_preferences(project_path, role, account_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_path, role) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`,
    [projectPath, role, account.id, now],
  );
  return { projectPath, role, accountId: account.id, updatedAt: now };
}

function quotaFor(core: AccountCore, accountId: string): ExecutionQuotaEvidence {
  let verified: ExecutionQuotaEvidence | null = null;
  let observed = false;
  for (const state of core.currentQuotas(accountId)) {
    const current = state.status === "current" ? state.current : null;
    if (!current) continue;
    if (current.verification === "verified" && typeof current.remaining === "number") {
      verified = { status: "verified", remaining: current.remaining, unit: state.definition.unit.kind };
    } else observed = true;
  }
  if (verified) return verified;
  if (observed) return { status: "observed", remaining: null, unit: null };
  return { status: "unknown", remaining: null, unit: null };
}

function declaredModels(kind: string, allow: ExecutionModelEligibility[]): ExecutionModelEligibility[] {
  if (allow.length > 0) return allow;
  const options = AGENT_OPTIONS[kind as AgentKind];
  if (!options) return [];
  const modes = options.modes.map((mode) => mode.id);
  return options.models.filter((model) => !model.catalogOnly).map((model) => ({ id: model.id, eligibility: "unknown" as const, modes }));
}

export function listExecutionProfiles(database: Database = db, now = Date.now()): ExecutionProfile[] {
  const core = new AccountCore(database, () => now);
  const profiles: ExecutionProfile[] = [];
  for (const account of core.listAccounts()) {
    const meta = readExecutionMeta(database, account.id);
    const codex = account.codexProfile;
    const claude = account.claudeProfile;
    if (!codex && !claude) continue;
    const harnessId = codex?.harnessId ?? claude!.harnessId;
    const harness = harnesses.get(harnessId);
    const kind = codex ? "codex" as const : "claude" as const;
    const liveAuth: ProfileAuthentication = codex && harness && isCodexProfile(harness)
      ? cachedCodexAuthentication(harness, now)
      : claude && harness && isClaudeProfile(harness)
        ? cachedClaudeAuthentication(harness.id, claude, now)
        : "unknown";
    const blockers: string[] = [];
    if (meta.disabled || harness?.enabled === false) blockers.push("Profile is disabled. New launches are blocked.");
    if (!harness) blockers.push("Execution resource is missing. No ambient account was substituted.");
    if (claude && !claude.homeAccessAccepted) blockers.push("Owner has not accepted the Claude HOME-access disclosure.");
    if (liveAuth === "required") blockers.push("Authentication is required for this profile.");
    if (liveAuth === "unavailable") blockers.push("Authentication check did not succeed.");
    const pathOk = Boolean(harness && (codex ? harness.env.CODEX_HOME === codex.directory : harness.env.CLAUDE_CONFIG_DIR === claude?.directory));
    if (!pathOk) blockers.push("The stored directory does not match the execution resource.");
    const executionReady = blockers.length === 0 && liveAuth === "authenticated";
    const models = declaredModels(harness?.kind ?? (codex ? "codex" : "claude-code"), meta.models);
    profiles.push({
      accountId: account.id,
      provider: account.provider,
      displayName: account.displayName,
      kind,
      support: codex ? "supported" : "partial",
      authProfile: {
        mechanism: codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR",
        path: codex?.directory ?? claude?.directory ?? null,
        directoryIdentity: codex?.directoryIdentity ?? claude?.directoryIdentity ?? null,
      },
      configuredIdentity: meta.configuredIdentity,
      verifiedSubject: null,
      subjectLabel: subjectLabel(meta.configuredIdentity),
      authentication: liveAuth,
      lastAuthentication: meta.lastAuthentication,
      lastVerifiedAt: meta.lastVerifiedAt,
      models,
      modes: [...new Set(models.flatMap((model) => model.modes))],
      readiness: blockers.length ? "blocked" : liveAuth === "authenticated" ? "ready" : "unchecked",
      blockers,
      limitations: codex ? codexLimitations() : claudeLimitations(),
      quota: quotaFor(core, account.id),
      concurrencyLimit: meta.concurrencyLimit,
      providerSharedLimit: meta.providerSharedLimit,
      disabled: meta.disabled,
      executionReady,
      harnessId,
      homeAccessAccepted: claude ? claude.homeAccessAccepted : null,
      providerRefusal: activeProviderRefusalsForHarness(harnessId)[0] ?? null,
    });
  }
  return profiles.sort((a, b) => a.provider.localeCompare(b.provider) || a.displayName.localeCompare(b.displayName));
}

export function activeMissionUsesAccount(database: Database, accountId: string): boolean {
  const row = database.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM orchestration_reservations WHERE account_id = ? AND status IN ${ACTIVE}`,
  ).get(accountId);
  return (row?.n ?? 0) > 0;
}

export function loadAccountAnswerSnapshot(database: Database = db): AccountAnswerSnapshot {
  const profiles = listExecutionProfiles(database);
  const names = new Map(profiles.map((profile) => [profile.accountId, profile.displayName]));
  const attributions: AccountAttribution[] = [];
  const reservations = database.query<{ task_id: string; account_id: string | null; model_id: string; harness_id: string }, []>(
    "SELECT task_id, account_id, model_id, harness_id FROM orchestration_reservations ORDER BY updated_at DESC LIMIT 40",
  ).all();
  for (const row of reservations) {
    attributions.push({
      taskId: row.task_id,
      accountId: row.account_id,
      displayName: row.account_id ? names.get(row.account_id) ?? null : null,
      modelId: row.model_id,
      provider: null,
    });
  }
  const events = database.query<{ task_id: string; data: string }, []>(
    `SELECT r.task_id, e.data FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE e.stream = 'status' AND e.data LIKE '%"kind":"execution-identity"%'
     ORDER BY e.id DESC LIMIT 40`,
  ).all();
  for (const event of events) {
    try {
      const parsed = JSON.parse(event.data) as { accountProfile?: { id?: string; displayName?: string } | null; model?: string | null; provider?: string };
      const accountId = parsed.accountProfile?.id ?? null;
      if (attributions.some((row) => row.taskId === event.task_id && row.accountId === accountId)) continue;
      attributions.push({
        taskId: event.task_id,
        accountId,
        displayName: parsed.accountProfile?.displayName ?? (accountId ? names.get(accountId) ?? null : null),
        modelId: parsed.model ?? null,
        provider: parsed.provider ?? null,
      });
    } catch { /* ignore a malformed historical status line */ }
  }
  return { profiles, preferences: listProjectAccountPreferences(database), attributions };
}
