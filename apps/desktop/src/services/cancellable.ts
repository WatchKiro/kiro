/**
 * Runs a native command that the Rust core can abort by request id.
 *
 * `start` receives a fresh request id to pass to the command. When `signal`
 * aborts, the returned promise rejects with `signal.reason` straight away and
 * `cancel` asks the core to abort the command (best effort: if the command
 * already finished, its result is simply discarded).
 */
export function cancellable<T>(
  signal: AbortSignal,
  start: (requestId: string) => Promise<T>,
  cancel: (requestId: string) => Promise<unknown>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);

  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
      cancel(requestId).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    start(requestId)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
