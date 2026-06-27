/**
 * Knob: `fault-evidence` (T-201) — emit a bounded typed `FaultEvidencePacket`
 * (owner-context: paths/symbols only, no raw source) into the bench loop instead
 * of raw-source hint blobs.
 *
 * Default-OFF. NOOP-apply registry entry: the EFFECT is delivered out of band by
 * the bench driver via `benchPostureFromState` projection (`faultEvidence`
 * field) + `buildConfig`. Exists here so the resolver / report / preset layer
 * can SEE the knob. Strict truthy gate: `"1"`/`"on"`/`"true"` ⇒ enabled.
 */

import { faultEvidenceSchema } from "@/config/knob-schema/schemas/bench-a"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"

// DERIVED from `faultEvidenceSchema` (the SSOT). NOOP apply (the effect is
// delivered out of band by the bench driver via `benchPostureFromState`), so no
// apply binding. Registration is CENTRAL (`registerBenchKnobs`) — this file no
// longer self-registers; it only re-exports the derived knob for back-compat.
export const faultEvidenceKnob = deriveKnob(faultEvidenceSchema)
