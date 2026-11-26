import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { getLocale, t } from "@/i18n/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LaunchTarget } from "@/components/ui/launch-target";
import { ProviderRefusalNotice } from "@/components/ui/provider-refusal-notice";
import type { CodexProfileView } from "../../../shared/accounts/codex-profile.ts";

/** Passive reads never start Codex. Only an explicit Check starts login status. */
export function CodexProfiles({ onChanged }: { onChanged: () => Promise<void> }) {
  const [profiles, setProfiles] = useState<CodexProfileView[]>([]);
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.accountCore.codexProfiles().then(setProfiles).catch(() => setError(t("codex_profiles.failed"))); }, []);
  const run = async (action: () => Promise<unknown>, refresh = false) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await action();
      if (refresh) { setProfiles(await api.accountCore.codexProfiles()); await onChanged(); }
    } catch (caught) {
      const validation = caught instanceof ApiError && caught.status >= 400 && caught.status < 500;
      setError(validation ? (getLocale() === "en" ? caught.message : t("codex_profiles.failed")) : t("errors.server"));
    }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border p-3" data-testid="codex-profiles" aria-label={t("codex_profiles.title")}>
    <h3 className="text-sm font-semibold">{t("codex_profiles.title")}</h3>
    <p className="text-xs text-muted-foreground">{t("codex_profiles.hint")}</p>
    {error && <p role="alert" className="text-xs text-destructive" data-testid="codex-profile-error">{error}</p>}
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(null); setName(""); setDirectory(""); }} data-testid="codex-profile-add">{t("codex_profiles.add")}</Button>
    {editing !== undefined && <form className="space-y-2" onSubmit={e => {
      e.preventDefault(); void run(async () => { await api.accountCore.registerCodexProfile({ displayName: name, directory }, editing ?? undefined); setEditing(undefined); }, true);
    }}>
      <label className="block text-xs">{t("codex_profiles.name")}<Input data-testid="codex-profile-name" value={name} onChange={e => setName(e.target.value)} required maxLength={160} /></label>
      <label className="block text-xs">{t("codex_profiles.directory")}<Input data-testid="codex-profile-directory" value={directory} onChange={e => setDirectory(e.target.value)} required spellCheck={false} /></label>
      <Button size="sm" type="submit" disabled={busy} data-testid="codex-profile-save">{t("codex_profiles.save")}</Button>{" "}
      <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditing(undefined)}>{t("common.cancel")}</Button>
    </form>}
    {profiles.map(p => <article key={p.accountId} className="space-y-2 rounded-lg border p-3" data-testid="codex-profile-card" data-account-id={p.accountId}>
      <h4 className="text-sm font-medium">{p.displayName}</h4>
      <p className="break-all text-xs">CODEX_HOME: {p.directory}</p>
      <p className="text-xs" data-testid="codex-profile-status">{p.providerRefusal && p.availability === "ready" ? t("codex_profiles.signed_in_refused") : t(`codex_profiles.${p.availability}`)}</p>
      {p.launchTarget && <LaunchTarget facts={p.launchTarget} testId="codex-profile-launch-target" />}
      {p.providerRefusal && <ProviderRefusalNotice refusal={p.providerRefusal} accountLabel={p.displayName} testId="codex-profile-refusal" className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs" />}
      <p className="text-xs text-muted-foreground">{t("codex_profiles.quota")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} data-testid="codex-profile-check" onClick={() => void run(async () => {
          const checked = await api.accountCore.checkCodexProfile(p.accountId);
          setProfiles(rows => rows.map(row => row.accountId === p.accountId ? checked : row));
        })}>{t("codex_profiles.check")}</Button>
        <Button size="sm" variant="outline" disabled={busy} data-testid="codex-profile-edit" onClick={() => { setEditing(p.accountId); setName(p.displayName); setDirectory(p.directory); }}>{t("codex_profiles.edit")}</Button>
        <Button size="sm" variant="ghost" disabled={busy} data-testid="codex-profile-remove" onClick={() => void run(() => api.accountCore.removeCodexProfile(p.accountId), true)}>{t("codex_profiles.remove")}</Button>
      </div>
      <details className="text-xs"><summary>{t("codex_profiles.setup")}</summary><p className="my-2 text-muted-foreground">{t("codex_profiles.setup_hint")}</p><code className="block break-all select-text">{p.setupCommand}</code></details>
    </article>)}
  </section>;
}
