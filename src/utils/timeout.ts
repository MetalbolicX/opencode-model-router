// ---------------------------------------------------------------------------
// src/utils/timeout.ts — Promise timeout helper for SDK calls.
//
// Wraps a promise with a timeout so the caller never hangs indefinitely.
// The timer is always cleaned up via finally, even on success or rejection.
// ---------------------------------------------------------------------------

export const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const race = Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
  try {
    return await race;
  } finally {
    clearTimeout(timer!);
  }
};