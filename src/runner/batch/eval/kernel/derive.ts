/**
 * Forward shim — `deriveKnob` MOVED to `@/runner/knobs/derive` (aug-30
 * structural audit G3-01).
 *
 * The derive primitive is knob-framework core: it needs nothing from
 * `@/runner/batch`, and its importers are the knob files themselves. Hosting
 * it here pointed the core knob slice at an app-level consumer (a
 * wrong-direction edge closing a batch↔knobs import SCC). This shim keeps the
 * historical import path working for batch-side callers and the derive-parity
 * tests; the edge now points batch→knobs, the allowed direction.
 */

// `AnyKnobSchema` re-export kept for callers that imported it alongside
// `deriveKnob` from this module (forward to the config-leaf contract SSOT).
export type { AnyKnobSchema } from "@/config/knob-schema/contracts"
export { deriveKnob, type KnobRelationships } from "@/runner/knobs/derive"
