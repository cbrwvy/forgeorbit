import { useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import { t } from "@/i18n/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { when } from "@/lib/accounts";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import type { ExecutionProfile } from "../../../shared/accounts/execution-profile.ts";

function quotaText(profile: ExecutionProfile): string {
  if (profile.quota.status === "verified" && profile.quota.remaining != null) {
    return `${t("multiaccount.quota_verified")}: ${profile.quota.remaining} ${profile.quota.unit ?? ""}`.trim();
  }
  if (profile.quota.status === "observed") return t("multiaccount.quota_observed");
  return t("multiaccount.quota_unknown");
}

export function ExecutionProfileList({ profiles, renderActions }: {
  profiles: ExecutionProfile[];
  renderActions?: (profile: ExecutionProfile) => ReactNode;
}) {
  const groups = new Map<string, ExecutionProfile[]>();
  for (const profile of profiles) {
    const rows = groups.get(profile.provider) ?? [];
    rows.push(profile);
    groups.set(profile.provider, rows);
  }
  return <div className="space-y-4" data-testid="execution-profile-list">
    {profiles.length === 0 && <p className="text-xs text-muted-foreground">{t("multiaccount.none")}</p>}
    {[...groups.entries()].map(([provider, rows]) => <section key={provider} className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide">{provider}</h4>
      {rows.map((profile) => <article key={profile.accountId} className="ds-panel min-w-0 space-y-2 p-3 [overflow-wrap:anywhere]" data-testid="execution-profile-card" data-account-id={profile.accountId} data-support={profile.support}>
        <h5 className="text-sm font-medium">{profile.displayName}</h5>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={profile.authentication === "authenticated" ? "success" : profile.authentication === "required" ? "warning" : "secondary"} data-testid="execution-profile-auth">
            {t(`multiaccount.auth.${profile.authentication}`)}
          </Badge>
          <p className="text-sm" data-testid="execution-profile-quota">{t("multiaccount.quota")}: {quotaText(profile)}</p>
        </div>
        <details className="space-y-1 text-muted-foreground">
          <summary className="cursor-pointer text-xs">{t("multiaccount.profileDetails")}</summary>
          <p className="text-xs">{profile.authProfile.mechanism}: {profile.authProfile.path}</p>
          <p className="text-xs" data-testid="execution-profile-subject">{t("multiaccount.verified_identity")}: {profile.verifiedSubject ?? t("multiaccount.unknown")}</p>
          <p className="text-xs">{t("multiaccount.configured_identity")}: {profile.configuredIdentity ?? t("multiaccount.unknown")} ({profile.subjectLabel})</p>
          <p className="text-xs">{t("multiaccount.readiness")}: {t(`multiaccount.readiness.${profile.readiness}`)}{profile.support === "partial" ? ` · ${t("multiaccount.supportPartial")}` : ""}</p>
          <p className="text-xs">{t("multiaccount.models")}: {profile.models.map((model) => `${model.id} (${model.eligibility})`).join(", ") || t("multiaccount.unknown")}</p>
          <p className="text-xs text-muted-foreground">{t("multiaccount.last_verified")}: {when(profile.lastVerifiedAt)}. {t("multiaccount.not_a_grant")}</p>
        </details>
        {profile.blockers.map((blocker) => <p key={blocker} className="text-xs text-destructive">{blocker}</p>)}
        {profile.limitations.map((line) => <p key={line} className="text-xs text-muted-foreground" data-testid="execution-profile-limitation">{line}</p>)}
        {renderActions?.(profile)}
      </article>)}
    </section>)}
  </div>;
}

/** Owner registration for a Claude config directory. Codex registration stays in CodexProfiles. */
export function ExecutionProfiles({ refreshKey = 0 }: { refreshKey?: number }) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<ExecutionProfile[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.accountCore.executionProfiles().then((result) => setProfiles(result.profiles)).catch(() => setError(t("multiaccount.failed")));
  useEffect(() => { void load(); }, [refreshKey]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await load(); } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("multiaccount.failed"));
    } finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border p-3" data-testid="execution-profiles" aria-label={t("multiaccount.title")}>
    <h3 className="text-sm font-semibold">{t("multiaccount.title")}</h3>
    <p className="text-xs text-muted-foreground">{t("multiaccount.hint")}</p>
    <details className="space-y-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t("multiaccount.profileDetails")}</summary>
      <p>{t("multiaccount.partial")}</p>
      <p>{t("multiaccount.no_fallback")}</p>
    </details>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Button size="sm" variant="outline" disabled={busy} data-testid="claude-profile-add" onClick={() => { setOpen(true); setAccepted(false); }}>{t("multiaccount.add_claude")}</Button>
    {open && <form className="space-y-2" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => { await api.accountCore.registerClaudeProfile({ displayName: name, directory, homeAccessAccepted: accepted }); setOpen(false); });
    }}>
      <label className="block text-xs">{t("codex_profiles.name")}<Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} data-testid="claude-profile-name" /></label>
      <label className="block text-xs">{t("multiaccount.directory")}<Input value={directory} onChange={(event) => setDirectory(event.target.value)} required spellCheck={false} data-testid="claude-profile-directory" /></label>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} data-testid="claude-profile-acceptance" />{t("multiaccount.home_acceptance")}</label>
      <p className="text-xs text-muted-foreground">{t("multiaccount.home_acceptance_hint")}</p>
      <Button size="sm" type="submit" disabled={busy} data-testid="claude-profile-save">{t("multiaccount.save")}</Button>
    </form>}
    <ExecutionProfileList profiles={profiles} renderActions={(profile) => {
      const consentRequired = profile.kind === "claude" && profile.homeAccessAccepted === false;
      return <>
        {consentRequired && <div className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">{t("multiaccount.home_acceptance_hint")}</p>
          <Button size="sm" disabled={busy} onClick={() => void run(() => api.accountCore.acceptClaudeHomeAccess(profile.accountId))}>
            {t("multiaccount.accept_home_access")}
          </Button>
        </div>}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" variant="outline" disabled={busy || consentRequired} onClick={() => void run(() => profile.kind === "claude" ? api.accountCore.checkClaudeProfile(profile.accountId) : api.accountCore.checkCodexProfile(profile.accountId))}>{t("multiaccount.check")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.accountCore.updateExecutionMeta(profile.accountId, { disabled: !profile.disabled }))}>{profile.disabled ? t("multiaccount.enable") : t("multiaccount.disable")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
            let confirmActive = false;
            try {
              if (profile.kind === "claude") await api.accountCore.removeClaudeProfile(profile.accountId);
              else await api.accountCore.removeCodexProfile(profile.accountId);
              return;
            } catch (caught) {
              if (!(caught instanceof ApiError) || caught.status !== 409) throw caught;
              confirmActive = await confirm({ title: t("multiaccount.remove"), description: t("multiaccount.remove_active"), variant: "destructive" });
              if (!confirmActive) return;
            }
            if (profile.kind === "claude") await api.accountCore.removeClaudeProfile(profile.accountId, true);
          })}>{t("multiaccount.remove")}</Button>
        </div>
      </>;
    }} />
  </section>;
}
