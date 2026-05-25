/**
 * Pass-through {@link StopReasonPolicy} (ADR-0242). Frozen object literal
 * whose `handle` always returns `{ kind: "continue" }`. Used as the default
 * when no policy is wired and the surface still wants a non-undefined port
 * reference (e.g. testing the wire site itself, or a composition root that
 * always passes a port). HELL-SR-10 locks the byte-identical contract.
 *
 * The loop itself does NOT install this — it short-circuits on
 * `config.stopReasonPolicy === undefined` for zero allocation. This export
 * is the canonical pass-through for explicit wiring + tests.
 */

import type { StopReasonPolicy } from "./port"
import type { StopAction } from "./types"

const CONTINUE: StopAction = Object.freeze({ kind: "continue" })

export const noOpStopReasonPolicy: StopReasonPolicy = Object.freeze({
  handle(): StopAction {
    return CONTINUE
  },
})
