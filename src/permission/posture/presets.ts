/**
 * RFC-05 E1 — preset PATCH algebra, projection, migration and deterministic
 * serialization.
 *
 * Presets are LOSSLESS partial patches derived from the existing
 * `APPROVAL_LADDER` SSOT (RFC-05 R6 "reuse; do not fork"). Selecting a preset
 * changes only the three `ThreadPermission` fields it names and PRESERVES every
 * unmentioned field — critically the orthogonal `askOutsidePlan` question knob,
 * which a full-record replacement (`setThreadPermission`) would erase. "Custom"
 * is a projection: a record that matches no offered preset.
 *
 * Slice rules: imports only sibling `@/permission` types/tables. No IO, no env,
 * no `availability.ts` value import (keeps the runtime dependency acyclic:
 * availability -> presets -> {approval-ladder, types}).
 */

import { APPROVAL_LADDER } from "../approval-ladder"
import type { ThreadPermission } from "../permission-store"
import type { PermissionMode } from "../types"
import {
  CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN,
  CURRENT_BEHAVIOR_MODE,
  INITIAL_REVISION,
  type PosturePatch,
  type PosturePreset,
  type PostureRecord,
  type RequestedPosture,
  type ResolvedPermissionPosture,
} from "./types"

/* ------------------------------------------------------------------------- *
 * Offered presets — approval-ladder rungs MINUS parked `full-access`/`custom`.
 * ------------------------------------------------------------------------- */

/** The offered posture presets, in escalation order. `full-access` is PARKED
 *  (RFC-05: no preset/label/action) and `custom` is not a rung, so neither is
 *  listed. Kept in lockstep with {@link PosturePreset} by the two-way guard
 *  below. */
export const OFFERED_PRESETS = [
  "read-only",
  "auto",
  "granular",
  "guardian-approvals",
] as const satisfies ReadonlyArray<PosturePreset>

/** Compile-time exhaustiveness: any {@link PosturePreset} NOT present in
 *  {@link OFFERED_PRESETS} surfaces here as a type error (resolves to a
 *  non-`never` type). Pure type machinery — erased at build. This is what makes
 *  parking `full-access` explicit: if the ladder gains a new non-parked rung it
 *  MUST be added here or the build fails. */
type MissingOfferedPreset = Exclude<PosturePreset, (typeof OFFERED_PRESETS)[number]>
const _offeredPresetsExhaustive: MissingOfferedPreset extends never ? true : never = true
void _offeredPresetsExhaustive

/* ------------------------------------------------------------------------- *
 * Canonical serialization (deterministic — sorted keys at every level).
 * ------------------------------------------------------------------------- */

/** Recursively sort object keys so two structurally-equal values serialize to
 *  byte-identical JSON regardless of key insertion order. Symbol-keyed
 *  properties (e.g. a {@link import("./availability").PostureLock} brand) are
 *  invisible to `Object.keys` and are intentionally omitted. */
const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src).sort()) {
    const v = src[k]
    // Drop `undefined` so an explicitly-absent optional and a missing key
    // serialize identically (exactOptionalPropertyTypes friendliness).
    if (v === undefined) continue
    out[k] = canonicalize(v)
  }
  return out
}

/** Deterministic canonical JSON of any posture value. */
export const serializePosture = (value: unknown): string => JSON.stringify(canonicalize(value))

/** Deterministic canonical JSON of a resolved posture (locks included; the
 *  lock brand symbol is omitted, its value-only fields are kept). */
export const serializeResolvedPosture = (posture: ResolvedPermissionPosture): string =>
  serializePosture(posture)

/** Structural equality of two `ThreadPermission`s via canonical JSON. */
const threadPermissionEquals = (a: ThreadPermission, b: ThreadPermission): boolean =>
  serializePosture(a) === serializePosture(b)

/* ------------------------------------------------------------------------- *
 * Preset -> patch, and the lossless apply algebra.
 * ------------------------------------------------------------------------- */

/** The lossless PATCH a preset denotes: the three `ThreadPermission` fields of
 *  the corresponding {@link APPROVAL_LADDER} rung. `askOutsidePlan` AND `mode`
 *  are deliberately OMITTED so selecting a preset never touches the question
 *  knob NOR the permission mode (preset ≠ mode — a named preset may leave `mode`
 *  unmentioned). This is a projection of the SSOT rung into a partial patch —
 *  never a second table. */
export const presetPatch = (preset: PosturePreset): PosturePatch => {
  const rung = APPROVAL_LADDER[preset]
  return {
    approvalPolicy: rung.approvalPolicy,
    approvalsReviewer: rung.approvalsReviewer,
    sandboxPolicy: rung.sandboxPolicy,
  }
}

/** Apply a lossless partial patch over a complete record. EVERY field the
 *  patch does not mention is preserved from the base record. `??` (not `||`)
 *  is load-bearing: a patched `askOutsidePlan: false` must win, and only a
 *  genuinely absent (`undefined`) field falls back to the base. */
export const applyPatch = (record: PostureRecord, patch: PosturePatch): PostureRecord => ({
  threadPermission: {
    approvalPolicy: patch.approvalPolicy ?? record.threadPermission.approvalPolicy,
    approvalsReviewer: patch.approvalsReviewer ?? record.threadPermission.approvalsReviewer,
    sandboxPolicy: patch.sandboxPolicy ?? record.threadPermission.sandboxPolicy,
  },
  askOutsidePlan: patch.askOutsidePlan ?? record.askOutsidePlan,
  // `??` (not `||`): only a genuinely-absent `mode` falls back to the base;
  // every named mode (including no falsy member exists in the union) wins.
  mode: patch.mode ?? record.mode,
})

/** Apply a named preset losslessly (preserves `askOutsidePlan`). */
export const applyPreset = (record: PostureRecord, preset: PosturePreset): PostureRecord =>
  applyPatch(record, presetPatch(preset))

/** Capture a complete record as a full lossless patch. `applyPatch(anyBase,
 *  toCustomPatch(r))` MUST reproduce `r` exactly (custom roundtrip is
 *  lossless). */
export const toCustomPatch = (record: PostureRecord): PosturePatch => ({
  approvalPolicy: record.threadPermission.approvalPolicy,
  approvalsReviewer: record.threadPermission.approvalsReviewer,
  sandboxPolicy: record.threadPermission.sandboxPolicy,
  askOutsidePlan: record.askOutsidePlan,
  mode: record.mode,
})

/* ------------------------------------------------------------------------- *
 * Projection: record -> named preset, else "custom" (null).
 * ------------------------------------------------------------------------- */

/** Project a resolved `ThreadPermission` back to the OFFERED preset it exactly
 *  matches, or `null` ("custom") when it matches none. The offered set is
 *  mutually exclusive by construction, so at most one matches. A `full-access`
 *  record (parked, not offered) projects to `null` — its label is never
 *  surfaced. */
export const projectPreset = (threadPermission: ThreadPermission): PosturePreset | null => {
  for (const preset of OFFERED_PRESETS) {
    if (threadPermissionEquals(threadPermission, APPROVAL_LADDER[preset])) return preset
  }
  return null
}

/** Build the operator-requested view: the patch plus the preset the resulting
 *  effective `ThreadPermission` projects to. */
export const buildRequested = (
  effectiveThreadPermission: ThreadPermission,
  patch: PosturePatch,
): RequestedPosture => ({
  preset: projectPreset(effectiveThreadPermission),
  patch,
})

/* ------------------------------------------------------------------------- *
 * Legacy-absence migration to current behavior.
 * ------------------------------------------------------------------------- */

/** A legacy/partial stored posture: the existing `ThreadPermission` (always
 *  present in the store) plus the NEW posture fields, any of which may be
 *  absent on a record written before RFC-05. */
export interface LegacyPostureInput {
  readonly threadPermission: ThreadPermission
  readonly askOutsidePlan?: boolean | undefined
  readonly mode?: PermissionMode | undefined
  readonly revision?: number | undefined
  readonly requestedPatch?: PosturePatch | undefined
}

/** The migrated posture: a complete record, its revision, and the requested
 *  view. */
export interface MigratedPosture {
  readonly record: PostureRecord
  readonly revision: number
  readonly requested: RequestedPosture
}

/** Migrate a legacy/partial posture to EXACT current behavior. Missing new
 *  fields map to today's behavior — the question knob to
 *  {@link CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN} (unrestricted), the revision to
 *  {@link INITIAL_REVISION}, the requested patch to empty. No inference is
 *  replayed from any event log. The existing `ThreadPermission` is preserved
 *  verbatim. */
export const migrateLegacy = (input: LegacyPostureInput): MigratedPosture => {
  const askOutsidePlan = input.askOutsidePlan ?? CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN
  // Legacy-absent `mode` maps to the existing default mode — NO behavior change
  // for a record written before the mode axis existed.
  const mode = input.mode ?? CURRENT_BEHAVIOR_MODE
  const record: PostureRecord = {
    threadPermission: input.threadPermission,
    askOutsidePlan,
    mode,
  }
  const revision = input.revision ?? INITIAL_REVISION
  const patch = input.requestedPatch ?? {}
  return {
    record,
    revision,
    requested: buildRequested(input.threadPermission, patch),
  }
}
