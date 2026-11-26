import { CodexProfiles } from "./codex-profiles.ts";
import { probeHarnessVersion } from "./agent-status.ts";
import { profileLaunchTarget } from "./launch-target.ts";
import { harnesses } from "./db.ts";
import { ClaudeProfiles } from "./claude-profiles.ts";
import { activeMissionUsesAccount, listExecutionProfiles, listProjectAccountPreferences, noteAuthenticationCheck, setProjectAccountPreference, writeExecutionMeta } from "./multiaccount/registry.ts";
import { CodexSource } from "./codex-source.ts";
import type { CodexEvidenceCollector } from "./codex-evidence.ts";
import { TrustedQuotaRefresh } from "./trusted-quota.ts";
import { AccountCore, AccountCoreError } from "./account-core.ts";
import { LegacyUsageBridge } from "./account-usage-bridge.ts";
import { ACCOUNT_SOURCE_CAPABILITIES, accountSourceCapabilities } from "../shared/accounts/capabilities.ts";
import { allActiveProviderRefusals } from "./provider-refusals.ts";

const MAX_BODY_BYTES = 16 * 1024;
async function body(req: Request): Promise<unknown> {
  if (!req.body) throw new AccountCoreError("JSON body required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AccountCoreError("Body too large.", 413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AccountCoreError("Invalid JSON."); }
  } finally { reader.releaseLock(); }
}
function only(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !(key in value)) throw new AccountCoreError("Invalid association body.");
  const id = (value as Record<string, unknown>)[key];
  if (typeof id !== "string" || !id || id.length > 160) throw new AccountCoreError("Invalid association ID.");
  return id;
}
/** Mounted by the existing Bun server. Authorization is required BEFORE parsing any body. */
export async function accountHttp(req: Request, core: AccountCore, legacy: LegacyUsageBridge, bearerAuthorized: boolean, trusted = new TrustedQuotaRefresh(core), codex = new CodexSource(), evidence: CodexEvidenceCollector | null = null, onQuotaRefresh?: () => void): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (!bearerAuthorized) return reply({ error: "unauthorized" }, 401);
  try {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [, group, id, child, childId] = segments;
    if (segments.length > 5) return reply({ error: "not found" }, 404);
    const method = req.method;
    const cursor = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new AccountCoreError("Invalid history cursor.");
    if (group === "codex-profiles") {
      if ((url.search && !url.searchParams.has("confirm")) || childId || segments.length > 4) throw new AccountCoreError("Invalid profile request.");
      const profiles = new CodexProfiles(core);
      const withTarget = <T extends { harnessId: string }>(view: T) => ({ ...view, launchTarget: profileLaunchTarget(view.harnessId) });
      if (!id && method === "GET") return reply(profiles.list().map(withTarget));
      if (!id && method === "POST") return reply(withTarget(profiles.register(await body(req))), 201);
      if (id && !child && method === "PATCH") return reply(withTarget(profiles.register(await body(req), id)));
      if (id && !child && method === "DELETE") {
        if (activeMissionUsesAccount(core.db, id) && url.searchParams.get("confirm") !== "active") {
          throw new AccountCoreError("This profile is referenced by an active mission. Confirm removal to detach the reference. Credentials are not deleted.", 409);
        }
        profiles.remove(id);
        return reply({ removed: true });
      }
      if (id && child === "check" && method === "POST") {
        const checked = await profiles.check(id);
        noteAuthenticationCheck(core.db, id, checked.authentication, Date.now());
        // The Owner pressed Check: read the version of the executable this profile launches (and remember it).
        const harness = harnesses.get(checked.harnessId);
        if (harness && checked.availability !== "unavailable") await probeHarnessVersion(harness);
        return reply(withTarget(checked));
      }
      return reply({ error: "not found" }, 404);
    }
    if (group === "claude-profiles") {
      if (url.search && !url.searchParams.has("confirm") || childId || segments.length > 4) throw new AccountCoreError("Invalid profile request.");
      const profiles = new ClaudeProfiles(core);
      const withTarget = <T extends { harnessId: string }>(view: T) => ({ ...view, launchTarget: profileLaunchTarget(view.harnessId) });
      if (!id && method === "GET") return reply(profiles.list().map(withTarget));
      if (!id && method === "POST") return reply(withTarget(profiles.register(await body(req))), 201);
      if (id && !child && method === "PATCH") return reply(withTarget(profiles.register(await body(req), id)));
      if (id && !child && method === "DELETE") {
        if (activeMissionUsesAccount(core.db, id) && url.searchParams.get("confirm") !== "active") {
          throw new AccountCoreError("This profile is referenced by an active mission. Confirm removal to detach the reference. Credentials are not deleted.", 409);
        }
        profiles.remove(id);
        return reply({ removed: true });
      }
      if (id && child === "check" && method === "POST") {
        const checked = await profiles.check(id);
        noteAuthenticationCheck(core.db, id, checked.authentication, Date.now());
        const harness = harnesses.get(checked.harnessId);
        if (harness && checked.availability !== "unavailable") await probeHarnessVersion(harness);
        return reply(withTarget(checked));
      }
      return reply({ error: "not found" }, 404);
    }
    if (group === "execution-profiles") {
      if (!id && method === "GET") return reply({ profiles: listExecutionProfiles(core.db), preferences: listProjectAccountPreferences(core.db) });
      if (id && child === "meta" && method === "PUT") {
        core.getAccount(id);
        return reply(writeExecutionMeta(core.db, id, await body(req)));
      }
      if (!id && child === undefined && method === "PUT") return reply({ error: "not found" }, 404);
      return reply({ error: "not found" }, 404);
    }
    if (group === "project-account-preferences" && !id && method === "PUT") {
      const value = await body(req);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountCoreError("Invalid project preference.");
      const row = value as Record<string, unknown>;
      return reply(setProjectAccountPreference(core.db, {
        projectPath: String(row.projectPath ?? ""),
        role: String(row.role ?? ""),
        accountId: row.accountId == null ? null : String(row.accountId),
      }));
    }
    if (group === "codex-source") {
      if (url.search || child || segments.length > 3) throw new AccountCoreError("Invalid connector request.");
      if (!id && method === "GET") return reply(codex.snapshot());
      if (!id && method === "DELETE") return reply(codex.disconnect());
      if (id === "inspect" && method === "POST") {
        const value = await body(req);
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
          || (value as Record<string, unknown>).consent !== true) throw new AccountCoreError("Explicit process consent is required; no other connector options are accepted.");
        return reply(await codex.inspect(true, req.signal));
      }
      return reply({ error: "Account linking and quota acquisition require stable documented subject evidence." }, 409);
    }
    if (group === "quota-sources" && !id && method === "GET") return reply(trusted.catalog());
    if (group === "capabilities" && !id && method === "GET") return reply(Object.fromEntries(Object.keys(ACCOUNT_SOURCE_CAPABILITIES).map(kind => [kind, accountSourceCapabilities(kind)])));
    if (group === "legacy-usage" && !id && method === "GET") return reply(legacy.history(cursor));
    if (group === "legacy-tokens" && !id && method === "GET") return reply(legacy.tokenHistory(cursor));
    if (group === "accounts") {
      if (!id && method === "GET") return reply(core.listAccounts(url.searchParams.get("archived") === "true"));
      if (!id && method === "POST") return reply(core.createAccount(await body(req)), 201);
      if (id && !child) {
        if (method === "GET") return reply(core.getAccount(id));
        if (method === "PATCH") return reply(core.updateAccount(id, await body(req)));
        if (method === "DELETE") { core.archiveAccount(id); return reply({ archived: true }); }
      }
      if (id) {
        core.getAccount(id);
        if (child === "quota-sources" && !childId && method === "GET") return reply(trusted.availability(id));
        if (child === "quota-refresh" && !childId && method === "POST") {
          if (url.search) throw new AccountCoreError("Refresh query parameters are not supported.");
          const refreshed = await trusted.refresh(id, only(await body(req), "sourceId"));
          onQuotaRefresh?.();
          return reply(refreshed);
        }
        if (child === "provider-evidence" && !childId) {
          if (url.search) throw new AccountCoreError("Provider evidence query parameters are not supported.");
          if (!evidence) throw new AccountCoreError("Provider evidence is not configured.", 501);
          if (method === "GET") return reply(evidence.view(id));
          // Manual, consented, one-shot. Never started by a read, a timer or the router.
          if (method === "POST") return reply(await evidence.refresh(id, await body(req), req.signal));
        }
        if (child === "harnesses") {
          if (!childId && method === "GET") return reply(core.bindings(id));
          if (!childId && method === "POST") return reply(core.bindHarness(id, only(await body(req), "harnessId")), 201);
          if (childId && method === "DELETE") { core.unbindHarness(id, childId); return reply({ unbound: true }); }
        }
        if (child === "profiles") {
          if (!childId && method === "GET") return reply(core.associations(id));
          if (!childId && method === "POST") return reply(core.bindProfile(id, only(await body(req), "profileId")), 201);
          if (childId && method === "DELETE") { core.unbindProfile(id, childId); return reply({ unbound: true }); }
        }
        if (child === "subscriptions") {
          if (!childId && method === "GET") return reply(core.subscriptionsFor(id));
          if (!childId && method === "POST") { core.linkSubscription(id, only(await body(req), "subscriptionId")); return reply(core.subscriptionsFor(id), 201); }
          if (childId && method === "DELETE") { core.unlinkSubscription(id, childId); return reply({ unlinked: true }); }
        }
        if (child === "definitions" && !childId && method === "GET") return reply(core.definitions(id, url.searchParams.get("archived") === "true"));
        if (child === "quota-observations" && !childId && method === "POST") return reply(core.recordOwnerPool(id, await body(req)), 201);
        if (child === "quotas" && !childId && method === "GET") return reply(core.currentQuotas(id));
        if (child === "provider-refusals" && !childId && method === "GET") return reply(allActiveProviderRefusals(core.db).filter(refusal => refusal.accountId === id));
        if (child === "models" && !childId && method === "GET") return reply(core.modelCapabilities(id));
      }
    }
    if (group === "subscriptions") {
      if (!id && method === "GET") return reply({ subscriptions: core.listSubscriptions(), commitments: core.commitments() });
      if (!id && method === "POST") return reply(core.createSubscription(await body(req)), 201);
      if (id && !child && method === "GET") {
        const subscription = core.listSubscriptions(true).find(s => s.id === id);
        if (!subscription) throw new AccountCoreError("Subscription not found.", 404);
        return reply(subscription);
      }
      if (id && !child && method === "PATCH") return reply(core.updateSubscription(id, await body(req)));
      if (id && !child && method === "DELETE") { core.archiveSubscription(id); return reply({ archived: true }); }
    }
    if (group === "quotas") {
      if (!id && method === "POST") return reply(core.createDefinition(await body(req)), 201);
      if (id && !child && method === "GET") return reply(core.getDefinition(id));
      if (id && !child && method === "PATCH") return reply(core.updateQuotaThreshold(id, await body(req)));
      if (id && !child && method === "DELETE") { core.archiveDefinition(id); return reply({ archived: true }); }
      if (id && child === "observations" && !childId) {
        if (method === "GET") return reply(core.historyPage(id, cursor));
        if (method === "POST") return reply(core.recordObservation(id, await body(req)), 201);
      }
    }
    if (group === "identity" && !id && method === "GET") return reply(core.resolveIdentity(url.searchParams.get("harnessId") ?? "", url.searchParams.get("profileId")));
    return reply({ error: "not found" }, 404);
  } catch (error) {
    // Never serialize SQLite details, request content, environment or provider errors.
    return reply({ error: error instanceof AccountCoreError ? error.message : "Account operation failed." }, error instanceof AccountCoreError ? error.status : 500);
  }
}
