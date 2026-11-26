import { t as tr } from "@/i18n/core";
import type { GitHubPullMergeability } from "../../shared/types.ts";

export type MergeTone = "ok" | "warn" | "bad" | "muted";

export interface MergeabilityView {
  label: string;
  tone: MergeTone;
  canMerge: boolean;
  showUpdateBranch: boolean;
}

/** Map GitHub's mergeable / mergeable_state into a label, colour tone, whether
 *  the Merge button should be enabled, and whether to offer "Update branch".
 *  Pure — drives whether a PR can be merged from the UI, so it's unit-tested. */
export function mergeabilityView(m: GitHubPullMergeability): MergeabilityView {
  if (m.mergeable === null) {
    // `mergeable === null` can be a transient "still computing" state
    // (GitHub) or a PERMANENT unknown (Bitbucket, when the diffstat scan
    // fails or hits its page cap) — there's no way to tell them apart from
    // this shape alone. Keeping the merge button enabled here matches the
    // pre-mergeability-feature baseline (no verdict meant merge stayed
    // enabled) rather than regressing Bitbucket to a permanently dead button.
    return {
      get label() { return tr("settings.mergeability_hasn_t_been_verified_merging_will_efe247"); },
      tone: "muted",
      canMerge: true,
      showUpdateBranch: m.mergeableState === "behind",
    };
  }
  switch (m.mergeableState) {
    case "clean":
    case "has_hooks":
      return { get label() { return tr("settings.ready_to_merge_28f738"); }, tone: "ok", canMerge: m.mergeable, showUpdateBranch: false };
    case "unstable":
      return { get label() { return tr("settings.mergeable_some_checks_are_pending_or_failing_6d5a67"); }, tone: "warn", canMerge: m.mergeable, showUpdateBranch: false };
    case "behind":
      return { get label() { return tr("settings.out_of_date_with_the_base_branch_066527"); }, tone: "warn", canMerge: m.mergeable, showUpdateBranch: true };
    case "dirty":
      return { get label() { return tr("settings.conflicts_must_be_resolved_before_merging_e71d55"); }, tone: "bad", canMerge: false, showUpdateBranch: false };
    case "blocked":
      return { get label() { return tr("settings.blocked_by_required_reviews_or_checks_256f24"); }, tone: "bad", canMerge: false, showUpdateBranch: false };
    case "draft":
      return { get label() { return tr("settings.draft_mark_ready_for_review_to_merge_b2c139"); }, tone: "muted", canMerge: false, showUpdateBranch: false };
    default:
      return { label: `Mergeability: ${m.mergeableState}`, tone: "muted", canMerge: m.mergeable, showUpdateBranch: false };
  }
}
