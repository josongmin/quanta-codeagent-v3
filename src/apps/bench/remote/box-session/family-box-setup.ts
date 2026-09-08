/**
 * LEAF — the ON-BOX FAMILY SETUP sequence, and the WARM-BOX reuse gate.
 *
 * Extracted from `ec2-lifecycle.ts` so the ordering below is a readable,
 * testable unit rather than four lines buried in a 900-line provisioning module
 * (and so that module does not grow toward the god-module ceiling).
 *
 * ## 🔴 ORDERING: the family's own REFUSAL runs FIRST
 *
 * `profile.setupBox` is a family's ADMISSION GATE — the one place a family can
 * say "this lane may not run on this box at all". A family's declared
 * {@link FamilyRemoteBootstrap} is subordinate to it: executing bootstrap
 * commands on a box the family itself refuses is, at best, wasted ssh, and for
 * ProMax it was an ANSWER-KEY LEAK — the bootstrap fetched the gold-bearing
 * upstream tree onto the box and the refusal that the receipt cited as its guard
 * then fired against a box that already held the answer key.
 *
 * So: admission gate, THEN the declared AGENT-phase bootstrap. The order is
 * observable — a recording ssh sees an EMPTY command sequence on a refused
 * lane — which is the only way to tell a real guard from one that fires late.
 *
 * Only families that declare a bootstrap are affected: for verified / live / pro
 * (`bootstrap === undefined`) the two orderings are byte-identical, since the
 * executor issues nothing at all.
 *
 * ## 🔴 A WARM box is not a bootstrapped box
 *
 * `attachBox` reuses a still-running box. A family that declares a remote
 * bootstrap has, by construction, requirements the shared box image does not
 * satisfy (a pinned checkout, a verified digest, a dedicated interpreter), and a
 * reused box carries NO evidence that any of it happened — or that it happened
 * at the commit this campaign claims. {@link ensureWarmBoxFamilyBootstrap}
 * therefore re-runs the agent-phase sequence on attach, and REFUSES when the
 * attach path did not even carry the declared bootstrap: an unverified reuse
 * silently defeats the pin, and a report that cites the pin would then be false.
 */

import type { DatasetFamily } from "../../dataset-family-token"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import type { FamilyRemoteBootstrap } from "../../profiles/types"
import type { SpawnResult } from "../backend"
import { executeFamilyRemoteBootstrap } from "./family-bootstrap-exec"

export interface FamilyBoxSetupInput {
  readonly family: DatasetFamily
  /** PMX-04 — the family's DECLARED bootstrap, resolved at the launch root and
   *  CARRIED here. Runs AFTER the profile's imperative `setupBox` admission
   *  gate. `undefined` is byte-identical only for families that declare none;
   *  a declaring family with no payload is refused (fresh and warm). */
  readonly bootstrap?: FamilyRemoteBootstrap | undefined
  readonly ssh: (cmd: string) => Promise<SpawnResult>
  readonly log: (m: string) => void
}

/**
 * The family ADMISSION gate, on its own — the FIRST thing `bootstrapBox` does,
 * ahead of `mkdir ~/quanta`, the `src/` rsync, the config scp and `bun install`.
 *
 * 🔴 WHY IT IS SEPARATE FROM `setupBox` (aug-22 A-C). `setupBox` conflates two
 * questions — "may this family run here at all?" (ProMax: no) and "make the box
 * ready" (Pro: clone a harness, build a venv) — and it was called at the END of
 * `bootstrapBox`. So on the FRESH-PROVISION path a refusing family's refusal
 * arrived after the box had been created, mkdir'd, rsynced and installed into:
 * the guard fired, but everything it was guarding had already happened. The
 * attach path had been fixed; this is the same fix for the path that provisions.
 *
 * It takes no `ssh` ({@link FamilyAdmissionInput} has none), so "admission
 * cannot mutate the box" is a property of the type, not of the call site.
 */
export const assertFamilyAdmitsBox = (args: {
  readonly family: DatasetFamily
  readonly log: (m: string) => void
}): void => {
  resolveDatasetFamilyProfile(args.family).admitBox({ log: args.log })
}

/**
 * ON-BOX family bootstrap. `bootstrapBox`'s callee: run the family's own
 * admission gate, then its declared AGENT-phase bootstrap.
 *
 * Exported so the stop-rule and gold-absence hellgates can drive the REAL callee
 * with a fake ssh.
 */
export const setupBoxForFamily = async (args: FamilyBoxSetupInput): Promise<void> => {
  // 0. ADMISSION, again. `bootstrapBox` already ran this before it touched the
  //    box (see `assertFamilyAdmitsBox`); repeating it here costs nothing (the
  //    port issues no command) and keeps the ordering true for every OTHER
  //    caller of this callee, including the warm-box reuse gate below.
  assertFamilyAdmitsBox({ family: args.family, log: args.log })
  // 1. A family that DECLARES a bootstrap must CARRY it on the fresh path too.
  //    Warm reuse already refused a missing payload (`ensureWarmBoxFamilyBootstrap`).
  //    Fresh provision used to no-op inside `executeFamilyRemoteBootstrap`, so
  //    `box up` / `pool` could skip the pin while the report still claimed it.
  const declares = resolveDatasetFamilyProfile(args.family).remoteBootstrap !== undefined
  if (declares && args.bootstrap === undefined) {
    throw new Error(
      `[full-remote] refusing to bootstrap dataset-family=${args.family}: the family ` +
        "declares a remote bootstrap (a pinned checkout and an on-box digest verification), but " +
        "the provision path carried none — so this box would skip the pin while the report " +
        "still claimed it. Thread the resolved bootstrap onto the launch config " +
        "(`withResolvedFamilyBootstrap`).",
    )
  }
  // 2. The family's imperative on-box setup. Still ahead of the declared bootstrap.
  await resolveDatasetFamilyProfile(args.family).setupBox({ ssh: args.ssh, log: args.log })
  // 3. The declared AGENT-phase bootstrap. Gold-bearing commands are grader
  //    phase and are refused here by the executor's cross-check.
  //
  //    This is one of TWO non-test call sites of `executeFamilyRemoteBootstrap`,
  //    and it hardcodes the AGENT phase. The other is
  //    `box-session/family-box-grade.ts`, which drives the GRADER phase (and the
  //    teardown bound to it) around the on-box grade, plus the agent phase once
  //    per chunk to re-prove the box is clean.
  //
  //    This comment said the grader phase had no production caller at all. That
  //    was true until PMX-04 wired the grade, and is recorded here because the
  //    lie is the dangerous direction: it tells an operator no answer key ever
  //    lands on a box. `profiles/bootstrap-phase-wiring.ts` owns the claim as
  //    checked data — read it, not this prose.
  await executeFamilyRemoteBootstrap({
    bootstrap: args.bootstrap,
    phase: "agent",
    ssh: args.ssh,
    log: args.log,
  })
}

/**
 * The WARM-BOX reuse gate. Called on the attach path for a box that was NOT
 * re-bootstrapped.
 *
 * Fail-closed in two directions:
 *  - the family declares a bootstrap and the attach path carried one ⇒ re-run
 *    the agent-phase sequence (idempotent probes; the pin is re-proved rather
 *    than assumed);
 *  - the family declares a bootstrap and the attach path carried NONE ⇒ REFUSE.
 *    That is the exact silent-skip the audit found: the launch root resolved the
 *    bootstrap only after its idle-box early return, so a reused box ran neither
 *    the pinned checkout nor the hash step while the report still claimed both.
 *
 * A family with no declared bootstrap is untouched: no profile call, no ssh,
 * byte-identical reuse.
 */
export const ensureWarmBoxFamilyBootstrap = async (args: FamilyBoxSetupInput): Promise<void> => {
  // ADMISSION FIRST, ahead of the `declares` early-return below. A family that
  // refuses this lane refuses a REUSED box too, and gating that on "does it
  // declare a bootstrap?" made the refusal reachable only for families that
  // happen to have one — a refusing family without a declared bootstrap was
  // silently handed a warm box. Free for admitting families: no ssh, no branch.
  assertFamilyAdmitsBox({ family: args.family, log: args.log })
  const declares = resolveDatasetFamilyProfile(args.family).remoteBootstrap !== undefined
  if (!declares) return
  if (args.bootstrap === undefined) {
    throw new Error(
      `[full-remote] refusing to REUSE warm box for dataset-family=${args.family}: the family ` +
        "declares a remote bootstrap (a pinned checkout and an on-box digest verification), but " +
        "the attach path carried none — so this box's bootstrap state is unknown. Reusing it " +
        "would silently skip the pin while the report still claimed it. Launch a fresh box, or " +
        "thread the resolved bootstrap onto the attach config.",
    )
  }
  args.log(
    `[full-remote] warm box reuse: re-proving ${args.family}'s declared agent-phase bootstrap ` +
      "(a reused box carries no evidence the pin was ever verified)…",
  )
  await setupBoxForFamily(args)
}
