/**
 * Auto-background after 2 s — slice barrel (ADR-0223).
 *
 * SOTA absorption (Claude Code): when a long-running tool exec sits >2 s with
 * no progress, the UX automatically surfaces "move this to background?" and
 * one keystroke (Esc/Enter) flips the call into the detached path
 * (ADR-0140's `BackgroundSubagentScheduler`). Today quanta has the
 * underlying scheduler but requires an EXPLICIT user `/bg` invocation — this
 * slice is the automatic observer that DECIDES *when* the proposal should
 * surface, idempotently and per-call.
 *
 * Two ports + two default impls + one pure-functional kernel:
 *
 *   - {@link StuckDetectorPort} + {@link defaultStuckDetector} — `Map`-backed
 *     bookkeeping of `(toolCallId → startTimeMs)`, plus `isStuck(now)` probe.
 *   - {@link ProposeHandlerPort} + {@link defaultProposeHandler} — wraps the
 *     detector with the once-per-id rule (dismiss / accept terminal states).
 *   - `computeStuckProbe` / `normalizeThreshold` / `stuckProbeAbsent` — pure
 *     functions that hold the threshold algebra (SOLID strategy split).
 *
 * Plane-clean: this slice imports ZERO `@/*` modules. Its only outward edge
 * is `AgentConfig.autoBackground?` (the slot type lives in `port.ts` as
 * {@link AutoBackgroundConfig}; the actual `types.ts` declaration is a one-
 * line addition in the wire commit). Dispatch reads the slot via two-line
 * optional-chain calls (`config.autoBackground?.detector?.tickToolStart(...)`)
 * — default-OFF byte-identical when the slot is absent (RFC §1.2).
 *
 * ADR-0223: see `docs/decisions/0223-auto-background-stuck-detector.md`.
 */

export { type DefaultStuckDetectorOpts, defaultStuckDetector } from "./default-tracker"
export {
  type BuildSubagentForkOnAcceptOpts,
  buildSubagentForkOnAccept,
  type SubagentForkSink,
} from "./fork-on-accept"
export {
  type AutoBackgroundAcceptCallback,
  type AutoBackgroundConfig,
  DEFAULT_STUCK_THRESHOLD_MS,
  type ProposeHandlerPort,
  type StuckDetectorPort,
  type StuckProbeResult,
  type ToolTrackingEntry,
} from "./port"
export { type DefaultProposeHandlerOpts, defaultProposeHandler } from "./propose-handler"

export { computeStuckProbe, normalizeThreshold, stuckProbeAbsent } from "./stuck-detector"
