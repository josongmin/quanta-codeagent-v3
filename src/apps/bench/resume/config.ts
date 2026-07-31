/**
 * Bench-resume CONFIG resolution — the DEFAULT-OFF gate + bucket/region/campaign
 * resolution, and the fail-CLOSED `resumeActive` activation predicate.
 *
 * DEFAULT-OFF: `QUANTA_BENCH_RESUME` is read through the canonical `gateOn`
 * SSOT (unset / "" / "0" / "off" ⇒ false), so a normal bench run never touches
 * S3. `resumeActive` is the SINGLE place callers decide to engage the durable
 * layer: it is true ONLY when the gate is on AND a bucket is configured —
 * enabled-but-no-bucket is treated as OFF (never invent a bucket; fail closed).
 */
import { gateOn } from "@/shared"

export interface ResumeConfig {
  enabled: boolean
  bucket?: string
  region?: string
  campaignId: string
}

export const resolveResumeConfig = (env: Record<string, string | undefined>): ResumeConfig => {
  const bucket = env.QUANTA_BENCH_RESUME_S3_BUCKET
  const region = env.AWS_REGION ?? env.QUANTA_FULL_REMOTE_REGION
  // exactOptionalPropertyTypes: omit the optional keys rather than set them to
  // `undefined`, so the shape matches `ResumeConfig`'s `bucket?`/`region?`.
  return {
    enabled: gateOn(env, "QUANTA_BENCH_RESUME"),
    campaignId: env.QUANTA_BENCH_CAMPAIGN_ID ?? "default-campaign",
    ...(bucket !== undefined ? { bucket } : {}),
    ...(region !== undefined ? { region } : {}),
  }
}

/**
 * FAIL-CLOSED activation gate. True (and narrows `bucket` to a concrete string)
 * ONLY when the feature is enabled AND a bucket is configured. An enabled config
 * with no bucket is NOT active — callers must treat it as off rather than
 * fabricate a default bucket.
 */
export const resumeActive = (c: ResumeConfig): c is ResumeConfig & { bucket: string } =>
  c.enabled && !!c.bucket
