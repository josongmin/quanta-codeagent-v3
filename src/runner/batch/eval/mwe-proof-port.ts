/**
 * SCAFF-06 — executable public-MWE proof PORT for verify-and-select.
 *
 * Reuses the SAME execution path as the issue-smoke probe (extract the public
 * MWE, run it on the base tree, then per-candidate after rematerialising the
 * patch) but interprets it with the OPPOSITE, correct polarity for a fix oracle:
 *
 *   issue-smoke  — base must be GREEN; a candidate that BREAKS it is a hot-path
 *                  regression (and base-red MWEs are discarded).
 *   mwe-proof    — base must be RED (the MWE REPRODUCES the public failure); a
 *                  candidate that makes it GREEN provably fixed it (patched_green,
 *                  admit), one that leaves it red did not (candidate_red, veto).
 *
 * So this port engages precisely on the base-RED MWEs the smoke path throws away.
 * Authority is conferred only by EXECUTED outcomes of a proven base-red oracle
 * (see `mwe-proof.ts`); infra/setup failures are `execution_failed` (never a
 * candidate veto), and a non-reproducing MWE yields no authority.
 *
 * Production drivers supply this port only to the clean selector path. Research
 * mode stays byte-identical, while clean mode may promote a public MWE only after
 * executable base-red proof. The execution is dependency-injected, so it is fully
 * unit testable with fakes (no real Python).
 */

import { extractIssueRepro } from "@/agent/verification-plan/extract-issue-repro"
import type { Instance } from "../types"
import {
  classifyBaseMwe,
  classifyPatchedMwe,
  type MweProofReceipt,
  type MweProofState,
} from "./mwe-proof"
import { resetToBase, withCandidatePatch } from "./rematerialize"
import type { Candidate } from "./selection-executor"
import { type PrepareIssueSmokeSelectionPortDeps, runIssueSmokeScript } from "./selection-smoke"

/**
 * `runIssueSmokeScript` returns the run polarity as `boolean | null`:
 *   true  = exit 0 (MWE passed / did not reproduce a failure),
 *   false = exit non-zero (MWE failed / reproduced a failure),
 *   null  = setup/exec failure (infra).
 * Map that into the BASE proof state (a non-zero exit on base = reproduced).
 */
const baseStateFromRun = (run: boolean | null): MweProofState =>
  classifyBaseMwe({ found: true, ran: run !== null, reproducedFailure: run === false })

/**
 * Build the OPTIONAL executable public-MWE proof port.
 *
 * Returns `undefined` (no port) when there is no extractable MWE / baseCommit, or
 * when the base reset fails, or when the base MWE did NOT reproduce the public
 * failure (`base !== base_red` ⇒ not a valid fix oracle; a base-green MWE is the
 * smoke path's job, not this one). Otherwise returns a per-candidate probe that
 * rematerialises the patch, re-runs the MWE, and classifies the result into a
 * typed {@link MweProofReceipt}.
 */
export const prepareMweProofSelectionPort = async (
  instance: Pick<Instance, "problemStatement" | "localEnv" | "swebench">,
  sandbox: string,
  timeoutMs: number,
  deps: PrepareIssueSmokeSelectionPortDeps = {},
): Promise<((candidate: Candidate) => Promise<MweProofReceipt | null>) | undefined> => {
  const source = extractIssueRepro(instance.problemStatement)?.code
  const baseCommit = instance.swebench?.baseCommit
  if (source === undefined || baseCommit === undefined) return undefined
  const reset = deps.resetBase ?? resetToBase
  const runInSandbox = (sb: string): Promise<boolean | null> =>
    (deps.runScript ?? runIssueSmokeScript)(instance, sb, source, timeoutMs, deps)

  if (!(await reset(sandbox, baseCommit, timeoutMs))) return undefined
  let restoredBase = true
  let baseRun: boolean | null = null
  try {
    baseRun = await runInSandbox(sandbox)
  } finally {
    restoredBase = await reset(sandbox, baseCommit, timeoutMs)
  }
  if (!restoredBase) return undefined
  const base = baseStateFromRun(baseRun)
  // Only a PROVEN base-red oracle can confer candidate authority. A base that did
  // not reproduce (base_not_red / execution_failed) gives this port nothing to
  // say — return undefined so it is never supplied as a selection signal.
  if (base !== "base_red") return undefined

  const rematerialize = deps.rematerialize ?? withCandidatePatch
  return async (candidate) => {
    const patchedRun = await rematerialize<boolean | null>({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: (sb) => runInSandbox(sb),
    })
    return classifyPatchedMwe({
      base,
      ran: patchedRun !== null,
      passed: patchedRun === true,
    })
  }
}
