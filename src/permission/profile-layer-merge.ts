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
 * SAFETY POLARITY — declared explicitly per ATOMIC AXIS, NO global "false is
 * safer" heuristic. Polarity is axis-dependent, derived from the documented
 * semantics of each pillar in `permission-profile.ts`.
 *
 * PER-SUB-FIELD MERGE (the leak-free core, {@link PROFILE_COMBINERS}). The three
 * struct pillars `sandbox` / `network` / `control` plus `approval` are merged
 * under `most-restrictive` by taking the SAFEST value of EACH atomic sub-axis
 * INDEPENDENTLY — NOT by picking the whole winning struct by a sum of safety
 * bits. The sum-of-bits approach is UNSOUND: a LOWER-authority layer that is
 * safer on MORE axes (higher sum) would drag along an UNSAFE sub-field, leaking
 * past a higher-authority layer's specific safe bit (e.g. a per-user profile
 * `{readOnly:true, workspaceWrite:true, networkIsolated:true, osSandbox:seatbelt}`
 * sum=3 overriding a team-admin `{readOnly:true, workspaceWrite:FALSE, …}` sum=2,
 * so `workspaceWrite:true` leaks past the team-admin denial under the strategy
 * literally named "most-restrictive"). Per-sub-field merge makes the result
 * never-less-safe than ANY input on EVERY axis simultaneously, regardless of sum.
 *
 * Per-axis safe polarity (explicit, no heuristic):
 *   - `approval.mode`: `always` > `session` > `once` > `auto` (more confirmation
 *     = safer). `approval.promptUser`: `true` safer ⇒ OR (any prompting forces a
 *     prompt; suppressing it is a widen).
 *   - `network.mode`: `deny-all` > `allow-list` > `allow-all` (less egress safer).
 *     `network.allowHosts`: the INTERSECTION / narrower set (a wide list cannot
 *     widen a narrow one); on a `deny-all`/`allow-all` result `allowHosts` is
 *     dropped (not meaningful). `network.perRequestApproval`: `true` safer ⇒ OR.
 *   - `sandbox`: `readOnly:true` safer ⇒ OR; `workspaceWrite:false` safer ⇒ AND;
 *     `networkIsolated:true` safer ⇒ OR; `osSandbox` presence
 *     (seatbelt/landlock/windows-sandbox) safer than `none` ⇒ keep the active one.
 *   - `control`: `auditRequired:true` safer ⇒ OR; `managedBy` admin > team > user
 *     > (undefined) — stronger lock safer ⇒ keep the higher.
 *   - `fileSystem`: an allow-list table has no scalar safety ordering, so it is
 *     DELIBERATELY OMITTED from both tables ⇒ falls back to source-precedence
 *     under `most-restrictive` (the most-authoritative source's table wins).
 *     Encoding a "fewer entries = safer" rule would be arbitrary — rejected.
 *
 * {@link PROFILE_RESTRICTIVENESS} is RETAINED as a per-field safety MEASUREMENT
 * (HIGHER = safer) for audits / invariant checks — it is NOT the merge driver
 * for struct fields (the combiners are). When both are supplied, the engine
 * gives combiners PRIORITY.
 *
 * RELATION to `profile-inheritance.ts` (ADR-0438). That module resolves an
 * `extends` GRAPH with the SAME per-axis monotone-narrowing polarity but answers
 * a DIFFERENT question (base→derived inheritance, not source-precedence layers).
 * The two compose cleanly and do NOT double-merge: a caller resolves inheritance
 * FIRST (producing a complete profile per slot), THEN layers the resolved slots
 * here. This module never calls the inheritance resolver and vice-versa.
 *
 * Slice rules: leaf-friendly. Depends ONLY on the local pure types
 * (`permission-profile.ts`, `policy-layers/`). No IO, no state, no env reads.
 */

import type {
  ApprovalMode,
  ApprovalPolicy,
  ControlManagedBy,
  ControlPolicy,
  NetworkMode,
  NetworkPolicy,
  OsSandboxKind,
  PermissionProfile,
  SandboxPolicy,
} from "./permission-profile"
import { DEFAULT_PERMISSION_PROFILE } from "./permission-profile"
import type {
  ConfigLayer,
  FieldCombinerSpec,
  MergeResult,
  MergeStrategy,
  RestrictivenessSpec,
} from "./policy-layers"
import { mergeLayered } from "./policy-layers"
import { guardProvenance, type ProvenancedLayer } from "./policy-layers/provenance-guard"

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

/* ------------------------------------------------------------------------- */
/* Per-sub-field combiners — the leak-free `most-restrictive` merge.          */
/* Each takes the SAFEST value of every atomic axis INDEPENDENTLY, so the     */
/* result is never-less-safe than EITHER input on EVERY axis. Each is         */
/* commutative + associative + idempotent (a per-axis meet), so the engine's  */
/* fold is order-independent.                                                 */
/* ------------------------------------------------------------------------- */

/** sandbox — per-flag safe merge. readOnly OR (true safer); workspaceWrite AND
 *  (false safer); networkIsolated OR (true safer); osSandbox keep the active one
 *  (presence safer than `none`). */
const combineSandbox = (a: SandboxPolicy, b: SandboxPolicy): SandboxPolicy => ({
  osSandbox:
    OS_SANDBOX_SAFETY[b.osSandbox] > OS_SANDBOX_SAFETY[a.osSandbox] ? b.osSandbox : a.osSandbox,
  readOnly: a.readOnly || b.readOnly,
  workspaceWrite: a.workspaceWrite && b.workspaceWrite,
  networkIsolated: a.networkIsolated || b.networkIsolated,
})

/** The host CONSTRAINT a single layer imposes on an `allow-list` result:
 *    - `allow-list` mode ⇒ the EXACT permitted set; an ABSENT/empty `allowHosts`
 *      means ZERO hosts (∅ — an allow-list with no entries permits nothing), NOT
 *      "no constraint". This is the fix for the zero-host widen: a host-less
 *      allow-list layer must FORCE the intersection to ∅, so a co-layer can never
 *      INTRODUCE hosts it did not already permit.
 *    - `allow-all` ⇒ `undefined` = NO constraint (every host permitted; the merged
 *      mode became allow-list only because a co-layer was the narrower one).
 *    - `deny-all` ⇒ `undefined` too: it never reaches the host axis (the narrower
 *      deny-all mode wins, so the merged result is deny-all, not allow-list). */
const layerHostConstraint = (n: NetworkPolicy): ReadonlyArray<string> | undefined =>
  n.mode === "allow-list" ? (n.allowHosts ?? []) : undefined

/** network allowHosts intersection — a wider list cannot widen a narrower one,
 *  and a host-less allow-list layer (∅) cannot be widened by a co-layer adding
 *  hosts. Both sides constraining ⇒ intersection; one side constraining ⇒ that
 *  (narrower) set; neither (both allow-all/deny-all) ⇒ undefined. Order-independent
 *  (set intersection is commutative); output order follows `a` for determinism. */
const intersectAllowHosts = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (a !== undefined && b !== undefined) {
    const bs = new Set(b)
    return a.filter((h) => bs.has(h))
  }
  return a ?? b
}

/** network — per-axis safe merge. mode = NARROWER (lower egress wins);
 *  allowHosts = intersection (only meaningful on an allow-list result);
 *  perRequestApproval = OR (true safer). */
const combineNetwork = (a: NetworkPolicy, b: NetworkPolicy): NetworkPolicy => {
  const mode = NETWORK_SAFETY[b.mode] > NETWORK_SAFETY[a.mode] ? b.mode : a.mode
  const out: {
    mode: NetworkMode
    allowHosts?: ReadonlyArray<string>
    perRequestApproval?: boolean
  } = { mode }
  // allowHosts only meaningful when the merged mode is allow-list. Intersect the
  // host lists each side WOULD have used (each side's own allowHosts).
  if (mode === "allow-list") {
    // Pass each side's host CONSTRAINT (allow-list ⇒ exact set, absent ⇒ ∅;
    // allow-all/deny-all ⇒ no constraint) so a host-less allow-list layer forces
    // the intersection to ∅ and cannot be widened by a co-layer adding hosts.
    const hosts = intersectAllowHosts(layerHostConstraint(a), layerHostConstraint(b))
    if (hosts !== undefined) out.allowHosts = hosts
  }
  if ((a.perRequestApproval ?? false) || (b.perRequestApproval ?? false)) {
    out.perRequestApproval = true
  }
  return out
}

/** approval — per-axis safe merge. mode = STRICTER (more confirmation);
 *  promptUser = OR (true safer — suppressing a prompt is a widen). */
const combineApproval = (a: ApprovalPolicy, b: ApprovalPolicy): ApprovalPolicy => ({
  mode: APPROVAL_SAFETY[b.mode] > APPROVAL_SAFETY[a.mode] ? b.mode : a.mode,
  promptUser: a.promptUser || b.promptUser,
})

/** control — per-axis safe merge. managedBy = stronger lock (admin>team>user>
 *  undefined); auditRequired = OR (true safer). Preserves the optional-field
 *  shape: `managedBy` is omitted only when BOTH sides omit it. */
const combineControl = (a: ControlPolicy, b: ControlPolicy): ControlPolicy => {
  const managedBy =
    managedBySafety(b.managedBy) > managedBySafety(a.managedBy) ? b.managedBy : a.managedBy
  const auditRequired = a.auditRequired || b.auditRequired
  return managedBy !== undefined ? { managedBy, auditRequired } : { auditRequired }
}

/**
 * Per-STRUCT-field safe combiners for {@link PermissionProfile} under
 * `most-restrictive`. Each merges its field PER SUB-FIELD (safest atomic axis
 * independently), closing the whole-struct-by-sum leak. `fileSystem` is
 * intentionally ABSENT (no scalar safety ordering) ⇒ source-precedence fallback.
 */
export const PROFILE_COMBINERS: FieldCombinerSpec<PermissionProfile> = Object.freeze({
  sandbox: combineSandbox,
  network: combineNetwork,
  approval: combineApproval,
  control: combineControl,
}) as FieldCombinerSpec<PermissionProfile>

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
 * `most-restrictive` the {@link PROFILE_COMBINERS} merge each struct pillar PER
 * SUB-FIELD (safest atomic axis independently — NOT whole-struct-by-sum); under
 * `source-precedence` the most-authoritative present source wins each field
 * (team-admin > per-repo > per-user > default), structs intact.
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
  // ADR-0470 — SECURITY: under `source-precedence`, a higher-ranked per-repo /
  // frontmatter layer would otherwise WIN (and thus WIDEN) a grant-capable pillar
  // (approval / network / sandbox), letting a checked-in `.quanta` policy grant
  // autonomy. Drop those repo-controllable widens BEFORE the merge so per-repo can
  // only ever narrow. Scoped to `source-precedence` ONLY: the `most-restrictive`
  // strategy already merges the SAFEST value per sub-field (PROFILE_COMBINERS), so
  // per-repo cannot widen there and applying the guard would wrongly drop a SAFE
  // per-repo value (less safe — HELL-SUB-05). Default-ON; nothing-to-drop returns
  // the SAME array ref ⇒ byte-identical. (`dropped` records ready for telemetry.)
  const guarded =
    strategy === "source-precedence"
      ? guardProvenance(layers as ReadonlyArray<ProvenancedLayer>)
      : { layers }
  return mergeLayered(guarded.layers as ReadonlyArray<ConfigLayer<PermissionProfile>>, {
    base: DEFAULT_PERMISSION_PROFILE,
    strategy,
    // Combiners (per-sub-field safe) drive struct pillars under most-restrictive;
    // PROFILE_RESTRICTIVENESS is retained as a safety MEASUREMENT (and the engine
    // gives combiners priority over it for any field present in both).
    restrictiveness: PROFILE_RESTRICTIVENESS,
    combiners: PROFILE_COMBINERS,
  })
}
