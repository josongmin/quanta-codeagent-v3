/**
 * ADR-0332 — local mirror of the `AgentConfig.imageSanitizationRetry`
 * slot shape. Kept here (instead of imported from `@/agent/types`) so
 * the slice has zero `import "@/agent"` lines outside of `install.ts`
 * (the only sanctioned coupling site). The shape is verified to match
 * `AgentConfig["imageSanitizationRetry"]` at install-time by structural
 * assignability (the install helper writes the value through to the
 * cfg field — if the shape drifts, tsc catches it at the writeline).
 */

export interface ImageSanitizationRetrySlotShape {
  readonly enabled?: boolean
  readonly maxAttempts?: number
  readonly placeholder?: string
}
