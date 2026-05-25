/**
 * `DecisionEmitter` — narrow port for the gate-decision stream (Phase 2 of
 * ADR-0239, follow-up ADR-0250).
 *
 * Why a SEPARATE port from {@link StreamPort}: the `decision` AgentEvent
 * variant is rendered by the stdout adapter + persisted by the jsonl-recorder
 * the moment it lands on the main stream. Routing gate decisions through
 * those adapters by default would BREAK the default-OFF byte-identical
 * surface invariant (ADR-0239 §"Phase 2 contract" line 1). Instead the gate
 * sites call `decisionEmitter?.emit(...)` against THIS narrow port, and the
 * composition root wires it ONLY when developer-mode is on — typically as a
 * thin adapter onto the debug-tracer (`@/apps/cli/debug-tracer`) so a
 * developer can watch the decision stream on stderr without touching the
 * user-facing stdout/jsonl bytes.
 *
 * Contract:
 *  - The implementation is responsible for swallowing throws (`safeEmit`
 *    provides a default wrapping helper). A misbehaving consumer must NEVER
 *    propagate back into the gate's return path.
 *  - Caller-side: it is the GATE's responsibility to (a) sanitise the
 *    `reason`/`metadata` (no secrets, no PII, no full tool input) and
 *    (b) populate `turn` + `toolCallId` so the debug-tracer can line up
 *    decisions with `tool_call.id` rows.
 *  - This port is `@/stream`-owned but deliberately not re-exported from
 *    the barrel as an _adapter_; only the type ships through the barrel.
 *    Composition roots in `@/apps/*` (or `@/agent` wiring helpers) build
 *    concrete instances inline.
 */

import type { AgentEvent, StreamPort } from "."

/** The `decision` variant from {@link AgentEvent}, extracted as a standalone
 *  alias so emit-site call signatures stay short. */
export type DecisionEvent = Extract<AgentEvent, { type: "decision" }>

/** Narrow port — emit ONE gate decision. Implementations MUST be sync (the
 *  gate is in a hot path) and MUST NOT throw (throws are the caller's
 *  invariant, not the gate's). */
export interface DecisionEmitter {
  emit(event: DecisionEvent): void
}

/**
 * Build a {@link DecisionEmitter} that delegates to a {@link StreamPort}.
 * Defence-in-depth wrapper: a misbehaving adapter (e.g. a tee whose
 * downstream paints to a closed pipe) cannot poison the gate result. The
 * sink is invoked inside a try/catch and any throw is dropped on the floor
 * — Track A's debug-tracer is observational, never authoritative.
 *
 * Composition root note: pass the dedicated debug stream (NOT the main
 * stdout/jsonl stream) so default-OFF stays byte-identical. The natural
 * shape is a tiny `{ emit: (e) => tracer(e) }` proxy wrapping the
 * `createDebugTracer` callback the existing wire-up already builds.
 */
export const decisionEmitterFromStream = (stream: StreamPort): DecisionEmitter => ({
  emit(event: DecisionEvent): void {
    try {
      stream.emit(event)
    } catch {
      // Observational sink — never propagate a consumer failure into the
      // gate. The gate's deny/allow decision MUST stay stable.
    }
  },
})

/** Free-standing safe-emit helper. Used by the gate's own call sites so that
 *  the gate body never has to write `try { emitter.emit(...) } catch {}`
 *  inline (keeps cognitive complexity under the biome cap and centralises
 *  the contract in one place). Returns void; emit failure is silent. */
export const safeEmitDecision = (
  emitter: DecisionEmitter | undefined,
  event: DecisionEvent,
): void => {
  if (emitter === undefined) return
  try {
    emitter.emit(event)
  } catch {
    // Same posture as `decisionEmitterFromStream`. The gate is the source of
    // truth; the emit channel is best-effort developer telemetry.
  }
}
