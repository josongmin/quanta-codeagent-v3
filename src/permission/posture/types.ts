/**
 * RFC-05 E1 — permission-posture MODEL (schema/types only, no host/surface wiring).
 *
 * This is the leaf/schema packet. It defines the requested-vs-effective posture
 * split, the domain revision, the producer-backed lock type surface and the
 * lossless patch algebra's data shapes. It owns NO behavior: nothing here
 * mutates a live host, reads env, or does IO. E2 (durable authority/store) and
 * E3 (behavior-live cutover) consume these types; they do not fork them.
 *
 * SSOT reuse (RFC-05 R6 "Existing owner map"):
 *   - the name -> `ThreadPermission` mapping is `../approval-ladder`
 *     (`APPROVAL_LADDER`); presets here are LOSSLESS PATCHES derived from it,
 *     never a second table.
 *   - `ReviewerTier` / `ThreadPermission` are the existing permission types;
 *     E1 introduces NO new `PermissionMode` value and NO new `ReviewerTier`
 *     discriminant (see the §E1 stop rule).
 *
 * Slice rules: imports only sibling `@/permission` types. No `@/shared` value
 * dependency is required by the type surface; the runtime helpers live in
 * `presets.ts` / `availability.ts`.
 */

import type { NamedApprovalLadderRung } from "../approval-ladder"
import type { ThreadPermission } from "../permission-store"
import type { ReviewerTier } from "../types"

// Type-only re-export of the closed lock surface. The IMPLEMENTATION (brand +
// admission + producers) lives in `availability.ts` so a lock can only be
// minted through an admitted producer; the *type* is re-exported here because
// `types.ts` is the model's type surface (RFC-05 write-set: "source, lock,
// revision"). This is a type-only cycle (types <-> availability) and is inert
// at runtime.
export type { LockProducerId, PostureLock, PostureLockReason } from "./availability"

import type { PostureLock } from "./availability"

/* ------------------------------------------------------------------------- *
 * Question knob (Codex `requestUserInput` — "Allow the agent to ask questions
 * outside Plan mode"). ORTHOGONAL to the permission preset: it is NOT a field
 * of `ThreadPermission`, so selecting any permission preset must never clobber
 * it. This is the "question" field the RFC's lossless invariant protects.
 * ------------------------------------------------------------------------- */

/** The mid-task-question knob. `true` ⇒ the agent may ask outside Plan mode. */
export type AskOutsidePlan = boolean

/** Legacy-absence migration target: current behavior imposes NO outside-plan
 *  question gate (the agent asks freely today), so an absent value migrates to
 *  `true`. Defaulting to `false` would CHANGE current behavior (start blocking
 *  questions) — forbidden by "missing legacy fields map to current behavior". */
export const CURRENT_BEHAVIOR_ASK_OUTSIDE_PLAN: AskOutsidePlan = true

/** The revision a freshly-migrated / never-mutated posture carries. The domain
 *  revision is a CAS token for E2; it is independent of any kernel event
 *  sequence. */
export const INITIAL_REVISION = 0 as const

/* ------------------------------------------------------------------------- *
 * The complete posture RECORD — what patches apply OVER.
 * ------------------------------------------------------------------------- */

/** The complete, resolved posture state: the existing three-field
 *  `ThreadPermission` plus the orthogonal question knob. Presets/patches are
 *  PARTIAL projections over this whole record; applying one preserves every
 *  field it does not mention (the lossless invariant). */
export interface PostureRecord {
  readonly threadPermission: ThreadPermission
  readonly askOutsidePlan: AskOutsidePlan
}

/* ------------------------------------------------------------------------- *
 * Named presets — a strict subset of the existing approval-ladder rungs.
 * ------------------------------------------------------------------------- */

/** An OFFERED posture preset. Derived from the existing approval-ladder rung
 *  names MINUS the PARKED `full-access` rung (RFC-05 keeps one-click full-access
 *  parked: no preset, label or action) and MINUS the `custom` sentinel. The
 *  runtime tuple `OFFERED_PRESETS` in `presets.ts` is kept in lockstep with
 *  this type by a two-way exhaustiveness guard. */
export type PosturePreset = Exclude<NamedApprovalLadderRung, "full-access">

/* ------------------------------------------------------------------------- *
 * Lossless partial patch (exactOptionalPropertyTypes: `x?: T | undefined`).
 * ------------------------------------------------------------------------- */

/** A lossless partial patch over a {@link PostureRecord}. Every field is
 *  optional; an omitted field is PRESERVED from the base record when applied
 *  (`applyPatch`). A preset selection returns one of these — never a partial
 *  `ThreadPermission` masquerading as a full record. */
export interface PosturePatch {
  readonly approvalPolicy?: ThreadPermission["approvalPolicy"] | undefined
  readonly approvalsReviewer?: ThreadPermission["approvalsReviewer"] | undefined
  readonly sandboxPolicy?: ThreadPermission["sandboxPolicy"] | undefined
  readonly askOutsidePlan?: AskOutsidePlan | undefined
}

/* ------------------------------------------------------------------------- *
 * Requested vs Effective — DISTINCT types (RFC-05 requirement #1).
 * ------------------------------------------------------------------------- */

/** The operator-REQUESTED posture: the lossless patch they selected plus the
 *  named preset that patch/record projects to (`null` ⇒ "custom", i.e. the
 *  record matches no offered preset). This is deliberately NOT the same type as
 *  {@link EffectivePosture}: a request is a (possibly partial) selection, the
 *  effective view is the fully-resolved live record. */
export interface RequestedPosture {
  readonly preset: PosturePreset | null
  readonly patch: PosturePatch
}

/** The fully-RESOLVED effective posture that drives evaluation. Complete
 *  (never partial): a resolved `ThreadPermission`, the reviewer route resolved
 *  through the existing `selectDefaultReviewer` SSOT (no remap), and the bound
 *  question value. Distinct type from {@link RequestedPosture}. */
export interface EffectivePosture {
  readonly threadPermission: ThreadPermission
  readonly reviewerRoute: ReviewerTier
  readonly askOutsidePlan: AskOutsidePlan
}

/** The canonical resolved posture value (RFC-05 "Canonical authority"). The
 *  SAME immutable value drives permission evaluation, server-side
 *  revalidation, and the CLI/web state echo. `revision` is the domain CAS
 *  token E2 mutates against. */
export interface ResolvedPermissionPosture {
  readonly revision: number
  readonly requested: RequestedPosture
  readonly effective: EffectivePosture
  readonly locks: readonly PostureLock[]
}

/** Inputs needed to resolve the effective reviewer route through the existing
 *  `selectDefaultReviewer` policy. E1 never assumes fail-down: the availability
 *  flags are supplied by the caller (E3 wires the live ports). */
export interface ReviewerAvailability {
  readonly hasAutoReview: boolean
  readonly hasGuardianReview: boolean
  readonly autoReviewEnabled?: boolean | undefined
}

/** Monotonic CAS revision bump. Pure; the caller owns persistence (E2). */
export const nextRevision = (current: number): number => current + 1
