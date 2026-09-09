export type VerificationTier = "smoke" | "prepush" | "pr" | "full" | "nightly"

export type VerificationOutcome =
  | "passed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "skipped-input"
  | "not-selected"
  | "not-run"

export interface GateResult {
  readonly id: string
  readonly outcome: VerificationOutcome
  readonly elapsedMs: number
  readonly reason?: string
}

export interface VerificationResult {
  readonly tier: VerificationTier
  readonly gates: readonly GateResult[]
  readonly outcome: VerificationOutcome
  readonly exitCode: number
}

const EXIT: Record<VerificationOutcome, number> = {
  passed: 0,
  failed: 1,
  cancelled: 130,
  blocked: 2,
  "skipped-input": 1,
  "not-selected": 0,
  "not-run": 1,
}

export const exitCodeForOutcome = (outcome: VerificationOutcome): number => EXIT[outcome]

const OUTCOME_PRIORITY: readonly VerificationOutcome[] = [
  "cancelled",
  "blocked",
  "failed",
  "skipped-input",
  "not-run",
]

export const finalizeVerificationResult = (input: {
  readonly tier: VerificationTier
  readonly gates: readonly GateResult[]
}): VerificationResult => {
  if (input.gates.length === 0) {
    return { tier: input.tier, gates: input.gates, outcome: "failed", exitCode: 1 }
  }
  const present = new Set(input.gates.map((gate) => gate.outcome))
  const outcome = OUTCOME_PRIORITY.find((item) => present.has(item)) ?? "passed"
  return {
    tier: input.tier,
    gates: input.gates,
    outcome,
    exitCode: exitCodeForOutcome(outcome),
  }
}
