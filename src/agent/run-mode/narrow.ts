/**
 * Type-narrowing helpers + runtime matrix assert (RFC §6.2). The compile-time
 * narrow is the primary defense; the runtime assert is defense-in-depth
 * against unsafe casts and dynamic-dispatch paths.
 *
 * Usage:
 *   const policy = MODE_PRESETS.batch
 *   narrowMode("batch", policy)       // asserts policy is ModePolicy & {mode:"batch"}
 *   assertModeMatrix(policy)          // throws on matrix violations
 *
 * `narrowMode` is a TS assertion function — it does not return; it narrows.
 */

import type { AgentMode, ModePolicy } from "./types"

/**
 * Compile-time narrow: after this call, `policy` is typed as
 * `ModePolicy & { mode: M }` so subsequent code can rely on the matrix
 * column for that mode. Mismatch throws at runtime as defense-in-depth.
 */
export function narrowMode<M extends AgentMode>(
  mode: M,
  policy: ModePolicy,
): asserts policy is ModePolicy & { mode: M } {
  if (policy.mode !== mode) {
    throw new Error(
      `narrowMode: expected policy.mode === ${JSON.stringify(mode)} but got ${JSON.stringify(policy.mode)}`,
    )
  }
}

/** Per-mode invariant checker map — split out so each cell stays cohesive
 *  and the public `assertModeMatrix` is a thin dispatch. Each invariant fn
 *  performs propositional kind comparisons only (no numerical thresholds). */
type MatrixChecker = (p: ModePolicy) => void

const assertBatch: MatrixChecker = (p) => {
  if (p.permission.kind !== "auto") {
    throw new Error("matrix: batch mode requires permission.kind === 'auto'")
  }
  if (p.externalDeps.kind !== "hermetic") {
    throw new Error("matrix: batch mode requires externalDeps.kind === 'hermetic'")
  }
  if (p.sandbox.kind !== "per-instance") {
    throw new Error("matrix: batch mode requires sandbox.kind === 'per-instance'")
  }
  if (p.output.kind !== "structured") {
    throw new Error("matrix: batch mode requires output.kind === 'structured'")
  }
  if (p.network.kind !== "denied") {
    throw new Error("matrix: batch mode requires network.kind === 'denied'")
  }
}

const assertInteractive: MatrixChecker = (p) => {
  if (p.permission.kind !== "reviewer-backed") {
    throw new Error("matrix: interactive mode requires permission.kind === 'reviewer-backed'")
  }
  if (p.externalDeps.kind !== "host") {
    throw new Error("matrix: interactive mode requires externalDeps.kind === 'host'")
  }
  if (p.sandbox.kind !== "user-cwd") {
    throw new Error("matrix: interactive mode requires sandbox.kind === 'user-cwd'")
  }
}

const assertHeadless: MatrixChecker = (p) => {
  if (p.permission.kind !== "auto") {
    throw new Error("matrix: headless mode requires permission.kind === 'auto'")
  }
  if (p.termination.kind !== "single-turn") {
    throw new Error("matrix: headless mode requires termination.kind === 'single-turn'")
  }
}

const assertCiBot: MatrixChecker = (p) => {
  if (p.gitWrite.kind !== "branch-only") {
    throw new Error("matrix: ci-bot mode requires gitWrite.kind === 'branch-only'")
  }
  if (p.output.kind !== "github-check") {
    throw new Error("matrix: ci-bot mode requires output.kind === 'github-check'")
  }
  if (p.network.kind !== "allowlist") {
    throw new Error("matrix: ci-bot mode requires network.kind === 'allowlist'")
  }
}

const MATRIX_CHECKERS: Record<AgentMode, MatrixChecker> = {
  interactive: assertInteractive,
  headless: assertHeadless,
  batch: assertBatch,
  "ci-bot": assertCiBot,
}

/**
 * Defensive runtime check enforcing the matrix invariants from RFC §6.2. Each
 * cell is a propositional `if (lever.kind !== Y) throw`. There are NO
 * numerical thresholds here — only kind comparisons.
 */
export const assertModeMatrix = (policy: ModePolicy): void => {
  MATRIX_CHECKERS[policy.mode](policy)
}
