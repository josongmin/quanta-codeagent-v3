/**
 * Bench spot-resume FOUNDATION — public surface.
 *
 * Consumers (the per-turn cassette producer + the fresh-box replay consumer)
 * import FROM here. This barrel re-exports only the stable contract:
 *   - `resumeKey`                — pure S3-safe `${campaignId}/${instanceId}`.
 *   - `resolveResumeConfig` / `ResumeConfig` / `resumeActive` — DEFAULT-OFF gate.
 *   - `resumeStore`             — composed durable store for one key.
 */
export type { ResumeConfig } from "./config"
export { resolveResumeConfig, resumeActive } from "./config"
export { resumeKey } from "./identity"
export type { ResumeStore, ResumeStoreConfig } from "./store"
export { resumeStore } from "./store"
