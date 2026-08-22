/**
 * Pass-through {@link DispatchGuard} (ADR-0229). Frozen object literal whose
 * `check` always returns `{ kind: "allow" }`. Used as the default when no
 * guard is wired and the surface still wants a non-undefined port reference
 * (e.g. testing the wire site itself). HELL-DG-01 locks this contract.
 *
 * The dispatch seam itself does NOT install this — it short-circuits on
 * `config.dispatchGuard === undefined` for zero allocation. This export is
 * the canonical pass-through for explicit wiring + tests.
 */

import type { DispatchGuard } from "./port"
import type { GuardDecision } from "./types"

const ALLOW: GuardDecision = Object.freeze({ kind: "allow" })

export const noOpDispatchGuard: DispatchGuard = Object.freeze({
  check(): GuardDecision {
    return ALLOW
  },
})
