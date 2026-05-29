/**
 * ADR-0221 — Built-in emitters (no-op default + stdout/sink default).
 *
 * Two adapters:
 *
 *   - `noopEmitter` — default-OFF byte-identical. `emit()` always returns
 *     `ok(undefined)` and produces zero side effects. Used wherever a host
 *     has not opted in (HELL-DE-07 pins zero stdout/stderr writes).
 *
 *   - `defaultEmitter(sink)` — phase-guarded, canonical serializer +
 *     `sink.write(line + "\n")`. The host passes stdout/stderr/IDE transport
 *     explicitly. Either way, the phase guard runs FIRST — wrong-phase emit
 *     returns a typed error and the sink is never touched.
 *
 * Directive validation (shape sanity) runs inside `emit()` so a malformed
 * caller-constructed directive is rejected before serialization, not after
 * the sink has been written to.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import { checkPhase } from "./phase-guard"
import type { DirectiveEmitterPort, EmitContext } from "./port"
import { serialize } from "./serializer"
import type { EmitError, GitDirective } from "./types"
import { validateDirective } from "./validate"

/** Default-OFF emitter: every call is ok-noop. */
export const noopEmitter: DirectiveEmitterPort = {
  emit(): Result<void, EmitError> {
    return ok(undefined)
  },
}

/** A minimal write target. Hosts adapt stdout/stderr/transport sinks to this. */
export interface DirectiveSink {
  write(chunk: string): boolean
}

/**
 * Build an emitter that serializes + writes to `sink`. Runs the phase guard
 * first; wrong-phase emit returns typed error and never touches the sink.
 * Wrong-shape directive likewise short-circuits.
 */
export const defaultEmitter = (sink: DirectiveSink): DirectiveEmitterPort => ({
  emit(directive: GitDirective, ctx: EmitContext): Result<void, EmitError> {
    const phaseGate = checkPhase(ctx.phase)
    if (!phaseGate.ok) return phaseGate
    const shapeGate = validateDirective(directive)
    if (!shapeGate.ok) return shapeGate
    try {
      sink.write(`${serialize(directive)}\n`)
      return ok(undefined)
    } catch (e) {
      // Sinks SHOULD not throw, but if they do (closed fd, EPIPE), surface
      // as typed error rather than propagating — no-throw public surface.
      return err({
        kind: "invalid-directive",
        reason: errMessage(e),
      })
    }
  },
})
