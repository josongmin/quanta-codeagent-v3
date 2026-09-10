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

export const outcomeFromGates = (gates: readonly GateResult[]): VerificationOutcome => {
  if (gates.length === 0) return "failed"
  const present = new Set(gates.map((gate) => gate.outcome))
  return OUTCOME_PRIORITY.find((item) => present.has(item)) ?? "passed"
}

export const finalizeVerificationResult = (input: {
  readonly tier: VerificationTier
  readonly gates: readonly GateResult[]
}): VerificationResult => {
  const outcome = outcomeFromGates(input.gates)
  return {
    tier: input.tier,
    gates: input.gates,
    outcome,
    exitCode: exitCodeForOutcome(outcome),
  }
}
