/**
 * Stop-reason policy slice barrel (ADR-0242).
 *
 * Typed router over the Cursor 3.2.16 8-arm `stop_reason` vocabulary. The
 * default policy implements Cursor's verbatim routing table; the no-op
 * policy is a frozen pass-through used as the explicit byte-identical
 * opt-in. Default-OFF — wired by passing `config.stopReasonPolicy` into
 * `runAgent`; when absent, the loop short-circuits and falls through to
 * the legacy `recovery.decideOnAssembled` mapping (byte-identical to the
 * pre-ADR path).
 */

export { DEFAULT_STOP_REASON_ROUTING, defaultStopReasonPolicy } from "./default-policy"
export { noOpStopReasonPolicy } from "./no-op-policy"
export type { StopReasonPolicy } from "./port"
export type { StopAction, StopReasonKind } from "./types"
export { ALL_STOP_ACTION_KINDS, ALL_STOP_REASON_KINDS } from "./types"
