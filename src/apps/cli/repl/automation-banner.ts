/**
 * ADR-0280 — REPL inbox banner.
 *
 * Tiny helper that paints `[inbox: N]` on stderr after each tick that
 * produces a fire / errored outcome. Pure stderr (stdout stays clean
 * for headless / batch modes — banner emission MUST NOT pollute the
 * agent's structured output channel).
 *
 * Wiring: the composition root constructs an `InboxBanner` over the
 * engine (so the banner can query the unread count) and passes the
 * banner's `onTick` into `assembleAutomation`'s `deps.onTick` — or
 * composes the two observers (engine's default + banner's) inside the
 * apps/cli surface.
 *
 * NO-OP fallback: when called without an engine, returns a no-op
 * `paint()` so callers that forgot the env gate still pay zero cost.
 */

import type {
  AutomationEnginePort,
  InboxItem,
  TickOutcome,
} from "@/scheduler/automation-engine"

/** Public surface — what the host calls to paint or to subscribe to ticks. */
export interface InboxBanner {
  /** Force a paint (e.g. session-start, after `/inbox` reads). Reads the
   *  current unread count from the engine and emits the banner line. */
  paint(): Promise<void>
  /** Pass-through to `assembleAutomation`'s `onTick` — paint only on
   *  fire/errored outcomes (idle / engine-error are no-ops). */
  onTick(outcome: TickOutcome): void
  /** Last emitted unread count — observable for tests/observability.
   *  `null` until first paint. */
  readonly lastCount: number | null
}

/** Opts — `engine` is the only required dep; `stderr` and `unreadCounter`
 *  are test seams. */
export interface InboxBannerOpts {
  readonly engine: AutomationEnginePort
  /** Stderr writer. Default `process.stderr.write`. */
  readonly stderr?: (s: string) => void
  /** Inject the unread counter — production wires either the in-memory
   *  inspection seam (`engine.inbox` filtered by `read===false`) or the
   *  sqlite helper (`listInboxItems(db)`). Default uses the in-memory
   *  shape via duck-typing — engines that don't expose `inbox` produce
   *  count=0 (the banner becomes silent but never throws). */
  readonly unreadCounter?: () => Promise<number>
}

/**
 * Build an `InboxBanner`. The default `unreadCounter` reads
 * `engine.inbox` (duck-typed — present on the in-memory engine; absent
 * on the bare port). For sqlite, the composition root injects a
 * `unreadCounter` that calls `listInboxItems(db)` and filters by
 * `read === false`.
 *
 * Single-line stderr emission: `[automation inbox: 3]\n` — no ANSI
 * colors, no clearing, no positioning. The surface's pill chrome is
 * NOT modified; this is intentionally a lo-fi banner that any TTY can
 * render.
 */
export const createInboxBanner = (opts: InboxBannerOpts): InboxBanner => {
  const stderrWrite = opts.stderr ?? ((s: string): void => void process.stderr.write(s))
  const counter = opts.unreadCounter ?? defaultUnreadCounter(opts.engine)
  let lastCount: number | null = null

  const paint = async (): Promise<void> => {
    let count = 0
    try {
      count = await counter()
    } catch {
      // No-throw: a failed count means we skip this paint, not crash
      // the REPL. The next tick / paint will try again.
      return
    }
    if (count <= 0) {
      // Don't paint empty banners — the operator's stderr stays quiet
      // until there's actually something to notice.
      lastCount = 0
      return
    }
    lastCount = count
    stderrWrite(`[automation inbox: ${count}]\n`)
  }

  return {
    paint,
    onTick: (outcome: TickOutcome): void => {
      if (outcome.kind === "fired" || outcome.kind === "errored") {
        void paint()
      }
    },
    get lastCount(): number | null {
      return lastCount
    },
  }
}

/** Default unread counter — duck-typed read of `engine.inbox`. Engines
 *  that don't expose the inspection array always report 0 (banner becomes
 *  silent). */
const defaultUnreadCounter = (engine: AutomationEnginePort): (() => Promise<number>) => {
  const inboxLike = (engine as { readonly inbox?: ReadonlyArray<InboxItem> }).inbox
  if (inboxLike === undefined) {
    return async () => 0
  }
  return async () => {
    let n = 0
    // Re-read each call — for the in-memory engine the getter returns a
    // fresh frozen snapshot; for sqlite the host injects a real counter.
    // Narrow against the optional duck-typed shape (the port itself has
    // no `inbox`; only the in-memory engine extends with it).
    const current = (engine as { readonly inbox?: ReadonlyArray<InboxItem> }).inbox
    if (current === undefined) return 0
    for (const item of current) {
      if (!item.read) n++
    }
    return n
  }
}
