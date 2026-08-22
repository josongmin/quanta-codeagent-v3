/**
 * ADR-0177 — Default {@link CancellationController} implementation +
 * `AbortSignal` round-trip adapters.
 *
 * Backed by a private WHATWG `AbortController` so callers can hand the
 * derived `AbortSignal` to existing SDK calls (Anthropic / OpenAI / Bedrock
 * / Vertex / Foundry — all of which accept a plain `AbortSignal` via their
 * request options; see `src/llm/adapters/*` and `src/llm/providers/*`).
 *
 * Plane-clean: imports only `./types`. No `@/agent`, `@/llm`, `@/shared`
 * dependencies — keeps the slice trivially unit-testable.
 */
import type {
  CancellationCause,
  CancellationController,
  CancellationOutcome,
  CancellationSignal,
  CleanupHandler,
} from "./types"

export interface DefaultControllerOpts {
  /** Injection seam for tests. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Maximum number of cleanup handlers that may run concurrently inside
   *  {@link CancellationController.finalize}. Default 4.
   *
   *  Trade-off: serial (1) is safest for ordered resource teardown but
   *  becomes a bottleneck when one handler holds an idle network socket
   *  blocking faster sibling handlers. Unbounded parallel exhausts file
   *  descriptors when a session has 50+ open tools. Capping at a small
   *  constant (4) preserves the speed win on the common case (≤4 active
   *  resources per turn) without risking FD starvation on degenerate
   *  cases. The ADR section "Alternatives rejected" carries the full
   *  rationale. */
  readonly cleanupParallelism?: number
}

const DEFAULT_PARALLELISM = 4

/** Build a fresh {@link CancellationController}. Each call returns a new
 *  controller with its own private state — there is no global / singleton. */
export const createCancellationController = (
  opts?: DefaultControllerOpts,
): CancellationController => {
  const now = opts?.now ?? Date.now
  const parallelism = Math.max(1, opts?.cleanupParallelism ?? DEFAULT_PARALLELISM)

  const inner = new AbortController()
  let cause: CancellationCause | null = null
  let abortedAt: number | null = null
  const listeners: Array<() => void> = []
  const handlers: CleanupHandler[] = []
  let finalized = false
  let finalizedOutcome: CancellationOutcome | null = null

  const signal: CancellationSignal = {
    get aborted() {
      return inner.signal.aborted
    },
    get cause() {
      return cause
    },
    get abortedAt() {
      return abortedAt
    },
    addEventListener(_type, listener) {
      // Mirrors AbortSignal: late subscribers on an already-aborted signal
      // still receive an immediate synchronous fire. Keeps "wire unconditionally,
      // skip the pre-check race" pattern viable for downstream callers.
      if (inner.signal.aborted) {
        listener()
        return
      }
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    },
  }

  const fireCancel = (c: CancellationCause): void => {
    // First-cause-wins: only the first call latches state + fires listeners.
    if (cause !== null) return
    cause = c
    abortedAt = now()
    inner.abort()
    // Synchronous fan-out, registration order. A throwing listener must NOT
    // block sibling listeners — capture + continue. We intentionally do not
    // surface listener errors (they're observer-side: the cause is already
    // latched, retrying is meaningless). Production loggers can wrap.
    for (const l of listeners.slice()) {
      try {
        l()
      } catch {
        // swallow — see comment above.
      }
    }
  }

  const controller: CancellationController = {
    signal,
    cancel(c) {
      fireCancel(c)
    },
    registerCleanup(handler) {
      // Insertion-order list. Deregister returns a closure that removes the
      // exact handler instance — multiple registrations of the same handler
      // are tracked separately (rare, but the contract is "what you put in
      // you can take out").
      handlers.push(handler)
      let removed = false
      return () => {
        if (removed) return
        removed = true
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },
    async finalize(partial) {
      if (finalized && finalizedOutcome !== null) {
        // Idempotent: cached outcome on subsequent calls. We do NOT re-run
        // handlers — they may have non-idempotent side effects (closing
        // sockets, releasing locks).
        return finalizedOutcome
      }
      finalized = true

      // Safety net: caller forgot to cancel first. Document policy: we
      // synthesize an "external" cancel rather than throw, so an accidental
      // finalize still produces a valid outcome. ADR captures this as a
      // safety rail, not a supported flow.
      if (cause === null) {
        fireCancel("external")
      }
      // After fireCancel either path, cause is non-null.
      const finalCause = cause as CancellationCause
      const finalAt = abortedAt as number

      const snapshot = handlers.slice()
      const errors: string[] = []

      // Bounded parallel: chunk handlers into waves of `parallelism`. Within
      // a wave we use Promise.allSettled so one slow / throwing handler does
      // not block sibling progress; across waves we preserve registration
      // order, so dependent handlers (registered later) see prior waves
      // already settled. This is the trade-off the ADR documents.
      for (let i = 0; i < snapshot.length; i += parallelism) {
        const wave = snapshot.slice(i, i + parallelism)
        const settled = await Promise.allSettled(wave.map((h) => h.cleanup(finalCause, partial)))
        for (let j = 0; j < settled.length; j++) {
          const s = settled[j]
          if (s !== undefined && s.status === "rejected") {
            const r: unknown = s.reason
            // Plane-clean (header): inline the canonical errMessage body
            // (byte-identical to `src/shared/errors.ts` `errMessage`). The
            // pre-existing `typeof r === "string" ? r : String(r)` chain was
            // redundant — `String(str) === str` for any string `str`.
            const msg = r instanceof Error ? r.message : String(r)
            const h = wave[j]
            const name = h !== undefined ? h.name : "<unknown>"
            errors.push(`${name}: ${msg}`)
          }
        }
      }

      const outcome: CancellationOutcome = {
        cause: finalCause,
        cancelledAt: finalAt,
        partial,
        cleanupSucceeded: errors.length === 0,
        cleanupErrors: errors,
      }
      finalizedOutcome = outcome
      return outcome
    },
  }

  return controller
}

/** Wrap a plain WHATWG `AbortSignal` as a typed {@link CancellationSignal}.
 *
 *  Useful when a parent harness (test runner, CLI, browser surface) already
 *  has its own `AbortSignal` — we adopt it without re-keying every plumbed
 *  callsite. The `cause` is whatever the caller declares; default
 *  `"external"` because by construction we don't know more. Late events on
 *  the underlying signal still propagate. */
export interface FromAbortSignalOpts {
  /** Caller-injected clock. Defaults to `Date.now`. Slice invariant
   *  (no domain Date.now): tests/replay-stable callers MUST inject. */
  readonly now?: () => number
}

export const fromAbortSignal = (
  signal: AbortSignal,
  cause: CancellationCause = "external",
  opts: FromAbortSignalOpts = {},
): CancellationSignal => {
  const now = opts.now ?? Date.now
  let latchedCause: CancellationCause | null = signal.aborted ? cause : null
  let abortedAt: number | null = signal.aborted ? now() : null
  const listeners: Array<() => void> = []

  if (!signal.aborted) {
    signal.addEventListener(
      "abort",
      () => {
        if (latchedCause !== null) return
        latchedCause = cause
        abortedAt = now()
        for (const l of listeners.slice()) {
          try {
            l()
          } catch {
            // see fireCancel comment.
          }
        }
      },
      { once: true },
    )
  }

  return {
    get aborted() {
      return signal.aborted
    },
    get cause() {
      return latchedCause
    },
    get abortedAt() {
      return abortedAt
    },
    addEventListener(_type, listener) {
      if (signal.aborted) {
        listener()
        return
      }
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    },
  }
}

/** Project a typed {@link CancellationSignal} down to a plain `AbortSignal`.
 *
 *  Mandatory for SDK calls — every adapter under `src/llm/adapters/*` +
 *  `src/llm/providers/*` accepts an `AbortSignal`, not our typed wrapper.
 *  We forward abort one-way: when the typed signal fires, the returned
 *  `AbortSignal` aborts. Cause information is lost in the projection (by
 *  necessity — `AbortSignal` has no cause channel until DOM `reason` is
 *  fully standard across our targets), but the cancel ITSELF propagates. */
export const toAbortSignal = (signal: CancellationSignal): AbortSignal => {
  if (signal.aborted) {
    // Provide an already-aborted signal. AbortSignal.abort() is the
    // canonical constructor for this.
    return AbortSignal.abort()
  }
  const ac = new AbortController()
  signal.addEventListener("abort", () => {
    if (!ac.signal.aborted) ac.abort()
  })
  return ac.signal
}
