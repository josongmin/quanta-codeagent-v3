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
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import type { DatasetFamily } from "../../dataset-family-token"
import type { FamilyRemoteBootstrap } from "../../profiles/types"
import type { SpawnResult } from "../backend"
import { executeFamilyRemoteBootstrap } from "./family-bootstrap-exec"

export interface FamilyBoxSetupInput {
  readonly family: DatasetFamily
  /** PMX-04 — the family's DECLARED bootstrap, resolved at the launch root and
   *  CARRIED here. Runs AFTER the profile's imperative `setupBox` admission
   *  gate; `undefined` ⇒ not one extra ssh (byte-identical). */
  readonly bootstrap?: FamilyRemoteBootstrap | undefined
  readonly ssh: (cmd: string) => Promise<SpawnResult>
  readonly log: (m: string) => void
}

/**
 * ON-BOX family bootstrap. `bootstrapBox`'s callee: run the family's own
 * admission gate, then its declared AGENT-phase bootstrap.
 *
 * Exported so the stop-rule and gold-absence hellgates can drive the REAL callee
 * with a fake ssh.
 */
export const setupBoxForFamily = async (args: FamilyBoxSetupInput): Promise<void> => {
  // 1. ADMISSION. A family that refuses this lane refuses it BEFORE the box is
  //    asked to do anything on its behalf.
  await executeFamilyRemoteBootstrap({
    bootstrap: args.bootstrap,
    phase: "agent",
    ssh: args.ssh,
    log: args.log,
  })
  await resolveDatasetFamilyProfile(args.family).setupBox({ ssh: args.ssh, log: args.log })
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
