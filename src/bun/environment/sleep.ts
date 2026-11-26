/** Resolves when `ms` elapses or when `signal` aborts — abort is not an error. */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
  });
}
