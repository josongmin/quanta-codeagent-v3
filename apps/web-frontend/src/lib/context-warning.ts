/**
 * P2 (jul-10, UUX-4-18) — web context-warning parity with the CLI.
 *
 * The CLI warns when `usedTokens/max` crosses DEFAULT_WINDOW_WARN_RATIO in
 * `src/apps/cli/context-warning.ts`; this mirrors the SAME ratio (lock-step
 * pinned by the sibling test — the constant cannot drift silently). Unknown
 * window (`max <= 0`) NEVER fires, matching the S4 unknown-window gauge
 * posture (an unknown ceiling must not render as "nearly full").
 *
 * Copy is web-honest: the CLI advises /summarize-now (a CLI slash); the web
 * states the fact and what the runtime will do (auto-compaction).
 */

/** Mirror of the CLI's DEFAULT_WINDOW_WARN_RATIO — lock-step test enforced. */
export const CONTEXT_WARN_RATIO = 0.8

export const contextWarningLabel = (
  usage: { readonly total: number; readonly max: number } | null,
): string | null => {
  if (usage === null || usage.max <= 0) return null
  const pct = Math.floor((usage.total / usage.max) * 100)
  if (usage.total < usage.max * CONTEXT_WARN_RATIO) return null
  return `context ${pct}% full — the runtime will compact soon`
}
