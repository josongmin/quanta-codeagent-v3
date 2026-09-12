import { runGateDag } from "./gate-dag"
import {
  finalizeVerificationResult,
  type GateResult,
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

const isGateCliArg = (arg: string): boolean =>
  arg === "gate.ts" || arg === "tools/dev/gate.ts" || arg.endsWith("/gate.ts")

/** Diagnostic parse of a campaign argv. Unknown tokens stay null, never a guessed tier. */
export const tierFromGateCommand = (
  command: readonly string[],
): VerificationTier | "precommit" | null => {
  const idx = command.findIndex(isGateCliArg)
  if (idx === -1) return null
  const next = command.slice(idx + 1).find((arg) => !arg.startsWith("-"))
  if (next === undefined) return null
  if (next === "precommit") return "precommit"
  if (!knownTiers.has(next as VerificationTier)) return null
  return next as VerificationTier
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

export interface PlannedGate {
  readonly id: string
  readonly consumes?: string
}

export type GateRunAttempt = {
  readonly ok: boolean
  readonly elapsedMs?: number
}

/**
 * Single skip / fail-fast sequencer. CLI and tests must not reimplement this.
 *
 * Now a BRIDGE onto `runGateDag`, not a second implementation. There were two
 * schedulers: this one, which awaited every gate in manifest order, and a
 * ready-set DAG scheduler with resource exclusion and multi-input `consumes`
 * that had no production call site at all. Two schedulers is one too many for a
 * decision this load-bearing — the one nobody ran was where the newer thinking
 * lived, and the one everybody ran could not express "wait for A and B".
 *
 * Concurrency is 1: every gate here drives a real toolchain, no gate declares
 * the `resources` the scheduler would need to overlap them safely, and this
 * repository carries a measured scar about contention producing a differently
 * TIMED wrong answer rather than a slower right one. Raising it is a separate
 * change, gated on gates declaring what they hold.
 *
 * NOT "behaviourally identical to the loop it replaces", which is what this
 * docstring used to claim. Two differences, both measured, both deliberate, and
 * both pinned by tests:
 *
 *  1. A gate whose PRODUCER failed now reports `skipped-input`, where the old
 *     sequencer short-circuited on fail-fast first and reported the less
 *     actionable of the two reasons.
 *  2. Dispatch follows the ready set, so a gate declared BEFORE its producer run
 *     after it — measured `planned [a(consumes b), b]` dispatches `b,a`. The
 *     RESULT list stays in manifest order (`a,b`), which is what the report and
 *     every consumer of `GateResult[]` depend on.
 *
 * Serial it is; identical it is not, and saying so is cheaper than someone
 * discovering it from a changed message.
 */
export const stepGatePlan = async <T extends PlannedGate>(input: {
  readonly planned: readonly T[]
  readonly failFast: boolean
  readonly runGate: (gate: T) => GateRunAttempt | Promise<GateRunAttempt>
}): Promise<readonly GateResult[]> => {
  const byId = new Map(input.planned.map((gate) => [gate.id, gate]))
  const results = await runGateDag({
    // `PlannedGate.consumes` is a single id; the DAG takes a list. Widened
    // here rather than at the manifest, so nothing has to be restated to get
    // the new scheduler.
    gates: input.planned.map((gate) => ({
      id: gate.id,
      ...(gate.consumes === undefined ? {} : { consumes: [gate.consumes] }),
    })),
    failFast: input.failFast,
    concurrency: 1,
    run: async (gate) => {
      const planned = byId.get(gate.id)
      if (planned === undefined) throw new Error(`stepGatePlan: unknown gate ${gate.id}`)
      return await input.runGate(planned)
    },
  })
  return results.map((result) => ({
    id: result.id,
    outcome: result.outcome,
    elapsedMs: result.elapsedMs,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  }))
}

export const orchestrateGates = async (input: OrchestrateInput): Promise<VerificationResult> => {
  const planned = gatesForTier(input.gates, input.tier)
  return finalizeVerificationResult({
    tier: input.tier,
    gates: await stepGatePlan({
      planned,
      failFast: input.failFast,
      runGate: input.runGate,
    }),
  })
}
