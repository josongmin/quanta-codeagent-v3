/**
 * ADR-0205 — Default stderr emitter.
 *
 * Writes each serialized directive followed by `\n` to `process.stderr`.
 * Stdout is reserved for LLM response streaming + pipe consumers; emitting
 * directives there would contaminate the model's reply (HELL-GD-11).
 *
 * The name `defaultStdoutEmitter` reflects "default process-stdout-channel"
 * historically; the actual stream is stderr. We keep the symbol name so
 * external wiring (none yet) does not need to rename on adoption.
 */

import type { GitDirectiveEmitter } from "./port"
import { serialize } from "./serializer"
import type { GitDirective } from "./types"

/** A minimal write-shape the emitter targets — `process.stderr` matches. */
export interface DirectiveSink {
  write(chunk: string): boolean
}

/** Build an emitter that writes serialized directives + `\n` to the sink.
 *  Defaults to `process.stderr` (the production target). */
export const defaultStdoutEmitter = (
  sink: DirectiveSink = process.stderr,
): GitDirectiveEmitter => ({
  emit(directive: GitDirective): void {
    sink.write(`${serialize(directive)}\n`)
  },
})
