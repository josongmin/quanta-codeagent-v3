/**
 * ADR-0221 — DirectiveEmitterPort (closed-port, no-throw surface).
 *
 * Hosts (CLI/TUI/desktop) inject an implementation; tests inject a recording
 * fake. `emit` is synchronous and returns a `Result<void, EmitError>` — the
 * caller MUST handle the typed error (e.g. log + drop) rather than catch a
 * thrown exception. This matches the codebase-wide no-throw boundary policy.
 *
 * Default selection is the caller's responsibility — when no emitter is
 * wired, `noopEmitter` is used and every `emit()` is a typed `ok()` with no
 * side effect (default-OFF byte-identical).
 */

import type { Result } from "@/shared"
import type { EmitError, EmitPhase, GitDirective } from "./types"

export interface EmitContext {
  readonly phase: EmitPhase
}

export interface DirectiveEmitterPort {
  emit(directive: GitDirective, ctx: EmitContext): Result<void, EmitError>
}
