/**
 * Portfolio refresh signals forwarded from App's single `/app/events`
 * stream. The dashboard never opens its own EventSource.
 */

type Listener = (reason: string) => void;

const listeners = new Set<Listener>();

export function publishPortfolioRefresh(reason: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch (err) {
      console.warn("[agetor] portfolio refresh listener threw", err);
    }
  }
}

export function subscribePortfolioRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
