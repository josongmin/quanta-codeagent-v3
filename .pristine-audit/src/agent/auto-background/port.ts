/**
 * Stuck-detector + propose-handler ports (ADR-0223 — auto-background after 2s).
 *
 * SOTA absorption: Claude Code's UX trick — when a tool exec is in-flight for
 * >2 s with no progress, the UI automatically proposes "move to background?"
 * and one keystroke (Esc/Enter) flips the call into the detached path. The
 * underlying detached run is ADR-0140's `BackgroundSubagentScheduler`
 * (`fork`/`poll`/`await`) — this slice is the OBSERVER that DECIDES *when* to
 * surface the proposal. quanta has the runner; what was missing was the
 * automatic threshold + idempotent "ask once per call" surface. Today the
 * user has to type `/bg` explicitly.
 *
 * Plane-clean: this slice imports ONLY `@/shared` (`QuantaError` is not even
 * referenced — every method is no-throw). NO `@/agent/*`, `@/llm`, `@/tool`,
 * `@/permission`. The dispatch wrapper imports THIS slice (two-line `tick*`
 * call before/after `execute()`); this slice never imports the wrapper.
 *
 * Contracts (5 — every public method):
 *
 *  1. NO-THROW: every method on every port is total. A garbage tool-call-id, a
 *     duplicate end, a missing entry, a clock that returns NaN — all resolve
 *     to a structurally-honest answer (`stuck:false` / no-op / `false`),
 *     never an exception. Loops embedding this slice cannot break on it.
 *
 *  2. exactOptionalPropertyTypes: optional fields are OMITTED when absent,
 *     never `undefined`-set. The result type uses `readonly` projection to
 *     surface a sealed snapshot.
 *
 *  3. PURE-BY-STATE: every decision is driven by injected `now: () => number`.
 *     No module-scoped clock, no `Date.now` import. Tests pass a controlled
 *     clock to drive every threshold boundary deterministically.
 *
 *  4. IDEMPOTENT: `tickToolStart` called twice with the same id keeps the
 *     ORIGINAL `startTimeMs` (subsequent calls are no-ops — re-arming would
 *     mask a long-running tool). `tickToolEnd` on an unknown / already-ended
 *     id is a no-op (defense against double-emit dispatch races). Memory:
 *     every `tickToolEnd` DROPS the entry (no leak across long sessions).
 *
 *  5. ONCE-PER-ID PROPOSAL: `propose-handler` MUST surface its prompt at most
 *     once per `toolCallId`. A `dismiss` (user said "no" or closed the
 *     prompt) marks the id permanently — no re-propose for the same call,
 *     even if `isStuck` keeps returning true on every poll. Independent ids
 *     are independent (parallel tool calls don't dampen each other).
 */

/** A single tool call's tracking record snapshot. Returned by
 *  {@link StuckDetectorPort.isStuck} (in the wrapping result) and by
 *  {@link StuckDetectorPort.list}. Optional `toolName` is OMITTED when the
 *  tracker was started without one (exactOptionalPropertyTypes). */
export interface ToolTrackingEntry {
  readonly toolCallId: string
  readonly toolName?: string
  /** Wall-clock at the `tickToolStart` call. Pure: from the injected `now`. */
  readonly startTimeMs: number
}

/** Stuck-detection result. `elapsedMs` is `now - startTimeMs` at the
 *  {@link StuckDetectorPort.isStuck} call (i.e. computed fresh per-query, not
 *  cached). `threshold` echoes the configured value so the caller can render
 *  a stable diagnostic ("stuck >= 2000 ms"). */
export interface StuckProbeResult {
  readonly stuck: boolean
  readonly elapsedMs: number
  readonly threshold: number
}

/** Bookkeeping port — TRACKS tool-call start/end and answers "is this call
 *  past the threshold right now?". The port is INTENTIONALLY split from
 *  proposal surfacing: a host that wants to render the prompt as a status-bar
 *  badge (instead of a modal) consumes `isStuck` directly without dragging in
 *  the propose-handler. Every method is no-throw (see contract §1). */
export interface StuckDetectorPort {
  /** Begin tracking a tool call. Idempotent: a second call with the same
   *  `toolCallId` is a no-op (the original `startTimeMs` wins — see
   *  contract §4). `toolName` is purely diagnostic; omit when unknown. */
  tickToolStart(input: { readonly toolCallId: string; readonly toolName?: string }): void
  /** End tracking. Drops the in-memory entry. Idempotent: unknown / already-
   *  ended ids are no-ops (no throw, no log). */
  tickToolEnd(input: { readonly toolCallId: string }): void
  /** Probe: is `toolCallId` past the threshold at `now`? Unknown id returns
   *  `{stuck:false, elapsedMs:0, threshold}` — a tool that hasn't started
   *  cannot be stuck. `now` MUST be supplied by the caller (the port carries
   *  no clock — tests inject one; production passes `Date.now()`). */
  isStuck(input: { readonly toolCallId: string; readonly now: number }): StuckProbeResult
  /** Enumerate currently-tracked entries (snapshot; mutating the array does
   *  not affect the store). Insertion order. Diagnostic only. */
  list(): ReadonlyArray<ToolTrackingEntry>
}

/** Proposal-surface port — DECIDES whether to surface "background this?" to
 *  the user. Wraps a {@link StuckDetectorPort} probe with the once-per-id
 *  rule (see contract §5). Separated from the detector so a host can wire a
 *  DIFFERENT proposal UI (modal vs status-bar nudge vs no UI) without
 *  re-implementing the threshold math. */
export interface ProposeHandlerPort {
  /** Consult: should the host surface the background-proposal prompt for
   *  `toolCallId` right now? Returns `true` AT MOST ONCE per id across the
   *  process lifetime. After the host either (a) accepts the proposal
   *  (calls {@link accept}), (b) the user dismisses (calls {@link dismiss}),
   *  or (c) the tool ends (the detector drops the entry), subsequent
   *  `shouldPropose` calls return `false`. */
  shouldPropose(input: { readonly toolCallId: string; readonly now: number }): boolean
  /** Mark the proposal as accepted — the host moved the call to background.
   *  Idempotent. Subsequent `shouldPropose` for the same id returns false. */
  accept(input: { readonly toolCallId: string }): void
  /** Mark the proposal as dismissed — the user said no / closed the prompt.
   *  Idempotent. The id is permanently dampened (no re-propose). */
  dismiss(input: { readonly toolCallId: string }): void
  /** Did the host EVER surface a proposal for `toolCallId`? Diagnostic
   *  surface — tests and audit logs read this to assert idempotency. */
  hasProposed(toolCallId: string): boolean
}

/** Default knob value for the stuck threshold. Locked at 2 000 ms to mirror
 *  Claude Code's UX timing. Hosts override via
 *  {@link AutoBackgroundConfig.thresholdMs}. */
export const DEFAULT_STUCK_THRESHOLD_MS = 2_000

/** Caller-visible knob shape. Lives on `AgentConfig.autoBackground` (the
 *  agent-side slot is added by features.ts in a sibling wire — this slice
 *  only DEFINES the shape; default-OFF semantics live in dispatch.ts where
 *  the optional chain `config.autoBackground?.detector?.tickToolStart(...)`
 *  preserves byte-identical behaviour when absent). */
export interface AutoBackgroundConfig {
  /** Injected detector. When absent, dispatch performs zero `tick*` calls
   *  (default-OFF byte-identical — see ADR-0223 §default-off). */
  readonly detector?: StuckDetectorPort
  /** Optional proposal surface. A host may wire the detector without the
   *  proposer (e.g. to render its own status-bar nudge), in which case
   *  `isStuck` is consulted directly and `shouldPropose` is never read. */
  readonly proposer?: ProposeHandlerPort
  /** Threshold in ms — defaults to {@link DEFAULT_STUCK_THRESHOLD_MS}. The
   *  detector reads this at construction; a runtime knob bump requires
   *  re-constructing the detector (matches `dedupGate` / `capEnforcer`
   *  patterns — config is per-construction, not per-call). */
  readonly thresholdMs?: number
  /** ADR-0239 — host-side accept callback. When set, the proposer's
   *  {@link ProposeHandlerPort.accept} method invokes this with the
   *  observed elapsedMs (computed from the detector's tracking entry at
   *  the moment of accept). A composition root wires this to
   *  `BackgroundSubagentScheduler.fork(...)` so a one-keystroke accept
   *  flips the stuck tool's lineage into the detached path. Default-OFF
   *  byte-identical: absent ⇒ accept is bookkeeping-only (the once-per-id
   *  state still flips; nothing else happens). User-supplied callback
   *  WINS over any composition-root default — a host that wires its own
   *  accept handler suppresses the auto-fork. */
  readonly onAccept?: AutoBackgroundAcceptCallback
}

/** Signature for {@link AutoBackgroundConfig.onAccept}. NO-THROW expected; a
 *  callback that throws is caught at the proposer boundary and surfaced as
 *  a no-op (the once-per-id state still flips). `elapsedMs` is computed from
 *  the detector at the moment of `accept()`; when the detector has no entry
 *  for the id (already ended), the field is `0`. */
export type AutoBackgroundAcceptCallback = (input: {
  readonly toolCallId: string
  readonly elapsedMs: number
}) => void
