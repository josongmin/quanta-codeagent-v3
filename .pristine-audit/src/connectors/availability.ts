/**
 * Availability port re-export (ADR-0160 Phase A).
 *
 * The port definition lives in `./types` (alongside its sibling ports). This
 * file exists as a documented anchor for "the availability surface" so future
 * adapters / consumers have an obvious import target separate from the
 * registry surface (SRP at the barrel level).
 *
 * The concrete adapter lives in `./availability-prober` (Phase D).
 */

export type { AvailabilityCheckerPort, AvailabilityVerdict } from "./types"
