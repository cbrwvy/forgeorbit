/**
 * FO-ROUTING04: AI Router 2.0 — Client API Facade
 */

import { api } from "./api.ts";
import type {
  CandidateEvaluation,
  MultiProjectAllocationPlan,
  ProjectRouterPolicyConfig,
  RoutingDecisionRecord,
  TaskRequirementsInput,
} from "../../shared/router-v2/types.ts";

export interface EvaluationResponse {
  selected: CandidateEvaluation | null;
  eligible: CandidateEvaluation[];
  ineligible: CandidateEvaluation[];
  all: CandidateEvaluation[];
}

export const routerV2Api = {
  async getPolicy(scopeId = "global"): Promise<ProjectRouterPolicyConfig> {
    const data = await api.getRouterV2Config(scopeId);
    return data.policy;
  },

  async savePolicy(policy: ProjectRouterPolicyConfig): Promise<ProjectRouterPolicyConfig> {
    const data = await api.saveRouterV2Config(policy);
    return data.policy;
  },

  async evaluateTask(
    requirements: TaskRequirementsInput,
    policyOverride?: Partial<ProjectRouterPolicyConfig>,
  ): Promise<EvaluationResponse> {
    return api.evaluateRouterV2Task({ requirements, policyOverride });
  },

  async proposePlan(
    projectTasks: { projectPath: string; taskIds: string[] }[],
    policyOverride?: Partial<ProjectRouterPolicyConfig>,
  ): Promise<MultiProjectAllocationPlan> {
    const data = await api.proposeRouterV2Plan({ projectTasks, policyOverride });
    return data.plan;
  },

  async applyPlan(
    plan: MultiProjectAllocationPlan,
    approvedDigest: string,
  ): Promise<{ success: boolean; appliedCount: number; errors: string[] }> {
    return api.applyRouterV2Plan({ plan, approvedDigest });
  },

  async getHistory(limit = 50): Promise<RoutingDecisionRecord[]> {
    const data = await api.getRouterV2History(limit);
    return data.history;
  },
};
