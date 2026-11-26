/**
 * What an execution config runs as: the agents, their permission level and the
 * signature an approval freezes. Shared by Execution Batches and the bounded
 * autonomous grant (FO-ORCH08), which must read the very same facts.
 */

import { agentProfiles, harnesses, pipelines } from "./db.ts";
import { modeAccessLevel, stableHash, type ExecutionConfig } from "../shared/project-execution.ts";
import { DEFAULT_MODEL, defaultModeFor, type Harness } from "../shared/types.ts";

export function harnessOf(id: string): Harness | null {
  return harnesses.getByIdOrKind(id);
}

export interface ConfigAgent {
  harnessId: string;
  harness: Harness | null;
  mode: string;
  /** The model this agent launches with (the harness default when none is set). */
  model: string | null;
  /** The agent profile that names its account, when there is one. */
  profileId: string | null;
}

/** Every agent the config runs as: one, or each pipeline step's. */
export function agentsOf(config: ExecutionConfig): ConfigAgent[] {
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    if (!pipeline) return [];
    return pipeline.graph.steps.map((step) => {
      const profile = step.agentProfileId ? agentProfiles.get(step.agentProfileId) : null;
      const harness = profile ? harnessOf(profile.harness) : null;
      return {
        harnessId: harness?.id ?? profile?.harness ?? "?",
        harness,
        mode: profile?.mode ?? (harness ? defaultModeFor(harness.kind) : "auto"),
        model: profile?.model ?? (harness ? DEFAULT_MODEL[harness.kind] ?? null : null),
        profileId: step.agentProfileId ?? null,
      };
    });
  }
  const harness = harnessOf(config.harness);
  return [{
    harnessId: harness?.id ?? config.harness,
    harness,
    mode: config.mode,
    model: config.model || (harness ? DEFAULT_MODEL[harness.kind] ?? null : null),
    profileId: config.profileId ?? null,
  }];
}

export function accessLevelOf(config: ExecutionConfig): number {
  const agents = agentsOf(config);
  if (agents.length === 0) return 4;
  return Math.max(...agents.map((agent) => (agent.harness ? modeAccessLevel(agent.harness.kind, agent.mode) : 4)));
}

/**
 * Everything a start's agents depend on, hashed: the config, the profile's
 * fields, every pipeline step's profile. Editing any of it after approval
 * holds the start.
 */
export function executionSignature(config: ExecutionConfig): string {
  const profileParts = (id: string | null | undefined) => {
    const profile = id ? agentProfiles.get(id) : null;
    return profile
      ? [profile.id, profile.harness, profile.model, profile.effort, profile.mode, profile.fast, profile.maxMode, profile.instructions, profile.skills]
      : null;
  };
  const parts: unknown[] = [config.pipelineId, config.profileId, config.harness, config.model, config.effort, config.mode, config.fast, config.maxMode];
  if (config.profileId) parts.push(profileParts(config.profileId));
  if (config.pipelineId) {
    const pipeline = pipelines.get(config.pipelineId);
    parts.push(pipeline
      ? [pipeline.maxSteps, pipeline.graph.startStepId, pipeline.graph.edges.map((edge) => [edge.from, edge.to]),
        pipeline.graph.steps.map((step) => [step.id, step.instructions, profileParts(step.agentProfileId), step.subagents?.profileIds ?? []])]
      : null);
  }
  return stableHash(JSON.stringify(parts));
}
