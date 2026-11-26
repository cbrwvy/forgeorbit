import { staticLabel } from "@/i18n/presentation";
import { t as tr } from "@/i18n/core";
import { I18nText, useLocale as useUILocale } from "@/i18n/react";
import { useEffect, useState } from "react";
import { BookOpen, Trash2 } from "lucide-react";
import { api, type GitHubTokensResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IDENTIFIER_INPUT_PROPS } from "@/lib/identifier-input";
import { GitHubSetupDialog } from "@/components/settings/GitHubSetupDialog";
import { GIT_HOST_TOKENS_SECTION } from "../../../shared/types.ts";

const DATALIST_ID = "github-token-hosts";

const EMPTY: GitHubTokensResult = { tokens: [], detectedHosts: [] };

/**
 * "Git host tokens" Settings section — lists stored per-host credentials and
 * lets the user add/replace or delete one. One shared store serves GitHub,
 * GitLab, and Bitbucket: entries are keyed by the raw remote host, which may
 * be a plain provider domain (github.com, gitlab.com, bitbucket.org) or an
 * ssh alias host (e.g. `github-work.com`, `bitbucket-work.com`) — the
 * provider domains act as the default entry used when no alias-specific
 * credential exists for that provider. GitHub and GitLab use a plain PAT;
 * Bitbucket expects Basic auth entered as a single `email:api_token` string
 * (an Atlassian API token, not the retired app-password format). The raw
 * credential is never returned by the API — only a redacted `tokenPreview`
 * — so the add-form input is always cleared (never re-populated) after a
 * successful save.
 */
export function GitHubTokensSection() {
  useUILocale();
  const [data, setData] = useState<GitHubTokensResult>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingHost, setDeletingHost] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listGitHubTokens();
      setData(result);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const storedHosts = new Set(data.tokens.map((t) => t.host));
  const hostsWithoutToken = data.detectedHosts.filter((h) => !storedHosts.has(h));

  const save = async () => {
    const trimmedHost = host.trim().toLowerCase();
    if (!trimmedHost) {
      setSaveError("Host is required");
      return;
    }
    if (!token.trim()) {
      setSaveError("Token is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.setGitHubToken({
        host: trimmedHost,
        token: token.trim(),
        label: label.trim() || null,
      });
      setData(result);
      setHost("");
      setToken("");
      setLabel("");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (h: string) => {
    setDeletingHost(h);
    setDeleteError(null);
    try {
      const result = await api.deleteGitHubToken(h);
      if (result.ok) {
        await refresh();
      }
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingHost(null);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <label className="text-xs text-muted-foreground">{staticLabel(GIT_HOST_TOKENS_SECTION)}</label>
          <p className="text-[length:var(--text-caption)] leading-snug text-muted-foreground"><I18nText id="settings.repos_reached_through_an_ssh_host_alias_git" />{" "}<code className="font-mono">email:api_token</code>.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setGuideOpen(true)}
          className="shrink-0"
        >
          <BookOpen className="mr-1 size-3.5" />{" "}<I18nText id="settings.setup_guide" />{" "}</Button>
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-danger">
          {loadError}
        </div>
      )}

      {!loading && (
        <div className="space-y-1.5">
          {data.tokens.map((t) => (
            <div
              key={t.host}
              className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{t.host}</span>
                  {t.label && (
                    <span className="truncate text-[length:var(--text-caption)] text-muted-foreground">{t.label}</span>
                  )}
                </div>
                <div className="truncate font-mono text-[length:var(--text-caption)] text-muted-foreground">
                  {t.tokenPreview}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void remove(t.host)}
                disabled={deletingHost === t.host}
                aria-label={tr("common.delete_token_for", { p0: String(t.host) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {data.tokens.length === 0 && (
            <p className="text-xs text-muted-foreground"><I18nText id="settings.no_tokens_stored_yet" />{" "}
              <button
                type="button"
                onClick={() => setGuideOpen(true)}
                className="text-primary underline-offset-4 hover:underline"
              ><I18nText id="settings.how_to_create_one" />{" "}</button>
            </p>
          )}
          {hostsWithoutToken.map((h) => (
            <div
              key={h}
              className="flex items-center gap-2 rounded-md border border-dashed border-border/40 px-3 py-2 opacity-60"
            >
              <div className="min-w-0 flex-1 truncate">{h}</div>
              <span className="text-[length:var(--text-caption)] uppercase text-muted-foreground"><I18nText id="settings.no_token_yet" /></span>
            </div>
          ))}
        </div>
      )}

      {deleteError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-danger">
          {deleteError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground"><I18nText id="settings.host" /></label>
          <Input
            {...IDENTIFIER_INPUT_PROPS}
            // Keeps the detected-hosts <datalist> working — see identifier-input.ts.
            autoComplete={undefined}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="github.com / gitlab.com / bitbucket.org"
            list={DATALIST_ID}
          />
          <datalist id={DATALIST_ID}>
            {data.detectedHosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground"><I18nText id="settings.label_optional" /></label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={tr("settings.work_account")}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground"><I18nText id="settings.token" /></label>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_… / glpat-… / email:api_token"
          autoComplete="off"
        />
      </div>

      {saveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-danger">
          {saveError}
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? tr("common.saving_23e392") : tr("common.save_token")}
        </Button>
      </div>

      <GitHubSetupDialog open={guideOpen} onClose={() => setGuideOpen(false)} />
    </section>
  );
}
