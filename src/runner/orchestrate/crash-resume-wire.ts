/**
 * ADR-0528 — crash-resume LIVE wiring (runner composition layer).
 *
 * ADR-0525 built the §13.2 persistence module (`@/session` crash-resume:
 * mark/clear/detect/offer) but left it UNWIRED — no live caller. This module is
 * that wiring. It lives in the runner orchestration layer because that is the
 * only seam that may import BOTH `@/agent` (the turn loop) and `@/session` (the
 * store) — the `@/agent` slice is fenced off from `@/session`, so the marker
 * cannot be persisted from inside the loop itself.
 *
 * Contract (mirrors ADR-0525's gate semantics):
 *   - {@link withCrashResumeMarker} persists an `in-progress` marker BEFORE the
 *     turn body runs (so a process death ANYWHERE inside the turn is
 *     recoverable on the next restart) and clears it once the turn resolves —
 *     reaching the `finally` proves the process SURVIVED, so it is not a crash.
 *     Only a hard process death (SIGKILL / OOM / power loss) between the mark
 *     and the clear leaves the marker behind, which is exactly the crash window
 *     the restart-detection recovers.
 *   - {@link bootstrapCrashResumeOffers} turns the restart-time detection into
 *     operator-facing offers (the host bootstrap calls this).
 *
 * GATE (default-OFF): every persistence op delegates to the `@/session`
 * crash-resume functions, which are NO-OPs unless `QUANTA_CRASH_RESUME` is on
 * (read via the injected `env`). So when the gate is absent this wrapper is a
 * transparent pass-through: it runs `fn` and writes nothing — byte-identical to
 * the unwired turn path. NEVER throws on the mark/clear path (durability, not
 * correctness) — `fn`'s own result/throw propagates unchanged.
 */

import {
  buildCrashResumeOffer,
  clearSessionInterrupted,
  type CrashResumeOffer,
  detectInterruptedSessions,
  markSessionInterrupted,
  type SessionMeta,
  type SessionRootProvider,
} from "@/session"

/** Inputs for {@link withCrashResumeMarker}. `now` is INJECTED (ADR-0525 keeps
 *  the clock out of the pure module); defaults to wall-clock for live callers. */
export interface CrashResumeMarkerArgs {
  readonly sessionId: string
  /** The user prompt that started this turn (the recoverable task intent). */
  readonly userText: string
  /** Threaded from the composition root — the `@/session` slice is env-pure. */
  readonly env: Record<string, string | undefined>
  readonly provider?: SessionRootProvider
  readonly now?: () => number
}

/**
 * Run `fn` (the turn) bracketed by a persisted crash-resume marker: mark
 * in-progress BEFORE, clear AFTER (in `finally`, so a throw still clears since
 * reaching `finally` means the process survived). Returns `fn`'s result; its
 * throw propagates unchanged. The mark/clear are best-effort + gate-gated, so
 * when `QUANTA_CRASH_RESUME` is off this is a transparent `await fn()`.
 */
export const withCrashResumeMarker = async <T>(
  args: CrashResumeMarkerArgs,
  fn: () => Promise<T>,
): Promise<T> => {
  const opts = { env: args.env, ...(args.provider !== undefined ? { provider: args.provider } : {}) }
  const at = (args.now ?? Date.now)()
  await markSessionInterrupted(
    args.sessionId,
    { userText: args.userText, partialAssistantText: "", reason: "in-progress", interruptedAt: at },
    opts,
  )
  try {
    return await fn()
  } finally {
    await clearSessionInterrupted(args.sessionId, opts)
  }
}

/**
 * Restart-time bootstrap: detect sessions that died mid-turn and turn each into
 * an operator-facing resume offer (most-recent-first). The host presents the
 * offer(s); accepting re-injects `offer.resumeMessage`. Gate-gated: returns
 * `[]` when `QUANTA_CRASH_RESUME` is off (no I/O). NEVER throws.
 */
export const bootstrapCrashResumeOffers = async (
  candidates: readonly SessionMeta[],
  opts: { env: Record<string, string | undefined>; provider?: SessionRootProvider },
): Promise<CrashResumeOffer[]> => {
  const detections = await detectInterruptedSessions(candidates, opts)
  return detections.map(buildCrashResumeOffer)
}
