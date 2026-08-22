/**
 * Default in-memory {@link StuckDetectorPort} (ADR-0223).
 *
 * `Map<toolCallId, startTimeMs>` keyed by the dispatch-generated
 * `ToolUseBlock.id`. The map is the SSOT for the slice — every probe is a
 * single `Map.get` + arithmetic; `tickToolEnd` is a single `Map.delete` (no
 * tombstone, no soft-leak across long sessions — contract §4 in port.ts).
 *
 * Pure-by-state: the constructor takes a `now: () => number` (default
 * `Date.now`). NO module-scope clock, NO `setTimeout` (we don't ARM a timer —
 * `isStuck` is poll-based; the host is expected to call it during its idle
 * loop or on every dispatch-progress event). This keeps the slice
 * synchronous + zero-thread + cancellation-trivial.
 *
 * NO-THROW: every method is total (see port.ts contract §1). A clock that
 * returns NaN propagates `NaN` through the result `elapsedMs` field — the
 * `stuck` comparison short-circuits to `false` because `NaN >= threshold` is
 * always false. We do NOT defensively coerce to 0 because that would mask
 * the clock-injection bug; surfacing NaN keeps the caller's debugger honest.
 */

import type { StuckDetectorPort, StuckProbeResult, ToolTrackingEntry } from "./port"
import { computeStuckProbe, normalizeThreshold, stuckProbeAbsent } from "./stuck-detector"

/** Construction-time options for {@link defaultStuckDetector}. All fields
 *  optional; defaults mirror Claude Code's 2 s UX threshold. */
export interface DefaultStuckDetectorOpts {
  /** Trigger threshold in ms (inclusive — a probe at exactly `threshold`
   *  elapsed returns `stuck:true`; see HELL-AB-02). Default
   *  {@link DEFAULT_STUCK_THRESHOLD_MS} (2 000). */
  readonly thresholdMs?: number
  /** Injected clock for tests. Default `Date.now`. */
  readonly now?: () => number
}

/** Internal mutable entry — never escapes the store. The external snapshot
 *  type ({@link ToolTrackingEntry}) is built from this on every `list()` call
 *  via {@link toEntry}, projecting `toolName` only when present. */
interface InternalEntry {
  readonly toolCallId: string
  readonly toolName: string | undefined
  readonly startTimeMs: number
}

/** Project the internal entry to the external readonly shape.
 *  Optional `toolName` is OMITTED (not set to `undefined`) when absent. */
const toEntry = (e: InternalEntry): ToolTrackingEntry =>
  e.toolName !== undefined
    ? { toolCallId: e.toolCallId, toolName: e.toolName, startTimeMs: e.startTimeMs }
    : { toolCallId: e.toolCallId, startTimeMs: e.startTimeMs }

export const defaultStuckDetector = (opts: DefaultStuckDetectorOpts = {}): StuckDetectorPort => {
  // Threshold normalization lives in stuck-detector.ts (pure helper). A
  // negative / non-finite value coerces to the default — see SSOT comment
  // in normalizeThreshold.
  const threshold = normalizeThreshold(opts.thresholdMs)

  // The clock is captured ONCE — no per-call `opts.now ?? Date.now` so a
  // future seam change cannot accidentally pick up a stale reference.
  const now = opts.now ?? Date.now

  // Insertion-order Map — preserves a stable `list()` ordering for diagnostic
  // surfaces (UI status bars, audit trails). Entry shape locked to
  // {@link InternalEntry}; the external projection lives in {@link toEntry}.
  const store = new Map<string, InternalEntry>()

  return {
    tickToolStart(input) {
      // Contract §4: idempotent. A second `tickToolStart` for the same id is
      // a NO-OP — the original `startTimeMs` is preserved. Re-arming would
      // mask a long-running tool (the wrapper might fire on retry; the user
      // experience must reflect the ORIGINAL start, not the retry).
      if (store.has(input.toolCallId)) return
      store.set(input.toolCallId, {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        startTimeMs: now(),
      })
    },

    tickToolEnd(input) {
      // Contract §4: idempotent + memory-clean. `Map.delete` returns false
      // for unknown ids and is a no-op — we don't branch on the return.
      store.delete(input.toolCallId)
    },

    isStuck(input): StuckProbeResult {
      const entry = store.get(input.toolCallId)
      if (entry === undefined) {
        // Contract: a tool that hasn't started cannot be stuck. Pure helper
        // builds the shape-stable zero so the caller may unconditionally
        // read `elapsedMs` for a diagnostic render.
        return stuckProbeAbsent(threshold)
      }
      // Delegate the threshold algebra to the pure kernel — `>=` boundary
      // semantics + NaN propagation live there, not duplicated here.
      return computeStuckProbe({ startTimeMs: entry.startTimeMs, now: input.now, threshold })
    },

    list() {
      // Snapshot — mutating the returned array does not affect the store
      // (we project into fresh objects via toEntry).
      const out: ToolTrackingEntry[] = []
      for (const e of store.values()) out.push(toEntry(e))
      return out
    },
  }
}
