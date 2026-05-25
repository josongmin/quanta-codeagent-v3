/**
 * ADR-0220 — No-op emitter (default-OFF byte-identical default).
 *
 * Discards every directive. Used wherever a host has not opted in to the
 * `::git-*` channel — the call sites stay byte-identical to today's
 * behaviour (HELL-GD-01).
 */

import type { GitDirectiveEmitter } from "./port"

export const noopEmitter: GitDirectiveEmitter = {
  emit(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
}
