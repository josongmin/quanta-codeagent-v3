/**
 * H16 — in-memory {@link DreamStatePort} (single-process / tests).
 *
 * Holds the persisted counter/clock in a field. Production wires a JSON-file
 * adapter (see `./json-file-state.ts`) so the cadence survives across CLI
 * runs; this impl is the deterministic test fake + the fallback for hosts
 * that do not want on-disk dream bookkeeping.
 *
 * Plane-clean: no I/O, no clock.
 */

import type { DreamStatePort } from "./port"
import { type DreamState, INITIAL_DREAM_STATE } from "./types"

export class InMemoryDreamState implements DreamStatePort {
  private state: DreamState

  constructor(initial: DreamState = INITIAL_DREAM_STATE) {
    this.state = initial
  }

  read(): DreamState {
    return this.state
  }

  write(state: DreamState): void {
    this.state = state
  }
}
