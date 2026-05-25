/**
 * Closed-port for stop-reason policy (ADR-0241).
 *
 * The recovery loop consults a {@link StopReasonPolicy} after the LLM stream
 * has been assembled and BEFORE the existing 3-arm `decideOnAssembled` branch
 * runs. Hosts can attach a policy to map every Cursor-style `stop_reason` to
 * one of the four {@link StopAction} arms (`continue` | `surface` | `abort`
 * | `hitl`).
 *
 * Default-OFF contract: absent ⇒ the loop runs the historical 3-arm logic
 * byte-identical. Wired ⇒ the policy's `handle` is the single decision
 * point; returning `"continue"` falls through to the historical branches.
 */

import type { StopAction, StopReasonContext, StopReasonKind } from "./types"

/**
 * Pure pluggable mapper. Implementations MUST be deterministic for a given
 * (reason, ctx) — the loop calls `handle` once per turn assembly. Side effects
 * (metric counters via `ctx.metrics`) are permitted; thrown errors are NOT
 * (the loop treats `handle` as infallible — a throw escapes the recovery
 * envelope and aborts the turn with no rationale).
 */
export interface StopReasonPolicy {
  handle(reason: StopReasonKind, ctx: StopReasonContext): StopAction
}
