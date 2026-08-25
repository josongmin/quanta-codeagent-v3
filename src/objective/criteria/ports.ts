/**
 * GOAL-03 — verifier PORTS owned by the objective slice.
 *
 * The objective domain never executes a process or inspects the filesystem. It
 * declares what a check RUNNER and a workspace EVIDENCE source must provide,
 * and what a verification BATCH looks like when the host commits it. The host
 * adapter (`@/host/runtime/objective-verifier-wire`) implements the ports over
 * the existing argv runner / sandbox / git.
 *
 * SLICE FENCE: pure types (+ one pure predicate). No runtime/tool imports.
 */

import type { CheckSpec } from "./model"

export interface CheckRunInput {
  /** Exact argv elements — never joined, never shell-interpolated. */
  readonly argv: readonly string[]
  /** The session-owned workspace; never model/check input. */
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

/** What a runner reports. Raw output is NEVER carried — digest + byte length only. */
export interface CheckRunResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdoutDigest: string
  readonly stdoutBytes: number
  readonly stderrDigest: string
  readonly stderrBytes: number
  readonly durationMs: number
}

export interface ObjectiveCheckRunner {
  run(input: CheckRunInput): Promise<CheckRunResult>
}

export interface WorkspaceEvidence {
  /** Versioned canonical digest of the workspace source state. */
  readonly sourceDigest: string
  /** Cheap identity (HEAD + porcelain status digest) used to skip a rehash. */
  readonly precheck: string
  readonly capturedAt: number
  readonly fileCount: number
}

export type WorkspaceEvidenceFailure =
  | { readonly kind: "source-unavailable"; readonly reason: string }
  | { readonly kind: "cap-exceeded"; readonly reason: string }

export interface WorkspaceEvidencePort {
  /** Cheap precheck only (no full manifest). */
  precheck(cwd: string): Promise<string | WorkspaceEvidenceFailure>
  /** Full canonical manifest digest. */
  capture(cwd: string): Promise<WorkspaceEvidence | WorkspaceEvidenceFailure>
}

export const isEvidenceFailure = (
  v: WorkspaceEvidence | WorkspaceEvidenceFailure | string,
): v is WorkspaceEvidenceFailure =>
  typeof v === "object" &&
  v !== null &&
  "kind" in v &&
  typeof (v as { kind: unknown }).kind === "string"

/** One check outcome inside a batch. `passed` is NOT carried — the authority
 *  recomputes it from `timedOut` + `exitCode` + the immutable `successExitCodes`. */
export interface VerificationBatchResult {
  readonly criterionId: string
  readonly checkId: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdoutDigest: string
  readonly stderrDigest: string
}

export interface VerificationBatch {
  readonly objectiveId: string
  readonly expectedRevision: number
  /** The workspace digest that was STABLE across the whole batch. */
  readonly sourceDigest: string
  readonly verifiedAt: number
  readonly results: readonly VerificationBatchResult[]
}

export type VerificationInvalidationReason =
  | "stale-source"
  | "source-unavailable"
  | "sandbox-unavailable"
  | "cancelled"
  | "cap-exceeded"
  | "runner-unavailable"

/** The pure pass predicate every consumer must agree on. */
export const checkPassed = (
  check: Pick<CheckSpec, "successExitCodes">,
  result: Pick<VerificationBatchResult, "exitCode" | "timedOut">,
): boolean =>
  !result.timedOut && result.exitCode !== null && check.successExitCodes.includes(result.exitCode)

/** The outcome of one verification run (host coordinator). */
export type VerificationOutcome =
  | {
      readonly kind: "verified"
      readonly passed: number
      readonly failed: number
      readonly revision: number
    }
  | { readonly kind: "no-checks" }
  | { readonly kind: "stale-source" }
  | { readonly kind: "source-unavailable"; readonly reason: string }
  | { readonly kind: "cap-exceeded"; readonly reason: string }
  | { readonly kind: "runner-unavailable"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "freshness-unresolved" }
  | { readonly kind: "rejected"; readonly reason: string }

export type ReconcileOutcome =
  | { readonly kind: "fresh"; readonly verified: number }
  | { readonly kind: "invalidated"; readonly checkIds: readonly string[] }
  | { readonly kind: "no-objective" }
  | { readonly kind: "source-unavailable"; readonly reason: string }
  | { readonly kind: "cap-exceeded"; readonly reason: string }
  | { readonly kind: "freshness-unresolved" }

/** What a surface (model tool / CLI / web) may ask the host verifier to do. It
 *  never receives argv — only the stored immutable checks run. */
export interface ObjectiveVerificationPort {
  verify(
    threadId: string,
    criterionIds?: readonly string[],
    signal?: AbortSignal,
  ): Promise<VerificationOutcome>
  reconcile(threadId: string): Promise<ReconcileOutcome>
}

export const MAX_CHECKS_PER_BATCH = 32
/** Per-check wall-clock ceiling: 10 minutes (600_000 ms) — the longest a single
 *  verifier command (a test suite) may run before it is an `unavailable` result. */
export const MAX_CHECK_TIMEOUT_MS = 600_000
/** Whole-batch deadline: 15 minutes (900_000 ms) — bounds the reconcile/verify
 *  round so settlement can never wait on an unbounded verifier. */
export const MAX_BATCH_DEADLINE_MS = 900_000
