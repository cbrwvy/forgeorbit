/**
 * CI facts for a registered project.
 * Live GitHub calls go through the existing github.ts client and are opt-in.
 * Dispatch of a real workflow is not performed here.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { redactInfraText, type CiFailedJob } from "../../shared/infra-auto/model.ts";

export interface CiWorkflowFile {
  name: string;
  path: string;
}

export function discoverLocalWorkflows(repoPath: string): CiWorkflowFile[] {
  const dir = path.join(repoPath, ".github", "workflows");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ name, path: `.github/workflows/${name}` }));
}

export interface CiCheck {
  name: string;
  sha: string;
  conclusion: string | null;
  status: string;
  failedJobs: CiFailedJob[];
  logExcerpt: string;
}

export function checksForSha(records: CiCheck[], sha: string, required: string[]): { passed: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const name of required) {
    const matches = records.filter((record) => record.name === name && record.sha === sha);
    if (matches.length === 0) {
      blockers.push(`CI check ${name} is not recorded for ${sha}.`);
      continue;
    }
    const latest = matches[matches.length - 1]!;
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      const jobs = latest.failedJobs.map((job) => `${job.name} (${job.conclusion}${job.failedSteps.length ? `: ${job.failedSteps.join(", ")}` : ""})`).join("; ");
      blockers.push(`CI check ${name} is ${latest.conclusion ?? latest.status} for ${sha}${jobs ? ` — ${jobs}` : ""}.`);
    }
  }
  return { passed: blockers.length === 0, blockers: blockers.map((line) => redactInfraText(line, 500)) };
}

export interface LiveCiPort {
  listWorkflows(projectPath: string): Promise<Array<{ name: string; path: string; state: string }>>;
  listRuns(projectPath: string): Promise<Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    headBranch: string;
    headSha: string | null;
    htmlUrl: string;
  }>>;
}

/** Uses the existing GitHub client. Tests inject a port instead of calling this. */
export function githubLivePort(): LiveCiPort {
  return {
    async listWorkflows(projectPath) {
      const { listGitHubWorkflows } = await import("../github.ts");
      const result = await listGitHubWorkflows({ dir: projectPath });
      if (!result.ok) throw new Error(redactInfraText(result.error));
      return result.workflows.map((workflow) => ({
        name: workflow.path.split("/").pop() || workflow.name,
        path: workflow.path,
        state: workflow.state,
      }));
    },
    async listRuns(projectPath) {
      const { listGitHubWorkflowRuns } = await import("../github.ts");
      const result = await listGitHubWorkflowRuns({ dir: projectPath });
      if (!result.ok) throw new Error(redactInfraText(result.error));
      return result.runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        headBranch: run.headBranch,
        headSha: run.headSha,
        htmlUrl: run.htmlUrl,
      }));
    },
  };
}
