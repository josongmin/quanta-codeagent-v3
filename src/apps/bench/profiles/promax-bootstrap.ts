/**
 * PMX-04 — the ProMax profile's REMOTE BOOTSTRAP leaf.
 *
 * This is the PROJECTION layer the ticket asks for and nothing more: it decides
 * the on-box LAYOUT (where the pinned upstream checkout and the dedicated
 * interpreter live) and then delegates every semantic decision — which commit,
 * which three file hashes, how the checkout avoids a moving branch, how many
 * evaluator workers — to `harness/promax/evaluator-bootstrap.ts`, which owns
 * them.
 *
 * Keeping it in `profiles/` rather than in `remote/` is what satisfies packet
 * invariant 10: `box-session.ts` / `ec2-lifecycle.ts` gain no ProMax branch, and
 * a future family adds its own leaf here instead of editing a consumer.
 */
import {
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
} from "../harness/promax"
import type { BenchRunConfig } from "../run-config"
import { formatPythonVersion } from "./python-version"
import type { FamilyBootstrapCommand, FamilyRemoteBootstrap } from "./types"

/**
 * The on-box layout PMX-04 owns.
 *
 * Absolute by requirement: `~` is not expanded inside an env value, and a
 * cwd-relative campaign path cannot be replayed from a report.
 *
 * ## 🔴 The PATH is not the defence — do not read it as one
 *
 * A quanta-owned root outside the box user's `$HOME` puts the checkout outside
 * the tree the agent's workspace tooling walks. That is tidiness, NOT security:
 * the bench agent's `bash` tool is unsandboxed on a bench box (a pre-existing
 * architectural property of `runner/batch/eval/sandbox.ts`), so a path the agent
 * can `cat` is a filename, not a boundary. Nor does withholding the path from
 * the agent's env buy anything — the root and the pinned commit are both shipped
 * to the box in plaintext production source and printed by every dry-run.
 *
 * What actually keeps the answer key away from the agent is ABSENCE during the
 * agent phase: {@link PROMAX_ONBOX_CHECKOUT_ROOT} does not EXIST while the agent
 * runs. Every command that creates or reads it is declared `phase: "grader"` and
 * `goldBearing: true` in `harness/promax/evaluator-bootstrap.ts`, and the
 * executor refuses to run a gold-bearing command in the agent phase.
 *
 * 🔴 AND TODAY, MORE BLUNTLY THAN THAT: none of this plan executes on any lane.
 * ProMax's `admitBox` refuses every box (PMX-04), and NO production caller runs
 * the `grader` phase at all, so the checkout below is never created and its
 * teardown never runs. The plan is a specification that a dry-run prints, not a
 * sequence a box has performed. `profiles/bootstrap-phase-wiring.ts` owns that
 * statement as checked data, and surfaces it on the dry-run plan so an operator
 * is not left inferring liveness from the plan's existence.
 *
 * {@link PROMAX_ONBOX_ROOT} is the CAMPAIGN root: the agent phase creates it
 * EMPTY (so the disk gate has a real mount to measure) and nothing is in it
 * until grading starts.
 */
export const PROMAX_ONBOX_ROOT = "/opt/quanta/promax"
export const PROMAX_ONBOX_CHECKOUT_ROOT = `${PROMAX_ONBOX_ROOT}/upstream`
export const PROMAX_ONBOX_VENV_ROOT = `${PROMAX_ONBOX_ROOT}/venv`

/**
 * Agent-side concurrency as far as the BOOTSTRAP is concerned.
 *
 * It is deliberately 1 here and not "whatever the box will run with": this value
 * exists only so the specification records that the two axes are DIFFERENT
 * numbers. The live patch-gen concurrency is resolved by the remote executor at
 * launch (it is bounded by the shared model rate limit, which is a property of
 * the account, not of the family), and it never becomes the grader's.
 */
const BOOTSTRAP_PATCHGEN_UNITS = 1

export const proMaxRemoteBootstrap = (cfg: BenchRunConfig): FamilyRemoteBootstrap => {
  const spec = buildProMaxBootstrapSpec({
    campaignRoot: PROMAX_ONBOX_ROOT,
    checkoutRoot: PROMAX_ONBOX_CHECKOUT_ROOT,
    venvRoot: PROMAX_ONBOX_VENV_ROOT,
    patchGenConcurrency: BOOTSTRAP_PATCHGEN_UNITS,
  })
  // 🔴 NO RE-MAPPING. This used to project each command to `{step, argv,
  // purpose}`, which DROPPED the typed `verifies` digest expectation at the
  // profile boundary — the box then executed argv with nothing comparing the
  // observed hash, while the campaign receipt cited the check as its guard.
  // `ProMaxBootstrapCommand extends FamilyBootstrapCommand`, so the plan is the
  // value the port carries and a future field cannot be silently lost here.
  const commands: readonly FamilyBootstrapCommand[] = buildProMaxBootstrapPlan(spec)
  return {
    family: "promax",
    commands,
    graderWorkers: spec.evaluatorWorkers,
    planNotes: [
      `[dry-run] promax-upstream-repo=${spec.upstreamRepoUrl}`,
      `[dry-run] promax-checkout-root=${spec.checkoutRoot} (detached at ${cfg.promax.upstreamCommit})`,
      `[dry-run] promax-evaluator=${spec.checkoutRoot}/${PROMAX_EVALUATOR_RELATIVE_PATH}`,
      `[dry-run] promax-eval-meta=${spec.checkoutRoot}/${PROMAX_EVAL_META_RELATIVE_PATH}`,
      `[dry-run] promax-evaluator-python=${spec.evaluatorPython}`,
      // The interpreter FLOOR, printed beside the interpreter it constrains. It
      // is checked on the box (an agent-phase probe carrying the typed floor),
      // so this line describes a gate rather than an expectation.
      `[dry-run] promax-min-python=${formatPythonVersion(spec.minPythonVersion)} (REFUSES the box below this; pinned evaluator uses PEP 604)`,
      // The two concurrency axes, printed together on purpose: an operator who
      // raises patch-gen concurrency must be able to see that the grader did not
      // move with it.
      `[dry-run] promax-evaluator-workers=${spec.evaluatorWorkers} (grader; PINNED until a measured concurrency campaign)`,
      `[dry-run] promax-required-platform=${spec.requiredPlatform.os}/${spec.requiredPlatform.architecture}`,
    ],
  }
}
