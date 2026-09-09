/**
 * RFC-06 F1 — the SINGLE production skill-runtime-authority builder
 * (`@/runner/assemble/session-authorities`).
 *
 * This is F1's half of the shared session-authorities owner lock (board §5:
 * A2 -> D4 -> C2 -> E2/E3 -> F1; host bootstrap C2 -> E3 -> F1). It mirrors
 * RFC-03 C2's `build-objective.ts` and RFC-05 E3's `build-posture.ts`: ONE place
 * production code constructs the per-session skill runtime authority, so no
 * surface mints its own discovery scan + per-consumer disabled filter.
 *
 * It performs the REAL loader composition RFC-06 pins as load-bearing ("The
 * production composition test must show a real loader call; existence of decision
 * functions is not evidence"):
 *
 *   1. `buildSkillSnapshot` — the real precedence-resolved registry (discovery
 *      of admin/repo/team/user/personal/system sources);
 *   2. `loadAdminPolicy` — the real `<orgConfigDir>/org-policy.json` loader
 *      (parse + validate + fail-loud), NOT a hand-rolled policy literal;
 *   3. the durable disabled-set store read.
 *
 * All three feed {@link createSkillRuntimeAuthority}, which derives the three
 * consistent projections at one unified revision. Removing the `loadAdminPolicy`
 * call makes the production policy test RED (required/banned no longer enforced).
 *
 * `runner/assemble` is the Layer-2 composition seam, so it MAY import the
 * `@/skill` domain (construction). exactOptionalPropertyTypes: optional fields
 * are OMITTED when absent.
 */

import { errMessage } from "@/shared"
import {
  type AdminPolicyReader,
  buildSkillSnapshot,
  createJsonDisabledStore,
  createSkillRuntimeAuthority,
  type DisabledStorePort,
  loadAdminPolicy,
  type SkillRuntimeAuthority,
  type SkillSnapshotInputs,
} from "@/skill"

/** Fail-loud wrapper so surface wiring cannot collapse malformed org policy into disable. */
export class SkillAdminPolicyLoadError extends Error {
  constructor(cause: unknown) {
    super(errMessage(cause))
    this.name = "SkillAdminPolicyLoadError"
  }
}

export interface BuildSkillRuntimeAuthorityInput {
  /** Host discovery inputs for the real `buildSkillSnapshot` (user/system/repo/
   *  home/org dirs). The registry is the single precedence resolver. */
  readonly snapshotInputs: SkillSnapshotInputs
  /** Org config dir the real `loadAdminPolicy` reads `org-policy.json` from.
   *  Absent/null ⇒ no admin policy (admin scope disabled). Defaults to
   *  `snapshotInputs.orgConfigDir` so one host input drives both loaders. */
  readonly orgConfigDir?: string | null
  /** The durable user-disabled-set store. Injected by tests / the live default
   *  path; when absent, {@link disabledSetPath} builds the JSON fs store. */
  readonly disabledStore?: DisabledStorePort
  /** Path for the default JSON disabled-set store when {@link disabledStore} is
   *  absent (e.g. `<userSkillsDir>/.disabled.json`). */
  readonly disabledSetPath?: string
  /** Closed-port fs reader forwarded to the REAL `loadAdminPolicy` (tests inject
   *  an in-memory reader; production omits it and gets the fs adapter). Passing
   *  ONLY the reader keeps the real loader's parse/validate/fail-loud path on the
   *  production code path — a removed `loadAdminPolicy` call turns the policy test
   *  RED rather than being papered over by an injected policy object. */
  readonly readPolicyFile?: AdminPolicyReader
}

/**
 * Construct THE per-session skill runtime authority over the real registry +
 * admin policy + durable disabled set. This is the one production skill-runtime
 * constructor owner (mirrors `buildObjectiveAuthority` / `buildPostureAuthority`).
 */
export const buildSkillRuntimeAuthority = async (
  input: BuildSkillRuntimeAuthorityInput,
): Promise<SkillRuntimeAuthority> => {
  const snapshot = await buildSkillSnapshot(input.snapshotInputs)

  const orgConfigDir =
    input.orgConfigDir !== undefined
      ? input.orgConfigDir
      : (input.snapshotInputs.orgConfigDir ?? null)
  let loaded: Awaited<ReturnType<typeof loadAdminPolicy>>
  try {
    loaded = await loadAdminPolicy({
      orgConfigDir,
      ...(input.readPolicyFile !== undefined ? { readPolicyFile: input.readPolicyFile } : {}),
    })
  } catch (e) {
    throw new SkillAdminPolicyLoadError(e)
  }

  const disabledStore: DisabledStorePort =
    input.disabledStore ??
    createJsonDisabledStore({ path: requireDisabledSetPath(input.disabledSetPath) })
  const persisted = await disabledStore.read()

  return createSkillRuntimeAuthority({
    snapshot,
    policy: loaded.policy,
    disabledStore,
    persisted,
  })
}

/** A JSON disabled store needs a path; a caller that supplies neither a store nor
 *  a path is a composition bug (fail loud, never a silent no-op store). */
const requireDisabledSetPath = (path: string | undefined): string => {
  if (path === undefined || path.length === 0) {
    throw new Error(
      "buildSkillRuntimeAuthority: provide either `disabledStore` or a `disabledSetPath`",
    )
  }
  return path
}
