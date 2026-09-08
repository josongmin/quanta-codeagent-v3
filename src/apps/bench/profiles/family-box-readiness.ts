/**
 * G-F5 — bootstrap and warm-box selection share ONE family-derived readiness.
 *
 * Common prerequisites (bun + synced src) always apply. The swebench grading
 * shim is optional: only families that grade through the swebench harness need
 * `~/swebench-python`. A family with `boxGrade` grades in its own grader phase —
 * skip the SHIM, never skip family setup. Warm selection must use this probe,
 * not a hardcoded swebench path for every family.
 */
import type { DatasetFamilyProfile } from "./types"

/** Families that grade via the swebench harness need the on-box shim.
 *  `boxGrade` present ⇒ skip SHIM only, not family setup. */
export const familyRequiresSwebenchShim = (profile: DatasetFamilyProfile): boolean =>
  profile.boxGrade === undefined

const BUN_READY = "test -x ~/.bun/bin/bun"
const SRC_READY = "test -d ~/quanta/src"
const SWEBENCH_SHIM_READY = "test -x ~/swebench-python"

/** SSH probe that `isBootstrapped` / warm selection and post-bootstrap
 *  readiness both consume. Swebench-family order stays byte-identical to the
 *  historical universal probe so default-family inspect rails keep matching. */
export const boxProfileReadinessProbe = (profile: DatasetFamilyProfile): string => {
  const checks = familyRequiresSwebenchShim(profile)
    ? [BUN_READY, SWEBENCH_SHIM_READY, SRC_READY]
    : [BUN_READY, SRC_READY]
  return `${checks.join(" && ")} && echo OK`
}
