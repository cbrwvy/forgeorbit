import { AccountCore } from "./account-core.ts";
import { db } from "./db.ts";
import { TrustedQuotaRefresh } from "./trusted-quota.ts";
import { buildModelRouterResourceContext as assembleContext } from "../shared/model-router/resource-context.ts";

/** Read-only snapshot for Router UI. Never refreshes providers or mutates state. */
export function buildModelRouterResourceContext(now = Date.now()) {
  const core = new AccountCore(db, () => now);
  const trusted = new TrustedQuotaRefresh(core);
  const accounts = core.listAccounts();
  const quotasByAccount = new Map(accounts.map((account) => [account.id, core.currentQuotas(account.id)] as const));
  const trustedSourcesByAccount = new Map(accounts.map((account) => [account.id, trusted.availability(account.id)] as const));
  const harnessRows = db.query<{ id: string; label: string; enabled: number }, []>(
    "SELECT id, label, enabled FROM harnesses ORDER BY id",
  ).all().map((h) => ({ id: h.id, label: h.label, enabled: h.enabled === 1 }));
  return assembleContext({
    capturedAt: now,
    harnesses: harnessRows,
    accounts,
    quotasByAccount,
    trustedSourcesByAccount,
    now,
  });
}
