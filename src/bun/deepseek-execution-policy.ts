/** FO-DEEPSEEK02 / FO-PROVIDERS-READY01: frozen admission requirements.
 * Not a runnable DSH profile. Assessed 0.2.1-rc.5 and 0.2.2-rc.1 cannot
 * enforce project-only reads and writes. A path Seatbelt does not close
 * hard-link aliases. Neither a fixture, a login, nor a grant may promote
 * this assessment into execution. No spawn, credential lookup, profile
 * initialization, or catalog probe here.
 */
import { createHash } from "node:crypto";

const requirements = Object.freeze({
  executable: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
  version: "0.2.1-rc.5 and 0.2.2-rc.1",
  protocol: "headless-jsonl",
  profile: "ForgeOrbit-owned, isolated composition required; none admitted",
  configurationDigest: null,
  provider: "explicit exact provider required; no fallback",
  model: "explicit verified model required; none verified",
  authentication: "explicit source required; no ambient credentials",
  workspace: "canonical selected project and cwd; no outside reads or writes",
  developer: "project file reads and edits only",
  reviewer: "project reads only; no implementation mutations",
  shell: "denied",
  networkTools: "denied; provider transport requires separate explicit admission",
  providerRetries: 0,
  taskRetries: 0,
  auxiliaryInference: "denied, including title, compaction, goals, web and subagents",
  timeout: "explicit process deadline required; not a token, turn or USD cap",
  cancellation: "terminate owned process and verify descendant quiescence",
  session: "fresh only; no automatic resume or replay",
  grants: "existing FO-AUTO01/02 durable reservation and consumption required",
  provenance: "exact executable/carrier/config/model/role/workspace and genuine outcome",
  usage: "unknown unless genuinely reported; no inferred cost or identity",
});

export const DEEPSEEK_POLICY = Object.freeze({
  id: "fo-deepseek02-project-files-v1",
  status: "blocked" as const,
  requirements,
  blockers: Object.freeze([
    "filesystem-read-scope",
    "filesystem-write-scope",
    "hard-link-alias",
    "inherited-file-descriptor",
    "setsid-descendant",
    "component-boot",
  ] as const),
});

/** Assessment identity only. This is never an approved resource/grant digest. */
export const DEEPSEEK_POLICY_DIGEST = createHash("sha256").update(JSON.stringify(DEEPSEEK_POLICY)).digest("hex");

export const DEEPSEEK_ASSESSED_VERSIONS = ["0.2.1-rc.5", "0.2.2-rc.1"] as const;

export const DEEPSEEK_EXECUTION_BLOCKER = "DeepSeek DSH execution is unsupported: assessed versions 0.2.1-rc.5 and 0.2.2-rc.1 leave filesystem reads unconfined, and workspace-write also permits shared temporary directories. A path Seatbelt still allows a hard link inside the project to reach an outside inode. Inherited descriptors and setsid descendants are not contained. Other versions are unassessed. No fallback or launch is allowed.";

export function deepseekPolicyAssessment() {
  return {
    id: DEEPSEEK_POLICY.id,
    digest: DEEPSEEK_POLICY_DIGEST,
    status: DEEPSEEK_POLICY.status,
    protocol: DEEPSEEK_POLICY.requirements.protocol,
    blockers: [...DEEPSEEK_POLICY.blockers],
  };
}
