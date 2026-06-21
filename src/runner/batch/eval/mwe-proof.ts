/**
 * SCAFF-06 — Executable public MWE proof-state machine (PURE).
 *
 * A public-issue Minimal Working Example (extracted by `extract-issue-repro.ts`)
 * is, by itself, only a SEED: it is the issue author's claimed reproduction, not a
 * script we have observed go red on the base tree and green under a fix. This
 * module is the typed promotion ladder that decides WHEN such an MWE may speak as
 * CLEAN HARD AUTHORITY (admit/veto a candidate) versus when it is advisory-only.
 *
 * The promotion contract (ticket SCAFF-06):
 *   - The MWE must REPRODUCE the public failure on the base tree (`base_red`) —
 *     otherwise it is not a valid oracle and can only steer generation.
 *   - The candidate must be EXECUTED against that same base-red MWE in the same
 *     env. Passing ⇒ `patched_green` (clean admit). Failing ⇒ `candidate_red`
 *     (clean veto). Both are EXECUTED outcomes of a proven oracle.
 *   - Anything that did not actually run, or ran but never reproduced the public
 *     failure, has NO veto authority: `not_found`, `base_not_red`,
 *     `execution_failed`, and a bare `base_red` (no candidate run) cannot reject.
 *   - Env/infra failures running the MWE are `execution_failed` and MUST be
 *     reported as infra — never as candidate-unresolved (that would blame the
 *     model for a broken repro setup).
 *
 * Pure + deterministic: every function takes raw exec results as plain inputs and
 * returns a value. No I/O, no clock, no randomness — same inputs ⇒ same receipt.
 */

/**
 * Proof states for an executable public MWE.
 *
 * Promotion order (each later state strictly requires the prior to have held):
 *   not_found → execution_failed | base_not_red | base_red → patched_green
 *                                                          \→ candidate_red
 */
export type MweProofState =
  /** No extractable MWE — nothing to run. */
  | "not_found"
  /** The MWE ran on base but did NOT reproduce the public failure (base-green). */
  | "base_not_red"
  /** The MWE reproduced the public failure on base — a valid executable oracle. */
  | "base_red"
  /** base_red AND the candidate made the same MWE pass — a clean admit. */
  | "patched_green"
  /**
   * base_red AND the candidate was EXECUTED against the same MWE but it still
   * failed — the candidate did not fix the proven oracle. This is the minimal
   * honest encoding of "candidate did not fix a base-red MWE": a distinct,
   * clearly-named EXECUTED-red state (NOT a carry-through of `base_red`, which
   * would conflate "candidate observed failing" with "candidate never run").
   */
  | "candidate_red"
  /** Infra/env failure running the MWE — NOT candidate-wrong. */
  | "execution_failed"

/**
 * Telemetry receipt for an MWE proof outcome. The execution evidence
 * (`command` / `envPrefix` / `exitStatus`) is carried for the EXECUTED candidate
 * states (`patched_green`, `candidate_red`) so a clean admit/veto can be audited
 * as having actually run, in the candidate's own env.
 */
export interface MweProofReceipt {
  readonly state: MweProofState
  /** The exact argv/cmd string that was executed (executed candidate states). */
  readonly command?: string
  /** The uv/env prefix used — parity evidence that base & candidate shared env. */
  readonly envPrefix?: string
  /** The MWE process exit status (executed candidate states). */
  readonly exitStatus?: number
}

/**
 * Classify the BASE-tree MWE run into a proof state.
 *
 *   found=false                  ⇒ not_found        (no MWE to run)
 *   found && !ran                ⇒ execution_failed (MWE present, infra blocked the run)
 *   ran && reproducedFailure     ⇒ base_red         (valid oracle)
 *   ran && !reproducedFailure    ⇒ base_not_red     (base-green; not an oracle)
 */
export const classifyBaseMwe = (args: {
  readonly found: boolean
  readonly ran: boolean
  readonly reproducedFailure: boolean
}): MweProofState => {
  if (!args.found) return "not_found"
  if (!args.ran) return "execution_failed"
  return args.reproducedFailure ? "base_red" : "base_not_red"
}

/**
 * Classify the CANDIDATE-side MWE run, given the established `base` state.
 *
 * The candidate run only carries authority when the base proved a valid oracle
 * (`base === "base_red"`):
 *   ran && passed   ⇒ patched_green (carry command/envPrefix/exitStatus)
 *   ran && !passed  ⇒ candidate_red (executed RED — candidate did not fix oracle)
 *   !ran            ⇒ execution_failed (infra blocked the candidate run)
 *
 * If `base !== "base_red"`, the patched run has NO authority: the receipt simply
 * echoes the (non-authoritative) base state. A base that was never red cannot be
 * promoted to a veto by anything that happens candidate-side.
 */
export const classifyPatchedMwe = (args: {
  readonly base: MweProofState
  readonly ran: boolean
  readonly passed: boolean
  readonly command?: string
  readonly envPrefix?: string
  readonly exitStatus?: number
}): MweProofReceipt => {
  // No proven base oracle ⇒ candidate run earns nothing; echo the base state.
  if (args.base !== "base_red") return { state: args.base }
  if (!args.ran) return { state: "execution_failed" }
  const evidence = {
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.envPrefix !== undefined ? { envPrefix: args.envPrefix } : {}),
    ...(args.exitStatus !== undefined ? { exitStatus: args.exitStatus } : {}),
  }
  return { state: args.passed ? "patched_green" : "candidate_red", ...evidence }
}

/**
 * Build a receipt for a base-only classification (no candidate run yet). A bare
 * base state never carries execution evidence and never has veto authority.
 */
export const baseReceipt = (state: MweProofState): MweProofReceipt => ({ state })

/**
 * TRUE only for the two EXECUTED outcomes of a proven (base-red) oracle:
 *   - `patched_green`: candidate passed a base-red MWE  ⇒ may clean-ADMIT.
 *   - `candidate_red`: candidate executed but failed it ⇒ may clean-VETO.
 *
 * Everything else is FALSE — the MWE may guide generation but cannot decide
 * selection:
 *   - `not_found` / `base_not_red`: not a valid oracle.
 *   - `execution_failed`: infra, not a verdict.
 *   - `base_red` alone: oracle proven, but the candidate was never run against it.
 */
export const isCleanVetoAuthority = (receipt: MweProofReceipt): boolean =>
  receipt.state === "patched_green" || receipt.state === "candidate_red"

/**
 * TRUE for `execution_failed` only. An infra/env failure running the MWE must be
 * reported as a repro-setup failure, never folded into candidate-unresolved.
 */
export const isInfraFailure = (receipt: MweProofReceipt): boolean =>
  receipt.state === "execution_failed"

/**
 * Clean lexicographic AUTHORITY rank of an MWE receipt for the selector's TOP
 * tier (SCAFF-06). Only the two EXECUTED outcomes of a proven base-red oracle
 * speak:
 *   - `patched_green` ⇒ +1 (candidate provably fixes the PUBLIC reported failure
 *     ⇒ admit / rank above non-proven candidates),
 *   - `candidate_red`  ⇒ -1 (candidate was executed and provably FAILS the
 *     base-red public MWE ⇒ veto / rank below neutral),
 *   - everything else ⇒ 0 (no authority). Crucially `execution_failed` (infra)
 *     and an ABSENT receipt are BOTH 0 — an infra failure must never veto a
 *     candidate, and an unpopulated receipt keeps selection byte-identical until
 *     a real MWE execution feeds receipts.
 */
export const mweProofAuthorityRank = (receipt: MweProofReceipt | undefined): -1 | 0 | 1 => {
  if (receipt === undefined) return 0
  if (receipt.state === "patched_green") return 1
  if (receipt.state === "candidate_red") return -1
  return 0
}
