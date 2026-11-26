/**
 * A link, not an action: ask the app to open Settings on the accounts panel. Nothing is saved, checked
 * or launched by following it. Used by the provider-refusal notice wherever the notice is shown outside
 * Settings (the Head chat, the task panel, the launch preflight).
 */
export const OPEN_ACCOUNTS_EVENT = "forgeorbit:open-accounts";

export function requestOpenAccounts(): void {
  try { window.dispatchEvent(new CustomEvent(OPEN_ACCOUNTS_EVENT)); } catch { /* no window: nothing to open */ }
}

export function onOpenAccountsRequest(handler: () => void): () => void {
  window.addEventListener(OPEN_ACCOUNTS_EVENT, handler);
  return () => window.removeEventListener(OPEN_ACCOUNTS_EVENT, handler);
}
