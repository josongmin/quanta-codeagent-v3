/**
 * ADR-0221 — HARD phase guard.
 *
 * Codex emits `::git-*` directives ONLY in the `final_answer` phase, after
 * the mutation has succeeded. Commentary and intermediate phases MUST NOT
 * emit — a directive there could leak ahead of a not-yet-confirmed commit,
 * confuse a tailing UI into showing a branch/PR that may still be rolled
 * back, or contaminate the model's scratchpad with protocol noise.
 *
 * This module is the SOLE place that enforces the phase invariant. The
 * default emitter calls `checkPhase` before serialization; tests pin the
 * rejection via HELL-DE-02/03.
 */

import { err, ok, type Result } from "@/shared"
import type { EmitError, EmitPhase } from "./types"

/** Return `ok` iff phase is `final-answer`; otherwise a typed `wrong-phase` error. */
export const checkPhase = (phase: EmitPhase): Result<void, EmitError> => {
  if (phase === "final-answer") return ok(undefined)
  // Narrowed: phase is "commentary" | "intermediate".
  return err({ kind: "wrong-phase", phase })
}
