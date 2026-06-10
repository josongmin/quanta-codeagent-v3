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
  type CrashResumeOffer,
  clearSessionInterrupted,
  crashResumePartialEnabled,
  detectInterruptedSessions,
  markSessionInterrupted,
  type SessionMeta,
  type SessionRootProvider,
} from "@/session"
import { errMessage, logger } from "@/shared"

/**
 * AUDIT #13 (jun-10 silent-failure) — per-session GENERATION token for the L3
 * partial flush. `void flush(partial)` is fire-and-forget by contract (a flush
 * must never block the turn), so a flush that is still in flight when the turn
 * RESOLVES could otherwise land AFTER the resolve path's clear — re-instating
 * the interrupted marker on a cleanly-completed session AND rolling the
 * snapshot back to the state its stale read-modify-write loaded.
 *
 * Fence: each flush MINTS the session's current epoch at dispatch; the resolve
 * path ({@link withCrashResumeMarker}'s `finally`) and the partial-subscription
 * disposer BUMP it. The probe is threaded into the store write (`staleIf`,
 * evaluated inside the store's serialized RMW critical section, between load
 * and save), so a stale flush is DISCARDED — not merely reordered — and the
 * last state written is always the newest state.
 *
 * The map holds one small integer per session id seen by this process (bounded;
 * epochs are relative, so a fresh entry starting at 0 is always correct).
 */
const partialFlushEpochs = new Map<string, number>()

const currentFlushEpoch = (sessionId: string): number => partialFlushEpochs.get(sessionId) ?? 0

const bumpFlushEpoch = (sessionId: string): void => {
  partialFlushEpochs.set(sessionId, currentFlushEpoch(sessionId) + 1)
}

/** Staleness probe handed to a partial-flush impl (AUDIT #13). `isStale()`
 *  flips true once the turn resolved or the subscription was disposed — a
 *  custom impl SHOULD thread it into its write (the default impl forwards it
 *  to the store's `staleIf` seam) so an in-flight stale write is discarded. */
export interface PartialFlushContext {
  readonly isStale: () => boolean
}

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
  const opts = {
    env: args.env,
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
  }
  const at = (args.now ?? Date.now)()
  await markSessionInterrupted(
    args.sessionId,
    { userText: args.userText, partialAssistantText: "", reason: "in-progress", interruptedAt: at },
    opts,
  )
  try {
    return await fn()
  } finally {
    // AUDIT #13 resolve fence: invalidate every outstanding partial flush
    // BEFORE clearing. A flush still in flight trips its `staleIf` probe inside
    // the store's serialized RMW and is DISCARDED — it can never land after
    // this clear and re-instate the marker / roll the snapshot back.
    bumpFlushEpoch(args.sessionId)
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

/** A minimal subscribable session — `RuntimeSession.subscribe` satisfies it.
 *  Only the two event shapes the partial-flush cares about are typed. */
interface PartialFlushSession {
  subscribe(
    listener: (event: { readonly type: string; readonly delta?: string }) => void,
  ): () => void
}

/**
 * ADR-0528 L3 (P2, gate `QUANTA_CRASH_RESUME_PARTIAL`) — keep the persisted
 * marker's `partialAssistantText` FRESH during a long turn so a hard crash
 * recovers the in-flight progress, not just the task intent.
 *
 * STRUCTURAL seam (no polling, no magic interval): subscribe to the live session
 * event stream, ACCUMULATE `turn.output.delta` text, and FLUSH the accumulated
 * partial to the marker on each `tool.invoked` boundary — i.e. right BEFORE the
 * agent runs a tool, which is the riskiest crash window (a long/hung tool can
 * SIGKILL the process). Event-driven ⇒ bounded writes (one per tool call), no
 * per-token churn. Returns the unsubscribe fn (call it at turn resolve).
 *
 * Gate-gated: when `QUANTA_CRASH_RESUME_PARTIAL` (⊃ `QUANTA_CRASH_RESUME`) is
 * off, this NEVER subscribes and returns a no-op disposer (byte-identical). The
 * flush impl is injectable for tests; the default updates the marker via
 * `markSessionInterrupted` (best-effort, NEVER throws).
 */
export const attachCrashResumePartial = (
  session: PartialFlushSession,
  args: CrashResumeMarkerArgs,
  flushImpl?: (partial: string, ctx: PartialFlushContext) => Promise<void>,
): (() => void) => {
  if (!crashResumePartialEnabled(args.env)) return () => undefined
  const opts = {
    env: args.env,
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
  }
  const flush =
    flushImpl ??
    ((partial: string, ctx: PartialFlushContext) =>
      markSessionInterrupted(
        args.sessionId,
        {
          userText: args.userText,
          partialAssistantText: partial,
          reason: "in-progress",
          interruptedAt: (args.now ?? Date.now)(),
        },
        { ...opts, staleIf: ctx.isStale },
      ))
  let partial = ""
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn.output.delta") {
      partial += event.delta ?? ""
    } else if (event.type === "tool.invoked" && partial.length > 0) {
      // AUDIT #13: fire-and-forget by contract, but EPOCH-FENCED — the flush
      // mints the session's current generation; if the turn resolves (or the
      // subscription is disposed) while this write is still in flight, the
      // probe trips inside the store's serialized RMW and the write is
      // discarded. The `.catch` keeps a rejecting custom impl from becoming an
      // unhandled rejection (best-effort durability, NEVER throws).
      const minted = currentFlushEpoch(args.sessionId)
      void flush(partial, {
        isStale: () => currentFlushEpoch(args.sessionId) !== minted,
      }).catch((e) => {
        logger.warn("crash-resume: partial flush failed", {
          sessionId: args.sessionId,
          error: errMessage(e),
        })
      })
    }
  })
  return () => {
    // Dispose fence (AUDIT #13): anything still in flight is now stale.
    bumpFlushEpoch(args.sessionId)
    unsubscribe()
  }
}

/**
 * Split startup offers into the one for the CURRENTLY-launching session (`own` —
 * safe to AUTO RE-INJECT, e.g. `quanta --resume X` where X crashed mid-turn) vs
 * the rest (`others` — different sessions, surface-only; the user resumes them
 * via `--resume <id>`). CRITICAL correctness fence: a stranger session's task
 * must NEVER be re-injected into the current session — only `own` is a reinject
 * candidate. Pure.
 */
export const selectCrashResumeReinject = (
  offers: readonly CrashResumeOffer[],
  currentSessionId: string | undefined,
): { own?: CrashResumeOffer; others: CrashResumeOffer[] } => {
  const own =
    currentSessionId === undefined
      ? undefined
      : offers.find((o) => o.sessionId === currentSessionId)
  const others = offers.filter((o) => o.sessionId !== currentSessionId)
  return own !== undefined ? { own, others } : { others }
}
