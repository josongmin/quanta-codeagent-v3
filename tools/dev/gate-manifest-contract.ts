/**
 * `tools/dev/gate-manifest-contract` — the pure validator every gate entrypoint
 * shares.
 *
 * # The drift this exists to stop
 *
 * `gate.ts` used to guard the manifest with a hand-maintained COUNT floor
 * (`MIN_OWNED = { precommit: 10, prepush: 11 }`). A later commit consolidated
 * three precommit gates (`fc-validate`, `fc-diff`, `fc-lint`) into one
 * (`fc-ci`) and nobody moved the floor. From that commit on, the manifest owned
 * 8 precommit gates against a floor of 10, so `bun run precommit`,
 * `bun run prepush`, and every `gate.ts <tier>` invocation printed
 *
 *     gate.ts: the manifest owns 8 precommit gate(s), below the floor of 10.
 *
 * and exited 1 BEFORE dispatching a single gate. The local verification command
 * was dead at HEAD and the failure read as a manifest problem, not a floor
 * problem.
 *
 * Worse, `--list` returns before that check, so the listing path kept printing a
 * healthy-looking manifest. Listing said "fine"; running said "refusing". The
 * two paths disagreed because only one of them validated.
 *
 * # Why a count floor cannot be the contract
 *
 * A number cannot name what is missing, and it cannot tell a DELETION from a
 * RENAME from a MIS-STAGE. Three gates folding into one is a legitimate edit; a
 * gate silently moving from `precommit` to `prepush` is not, and both move the
 * count by the same amount. So the contract is the exact `(id, stage)` set, and
 * a violation names the offending id.
 *
 * Loosening the floor would have "fixed" the red in one character. That is the
 * repair this module refuses to make available: the contract is edited by
 * adding or removing a named entry, in the same reviewable diff as the manifest
 * change it describes.
 *
 * # No side effects
 *
 * This validator spawns nothing, reads no files, and touches no environment. It
 * is the thing `--list`, `--plan` and the run path can all afford to call
 * before they diverge.
 */

/** Mirrors `GateStage` in `./gate-manifest`. Declared structurally so this
 *  module stays import-free of the manifest it validates (the manifest holds
 *  the contract data, so a value import would be a cycle). */
export type GateContractStage = "precommit" | "prepush"

/** One entry of the canonical exact set: which gate, owned by which stage. */
export interface GateContractEntry {
  readonly id: string
  readonly stage: GateContractStage
}

/** The manifest shape this validator needs. The real `Gate` has more fields. */
export interface GateUnderContract {
  readonly id: string
  readonly stage: GateContractStage
  readonly consumes?: string
}

export type GateManifestViolationKind =
  /** The contract names a gate the manifest no longer has. */
  | "missing"
  /** The manifest has a gate the contract does not name. */
  | "unexpected"
  /** Present on both sides, but owned by a different stage than contracted. */
  | "mis-staged"
  /** The same id appears twice in the manifest (or twice in the contract). */
  | "duplicate"
  /** A `consumes` that names no gate in the manifest at all. */
  | "dangling-consumes"
  /** `consumes` edges form a cycle, so no ordering can satisfy them. */
  | "consumes-cycle"
  /** A stage the contract claims to own has no gates left in it. */
  | "empty-stage"
  /** The contract itself is empty — the anti-vacuum floor. */
  | "empty-contract"

export interface GateManifestViolation {
  readonly kind: GateManifestViolationKind
  /** The offending gate id, or the stage name for stage-level violations. */
  readonly id: string
  /** One line, naming what to do about it. */
  readonly detail: string
}

const sortViolations = (
  violations: readonly GateManifestViolation[],
): readonly GateManifestViolation[] =>
  [...violations].sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind < b.kind ? -1 : 1,
  )

/**
 * Every `consumes` edge that participates in a cycle, by id.
 *
 * A cycle is not the same defect as a dangling producer: the ids all exist, so
 * the membership check clears, and the per-tier ordering check in `gatesForTier`
 * reports only the first pair it happens to see. Reported here so the whole
 * cycle is named at once.
 */
const consumesCycleIds = (gates: readonly GateUnderContract[]): readonly string[] => {
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  const state = new Map<string, "visiting" | "done">()
  const inCycle = new Set<string>()
  const walk = (id: string, path: string[]): void => {
    const seen = state.get(id)
    if (seen === "done") return
    if (seen === "visiting") {
      // Everything from the first sighting of `id` onwards is the cycle.
      for (const member of path.slice(path.indexOf(id))) inCycle.add(member)
      return
    }
    state.set(id, "visiting")
    const next = byId.get(id)?.consumes
    if (next !== undefined && byId.has(next)) walk(next, [...path, id])
    state.set(id, "done")
  }
  for (const gate of gates) walk(gate.id, [])
  return [...inCycle].sort()
}

/** Index a side of the comparison, reporting any id declared twice. */
const indexById = (
  entries: readonly { readonly id: string; readonly stage: GateContractStage }[],
  describeDuplicate: (id: string) => string,
  into: GateManifestViolation[],
): Map<string, GateContractStage> => {
  const byId = new Map<string, GateContractStage>()
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      into.push({ kind: "duplicate", id: entry.id, detail: describeDuplicate(entry.id) })
      continue
    }
    byId.set(entry.id, entry.stage)
  }
  return byId
}

/** Set difference in both directions, plus the stage comparison a count cannot make. */
const membershipViolations = (
  contractById: ReadonlyMap<string, GateContractStage>,
  manifestById: ReadonlyMap<string, GateContractStage>,
): readonly GateManifestViolation[] => {
  const out: GateManifestViolation[] = []
  for (const [id, stage] of contractById) {
    const actual = manifestById.get(id)
    if (actual === undefined) {
      out.push({
        kind: "missing",
        id,
        detail: `gate "${id}" (${stage}) is in the contract but not in the manifest — it was deleted or renamed; remove it from the contract in the same diff if that is intended`,
      })
      continue
    }
    if (actual !== stage) {
      out.push({
        kind: "mis-staged",
        id,
        detail: `gate "${id}" is contracted to ${stage} but the manifest stages it as ${actual}`,
      })
    }
  }
  for (const [id, stage] of manifestById) {
    if (contractById.has(id)) continue
    out.push({
      kind: "unexpected",
      id,
      detail: `gate "${id}" (${stage}) is in the manifest but not in the contract — add it there so its existence is reviewable`,
    })
  }
  return out
}

/** Producer edges: named-but-absent, and cyclic. */
const consumesViolations = (
  gates: readonly GateUnderContract[],
  manifestById: ReadonlyMap<string, GateContractStage>,
): readonly GateManifestViolation[] => {
  const out: GateManifestViolation[] = []
  for (const gate of gates) {
    if (gate.consumes === undefined) continue
    if (manifestById.has(gate.consumes)) continue
    out.push({
      kind: "dangling-consumes",
      id: gate.id,
      detail: `gate "${gate.id}" consumes "${gate.consumes}", which is not a gate — the skip-on-failed-input protection would be silently off`,
    })
  }
  for (const id of consumesCycleIds(gates)) {
    out.push({
      kind: "consumes-cycle",
      id,
      detail: `gate "${id}" is part of a \`consumes\` cycle, so no ordering can put every producer before its consumer`,
    })
  }
  return out
}

/**
 * A stage the contract still claims must not be empty in the manifest.
 *
 * A mass mis-stage moves every gate out of one stage while keeping the TOTAL,
 * which is the shape the old superset floor was documented to catch and did not.
 */
const emptyStageViolations = (
  contract: readonly GateContractEntry[],
  gates: readonly GateUnderContract[],
): readonly GateManifestViolation[] =>
  (["precommit", "prepush"] as const)
    .filter(
      (stage) =>
        contract.some((entry) => entry.stage === stage) &&
        !gates.some((gate) => gate.stage === stage),
    )
    .map((stage) => ({
      kind: "empty-stage" as const,
      id: stage,
      detail: `the contract owns ${stage} gates but the manifest has none left in that stage`,
    }))

/**
 * Compare a manifest against its contract. Pure; returns every violation rather
 * than throwing on the first, so one run names the whole diff.
 */
export const validateGateManifest = (
  gates: readonly GateUnderContract[],
  contract: readonly GateContractEntry[],
): readonly GateManifestViolation[] => {
  // ANTI-VACUUM. An emptied contract would make every other check below
  // vacuously clear, which is exactly the shape the count floor had.
  if (contract.length === 0) {
    return [
      {
        kind: "empty-contract",
        id: "<contract>",
        detail:
          "the gate contract is empty, so every manifest would satisfy it — refusing to validate over nothing",
      },
    ]
  }

  const violations: GateManifestViolation[] = []
  const contractById = indexById(
    contract,
    (id) => `the contract names "${id}" more than once`,
    violations,
  )
  const manifestById = indexById(
    gates,
    (id) => `the manifest declares gate "${id}" more than once`,
    violations,
  )
  violations.push(
    ...membershipViolations(contractById, manifestById),
    ...consumesViolations(gates, manifestById),
    ...emptyStageViolations(contract, gates),
  )
  return sortViolations(violations)
}

/** Human-readable report. Empty string when there is nothing to say. */
export const formatGateManifestViolations = (
  violations: readonly GateManifestViolation[],
): string => {
  if (violations.length === 0) return ""
  const lines = violations.map((v) => `  [${v.kind}] ${v.detail}`)
  return (
    `gate manifest does not match its contract (${violations.length} violation(s)):\n` +
    `${lines.join("\n")}\n` +
    "The contract is tools/dev/gate-manifest.ts:GATE_CONTRACT. Edit it in the same diff as the manifest change — never widen a floor to clear this."
  )
}
