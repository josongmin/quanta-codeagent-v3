/**
 * LEAF — WHICH bootstrap phases a PRODUCTION caller actually executes.
 *
 * ## 🔴 Read this before trusting the gold-lifecycle machinery
 *
 * `remote/box-session/family-bootstrap-exec.ts` implements a complete answer-key
 * lifecycle: the GRADER phase materializes gold, a TEARDOWN bound to that same
 * executor call removes it, and the next chunk's AGENT phase proves the absence
 * before the agent runs. Every clause of it is real, tested, and fail-closed.
 *
 * It is also, TODAY, PRODUCTION-INERT — for two independent reasons an aug-22
 * adversarial audit established and this module records as DATA:
 *
 *   1. `executeFamilyRemoteBootstrap` has exactly ONE non-test caller
 *      (`family-box-setup.ts`), and it hardcodes `phase: "agent"`. Nothing in
 *      `src/` ever executes the GRADER phase, so the teardown in that call's
 *      `finally` never runs on any lane.
 *   2. ProMax is the only family declaring a `remoteBootstrap`, and its
 *      `admitBox` unconditionally refuses (PMX-04 owns the live lane). So even
 *      the agent-phase absence probe — whose call site IS wired — is never
 *      reached by a shipped family.
 *
 * That is a SAFE state, not a leak: the grader phase is the only thing that puts
 * answer-key bytes on a box, and a phase nobody executes materializes nothing.
 * What it is NOT is a live defence, and the previous module docs read as though
 * it were. The honest encoding is this table plus the two things it feeds:
 *
 *   • {@link assertFamilyBootstrapPhaseWiringInSync}, called on the DEFAULT path
 *     by the executor itself, so the table cannot rot into a lie in silence;
 *   • {@link familyBootstrapWiringPlanNotes}, which puts the inertness on the
 *     operator's `--dry-run` plan, so no campaign receipt can cite a teardown
 *     that does not run.
 *
 * ## Why there is no runtime REFUSAL here
 *
 * The obvious-looking guard — "refuse a family that ADMITS boxes while its
 * gold-materializing bootstrap has no grader-phase executor" — was considered
 * and REJECTED, on evidence rather than taste: the only lane on which the
 * agent-phase absence probe is currently proven end-to-end (the synthetic
 * admitting family in `promax-gold-absence-lifecycle.test.ts`, carrying the real
 * ProMax plan through the real `attachBox` provision and warm-reuse paths) has
 * exactly that shape. Adding the refusal would convert the strongest existing
 * proof of the probe into a refusal — i.e. it would REDUCE the defence in order
 * to look stricter.
 *
 * The clause is enforced instead where it costs nothing and can still fail:
 * `promax-bootstrap-phase-reachability.test.ts` asserts, over the real registry
 * and the real `src/` bytes, that no SHIPPED family admits boxes while its
 * teardown has no production executor. Flipping ProMax's `admitBox` to admit
 * without wiring a grader-phase caller turns that rail red.
 */
import {
  FAMILY_BOOTSTRAP_PHASES,
  type FamilyBootstrapPhase,
  type FamilyRemoteBootstrap,
} from "./types"

/**
 * How a phase reaches a box in production.
 *
 *  - `executed`  — a non-test module calls the executor with this phase.
 *  - `bound-to`  — this phase runs inside ANOTHER phase's executor call, so it
 *                  is exactly as reachable as that phase and no more.
 *  - `unwired`   — NOTHING in `src/` executes it. `owner`/`why` are rendered to
 *                  operators, so the claim has to stay true to stay useful.
 */
export type FamilyBootstrapPhaseWiring =
  | { readonly kind: "executed"; readonly callSite: string }
  | { readonly kind: "bound-to"; readonly phase: FamilyBootstrapPhase }
  | { readonly kind: "unwired"; readonly owner: string; readonly why: string }

/** The closed set of verdicts, so a new one cannot be added without revisiting
 *  every consumer (and so a test can prove the table did not collapse to one). */
export const FAMILY_BOOTSTRAP_PHASE_WIRING_KINDS = ["executed", "bound-to", "unwired"] as const

export type FamilyBootstrapPhaseWiringKind = (typeof FAMILY_BOOTSTRAP_PHASE_WIRING_KINDS)[number]

/**
 * THE TABLE. Every phase classified; checked against the real `src/` bytes by
 * `promax-bootstrap-phase-reachability.test.ts`, which scans for
 * `executeFamilyRemoteBootstrap({ … phase: "…" })` call sites and refuses to
 * classify a non-literal phase rather than reporting a false absence.
 */
export const FAMILY_BOOTSTRAP_PHASE_WIRING = {
  agent: {
    kind: "executed",
    callSite: "src/apps/bench/remote/box-session/family-box-setup.ts (setupBoxForFamily)",
  },
  grader: {
    kind: "executed",
    callSite: "src/apps/bench/remote/box-session/family-box-grade.ts (runFamilyBoxGrade)",
  },
  teardown: { kind: "bound-to", phase: "grader" },
} as const satisfies Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring>

export class FamilyBootstrapWiringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FamilyBootstrapWiringError"
  }
}

type WiringTable = Record<FamilyBootstrapPhase, FamilyBootstrapPhaseWiring>

/**
 * Does a PRODUCTION caller execute this phase? `bound-to` resolves to whatever
 * the phase it is bound to answers — one hop only; a chain of `bound-to` is a
 * drift-guard error rather than a recursion, because a phase whose reachability
 * takes two hops to state is a phase nobody can reason about.
 */
export const familyBootstrapPhaseIsExecutedInProduction = (
  phase: FamilyBootstrapPhase,
  table: WiringTable = FAMILY_BOOTSTRAP_PHASE_WIRING,
): boolean => {
  const wiring = table[phase]
  if (wiring === undefined) return false
  if (wiring.kind === "executed") return true
  if (wiring.kind === "unwired") return false
  return table[wiring.phase]?.kind === "executed"
}

/**
 * The phases with their OWN production call site, in declaration order.
 *
 * Deliberately NOT the same question as
 * {@link familyBootstrapPhaseIsExecutedInProduction}: a `bound-to` phase runs
 * when its host runs but has no call site of its own, and this list is the one
 * compared against a scan of `src/` for actual call sites.
 */
export const productionExecutedBootstrapPhases = (
  table: WiringTable = FAMILY_BOOTSTRAP_PHASE_WIRING,
): readonly FamilyBootstrapPhase[] =>
  FAMILY_BOOTSTRAP_PHASES.filter((phase) => table[phase]?.kind === "executed")

/**
 * RUNTIME drift guard for the table, called on the default path by
 * `executeFamilyRemoteBootstrap`.
 *
 * `satisfies Record<FamilyBootstrapPhase, …>` proves TOTALITY at compile time,
 * which is exactly what a "make it compile" widening of the annotation defeats.
 * This re-checks it where a widened annotation cannot help, and adds three
 * structural claims a type cannot make:
 *
 *   1. a `bound-to` must point at a phase that EXISTS and is NOT itself
 *      `bound-to` — reachability is one hop, so it can be stated in a sentence.
 *      (Pointing at an `unwired` phase is legal and is exactly today's state:
 *      the teardown is unreachable BECAUSE the grader is.)
 *   2. no key outside the phase union is classified;
 *   3. SOMETHING must be executed — a table in which no phase is reachable
 *      describes an executor that is dead code, and would make every consumer of
 *      {@link familyBootstrapPhaseIsExecutedInProduction} answer "unreachable"
 *      for free, which is the failure mode this module exists to report.
 */
export const assertFamilyBootstrapPhaseWiringInSync = (
  table: WiringTable = FAMILY_BOOTSTRAP_PHASE_WIRING,
): void => {
  const problems: string[] = []
  for (const phase of FAMILY_BOOTSTRAP_PHASES) {
    const wiring = table[phase]
    if (wiring === undefined) {
      problems.push(`phase \`${phase}\` is UNCLASSIFIED`)
      continue
    }
    if (wiring.kind !== "bound-to") continue
    const target = table[wiring.phase]
    if (target === undefined) {
      problems.push(`phase \`${phase}\` is bound to \`${wiring.phase}\`, which is UNCLASSIFIED`)
      continue
    }
    if (target.kind === "bound-to") {
      problems.push(
        `phase \`${phase}\` is bound to \`${wiring.phase}\`, which is itself bound to ` +
          `\`${target.phase}\` — reachability must be one hop, not a chain`,
      )
    }
  }
  for (const key of Object.keys(table)) {
    if (!(FAMILY_BOOTSTRAP_PHASES as readonly string[]).includes(key)) {
      problems.push(`\`${key}\` is classified but is not a bootstrap phase`)
    }
  }
  if (productionExecutedBootstrapPhases(table).length === 0) {
    problems.push(
      "no production caller executes ANY bootstrap phase — the executor would be dead code, " +
        "and every reachability question would answer `no` for free",
    )
  }
  if (problems.length === 0) return
  throw new FamilyBootstrapWiringError(
    `family bootstrap phase wiring is out of sync: ${problems.join("; ")}. The table in ` +
      "profiles/bootstrap-phase-wiring.ts must describe what src/ actually calls.",
  )
}

/**
 * Does this bootstrap put answer-key bytes on the box at all?
 *
 * The ONE definition, shared by the executor's two lifecycle clauses (a family
 * that materializes gold must declare a teardown, and must prove absence before
 * the agent runs) and by the operator-facing note below — so "materializes gold"
 * cannot come to mean two different things in the gate and in the plan.
 */
export const bootstrapMaterializesGold = (bootstrap: FamilyRemoteBootstrap): boolean =>
  bootstrap.commands.some((command) => command.phase === "grader" && command.goldBearing)

/**
 * The operator-facing consequence, on the `--dry-run` plan.
 *
 * Only a bootstrap that MATERIALIZES GOLD and whose lifecycle phases are not all
 * executed produces a line, so every family without one is byte-identical.
 *
 * This exists because the failure mode is not a leak today — it is a RECEIPT
 * that cites a teardown as its guard while nothing runs it. An operator reading
 * a plan should not have to open the source to learn that.
 */
export const familyBootstrapWiringPlanNotes = (
  bootstrap: FamilyRemoteBootstrap | undefined,
  table: WiringTable = FAMILY_BOOTSTRAP_PHASE_WIRING,
): readonly string[] => {
  if (bootstrap === undefined || !bootstrapMaterializesGold(bootstrap)) return []
  const unreached = FAMILY_BOOTSTRAP_PHASES.filter(
    (phase) => !familyBootstrapPhaseIsExecutedInProduction(phase, table),
  )
  if (unreached.length === 0) return []
  const owners = unreached
    .map((phase) => table[phase])
    .filter(
      (wiring): wiring is { kind: "unwired"; owner: string; why: string } =>
        wiring?.kind === "unwired",
    )
    .map((wiring) => `${wiring.owner}: ${wiring.why}`)
  const teardowns = bootstrap.commands.filter((command) => command.phase === "teardown").length
  return [
    `[dry-run] ⚠️ ${bootstrap.family}-gold-lifecycle=NOT-EXECUTED-IN-PRODUCTION — no production ` +
      `caller runs phase=${unreached.join("/")} (${owners.join("; ")}). This family's ` +
      `${teardowns} declared teardown command(s) therefore DO NOT RUN on any lane today, and ` +
      "neither does the grader work they undo; the family's own admission gate is what keeps " +
      "that from mattering. Do not cite the teardown as a live guard.",
  ]
}
