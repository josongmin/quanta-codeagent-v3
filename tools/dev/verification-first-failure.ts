export type FailureKind =
  | "assertion"
  | "timeout"
  | "setup"
  | "infrastructure"
  | "cancelled"
  | "unknown"

export interface FirstFailure {
  readonly testId: string
  readonly kind: FailureKind
  readonly fingerprint: string
  readonly sha: string
  readonly elapsedMs: number
}

export const CRITICAL_QUARANTINE_DENY = ["tests/unit/bench-full-remote-hellgate.test.ts"] as const

export const mayQuarantine = (testId: string): boolean =>
  !CRITICAL_QUARANTINE_DENY.some((id) => testId.includes(id))

export const requiredOutcomeAfterRetry = (_first: FirstFailure, _retryPassed: boolean): "failed" =>
  "failed"

export const preserveFirstFailure = (
  first: FirstFailure,
  retry: { readonly passed: boolean; readonly fingerprint: string },
): {
  readonly first: FirstFailure
  readonly retryPassed: boolean
  readonly required: "failed"
} => ({
  first,
  retryPassed: retry.passed,
  required: "failed",
})
