import { readOnlyReviewerContract } from "../../shared/qc-recovery.ts";
/**
 * FO-ROUTING04: AI Router 2.0 — Router Service
 *
 * Coordinates candidate gathering, policy loading, execution history queries,
 * quota resolution, evaluation, plan building, approval, and application.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { AGENT_OPTIONS, type AgentKind, type Harness, type Task } from "../../shared/types.ts";
import {
  type DimensionScore,
  type MultiProjectAllocationPlan,
  type PolicyWeights,
  type ProjectRouterPolicyConfig,
  type RouterAutonomyMode,
  type RouterConstraints,
  type RouterPolicyPreset,
  type RouterQuotaPolicy,
  type RouterRole,
  type RoutingDecisionRecord,
  type TaskRequirementsInput,
  DEFAULT_PRESET_WEIGHTS,
  DEFAULT_ROUTER_POLICY,
} from "../../shared/router-v2/types.ts";
import {
  type EvaluatorCandidateInput,
  evaluateCandidates,
} from "../../shared/router-v2/evaluator.ts";
import {
  type ProjectTaskPlanningItem,
  computePlanDigest,
  planCapacityAwareAllocation,
  planMultiProjectAllocation,
  verifyPlanFreshness,
} from "../../shared/router-v2/multi-project-planner.ts";
import { AccountCore } from "../account-core.ts";
import { allActiveProviderRefusals } from "../provider-refusals.ts";
import { refusalApplies } from "../../shared/provider-refusal.ts";
import { db, harnesses, tasks } from "../db.ts";
import { resourceKey } from "../orchestrated-resources.ts";
import { isCodexProfile, selectedCodexAccount, cachedCodexAuthentication } from "../codex-profiles.ts";
import { isClaudeProfile, cachedClaudeAuthentication } from "../claude-profiles.ts";
import { readExecutionMeta, setProjectAccountPreference } from "../multiaccount/registry.ts";
import { queryModelExecutionMetrics } from "./router-v2-history.ts";
import { routingQuota } from "./router-v2-quota-adapters.ts";
import { validatePolicyWeights, fallbackDigest, type FallbackProposal } from "../../shared/router-v2/resource-decision.ts";
import { cachedHarnessAuthentication, harnessBinaryPresent } from "../agent-status.ts";
import { agentDriverIsFake } from "../agents.ts";
import { selectedClaudeAccount } from "../claude-profiles.ts";
import { launchFingerprint } from "../../shared/task-scheduling.ts";

export const MODEL_DEFAULT_QUALITY_TIERS: Record<string, "flagship" | "advanced" | "standard" | "economy"> = {
  // Flagship
  "gpt-6-astra": "flagship",
  "gpt-6-astra-aeon": "flagship",
  "opus-5.5": "flagship",
  "fable-5.1": "flagship",
  "mythos-5.1": "flagship",
  // Advanced
  "gpt-6.1-sol": "advanced",
  "gpt-6-sol": "advanced",
  "sonnet-5.5": "advanced",
  "gemini-3.1-pro-preview": "advanced",
  // Standard
  "gpt-5.6-terra": "standard",
  "gpt-5.6-sol": "standard",
  "opus-5": "standard",
  "sonnet-5": "standard",
  // Economy
  "gpt-6-luna": "economy",
  "gpt-5.6-luna": "economy",
  "haiku-5.5": "economy",
  "gemini-3.5-flash": "economy",
};

export class RouterV2Service {
  constructor(private database: Database = db, private now: () => number = () => Date.now()) {}

  getPolicy(scopeId: string = "global"): ProjectRouterPolicyConfig {
    const row = this.database
      .query<
        {
          scope_id: string;
          preset: string;
          quota_policy: string;
          autonomy_mode: string;
          weights_json: string;
          constraints_json: string;
          updated_at: number;
        },
        [string]
      >(`SELECT * FROM router_v2_policies WHERE scope_id = ?`)
      .get(scopeId);

    if (!row) {
      if (scopeId !== "global") return this.getPolicy("global");
      return { ...DEFAULT_ROUTER_POLICY };
    }

    try {
      const weights = JSON.parse(row.weights_json) as PolicyWeights;
      const stored = JSON.parse(row.constraints_json) as RouterConstraints & { envelopeLocked?: boolean };
      const envelopeLocked = stored.envelopeLocked === true;
      const constraints = { ...stored };
      delete constraints.envelopeLocked;
      return {
        scopeId: row.scope_id,
        preset: row.preset as RouterPolicyPreset,
        quotaPolicy: row.quota_policy as RouterQuotaPolicy,
        autonomyMode: row.autonomy_mode as RouterAutonomyMode,
        weights,
        constraints,
        envelopeLocked,
        updatedAt: row.updated_at,
      };
    } catch {
      return { ...DEFAULT_ROUTER_POLICY };
    }
  }

  savePolicy(policy: ProjectRouterPolicyConfig): void {
    const weightError = validatePolicyWeights(policy.weights);
    if (weightError) throw new Error(weightError);
    const at = this.now();
    this.database.run(
      `INSERT INTO router_v2_policies (scope_id, preset, quota_policy, autonomy_mode, weights_json, constraints_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id) DO UPDATE SET
         preset = excluded.preset,
         quota_policy = excluded.quota_policy,
         autonomy_mode = excluded.autonomy_mode,
         weights_json = excluded.weights_json,
         constraints_json = excluded.constraints_json,
         updated_at = excluded.updated_at`,
      [
        policy.scopeId,
        policy.preset,
        policy.quotaPolicy,
        policy.autonomyMode,
        JSON.stringify(policy.weights),
        JSON.stringify({ ...policy.constraints, envelopeLocked: policy.envelopeLocked === true }),
        at,
      ],
    );
  }

  getQualityTier(modelId: string): "flagship" | "advanced" | "standard" | "economy" {
    const row = this.database
      .query<{ tier: string }, [string]>(`SELECT tier FROM router_v2_quality_tiers WHERE model_id = ?`)
      .get(modelId);
    if (row && ["flagship", "advanced", "standard", "economy"].includes(row.tier)) {
      return row.tier as "flagship" | "advanced" | "standard" | "economy";
    }
    return MODEL_DEFAULT_QUALITY_TIERS[modelId] ?? "standard";
  }

  saveQualityTier(modelId: string, tier: "flagship" | "advanced" | "standard" | "economy", notes?: string): void {
    this.database.run(
      `INSERT INTO router_v2_quality_tiers (model_id, tier, notes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET tier = excluded.tier, notes = excluded.notes, updated_at = excluded.updated_at`,
      [modelId, tier, notes ?? null, this.now()],
    );
  }

  gatherCandidatesSync(role: RouterRole = "developer"): EvaluatorCandidateInput[] {
    const core = new AccountCore(this.database, this.now);
    const accounts = core.listAccounts();
    const bindings = core.bindings();
    const harnessRows = this.database
      .query<{ id: string; kind: string; label: string; enabled: number }, []>(
        "SELECT id, kind, label, enabled FROM harnesses ORDER BY id",
      )
      .all();

    const candidates: EvaluatorCandidateInput[] = [];
    const quotas = new Map(accounts.map(a => [a.id, core.currentQuotas(a.id)]));
    // Read once: every refusal still standing. Matched per candidate by exact harness, account and model.
    const now = this.now();
    const refusals = allActiveProviderRefusals(this.database).filter(refusal => refusal.observedAt <= now);

    for (const h of harnessRows) {
      const enabled = h.enabled === 1;
      const harnessObj = harnesses.getByIdOrKind(h.id);

      const cliInstalled = harnessObj ? harnessBinaryPresent(harnessObj) : null;
      const simulated = !!harnessObj && agentDriverIsFake(harnessObj.kind);
      const cliLoggedIn = harnessObj ? cachedHarnessAuthentication(harnessObj, this.now()) : null;

      const boundAccounts = bindings
        .filter((b) => b.harnessId === h.id)
        .map((b) => accounts.find((a) => a.id === b.accountId && a.archivedAt === null))
        .filter((a): a is NonNullable<typeof a> => a != null);

      const isCodex = harnessObj ? isCodexProfile(harnessObj) : false;
      const isClaude = harnessObj ? isClaudeProfile(harnessObj) : false;
      let codexAccount: (typeof accounts)[number] | null = null;
      let claudeAccount: (typeof accounts)[number] | null = null;
      let codexBindingFailed = false;
      let claudeBindingFailed = false;
      if (isCodex && harnessObj) {
        const registered = accounts.find((account) => account.codexProfile?.harnessId === h.id) ?? null;
        try { codexAccount = selectedCodexAccount(harnessObj); } catch { codexAccount = registered; codexBindingFailed = true; }
      }
      if (isClaude && harnessObj) {
        const registered = accounts.find((account) => account.claudeProfile?.harnessId === h.id) ?? null;
        try { claudeAccount = selectedClaudeAccount(harnessObj, core); } catch { claudeAccount = registered; claudeBindingFailed = true; }
      }

      const effectiveAccounts = isCodex
        ? codexAccount
          ? [codexAccount]
          : []
        : isClaude
          ? claudeAccount
            ? [claudeAccount]
            : []
          : boundAccounts.length > 0
            ? boundAccounts
            : [null];

      const agentOptions = AGENT_OPTIONS[h.kind as AgentKind];
      const models = agentOptions ? agentOptions.models.filter((m) => !m.catalogOnly) : [];
      const modes = agentOptions ? agentOptions.modes : [];

      for (const acct of effectiveAccounts) {
        const accountId = acct?.id ?? null;
        const accountLabel = acct?.displayName ?? null;
        const meta = accountId ? readExecutionMeta(this.database, accountId) : null;

        let isolationType: "child-home" | "config-dir" | "ambient-keychain" | "none" = "none";
        let supportsRealMultiAccount = false;
        if (isCodex) {
          isolationType = "child-home";
          supportsRealMultiAccount = true;
        } else if (isClaude) {
          isolationType = "config-dir";
          supportsRealMultiAccount = false;
        } else if (h.kind === "cursor") {
          isolationType = "ambient-keychain";
          supportsRealMultiAccount = false;
        }

        let accountLoggedIn: boolean | null = accountId ? null : cliLoggedIn;
        if (isCodex && harnessObj) {
          const auth = cachedCodexAuthentication(harnessObj, this.now());
          accountLoggedIn = auth === "authenticated" ? true : auth === "unknown" ? null : false;
        }
        if (isClaude && claudeAccount?.claudeProfile) {
          const auth = cachedClaudeAuthentication(h.id, claudeAccount.claudeProfile, this.now());
          accountLoggedIn = auth === "authenticated" ? true : auth === "unknown" ? null : false;
        }
        const modelEvidence = accountId ? core.modelCapabilities(accountId).filter(row => row.harnessId === h.id &&
          row.observedAt <= this.now() && (row.expiresAt === null || row.expiresAt > this.now())) : [];

        for (const mod of models) {
          if (meta && meta.models.length > 0 && !meta.models.some((row) => row.id === mod.id)) continue;
          const qualityTier = this.getQualityTier(mod.id);

          const metrics = queryModelExecutionMetrics(this.database, {
            harnessId: h.id,
            modelId: mod.id,
            accountId,
            role: role === "reviewer" ? "reviewer" : "developer",
          });

          const quota = routingQuota(accountId ? quotas.get(accountId) ?? [] : [], accountId ?? "", acct?.provider ?? "", h.id, mod.id, this.now());
          let billing: "api" | "subscription" | "internal" | "unknown" = metrics.avgCostUsd != null ? "api" : "unknown";
          let currency = "USD";
          if (accountId) {
            try {
              const price = this.database.query<{ terms: string }, [string, string, string, number]>(
                `SELECT terms FROM usage_pricing WHERE harness_id = ? AND model_id = ? AND account_id = ? AND created_at < ?
                 ORDER BY created_at DESC, id DESC LIMIT 1`,
              ).get(h.id, mod.id, accountId, this.now());
              const terms = price ? JSON.parse(price.terms) as { billing?: string; currency?: string } : null;
              if (terms?.billing === "subscription" || terms?.billing === "internal" || terms?.billing === "api") {
                billing = metrics.avgCostUsd != null ? "api" : terms.billing;
              }
              if (typeof terms?.currency === "string") currency = terms.currency;
            } catch { /* missing pricing is Unknown cost, not zero */ }
          }

          let targetMode = "auto";
          let access: "read-only" | "workspace-write" | "unknown" = "workspace-write";

          if (role === "reviewer" || role === "head" || role === "research") {
            const reviewerContract = role === "reviewer" ? readOnlyReviewerContract(h.kind) : null;
            const readOnlyMode = reviewerContract ? modes.find(m => m.id === reviewerContract.mode)
              : modes.find(m => m.id === "ask" || m.id === "bounded-print" || m.id === "plan");
            if (readOnlyMode) {
              targetMode = readOnlyMode.id;
              access = "read-only";
            } else {
              targetMode = modes[0]?.id ?? "auto";
              access = "unknown";
            }
          } else {
            const writeMode = modes.find((m) => m.id === "auto" || m.id === "full-access" || m.id === "yolo");
            if (writeMode) {
              targetMode = writeMode.id;
              access = "workspace-write";
            } else {
              targetMode = modes[0]?.id ?? "auto";
              access = "unknown";
            }
          }

          const activeBlocks: string[] = [];
          if (h.kind === "cursor") {
            activeBlocks.push("cursor-internal-sandbox-unavailable");
          }
          if (h.kind === "deepseek-dsh") {
            activeBlocks.push("deepseek-containment-blocked");
          }
          if (meta?.disabled) activeBlocks.push("account-disabled");
          if (codexBindingFailed || claudeBindingFailed || accountId && (!isCodex && !isClaude ||
            !bindings.some(b => b.accountId === accountId && b.harnessId === h.id))) activeBlocks.push("account-binding-unavailable");
          if (modelEvidence.some(row => row.modelId === mod.id && row.support === "unsupported")) activeBlocks.push("account-model-unsupported");
          if (isClaude && claudeAccount && !claudeAccount.claudeProfile?.homeAccessAccepted) {
            activeBlocks.push("claude-home-access-not-accepted");
          }

          const runningCount = this.database
            .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM runs WHERE agent = ? AND status = 'running'`)
            .get(h.id)?.n ?? 0;
          const occupied = accountId
            ? (this.database.query<{ n: number }, [string]>(
              `SELECT COUNT(*) AS n FROM orchestration_reservations WHERE account_id = ? AND status IN ('reserved','starting','running','awaiting_qc','qc_running')`,
            ).get(accountId)?.n ?? 0)
            : runningCount;
          candidates.push({
            id: JSON.stringify([h.id, accountId, mod.id, targetMode]),
            harnessId: h.id,
            harnessLabel: h.label,
            kind: h.kind,
            enabled,
            cliInstalled,
            simulated,
            cliLoggedIn: accountLoggedIn,
            accountId,
            accountLabel,
            provider: acct?.provider ?? h.kind,
            providerIdentity: acct?.externalIdentity ?? null,
            supportsRealMultiAccount,
            isolationType,
            modelId: mod.id,
            modelLabel: mod.label,
            mode: targetMode,
            modeLabel: modes.find((m) => m.id === targetMode)?.label ?? targetMode,
            access,
            qualityTier,
            billing,
            costMinor: billing === "api" && metrics.avgCostUsd != null ? Math.ceil(metrics.avgCostUsd * 100) : null,
            currency,
            measuredLatencyMs: metrics.avgLatencyMs,
            latencySampleCount: metrics.runCount,
            queueWaitMs: occupied > 0 ? occupied * (metrics.avgLatencyMs ?? 60_000) : 0,
            poolId: quota.poolId ?? null,
            poolExhausted: Boolean(quota.poolId) && quota.isExhausted,
            quotaState: {
              isUnknown: quota.isUnknown,
              capacityEvidence: quota.capacityEvidence,
              remainingPercent: quota.remainingPercent,
              remainingUnits: quota.remainingUnits,
              unitKind: quota.unitKind,
              isExhausted: quota.isExhausted,
            },
            historyStats: {
              runCount: metrics.runCount,
              successRate: metrics.successRate,
              qcPassRate: metrics.qcPassRate,
              reworkRate: metrics.qcPassCount + metrics.qcReworkCount + metrics.qcBlockedCount >= 3
                ? metrics.qcReworkCount / (metrics.qcPassCount + metrics.qcReworkCount + metrics.qcBlockedCount) : null,
              isSyntheticTest: false,
              comparable: metrics.comparable,
              role: role === "reviewer" ? "reviewer" : "developer",
            },
            concurrency: {
              occupied,
              limit: meta?.concurrencyLimit ?? null,
            },
            activeBlocks,
            providerRefusal: refusals.find((refusal) => refusalApplies(refusal, { harnessId: h.id, accountId, modelId: mod.id })) ?? null,
            sandbox: isolationType,
            tools: [],
          });
        }
      }
    }

    return candidates;
  }

  async gatherCandidates(role: RouterRole = "developer"): Promise<EvaluatorCandidateInput[]> {
    return this.gatherCandidatesSync(role);
  }

  evaluateTaskSync(
    req: TaskRequirementsInput,
    options: {
      candidates?: EvaluatorCandidateInput[];
      policyOverride?: Partial<ProjectRouterPolicyConfig>;
      /** Internal, exact, one-operation retry supplied by the mission scheduler. */
      retryRefusalId?: string;
    } = {},
  ) {
    const role: RouterRole = req.role ?? "developer";
    const gathered = options.candidates ?? this.gatherCandidatesSync(role);
    const candidates = options.retryRefusalId ? gathered.map(candidate =>
      candidate.providerRefusal?.id === options.retryRefusalId && candidate.accountId === req.requestedAccountId &&
      candidate.harnessId === req.requestedHarnessId && candidate.modelId === req.requestedModelId && candidate.mode === req.requestedMode
        ? { ...candidate, providerRefusal: null }
        : candidate) : gathered;
    const basePolicy = this.getPolicy(req.projectId);
    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      ...options.policyOverride,
      weights: { ...basePolicy.weights, ...(options.policyOverride?.weights ?? {}) },
      constraints: { ...basePolicy.constraints, ...(options.policyOverride?.constraints ?? {}) },
    };

    return evaluateCandidates(candidates, req, policy);
  }

  async evaluateTask(
    req: TaskRequirementsInput,
    options: {
      candidates?: EvaluatorCandidateInput[];
      policyOverride?: Partial<ProjectRouterPolicyConfig>;
    } = {},
  ) {
    const role: RouterRole = req.role ?? "developer";
    const candidates = options.candidates ?? (await this.gatherCandidates(role));
    const basePolicy = this.getPolicy(req.projectId);
    const policy: ProjectRouterPolicyConfig = {
      ...basePolicy,
      ...options.policyOverride,
      weights: { ...basePolicy.weights, ...(options.policyOverride?.weights ?? {}) },
      constraints: { ...basePolicy.constraints, ...(options.policyOverride?.constraints ?? {}) },
    };

    return evaluateCandidates(candidates, req, policy);
  }

  recordDecision(decision: Omit<RoutingDecisionRecord, "id" | "createdAt" | "updatedAt">): RoutingDecisionRecord {
    const id = crypto.randomUUID();
    const at = this.now();
    const record: RoutingDecisionRecord = {
      ...decision,
      authority: decision.authority ?? "recommendation",
      id,
      createdAt: at,
      updatedAt: at,
    };

    this.database.run(
      `INSERT INTO router_v2_decisions (
        id, project_path, task_id, role, policy_preset, quota_policy, autonomy_mode,
        selected_harness_id, selected_model_id, selected_account_id, selected_mode,
        decision_type, plan_digest, evaluation_json, actual_attribution_json, authority, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectPath,
        record.taskId,
        record.role,
        record.policyPreset,
        record.quotaPolicy,
        record.autonomyMode,
        record.selectedHarnessId,
        record.selectedModelId,
        record.selectedAccountId,
        record.selectedMode,
        record.decisionType,
        record.planDigest,
        JSON.stringify(record.evaluation),
        record.actualAttribution ? JSON.stringify(record.actualAttribution) : null,
        record.authority ?? "recommendation",
        record.createdAt,
        record.updatedAt,
      ],
    );

    return record;
  }

  listDecisions(limit = 50): RoutingDecisionRecord[] {
    const rows = this.database
      .query<
        {
          id: string;
          project_path: string;
          task_id: string | null;
          role: string;
          policy_preset: string;
          quota_policy: string;
          autonomy_mode: string;
          selected_harness_id: string;
          selected_model_id: string;
          selected_account_id: string | null;
          selected_mode: string;
          decision_type: string;
          plan_digest: string | null;
          evaluation_json: string;
          actual_attribution_json: string | null;
          authority: string | null;
          created_at: number;
          updated_at: number;
        },
        [number]
      >(`SELECT * FROM router_v2_decisions ORDER BY created_at DESC LIMIT ?`)
      .all(limit);

    return rows.map((r) => ({
      id: r.id,
      projectPath: r.project_path,
      taskId: r.task_id,
      role: r.role as RouterRole,
      policyPreset: r.policy_preset as RouterPolicyPreset,
      quotaPolicy: r.quota_policy as RouterQuotaPolicy,
      autonomyMode: r.autonomy_mode as RouterAutonomyMode,
      selectedHarnessId: r.selected_harness_id,
      selectedModelId: r.selected_model_id,
      selectedAccountId: r.selected_account_id,
      selectedMode: r.selected_mode,
      decisionType: r.decision_type as "automatic" | "manual-override" | "fallback",
      authority: r.authority === "approval" || r.authority === "fallback-proposal" ? r.authority : "recommendation",
      planDigest: r.plan_digest,
      evaluation: JSON.parse(r.evaluation_json),
      actualAttribution: r.actual_attribution_json ? JSON.parse(r.actual_attribution_json) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async planMultiProject(
    projectTasks: { projectPath: string; taskIds: string[] }[],
    options: {
      policyOverride?: Partial<ProjectRouterPolicyConfig>;
      candidatesMap?: Map<string, EvaluatorCandidateInput[]>;
    } = {},
  ): Promise<MultiProjectAllocationPlan> {
    const { items, policy } = await this.portfolioItems(projectTasks, options);
    return this.issuePlan(planMultiProjectAllocation(items, policy));
  }

  /**
   * Remember that this Router produced exactly these contents. Issuing authorizes nothing: it is what lets an apply
   * tell a plan it produced from one a client built or edited, even when the edited one is re-signed and still eligible.
   */
  issuePlan<T extends MultiProjectAllocationPlan>(plan: T): T {
    const at = this.now();
    this.database.run("INSERT OR IGNORE INTO router_v2_issued_plans (digest, issued_at) VALUES (?, ?)", [plan.planDigest, at]);
    this.database.run("DELETE FROM router_v2_issued_plans WHERE issued_at < ?", [at - 7 * 24 * 60 * 60 * 1000]);
    return plan;
  }

  async planPortfolio(
    projectTasks: { projectPath: string; taskIds: string[] }[],
    options: {
      policyOverride?: Partial<ProjectRouterPolicyConfig>;
      candidatesMap?: Map<string, EvaluatorCandidateInput[]>;
    } = {},
  ): Promise<{ fair: MultiProjectAllocationPlan; capacity: MultiProjectAllocationPlan; authorizesExecution: false }> {
    const { items, policy } = await this.portfolioItems(projectTasks, options);
    return {
      fair: this.issuePlan(planMultiProjectAllocation(items, policy)),
      capacity: this.issuePlan(planCapacityAwareAllocation(items, policy)),
      authorizesExecution: false,
    };
  }

  private async portfolioItems(
    projectTasks: { projectPath: string; taskIds: string[] }[],
    options: {
      policyOverride?: Partial<ProjectRouterPolicyConfig>;
      candidatesMap?: Map<string, EvaluatorCandidateInput[]>;
    },
  ): Promise<{ items: ProjectTaskPlanningItem[]; policy: ProjectRouterPolicyConfig }> {
    const policy = { ...this.getPolicy("global"), ...options.policyOverride };
    const items: ProjectTaskPlanningItem[] = [];
    for (const pt of projectTasks) {
      for (const tId of pt.taskIds) {
        const task = tasks.get(tId);
        if (!task || task.archivedAt != null) continue;
        const taskRole: RouterRole = task.column === "review" ? "reviewer" : "developer";
        const candidates = options.candidatesMap?.get(tId) ?? (await this.gatherCandidates(taskRole));
        items.push({
          projectPath: pt.projectPath,
          projectPriority: "normal",
          task: {
            taskId: task.id,
            projectId: pt.projectPath,
            title: task.title,
            type: (task.taskType as TaskRequirementsInput["type"]) ?? "general",
            complexity: "unknown",
            role: taskRole,
          },
          candidates,
        });
      }
    }
    return { items, policy };
  }

  /**
   * Apply an Owner-approved plan to task settings. It never starts anything.
   *
   * The plan arrives from the caller, so it is checked as untrusted: its contents must still hash to
   * its digest (a re-labelled slot is refused). Unless the caller sets `recheck: false` (fixture tests only;
   * no production caller does), the digest must also be one this Router issued, it must not have been
   * applied before, every stage is re-evaluated now (the exact resource must still be eligible, the task
   * must not be running, and nothing else may own its resource: an agent profile, a pipeline or a mission).
   * One refused stage refuses the whole plan; nothing is written. An approval is not a reservation and not a launch.
   */
  applyPlan(
    plan: MultiProjectAllocationPlan,
    approvedDigest: string,
    options: { currentFingerprints?: Map<string, string>; recheck?: boolean } = {},
  ): { success: boolean; appliedCount: number; errors: string[] } {
    const recheck = options.recheck !== false;
    if (plan.planDigest !== approvedDigest) {
      return { success: false, appliedCount: 0, errors: ["Plan digest mismatch: plan has changed or is unapproved."] };
    }
    if (computePlanDigest(plan) !== plan.planDigest) {
      return { success: false, appliedCount: 0, errors: ["The plan's contents do not match its digest. It was changed after it was reviewed."] };
    }
    if (["applied", "stale", "invalidated"].includes(plan.status)) {
      return { success: false, appliedCount: 0, errors: [`This plan is ${plan.status} and cannot be applied.`] };
    }
    if (recheck) {
      // The plan came from the client. Its contents must be exactly what this Router issued: a changed plan that was
      // re-signed, and even one whose new resource is still eligible, has a digest the Router never issued.
      if (!this.database.query("SELECT 1 FROM router_v2_issued_plans WHERE digest = ? LIMIT 1").get(plan.planDigest)) {
        return { success: false, appliedCount: 0, errors: ["This plan was not issued by this Router, or it was changed after it was issued. Ask for a new plan and review it."] };
      }
      if (this.database.query("SELECT 1 FROM router_v2_decisions WHERE plan_digest = ? AND authority = 'approval' LIMIT 1").get(plan.planDigest)) {
        return { success: false, appliedCount: 0, errors: ["This plan was already applied. Review a new plan."] };
      }
    }

    if (options.currentFingerprints) {
      const freshness = verifyPlanFreshness(plan, options.currentFingerprints);
      if (!freshness.valid) {
        return { success: false, appliedCount: 0, errors: [freshness.reason ?? "Stale plan rejected before execution."] };
      }
    }

    if (recheck) {
      const refused: string[] = [];
      for (const slot of plan.slots) {
        const chosen = slot.selectedCandidate;
        if (!chosen) continue;
        const task = tasks.get(slot.taskId);
        if (!task || task.archivedAt != null) { refused.push(`Task ${slot.taskId} is missing or archived.`); continue; }
        // A plan sets an initial allocation. A task whose resource is owned elsewhere changes through that owner:
        // a bound agent through its detach, a pipeline through its run, an authorized mission through its resource proposal.
        if (task.agentProfileId) { refused.push(`Task ${task.title} follows an agent profile. Detach the agent first; a plan does not change its agent, model or mode.`); continue; }
        if (task.pipelineId || task.pipelineParentId) { refused.push(`Task ${task.title} belongs to a pipeline. A plan does not change a pipeline task's resource.`); continue; }
        if (this.missionManages(slot.taskId)) { refused.push(`Task ${task.title} belongs to a mission. Change its resource through the mission's resource proposal, which the Owner approves.`); continue; }
        const live = task.column === "running" || this.database.query("SELECT 1 FROM runs WHERE task_id = ? AND status = 'running' LIMIT 1").get(slot.taskId);
        if (live) { refused.push(`Task ${task.title} is running. A resource change waits until it settles.`); continue; }
        try {
          const now = this.evaluateTaskSync({
            taskId: slot.taskId, projectId: slot.projectPath, role: slot.role,
            requestedHarnessId: chosen.harnessId, requestedModelId: chosen.modelId, requestedAccountId: chosen.accountId, requestedMode: chosen.mode,
          }, { policyOverride: { preset: plan.policyPreset, quotaPolicy: plan.quotaPolicy, autonomyMode: plan.autonomyMode } });
          const hit = now.selected;
          if (!hit || hit.harnessId !== chosen.harnessId || hit.modelId !== chosen.modelId || hit.accountId !== chosen.accountId || hit.mode !== chosen.mode) {
            const pinned = now.all.find(row => row.harnessId === chosen.harnessId && row.modelId === chosen.modelId && row.accountId === chosen.accountId && row.mode === chosen.mode);
            refused.push(`The reviewed resource for ${task.title} is no longer eligible: ${pinned?.eliminationReasons[0] ?? "it is not in the Router catalog"}. No substitute was selected.`);
          }
        } catch (error) {
          refused.push(`The reviewed resource for ${task.title} could not be re-evaluated: ${error instanceof Error ? error.message : "unknown error"}. No substitute was selected.`);
        }
      }
      if (refused.length > 0) return { success: false, appliedCount: 0, errors: refused };
    }

    let applied = 0;
    const errors: string[] = [];

    this.database.transaction(() => {
      for (const slot of plan.slots) {
        if (!slot.selectedCandidate) continue;
        const task = tasks.get(slot.taskId);
        if (!task) {
          errors.push(`Task ${slot.taskId} not found.`);
          continue;
        }

        // Apply configuration to task
        tasks.update(slot.taskId, {
          agent: slot.selectedCandidate.harnessId as AgentKind,
          model: slot.selectedCandidate.modelId,
          mode: slot.selectedCandidate.mode,
        });
        if (slot.selectedCandidate.accountId && new AccountCore(this.database, this.now).listAccounts().some(account => account.id === slot.selectedCandidate!.accountId)) {
          setProjectAccountPreference(this.database, {
            projectPath: slot.projectPath,
            role: slot.role,
            accountId: slot.selectedCandidate.accountId,
          }, this.now());
        }

        // Record router decision
        this.recordDecision({
          projectPath: slot.projectPath,
          taskId: slot.taskId,
          role: slot.role,
          policyPreset: plan.policyPreset,
          quotaPolicy: plan.quotaPolicy,
          autonomyMode: plan.autonomyMode,
          selectedHarnessId: slot.selectedCandidate.harnessId,
          selectedModelId: slot.selectedCandidate.modelId,
          selectedAccountId: slot.selectedCandidate.accountId,
          selectedMode: slot.selectedCandidate.mode,
          decisionType: slot.selectedCandidate.isManualOverride ? "manual-override" : "automatic",
          authority: "approval",
          planDigest: plan.planDigest,
          evaluation: slot.selectedCandidate,
          actualAttribution: null,
        });

        applied++;
      }
    })();

    plan.status = "applied";
    plan.appliedAt = this.now();

    return {
      success: errors.length === 0,
      appliedCount: applied,
      errors,
    };
  }

  /** True while an unfinished mission plan still carries this task: its resource is that mission's to change. */
  private missionManages(taskId: string): boolean {
    const rows = this.database.query<{ plan_json: string }, [string]>(
      "SELECT plan_json FROM orchestration_missions WHERE status NOT IN ('completed', 'cancelled', 'failed') AND plan_json LIKE ?",
    ).all(`%${taskId}%`);
    return rows.some((row) => {
      try {
        const plan = JSON.parse(row.plan_json) as { tasks?: Array<{ taskId: string; phase: string }> };
        return (plan.tasks ?? []).some((entry) => entry.taskId === taskId && !["completed", "cancelled"].includes(entry.phase));
      } catch { return true; }   // an unreadable plan is not proof that the task is free
    });
  }

  /** Read-only recommendation. It does not change the task and does not start a run. */
  recordRecommendation(req: TaskRequirementsInput, policyOverride?: Partial<ProjectRouterPolicyConfig>): {
    evaluation: ReturnType<RouterV2Service["evaluateTaskSync"]>;
    record: RoutingDecisionRecord | null;
    authorizesExecution: false;
  } {
    const evaluation = this.evaluateTaskSync(req, { policyOverride });
    const selected = evaluation.selected;
    if (!selected) return { evaluation, record: null, authorizesExecution: false };
    const policy = this.getPolicy(req.projectId);
    const record = this.recordDecision({
      projectPath: req.projectId,
      taskId: req.taskId,
      role: req.role ?? "developer",
      policyPreset: policyOverride?.preset ?? policy.preset,
      quotaPolicy: policyOverride?.quotaPolicy ?? policy.quotaPolicy,
      autonomyMode: policyOverride?.autonomyMode ?? policy.autonomyMode,
      selectedHarnessId: selected.harnessId,
      selectedModelId: selected.modelId,
      selectedAccountId: selected.accountId,
      selectedMode: selected.mode,
      decisionType: selected.isManualOverride ? "manual-override" : "automatic",
      authority: "recommendation",
      planDigest: null,
      evaluation: selected,
      actualAttribution: null,
    });
    return { evaluation, record, authorizesExecution: false };
  }

  proposeCapacityPlan(
    items: ProjectTaskPlanningItem[],
    policy: ProjectRouterPolicyConfig = this.getPolicy("global"),
  ): MultiProjectAllocationPlan {
    return planCapacityAwareAllocation(items, policy);
  }

  /**
   * Builds an exact fallback proposal from currently eligible resources.
   * The failed run is preserved. Nothing is retried and nothing is applied.
   */
  proposeFallback(input: {
    requirements: TaskRequirementsInput;
    failed: FallbackProposal["failed"];
    evidenceHash: string;
    candidates?: EvaluatorCandidateInput[];
  }): FallbackProposal & { digest: string } {
    const candidates = (input.candidates ?? this.gatherCandidatesSync(input.requirements.role ?? "developer"))
      .filter(candidate => candidate.accountId !== input.failed.accountId || candidate.modelId !== input.failed.modelId || candidate.harnessId !== input.failed.harnessId);
    const evaluation = this.evaluateTaskSync({
      ...input.requirements,
      requestedAccountId: null,
      requestedModelId: null,
      requestedHarnessId: null,
      requestedMode: null,
    }, { candidates });
    const selected = evaluation.selected;
    const proposal: FallbackProposal = {
      failed: input.failed,
      replacement: selected ? {
        provider: selected.provider ?? selected.kind,
        harnessId: selected.harnessId,
        modelId: selected.modelId,
        accountId: selected.accountId,
        mode: selected.mode,
      } : null,
      evidenceHash: input.evidenceHash,
      authorizesExecution: false,
      explanation: selected
        ? `Eligible alternative ${selected.harnessId}/${selected.modelId}/${selected.accountId ?? "unassigned"}/${selected.mode}. ${selected.eliminationReasons.join(" ") || selected.selectionReasons[0] || "It passed elimination."} ${evaluation.explanation}`
        : `No eligible alternative. ${evaluation.explanation}`,
    };
    const digest = fallbackDigest(proposal);
    if (selected) {
      const policy = this.getPolicy(input.requirements.projectId);
      this.recordDecision({
        projectPath: input.requirements.projectId,
        taskId: input.requirements.taskId,
        role: input.requirements.role ?? "developer",
        policyPreset: policy.preset,
        quotaPolicy: policy.quotaPolicy,
        autonomyMode: policy.autonomyMode,
        selectedHarnessId: selected.harnessId,
        selectedModelId: selected.modelId,
        selectedAccountId: selected.accountId,
        selectedMode: selected.mode,
        decisionType: "fallback",
        authority: "fallback-proposal",
        planDigest: digest,
        evaluation: selected,
        actualAttribution: { runId: input.failed.runId, outcome: input.failed.reason },
      });
    }
    return { ...proposal, digest };
  }
}

export const routerV2Service = new RouterV2Service();
