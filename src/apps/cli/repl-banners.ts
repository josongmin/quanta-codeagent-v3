/**
 * Pure copy-builders for REPL banners that depend on env-resolved values.
 *
 * Closes the "string drift" bug class: prior to this helper, the REPL hardcoded
 * the human numbers ("60s", "20 consecutive denials") in the banner text while
 * the underlying behavior read from `QUANTA_IDLE_MS` / `QUANTA_REJECT_LIMIT`
 * separately. A user who set `QUANTA_IDLE_MS=30000` would still see "idle 60s"
 * in the auto-pause toast — a UI lie.
 *
 * These helpers interpolate the resolved env value INTO the message so the
 * displayed number always matches the behavior.
 */

/**
 * "[idle Ns — auto-paused. type or /resume]" — N derived from `idleMs`.
 *
 * `idleMs` is the same value the {@link createIdleMonitor} `idleThresholdMs`
 * binding receives (60_000 by default; overridable via `QUANTA_IDLE_MS`).
 * We floor to seconds for human display. A non-finite or non-positive input
 * (defensive) falls back to "idle — auto-paused…" without a stale number.
 */
export const idleBanner = (idleMs: number): string => {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    return "[idle — auto-paused. type or /resume]"
  }
  const seconds = Math.floor(idleMs / 1000)
  return `[idle ${seconds}s — auto-paused. type or /resume]`
}

/**
 * "\n[N consecutive denials — exiting. To re-enable, restart quanta]\n"
 *  — N derived from `rejectLimit`.
 *
 * The leading `\n` + trailing `\n` mirror the pre-cleanup write call exactly
 * so the byte stream is identical when the default (`20`) is used.
 * A non-finite or non-positive input falls back to a generic message that
 * never lies about the threshold.
 */
export const rejectExitBanner = (rejectLimit: number): string => {
  if (!Number.isFinite(rejectLimit) || rejectLimit <= 0) {
    return "\n[consecutive denials reached — exiting. To re-enable, restart quanta]\n"
  }
  return `\n[${Math.floor(rejectLimit)} consecutive denials — exiting. To re-enable, restart quanta]\n`
}
