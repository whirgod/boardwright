// Polls the server until stopped. Replace with the Match stream once #9 lands.

export interface PollOptions<T> {
  readonly load: () => Promise<T>;
  readonly onValue: (value: T) => void;
  readonly onError: (error: unknown) => void;
  /** Stop polling once this returns true for a loaded value (e.g. a finished Match). */
  readonly done?: (value: T) => boolean;
  readonly intervalMs: number;
  readonly signal: AbortSignal;
}

/**
 * Loads immediately, then `intervalMs` after each load finishes (never two
 * loads at once). Errors are reported and polling continues.
 */
export function poll<T>(options: PollOptions<T>): Promise<void> {
  const { load, onValue, onError, done, intervalMs, signal } = options;
  return new Promise((resolve) => {
    let timer: number | undefined;
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    const tick = async () => {
      if (signal.aborted) return;
      try {
        const value = await load();
        if (signal.aborted) return;
        onValue(value);
        if (done?.(value)) {
          signal.removeEventListener("abort", stop);
          resolve();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        onError(error);
      }
      timer = setTimeout(tick, intervalMs);
    };
    if (signal.aborted) resolve();
    else tick();
  });
}
