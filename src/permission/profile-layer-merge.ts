/**
 * Bridge — merge LAYERED named {@link PermissionProfile}s (per-user / per-repo /
 * team-admin) into ONE effective profile, using the pure
 * {@link mergeLayered} engine from `./policy-layers`.
 *
 * WHY this module exists. `policy-layers/index.ts` is a PURE, domain-agnostic
 * struct-merge engine (it knows nothing about permissions). The permission
 * domain needs two domain-specific facts to drive it:
 *   1. the canonical `default` baseline ({@link DEFAULT_PERMISSION_PROFILE}); and
 *   2. the per-field SAFETY polarity for the `most-restrictive` strategy — which
 *      direction of each profile pillar is "safer" (more restrictive).
 * This module supplies BOTH and nothing else, keeping the engine a leaf and the
 * domain knowledge in the permission slice.
 *
 * SAFETY POLARITY ({@link PROFILE_RESTRICTIVENESS}) — declared explicitly per
 * field, NO global "false is safer" heuristic. Polarity is field-dependent and
 * derived from the documented semantics of each pillar in `permission-profile.ts`:
 *   - `approval`: `always` > `session` > `once` > `auto` (more confirmation =
 *     safer; matches {@link DEFAULT_PERMISSION_PROFILE} preferring `once`+prompt
 *     over `auto`).
 *   - `network`: `deny-all` > `allow-list` > `allow-all` (less egress = safer;
 *     matches the deny-all default).
 *   - `sandbox`: `readOnly:true` safer, `workspaceWrite:false` safer,
 *     `networkIsolated:true` safer, and OS-sandbox presence
 *     (seatbelt/landlock/windows-sandbox) safer than `none` — each derived from
 *     the locked-down {@link DEFAULT_PERMISSION_PROFILE.sandbox}.
 *   - `control`: `auditRequired:true` safer; `managedBy` admin > team > user
 *     (stronger lock = safer).
 *   - `fileSystem`: an allow-list table has no scalar safety ordering, so it is
 *     DELIBERATELY OMITTED ⇒ falls back to source-precedence under
 *     `most-restrictive` (the most-authoritative source's table wins). Encoding
 *     a "fewer entries = safer" rule would be an arbitrary heuristic — rejected.
 *
 * Slice rules: leaf-friendly. Depends ONLY on the local pure types
 * (`permission-profile.ts`, `policy-layers/`). No IO, no state, no env reads.
 */

import type {
  ApprovalMode,
  ControlManagedBy,
  NetworkMode,
  OsSandboxKind,
  PermissionProfile,
} from "./permission-profile"
import { DEFAULT_PERMISSION_PROFILE } from "./permission-profile"
import type { ConfigLayer, MergeResult, MergeStrategy, RestrictivenessSpec } from "./policy-layers"
import { mergeLayered } from "./policy-layers"

/** Approval safety rank — HIGHER = more confirmation = safer. */
const APPROVAL_SAFETY: Readonly<Record<ApprovalMode, number>> = Object.freeze({
  always: 3,
  session: 2,
  once: 1,
  auto: 0,
})

/** Network egress safety rank — HIGHER = less egress = safer. */
const NETWORK_SAFETY: Readonly<Record<NetworkMode, number>> = Object.freeze({
  "deny-all": 2,
  "allow-list": 1,
  "allow-all": 0,
})

/** OS-sandbox presence safety rank — HIGHER = stronger sandbox = safer. Any
 *  concrete OS sandbox outranks `none`; the three concrete kinds are treated as
 *  equally strong (a host runs exactly one — cross-OS comparison is not
 *  meaningful, so we do NOT invent an ordering among them). */
const OS_SANDBOX_SAFETY: Readonly<Record<OsSandboxKind, number>> = Object.freeze({
  seatbelt: 1,
  landlock: 1,
  "windows-sandbox": 1,
  none: 0,
})

/** Control `managedBy` safety rank — HIGHER = stronger lock = safer.
 *  `undefined` (no declared manager) is the weakest (least locked). */
const MANAGED_BY_SAFETY: Readonly<Record<ControlManagedBy, number>> = Object.freeze({
  admin: 3,
  team: 2,
  user: 1,
})
const managedBySafety = (m: ControlManagedBy | undefined): number =>
  m === undefined ? 0 : MANAGED_BY_SAFETY[m]

/**
 * Per-field safety ordering for {@link PermissionProfile} under the
 * `most-restrictive` strategy. Every entry returns a numeric rank where HIGHER
 * is SAFER. See module doc for the polarity rationale per pillar.
 *
 * `fileSystem` is intentionally ABSENT (no scalar safety ordering for an
 * allow-list table) ⇒ it falls back to source-precedence.
 */
export const PROFILE_RESTRICTIVENESS: RestrictivenessSpec<PermissionProfile> = Object.freeze({
  approval: (a) => APPROVAL_SAFETY[a.mode],
  network: (n) => NETWORK_SAFETY[n.mode],
  sandbox: (s) =>
    // Sum the four orthogonal safety bits so a profile that is safer on MORE
    // axes ranks higher; each bit is 0/1 except OS-sandbox presence (also 0/1).
    (s.readOnly ? 1 : 0) +
    (s.workspaceWrite ? 0 : 1) +
    (s.networkIsolated ? 1 : 0) +
    OS_SANDBOX_SAFETY[s.osSandbox],
  control: (c) => (c.auditRequired ? 1 : 0) + managedBySafety(c.managedBy),
}) as RestrictivenessSpec<PermissionProfile>

/** Named-profile slots, ascending authority. Any slot omitted ⇒ no layer. The
 *  `default` baseline is ALWAYS {@link DEFAULT_PERMISSION_PROFILE} (the merge
 *  base), so it is not a slot here — callers layer ON TOP of it. */
export interface ProfileLayerSlots {
  readonly perUser?: PermissionProfile
  readonly perRepo?: PermissionProfile
  readonly teamAdmin?: PermissionProfile
}

/**
 * Merge layered named profiles into ONE effective {@link PermissionProfile} plus
 * the per-field {@link MergeResult.overrides} audit trail.
 *
 * The merge base is the locked-down {@link DEFAULT_PERMISSION_PROFILE}; each
 * present slot contributes a full profile as that source's layer value. Under
 * `most-restrictive` the {@link PROFILE_RESTRICTIVENESS} spec decides each field
 * by safety; under `source-precedence` the most-authoritative present source
 * wins each field (team-admin > per-repo > per-user > default).
 *
 * Determinism: depends only on the slot contents + strategy. Absent all slots ⇒
 * `merged` deep-equals the default baseline and `overrides` is `[]`.
 */
export const mergeProfileLayers = (
  slots: ProfileLayerSlots,
  strategy: MergeStrategy,
): MergeResult<PermissionProfile> => {
  const layers: Array<ConfigLayer<PermissionProfile>> = []
  if (slots.perUser !== undefined) layers.push({ source: "per-user", value: slots.perUser })
  if (slots.perRepo !== undefined) layers.push({ source: "per-repo", value: slots.perRepo })
  if (slots.teamAdmin !== undefined) layers.push({ source: "team-admin", value: slots.teamAdmin })
  return mergeLayered(layers, {
    base: DEFAULT_PERMISSION_PROFILE,
    strategy,
    restrictiveness: PROFILE_RESTRICTIVENESS,
  })
}
