/**
 * ADR-0232 — Per-turn git-directive collector (phase-aware wire).
 *
 * Problem this slice solves
 * -------------------------
 * The phase-guarded emitter (ADR-0221) accepts directives ONLY in the
 * `final-answer` phase. But the actual call sites that PRODUCE the directive
 * — the mutating git tools (`git_commit`, `git_branch_switch`, future
 * `gh_pr_create`) — run as `tool_use` calls in the LLM's INTERMEDIATE phase.
 * If a tool calls `emitter.emit(d, { phase: "intermediate" })` directly, the
 * phase guard rejects it and nothing reaches the wire. If a tool calls
 * `emitter.emit(d, { phase: "final-answer" })` directly (lying about phase),
 * the guard becomes ceremonial — directives leak ahead of the model's
 * committed final answer, exactly the failure the guard was built to prevent.
 *
 * The collector is the COUPLE-BREAKER: tools `record(directive)` during their
 * intermediate-phase execution; the loop calls `flush()` at the turn boundary
 * (the natural "final-answer" moment) which drains every collected entry into
 * the emitter with `phase: "final-answer"`. The phase invariant survives, the
 * call sites stay 1-line, and the directives arrive in submission order.
 *
 * Design points
 * -------------
 * 1. **No-throw public surface.** `record()` returns `void` (best-effort
 *    capture; a malformed shape SHOULD never crash a tool). `flush()`
 *    returns the result of each emit attempt so callers can observe wire
 *    failures (test-only; production swallows). The collector itself never
 *    throws.
 *
 * 2. **Default-OFF byte-identical.** When the host does NOT wire a
 *    collector, `noopCollector` is the sentinel: `record()` is a no-op,
 *    `flush()` returns an empty array, no allocation per call. Mirrors the
 *    `noopEmitter` discipline from ADR-0221.
 *
 * 3. **`includeIntermediate` opt-in.** Some hosts (e.g. a live-progress UI
 *    that wants to surface "we just committed X" mid-turn instead of waiting
 *    for the final-answer flush) need the directive immediately. When the
 *    knob is `true`, `record()` ALSO emits directly with
 *    `phase: "final-answer"` to bypass the phase guard for the eager
 *    surface. The default is `false` (strict ADR-0221 discipline: emit only
 *    at turn boundary).
 *
 * 4. **FIFO order, one drain per flush.** Entries arrive in record order and
 *    emit in record order. `flush()` empties the buffer so a subsequent turn
 *    starts clean — the collector is one logical "session" per turn, NOT a
 *    cumulative log.
 *
 * 5. **Per-turn vs per-session.** A single `GitDirectiveCollector` instance
 *    may be reused across turns (the loop calls `flush()` at the end of
 *    each turn, the buffer is empty again, the next turn records into it).
 *    The collector does NOT track turn boundaries itself — the loop owns
 *    the lifecycle. Calling `flush()` on an empty collector returns `[]`
 *    (no emit happens; the emitter is never touched on empty flush).
 *
 * 6. **Emitter missing ⇒ silent drop on flush.** If a host wires the
 *    collector but NOT an emitter (or wires `noopEmitter`), `flush()` still
 *    drains the buffer (so memory doesn't grow unbounded across turns) but
 *    the emit attempts hit the noop path. Records produced in this state
 *    are observable via the `length` accessor (test-only) so callers can
 *    diagnose a half-wired host.
 */

import { ok, type Result } from "@/shared"
import type { DirectiveEmitterPort } from "./port"
import type { EmitError, GitDirective } from "./types"

/** Knobs controlling collector behavior. All optional; all default-OFF. */
export interface GitDirectiveCollectorOptions {
  /** When `true`, `record()` ALSO emits the directive immediately with
   *  `phase: "final-answer"` (bypassing the deferred final-answer flush
   *  semantics). Use for live-progress surfaces that want mid-turn visibility.
   *  Default: `false` (strict ADR-0221 discipline — emit only at flush). */
  readonly includeIntermediate?: boolean
}

/** A typed collector port. Hosts inject a real instance; tests inject a
 *  recording fake; absent hosts use `noopCollector`. */
export interface GitDirectiveCollector {
  /** Capture a directive observed during an intermediate-phase tool call.
   *  Returns `void` — best-effort, never throws. */
  record(directive: GitDirective): void
  /** Drain the buffer and emit each entry through the underlying emitter
   *  with `phase: "final-answer"`. Returns one `Result` per submitted entry
   *  in record order (test-only observability; production callers may
   *  ignore the return). An empty buffer returns `[]` and does NOT touch
   *  the emitter (no allocation, no log spam). */
  flush(): ReadonlyArray<Result<void, EmitError>>
  /** Number of currently-buffered entries (test-only observability). */
  readonly length: number
}

/** Default-OFF sentinel: `record` is no-op, `flush` returns `[]`. */
export const noopCollector: GitDirectiveCollector = {
  record(): void {
    // intentional no-op
  },
  flush(): ReadonlyArray<Result<void, EmitError>> {
    return []
  },
  get length(): number {
    return 0
  },
}

/**
 * Build a turn-scoped collector wired to an emitter.
 *
 * @param emitter The phase-guarded emitter from ADR-0221. Required. To
 *                opt out of emission entirely, wire `noopEmitter`.
 * @param options Optional knobs (see {@link GitDirectiveCollectorOptions}).
 */
export const buildGitDirectiveCollector = (
  emitter: DirectiveEmitterPort,
  options: GitDirectiveCollectorOptions = {},
): GitDirectiveCollector => {
  const includeIntermediate = options.includeIntermediate === true
  // Buffer the typed directives in record order. The collector is single-
  // threaded (called from the dispatch seam which serializes tool calls)
  // so a plain array is the right primitive — no concurrent push hazard.
  const buffer: GitDirective[] = []

  return {
    record(directive: GitDirective): void {
      // Always buffer for the deferred flush. Even when includeIntermediate
      // emits eagerly, we still drain at flush time so the receiving wire
      // gets a single canonical event stream.
      buffer.push(directive)
      if (includeIntermediate) {
        // Best-effort eager emit. Errors are swallowed — the deferred flush
        // will surface them via its return value. The emitter itself is
        // no-throw (Result-returning), so this try/catch is defensive
        // against a misbehaving custom port that violates the no-throw
        // contract.
        try {
          emitter.emit(directive, { phase: "final-answer" })
        } catch {
          // Eager-emit failures NEVER poison the buffer; the flush will
          // re-attempt this directive at the natural final-answer boundary.
        }
      }
    },
    flush(): ReadonlyArray<Result<void, EmitError>> {
      if (buffer.length === 0) return []
      // Snapshot + clear so a record-during-flush (defensive against a
      // re-entrant emitter that synchronously records back, e.g. a sink
      // adapter that pipes into a second collector) does not double-drain.
      const drain = buffer.splice(0, buffer.length)
      const out: Result<void, EmitError>[] = []
      for (const d of drain) {
        try {
          out.push(emitter.emit(d, { phase: "final-answer" }))
        } catch (e) {
          // Defensive: emitters MUST be no-throw, but a custom port may
          // misbehave. Surface as a typed `invalid-directive` so the result
          // surface stays exhaustive (no thrown exception leaks).
          out.push({
            ok: false,
            error: {
              kind: "invalid-directive",
              reason: e instanceof Error ? e.message : String(e),
            },
          })
        }
      }
      return out
    },
    get length(): number {
      return buffer.length
    },
  }
}

/** Convenience: typed `ok` helper for callers that want to map the flush
 *  result into their own accumulator. Re-exported from `@/shared` semantics
 *  to keep the public surface self-contained. */
export const okVoid = (): Result<void, EmitError> => ok(undefined)
