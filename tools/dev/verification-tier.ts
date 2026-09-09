import {
  finalizeVerificationResult,
  type GateResult,
  type VerificationOutcome,
  type VerificationResult,
  type VerificationTier,
} from "./verification-result"

export type { VerificationTier }

export interface TierGate {
  readonly id: string
  readonly consumes?: string
  readonly tiers: readonly VerificationTier[]
}

export interface OrchestrateInput {
  readonly tier: VerificationTier
  readonly gates: readonly TierGate[]
  readonly failFast: boolean
  readonly runGate: (gate: TierGate) => { readonly ok: boolean; readonly elapsedMs?: number }
}

const knownTiers: ReadonlySet<VerificationTier> = new Set([
  "smoke",
  "prepush",
  "pr",
  "full",
  "nightly",
])

export const assertKnownTier = (tier: string): VerificationTier => {
  if (!knownTiers.has(tier as VerificationTier)) {
    throw new Error(`unknown verification tier: ${tier}`)
  }
  return tier as VerificationTier
}

export const gatesForTier = (
  gates: readonly TierGate[],
  tier: VerificationTier,
): readonly TierGate[] => {
  const ids = new Set<string>()
  const selected: TierGate[] = []
  for (const gate of gates) {
    if (!gate.tiers.includes(tier)) continue
    if (ids.has(gate.id)) throw new Error(`duplicate gate id: ${gate.id}`)
    ids.add(gate.id)
    selected.push(gate)
  }
  if (selected.length === 0) throw new Error(`tier ${tier} has no gates`)
  for (const gate of selected) {
    if (gate.consumes === undefined) continue
    const producer = selected.findIndex((item) => item.id === gate.consumes)
    const consumer = selected.findIndex((item) => item.id === gate.id)
    if (producer === -1) {
      throw new Error(`${gate.id} consumes missing producer ${gate.consumes}`)
    }
    if (producer > consumer) {
      throw new Error(`${gate.id} consumes ${gate.consumes} before it runs`)
    }
  }
  return selected
}

export const orchestrateGates = (input: OrchestrateInput): VerificationResult => {
  const planned = gatesForTier(input.gates, input.tier)
  const results: GateResult[] = []
  const poisoned = new Set<string>()
  let stopped = false
  for (const gate of planned) {
    if (stopped) {
      results.push({
        id: gate.id,
        outcome: "not-run",
        elapsedMs: 0,
        reason: "fail-fast",
      })
      continue
    }
    if (gate.consumes !== undefined && poisoned.has(gate.consumes)) {
      const outcome: VerificationOutcome = "skipped-input"
      poisoned.add(gate.id)
      results.push({
        id: gate.id,
        outcome,
        elapsedMs: 0,
        reason: `producer ${gate.consumes} failed`,
      })
      continue
    }
    const ran = input.runGate(gate)
    if (ran.ok) {
      results.push({
        id: gate.id,
        outcome: "passed",
        elapsedMs: ran.elapsedMs ?? 0,
      })
      continue
    }
    poisoned.add(gate.id)
    results.push({
      id: gate.id,
      outcome: "failed",
      elapsedMs: ran.elapsedMs ?? 0,
    })
    if (input.failFast) stopped = true
  }
  return finalizeVerificationResult({ tier: input.tier, gates: results })
}
