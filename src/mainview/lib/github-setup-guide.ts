import { t as tr } from "@/i18n/core";
/**
 * Content for the "Connect ForgeOrbit to GitHub" setup guide (`GitHubSetupDialog.tsx`).
 *
 * This module is the **single source of truth** for that guide's copy — the
 * component only maps over these exports; no permission/scope/step text is
 * hardcoded in JSX. Keeping it as plain data (rather than markdown, which the
 * webview has no renderer for) means the dialog stays typed end-to-end and a
 * future test file can assert coverage (no duplicate scope names, https-only
 * URLs, every load-bearing permission present) without touching React.
 *
 * Permission facts (scope names, fine-grained permission names, what each
 * token type can and can't do) were verified against docs.github.com as of
 * July 2026. **Classic tokens are recommended for full ForgeOrbit access**
 * because three of the ~70 `/github/*` integration surfaces
 * (`src/bun/server.ts`) are classic-token-only or otherwise unreachable with
 * a fine-grained PAT: the Notifications API only accepts classic tokens, the
 * Checks API has no grantable fine-grained permission (commit statuses still
 * work), and repository Discussions has no fine-grained permission at all.
 * Fine-grained tokens are documented as the least-privilege alternative with
 * an explicit list of what won't work.
 */

/** One row in a fine-grained-token permission table. */
export type GuidePermissionRow = {
  name: string;
  level: "Read-only" | "Read and write";
  usedFor: string;
};

/** One row in a classic-token scope table. */
export type GuideScopeRow = {
  scope: string;
  usedFor: string;
};

/** One numbered step in a click-path (token creation, auth resolution, …). */
export type GuideStep = {
  title: string;
  detail: string;
};

/** GitHub URLs the guide links out to via `api.openExternal` (the webview is
 *  sandboxed — no `<a target="_blank">`, see `src/mainview/lib/api.ts`). */
export const GITHUB_URLS = {
  fineGrainedTokens: "https://github.com/settings/personal-access-tokens",
  classicTokens: "https://github.com/settings/tokens",
  tokenDocs:
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
} as const;

/**
 * How ForgeOrbit resolves the token used to authenticate a GitHub request, in
 * order — mirrors `githubToken()` in `src/bun/github.ts:856-863` exactly.
 * Keep this in lockstep with that function; it's documentation of real
 * runtime behavior, not aspirational copy.
 */
export const AUTH_RESOLUTION_STEPS: GuideStep[] = [
  {
    get title() { return tr("common.a_token_saved_in_this_settings_section"); },
    get detail() { return tr("settings.forgeorbit_looks_up_the_token_stored_for_6841b6"); },
  },
  {
    get title() { return tr("common.environment_variables"); },
    get detail() { return tr("settings.if_no_token_is_stored_for_the_a51533"); },
  },
  {
    get title() { return tr("common.github_cli_login"); },
    get detail() { return tr("settings.if_neither_of_the_above_resolves_a_7d2a8a"); },
  },
];

/** Recommended classic-token scopes for FULL ForgeOrbit access. */
export const CLASSIC_SCOPES: GuideScopeRow[] = [
  {
    scope: "repo",
    get usedFor() { return tr("settings.pull_requests_issues_comments_reviews_labels_milestones_fa1f5e"); },
  },
  {
    scope: "workflow",
    get usedFor() { return tr("settings.github_actions_re_running_cancelling_and_dispatching_e98414"); },
  },
  {
    scope: "notifications",
    get usedFor() { return tr("settings.the_repo_s_notifications_inbox_and_thread_6f959a"); },
  },
  {
    scope: "project",
    get usedFor() { return tr("common.the_projects_panel_classic_and_projects_v2_boards"); },
  },
  {
    scope: "read:org",
    get usedFor() { return tr("common.org_owned_projects_and_other_org_context_needed"); },
  },
];

/** Fine-grained-token permissions for least-privilege access. All are
 *  Repository permissions unless the row's `usedFor` says otherwise. */
export const FINE_GRAINED_PERMISSIONS: GuidePermissionRow[] = [
  {
    name: "Contents",
    level: "Read and write",
    get usedFor() { return tr("common.merging_pull_requests_applying_review_suggestions_releases_and"); },
  },
  {
    name: "Pull requests",
    level: "Read and write",
    get usedFor() { return tr("settings.listing_creating_merging_closing_drafting_and_auto_90149a"); },
  },
  {
    name: "Issues",
    level: "Read and write",
    get usedFor() { return tr("common.issues_comments_labels_milestones_locking_pinning_transferring_and"); },
  },
  {
    name: "Actions",
    level: "Read and write",
    get usedFor() { return tr("common.listing_re_running_cancelling_and_dispatching_workflow_runs"); },
  },
  {
    name: "Commit statuses",
    level: "Read-only",
    get usedFor() { return tr("common.the_commit_status_panel"); },
  },
  {
    name: "Metadata",
    level: "Read-only",
    get usedFor() { return tr("common.added_automatically_by_github_collaborators_and_repository_info"); },
  },
  {
    name: "Projects (Organization permission)",
    level: "Read and write",
    get usedFor() { return tr("common.org_owned_projects_v2"); },
  },
];

/** What a fine-grained PAT cannot reach in ForgeOrbit, even with every
 *  permission above granted — phrased for the dialog's warning list. */
export const FINE_GRAINED_LIMITATIONS: string[] = [
  tr("common.the_notifications_inbox_github_s_notifications_api_only"),
  "Repository Discussions — there is no fine-grained permission for repo discussions.",
  "Check-run details — the Checks API can't be granted to fine-grained tokens (commit statuses still work).",
  "User-owned (non-organization) Projects.",
];

/** Caveats specific to organization-owned repositories. */
export const ORG_CAVEATS: string[] = [
  tr("common.a_fine_grained_token_used_against_an_organization"),
  "Classic tokens for organizations with SAML SSO enabled must be authorized per-organization via the token's \"Configure SSO\" menu before they'll work against that org's repos.",
  "Organization policies may cap how long any token — classic or fine-grained — is allowed to live.",
];

/** Why the same GitHub identity resolves differently across repos, and how
 *  to run multiple GitHub accounts side by side. */
export const MULTI_ACCOUNT_NOTE: string =
  "Tokens are stored per remote host, not globally. A repo reached through an ssh host " +
  "alias (e.g. git@github-work.com:org/repo.git) authenticates with whatever token is " +
  "stored for that alias host; the github.com entry is the default used for ordinary " +
  "github.com remotes. This is how multiple GitHub identities — a personal account and " +
  "a work account, say — can coexist in the same ForgeOrbit install.";

/** Click-path to create a fine-grained personal access token. */
export const FINE_GRAINED_CREATE_STEPS: GuideStep[] = [
  {
    get title() { return tr("common.open_github_settings_developer_settings"); },
    get detail() { return tr("common.from_your_github_profile_picture_go_to_settings"); },
  },
  {
    get title() { return tr("common.personal_access_tokens_fine_grained_tokens"); },
    get detail() { return tr("common.choose_fine_grained_tokens_then_click_generate_new"); },
  },
  {
    get title() { return tr("common.name_expiration_and_resource_owner"); },
    get detail() { return tr("settings.pick_a_name_and_expiration_set_resource_62fbbe"); },
  },
  {
    get title() { return tr("common.repository_access"); },
    get detail() { return tr("settings.choose_only_select_repositories_and_pick_the_f643aa"); },
  },
  {
    get title() { return tr("common.set_permissions"); },
    get detail() { return tr("common.grant_the_permissions_listed_below_then_click_generate"); },
  },
];

/** Click-path to create a classic personal access token. */
export const CLASSIC_CREATE_STEPS: GuideStep[] = [
  {
    get title() { return tr("common.open_github_settings_developer_settings"); },
    get detail() { return tr("common.from_your_github_profile_picture_go_to_settings"); },
  },
  {
    get title() { return tr("common.personal_access_tokens_tokens_classic"); },
    get detail() { return tr("common.choose_tokens_classic_then_generate_new_token_generate"); },
  },
  {
    get title() { return tr("common.note_and_expiration"); },
    get detail() { return tr("common.give_the_token_a_note_describing_what_it"); },
  },
  {
    get title() { return tr("common.select_scopes"); },
    get detail() { return tr("common.tick_the_scopes_listed_below_then_click_generate"); },
  },
  {
    get title() { return tr("common.saml_sso_organizations"); },
    get detail() { return tr("settings.if_the_token_needs_to_reach_an_618f64"); },
  },
];
