// ---------------------------------------------------------------------------
// src/utils/toast.ts — Fire-and-forget TUI toast adapter for the router.
//
// Centralizes the opencode TUI toast surface behind a tiny helper so every
// terminal-failure call site (delegate / verify / dispatch) shares the same
// defaults, error-handling, and silent-on-missing-TUI contract.
//
// Design (SDD: tui-toast-verification):
//   - Best-effort delivery. A missing `client.tui` surface or a rejected
//     `showToast()` promise MUST NEVER change the delegation / verification
//     outcome — toast failures are swallowed with `.catch(() => {})` and the
//     helper is synchronous (`void`).
//   - Defaults: `title: "Router"`, `variant: "warning"`, `duration: 5000`ms.
//     Operators see a single, recognizable toast prefix; callers only supply
//     the per-call message (and optionally override the variant).
//   - Narrow client interface: the helper reads only `client.tui?.showToast`
//     so it stays decoupled from the rest of the opencode SDK shape and is
//     trivial to mock in unit tests.
//
// Usage:
//   showRouterToast(ctx.plugin.client, { message: "Delegation unmet ..." });
// ---------------------------------------------------------------------------

/** Canonical toast variants accepted by opencode's TUI surface. */
export type RouterToastVariant = "info" | "success" | "warning" | "error";

/** Caller-supplied toast payload. Only `message` is required; the rest
 *  default to router-wide values via `showRouterToast`. */
export interface RouterToastInput {
  message: string;
  variant?: RouterToastVariant;
  title?: string;
  duration?: number;
}

/** Resolved toast body shape after defaults are applied. Matches the
 *  body shape the opencode TUI surface expects. */
export interface RouterToastBody {
  title: string;
  message: string;
  variant: RouterToastVariant;
  duration: number;
}

/** Minimal client shape the helper depends on. Defined inline so this
 *  module does not import `@opencode-ai/plugin` (and its opencode SDK
 *  changes) — only the slice we actually use. */
export interface RouterToastClient {
  tui?: {
    showToast?: (args: { body: RouterToastBody }) => Promise<unknown>;
  };
}

const DEFAULT_TITLE = "Router";
const DEFAULT_VARIANT: RouterToastVariant = "warning";
const DEFAULT_DURATION_MS = 5000;

/** Show a router-attributed TUI toast. Best-effort, never throws.
 *
 *  Contract:
 *    - Returns synchronously — the actual delivery is a fire-and-forget
 *      promise on `client.tui.showToast({ body })`.
 *    - If `client` is undefined, `client.tui` is missing, or `showToast`
 *      is missing, the call is a silent no-op (the TUI surface is optional
 *      per opencode's plugin shape).
 *    - If the underlying `showToast` rejects, the rejection is swallowed
 *      via `.catch(() => {})` — toast failure NEVER changes the primary
 *      delegation / verification outcome.
 *    - If `showToast` synchronously throws (some SDK shapes or test
 *      doubles), the throw is caught and swallowed — toast failure NEVER
 *      escapes the helper regardless of the underlying failure mode.
 *    - Defaults: `title: "Router"`, `variant: "warning"`, `duration: 5000`ms.
 */
export const showRouterToast = (
  client: RouterToastClient | undefined,
  input: RouterToastInput,
): void => {
  const showToast = client?.tui?.showToast;
  if (typeof showToast !== "function") return;
  const body: RouterToastBody = {
    title: input.title ?? DEFAULT_TITLE,
    message: input.message,
    variant: input.variant ?? DEFAULT_VARIANT,
    duration: input.duration ?? DEFAULT_DURATION_MS,
  };
  // Fire-and-forget: never throw, never block the caller. The optional
  // promise chain is intentionally unwrapped with `void` so the return
  // type is unambiguously `void`. The outer try/catch absorbs any
  // synchronous throw from the underlying call so neither the sync nor
  // the async failure mode can escape the helper.
  try {
    void showToast({ body }).catch(() => {});
  } catch {
    // Best-effort swallow: a sync throw from `showToast` MUST NOT
    // change the primary delegation / verification outcome.
  }
};
