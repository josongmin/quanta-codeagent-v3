/**
 * `@/capability` — cross-surface capability-exposure layer (ADR-0503 P3 / RFC §4).
 *
 * One declaration per feature (gate + surfaces) → one resolver → no split-brain.
 * The whole layer is behind the master `QUANTA_CAPABILITY_LAYER` gate (default-OFF,
 * byte-identical degrade): until on, only the read-only consistency probe consumes
 * it; legacy per-surface gates stay authoritative.
 */

export type {
  CapabilityDescriptor,
  CapabilitySurfaces,
  Surface,
} from "./descriptor"
export {
  type CapabilityProbeResult,
  runCapabilityProbe,
} from "./probe-all"
export { allCapabilities, CAPABILITIES } from "./registry"
export {
  CAPABILITY_LAYER_ENV,
  type ExposureProbe,
  probeExposureConsistency,
  resolveExposure,
} from "./resolve"
