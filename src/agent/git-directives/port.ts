/**
 * ADR-0205 — Closed-port emitter contract.
 *
 * Hosts (CLI/TUI/desktop) inject an implementation; tests inject a recording
 * fake. The port is intentionally minimal — synchronous `emit` because the
 * underlying sinks (stderr write, in-memory array, IPC channel) are all
 * non-blocking.
 */

import type { GitDirective } from "./types"

export interface GitDirectiveEmitter {
  emit(directive: GitDirective): void
}
