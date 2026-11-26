import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  AUTH_RESOLUTION_STEPS,
  CLASSIC_CREATE_STEPS,
  CLASSIC_SCOPES,
  FINE_GRAINED_CREATE_STEPS,
  FINE_GRAINED_LIMITATIONS,
  FINE_GRAINED_PERMISSIONS,
  GITHUB_URLS,
  MULTI_ACCOUNT_NOTE,
  ORG_CAVEATS,
  type GuideScopeRow,
  type GuideStep,
} from "@/lib/github-setup-guide";

/** Click-path to create a Bitbucket Atlassian API token, used in place of
 *  the retired (2026-06-09) app-password flow. Stored as a single
 *  `email:api_token` string — Bitbucket's Basic auth format. A *scopeless*
 *  Atlassian API token (the default the Atlassian account UI offers, aimed at
 *  Jira/Confluence) is rejected by api.bitbucket.org — the token must be
 *  created "with scopes" and have the Bitbucket scopes below selected. */
const BITBUCKET_CREATE_STEPS: GuideStep[] = [
  {
    get title() { return tr("common.open_id_atlassian_com_security"); },
    get detail() { return tr("common.sign_in_at_id_atlassian_com_then_choose"); },
  },
  {
    get title() { return tr("common.create_an_api_token_with_scopes"); },
    get detail() { return tr("settings.under_api_tokens_click_create_api_token_921140"); },
  },
  {
    get title() { return tr("common.copy_the_token"); },
    get detail() { return tr("common.click_create_and_copy_the_generated_token_it"); },
  },
  {
    get title() { return tr("common.save_it_as_email_api_token"); },
    get detail() { return tr("settings.back_in_the_git_host_tokens_section_91fba9"); },
  },
];

/** Bitbucket scopes to select when creating the scoped API token above — the
 *  minimum set covering everything this adapter's ~18 call sites touch
 *  (src/bun/bitbucket.ts): repository read/write for PR diffs, statuses, and
 *  merges; pull request and issue read/write; account read to resolve the
 *  viewer (`getBitbucketViewer`, used for the "me"-scoped BBQL filters). */
const BITBUCKET_SCOPES: GuideScopeRow[] = [
  {
    scope: "Repositories: Read, Write",
    get usedFor() { return tr("settings.listing_repos_reading_diffs_commit_statuses_and_edc5b7"); },
  },
  {
    scope: "Pull requests: Read, Write",
    get usedFor() { return tr("settings.listing_creating_merging_declining_and_reviewing_prs_80e6a6"); },
  },
  {
    scope: "Issues: Read, Write",
    get usedFor() { return tr("settings.the_repository_issue_tracker_listing_creating_updating_5184d8"); },
  },
  {
    scope: "Account: Read",
    get usedFor() { return tr("settings.resolving_the_signed_in_account_used_for_9fb471"); },
  },
];

/** Click-path to create a GitLab personal access token. */
const GITLAB_CREATE_STEPS: GuideStep[] = [
  {
    get title() { return tr("common.open_gitlab_edit_profile_access_tokens"); },
    get detail() { return tr("settings.from_your_gitlab_avatar_go_to_edit_b86358"); },
  },
  {
    get title() { return tr("common.name_expiration_and_scope"); },
    get detail() { return tr("common.give_the_token_a_name_and_expiration_then"); },
  },
  {
    get title() { return tr("common.create_and_save_it_in_forgeorbit"); },
    get detail() { return tr("settings.click_create_personal_access_token_and_copy_a9a905"); },
  },
];

const BITBUCKET_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const GITLAB_TOKENS_URL = "https://gitlab.com/-/user_settings/personal_access_tokens";

/**
 * "Connect ForgeOrbit to a git host" instructions modal, opened from
 * `GitHubTokensSection` (the header button and the empty-state link). Purely
 * informational — it does not embed the token form itself, which lives
 * directly behind it in the same Settings section. GitHub copy is sourced
 * from `lib/github-setup-guide.ts`; Bitbucket and GitLab copy is local to
 * this component (smaller, single-consumer guides that don't warrant a
 * shared data module yet). This component supplies section
 * headings/intro sentences and layout.
 */
export function GitHubSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useUILocale();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-2xl"
      labelledBy="github-setup-dialog-title"
      describedBy="github-setup-dialog-desc"
    >
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <h2 id="github-setup-dialog-title" className="text-base font-semibold"><I18nText id="settings.connect_forgeorbit_to_a_git_host" />{" "}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={tr("common.close")}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="max-h-[70vh] space-y-5 overflow-y-auto pt-3 text-sm">
        <section className="space-y-1">
          <p id="github-setup-dialog-desc" className="text-[11px] leading-snug text-muted-foreground"><I18nText id="settings.forgeorbit_talks_to_github_gitlab_and_bitbucket_using" />{" "}</p>
        </section>

        <GuideSection heading="GitHub: how ForgeOrbit finds a token">
          <StepList steps={AUTH_RESOLUTION_STEPS} />
          <p className="text-[11px] leading-snug text-muted-foreground"><I18nText id="settings.bitbucket_and_gitlab_resolve_the_same_way_minus" />{" "}
            <code className="font-mono">BITBUCKET_TOKEN</code>/
            <code className="font-mono">BITBUCKET_EMAIL</code>{" "}<I18nText id="settings.environment_variables_gitlab_tries_a_stored_entry_then" />{" "}<code className="font-mono">GITLAB_TOKEN</code><I18nText id="settings.then_a_stored" />{" "}
            <code className="font-mono">glab</code>{" "}<I18nText id="settings.cli_login" />{" "}</p>
        </GuideSection>

        <GuideSection heading="GitHub — recommended: classic token (full access)">
          <StepList steps={CLASSIC_CREATE_STEPS} />
          <div className="space-y-1.5">
            {CLASSIC_SCOPES.map((row) => (
              <div key={row.scope} className="rounded-md border border-border/60 px-3 py-2">
                <div className="font-mono text-xs">{row.scope}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void api.openExternal(GITHUB_URLS.classicTokens)}><I18nText id="settings.open_github_tokens_classic" />{" "}</Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitHub — alternative: fine-grained token (least privilege)">
          <StepList steps={FINE_GRAINED_CREATE_STEPS} />
          <div className="space-y-1.5">
            {FINE_GRAINED_PERMISSIONS.map((row) => (
              <div key={row.name} className="rounded-md border border-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{staticLabel(row.level)}</span>
                </div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1 rounded-md border border-border/60 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-warning"><I18nText id="settings.not_available_with_fine_grained_tokens" />{" "}</p>
            <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
              {FINE_GRAINED_LIMITATIONS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(GITHUB_URLS.fineGrainedTokens)}
            ><I18nText id="settings.open_github_fine_grained_tokens" />{" "}</Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitHub — working with organizations">
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
            {ORG_CAVEATS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </GuideSection>

        <GuideSection heading="GitHub — multiple accounts">
          <p className="text-[11px] leading-snug text-muted-foreground">{MULTI_ACCOUNT_NOTE}</p>
        </GuideSection>

        <GuideSection heading="Bitbucket: Atlassian API token">
          <StepList steps={BITBUCKET_CREATE_STEPS} />
          <div className="space-y-1.5">
            {BITBUCKET_SCOPES.map((row) => (
              <div key={row.scope} className="rounded-md border border-border/60 px-3 py-2">
                <div className="font-mono text-xs">{row.scope}</div>
                <div className="text-[11px] leading-snug text-muted-foreground">{row.usedFor}</div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(BITBUCKET_TOKENS_URL)}
            ><I18nText id="settings.open_atlassian_api_tokens" />{" "}</Button>
          </div>
        </GuideSection>

        <GuideSection heading="GitLab: personal access token">
          <StepList steps={GITLAB_CREATE_STEPS} />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void api.openExternal(GITLAB_TOKENS_URL)}
            ><I18nText id="settings.open_gitlab_access_tokens" />{" "}</Button>
          </div>
        </GuideSection>

        <GuideSection heading="Save the credential in ForgeOrbit">
          <p className="text-[11px] leading-snug text-muted-foreground"><I18nText id="settings.back_in_this_settings_section_paste_the_host" />{" "}<code className="font-mono">email:api_token</code>{" "}<I18nText id="settings.string_into_the_fields_below_then_click_save" />{" "}</p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="link"
              className="h-auto p-0"
              onClick={() => void api.openExternal(GITHUB_URLS.tokenDocs)}
            ><I18nText id="settings.github_s_token_documentation" />{" "}</Button>
          </div>
        </GuideSection>
      </div>
    </Dialog>
  );
}

function GuideSection({ heading, children }: { heading: string; children: ReactNode }) {
  useUILocale();
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium">{heading}</h3>
      {children}
    </section>
  );
}

function StepList({ steps }: { steps: GuideStep[] }) {
  useUILocale();
  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={step.title} className="rounded-md border border-border/60 px-3 py-2">
          <div className="text-xs font-medium">
            {i + 1}. {step.title}
          </div>
          <div className="text-[11px] leading-snug text-muted-foreground">{step.detail}</div>
        </li>
      ))}
    </ol>
  );
}
