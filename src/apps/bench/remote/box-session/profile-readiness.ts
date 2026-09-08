/**
 * LEAF — family-profile box readiness. Extracted from `ec2-lifecycle.ts` so
 * bootstrap and warm selection cannot drift onto a hardcoded swebench probe,
 * and so that module drops out of the 900–999 cohort.
 *
 * The probe STRING is owned by `profiles/family-box-readiness.ts`. This leaf
 * only runs it over ssh.
 */
import type { DatasetFamily } from "../../dataset-family-token"
import { boxProfileReadinessProbe } from "../../profiles/family-box-readiness"
import { resolveDatasetFamilyProfile } from "../../profiles/registry"
import type { SpawnResult } from "../backend"

/** Is this box fully bootstrapped for `family`? A warm box from a prior run
 *  satisfies the SAME probe bootstrap asserts; a half-provisioned one does not. */
export const isBoxProfileReady = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  family: DatasetFamily,
): Promise<boolean> => {
  const probe = await ssh(boxProfileReadinessProbe(resolveDatasetFamilyProfile(family)))
  return probe.code === 0 && probe.stdout.includes("OK")
}

/** Post-bootstrap gate: a completed phase sequence that still fails the
 *  profile probe is not ready — never a false-ready. */
export const assertBoxProfileReady = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  family: DatasetFamily,
): Promise<void> => {
  if (await isBoxProfileReady(ssh, family)) return
  throw new Error(
    `[full-remote] bootstrap finished but dataset-family=${family} readiness probe failed`,
  )
}
