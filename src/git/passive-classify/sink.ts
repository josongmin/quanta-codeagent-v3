/**
 * H6 (jun-3-misc §3) — Passive-VCS event sink (closed-port, no-throw).
 *
 * The classifier ({@link classifyPassiveVcs}) is pure. This port is the seam
 * that carries a classified {@link VcsEvent} OUT of the bash post-exec hook to
 * whatever consumer the host wired — in production, the dispatch/loop seam
 * adapts it onto the EXISTING turn-diff `AgentEvent` stream (it does NOT invent
 * a second bus). Mirrors the `DirectiveEmitterPort` / `noopEmitter` discipline
 * from ADR-0221:
 *
 *  - `noopVcsEventSink` is the default-OFF sentinel: `emit()` is a no-op, zero
 *    allocation, zero side effect. When the bash hook resolves this (knob OFF
 *    or no host wiring) the post-exec path is byte-identical.
 *  - A real host wires a sink that forwards onto the turn-diff bus.
 *
 * `emit` is NO-THROW by contract; the hook additionally guards the call so a
 * misbehaving custom sink can never break a bash turn.
 */

import type { VcsEvent } from "./types"

export interface PassiveVcsEventSink {
  /** Forward a classified VCS event. NO-THROW by contract. */
  emit(event: VcsEvent): void
}

/** Default-OFF sentinel: `emit` is a no-op. */
export const noopVcsEventSink: PassiveVcsEventSink = {
  emit(): void {
    // intentional no-op (byte-identical default-OFF path)
  },
}
