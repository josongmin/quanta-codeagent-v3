/**
 * Bench-resume CONFIG resolution — the DEFAULT-OFF gate + bucket/region/campaign
 * resolution, and the fail-CLOSED `resumeActive` activation predicate.
 *
 * DEFAULT-OFF: `QUANTA_BENCH_RESUME` is read through the canonical `gateOn`
 * SSOT (unset / "" / "0" / "off" ⇒ false), so a normal bench run never touches
 * S3. `resumeActive` is the SINGLE place callers decide to engage the durable
 * layer: it is true ONLY when the gate is on AND bucket + KMS key + principal +
 * retention ceiling are configured. Partial configuration is treated as OFF.
 */
import { gateOn } from "@/shared"

export interface ResumeConfig {
  enabled: boolean
  bucket?: string
  region?: string
  campaignId: string
  kmsKeyArn?: string
  principalArn?: string
  maxRetentionDays?: number
}

const positiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

export const resolveResumeConfig = (env: Record<string, string | undefined>): ResumeConfig => {
  const bucket = env.QUANTA_BENCH_RESUME_S3_BUCKET
  const region = env.AWS_REGION ?? env.QUANTA_FULL_REMOTE_REGION
  const kmsKeyArn = env.QUANTA_BENCH_RESUME_KMS_KEY_ARN
  const principalArn = env.QUANTA_BENCH_RESUME_PRINCIPAL_ARN
  const maxRetentionDays = positiveInt(env.QUANTA_BENCH_RESUME_MAX_RETENTION_DAYS)
  // exactOptionalPropertyTypes: omit the optional keys rather than set them to
  // `undefined`, so the shape matches `ResumeConfig`'s `bucket?`/`region?`.
  return {
    enabled: gateOn(env, "QUANTA_BENCH_RESUME"),
    campaignId: env.QUANTA_BENCH_CAMPAIGN_ID ?? "default-campaign",
    ...(bucket !== undefined ? { bucket } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(kmsKeyArn !== undefined ? { kmsKeyArn } : {}),
    ...(principalArn !== undefined ? { principalArn } : {}),
    ...(maxRetentionDays !== undefined ? { maxRetentionDays } : {}),
  }
}

/**
 * FAIL-CLOSED activation gate. True (and narrows `bucket` to a concrete string)
 * ONLY when the feature is enabled and every remote-security input exists.
 */
export type ActiveResumeConfig = ResumeConfig & {
  bucket: string
  kmsKeyArn: string
  principalArn: string
  maxRetentionDays: number
}

export const resumeActive = (c: ResumeConfig): c is ActiveResumeConfig =>
  c.enabled && !!c.bucket && !!c.kmsKeyArn && !!c.principalArn && c.maxRetentionDays !== undefined
