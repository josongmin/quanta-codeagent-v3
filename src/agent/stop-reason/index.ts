/**
 * Stop-reason policy slice (ADR-0241) — barrel.
 *
 * Re-exports the typed surface (`StopReasonKind` 8-arm + `StopAction` 4-arm),
 * the {@link StopReasonPolicy} port, and the two reference policies
 * (`DEFAULT_STOP_REASON_POLICY` mirrors Cursor's verbatim table;
 * `NO_OP_STOP_REASON_POLICY` is the byte-identical fallback).
 */

export type { StopReasonPolicy } from "./port"
export type { StopAction, StopReasonContext, StopReasonKind } from "./types"
export { ALL_STOP_ACTIONS, ALL_STOP_REASON_KINDS } from "./types"
export {
  DEFAULT_STOP_REASON_POLICY,
  buildDefaultStopReasonPolicy,
  mapStopReason,
} from "./default-policy"
export { NO_OP_STOP_REASON_POLICY } from "./no-op-policy"
