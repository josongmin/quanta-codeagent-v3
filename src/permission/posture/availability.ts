/**
 * RFC-05 E1 — producer-backed locks, offered options, and effective resolution.
 *
 * CLOSED PRODUCER-BACKED LOCKS (RFC-05 requirement #3): a {@link PostureLock}
 * can ONLY be minted through an ADMITTED producer. There is no public lock
 * constructor and no synthetic/config/cloud lock label — the Codex
 * `disabledByConfig` / `unavailableForCloudWork` / `serverDefault` labels have
 * no bound loader in this repo and are therefore UNconstructible here (DROP, not
 * synthesize). The `managed_policy` producer is the one admitted reason: it is
 * backed by the existing `ControlPolicy` (`permission-profile.ts`) and its lock
 * disappears when the managed policy is removed (non-vacuous).
 *
 * The lock brand is a module-private `unique symbol`: it is BOTH a compile-time
 * nominal guard (external code cannot name the key, so an object literal cannot
 * satisfy `PostureLock`) AND a runtime marker (`isPostureLock` checks it). Every
 * mint routes through `admitLock`, which fails closed for an unadmitted
 * producer.
 *
 * Slice rules: imports only sibling `@/permission` types/policy and `@/shared`
 * (leaf). No IO, no env.
 */

import { isRecord } from "@/shared"
import type { ControlPolicy } from "../permission-profile"
import type { ThreadPermission } from "../permission-store"
import { type ReviewerSandboxProfile, selectDefaultReviewer } from "../reviewer-default-policy"
import type { ReviewerTier } from "../types"
import { buildRequested, OFFERED_PRESETS } from "./presets"
import type {
  EffectivePosture,
  PosturePatch,
  PosturePreset,
  PostureRecord,
  ResolvedPermissionPosture,
  ReviewerAvailability,
} from "./types"

/* ------------------------------------------------------------------------- *
 * Closed lock reason / producer surface.
 * ------------------------------------------------------------------------- */

/** The closed set of admitted lock PRODUCER ids. Each has a real bound loader.
 *  Adding a member requires a production producer AND an enforcement test
 *  (RFC-05: "Admit each reason only with a production producer"). */
export type LockProducerId = "managed_policy"

/** The closed set of machine lock REASON codes. 1:1 with an admitted producer
 *  — there is no producer-free reason. */
export type PostureLockReason = "managed_policy"

/** Producer -> reason binding (total over the closed producer set). */
const PRODUCER_REASON: Readonly<Record<LockProducerId, PostureLockReason>> = {
  managed_policy: "managed_policy",
}

/** The admitted producers. A producer absent here fails closed in
 *  {@link admitLock}. */
const ADMITTED_LOCK_PRODUCERS: ReadonlySet<LockProducerId> = new Set<LockProducerId>([
  "managed_policy",
])

/** Module-private brand: a `unique symbol` that external code cannot name.
 *  Doubles as the runtime marker `isPostureLock` verifies. */
const LOCK_BRAND: unique symbol = Symbol("quanta.permission.posture.lock")

/** A producer-backed constraint on the posture. UNCONSTRUCTIBLE outside this
 *  module: the `[LOCK_BRAND]` key cannot be named elsewhere, so no object
 *  literal satisfies this interface, and the only minter ({@link admitLock}) is
 *  module-private. */
export interface PostureLock {
  readonly [LOCK_BRAND]: true
  readonly reason: PostureLockReason
  readonly producer: LockProducerId
  readonly label: string
  readonly detail?: string | undefined
}

/** Thrown when a lock mint is attempted for a producer that is not admitted.
 *  Guards against a cast that fabricates a producer-free label at runtime. */
export class UnadmittedLockProducerError extends Error {
  readonly producer: string
  constructor(producer: string) {
    super(`UnadmittedLockProducerError: no admitted lock producer '${producer}'`)
    this.name = "UnadmittedLockProducerError"
    this.producer = producer
  }
}

/** The single lock ADMISSION GATE and minter. Fails closed (throws) for an
 *  unadmitted producer; the reason is DERIVED from the producer binding, never
 *  caller-supplied, so a producer-free reason cannot be minted even via a cast.
 *  Exported so the admission contract is directly testable and so E2 can add a
 *  future admitted producer through the same gate; the producer-specific
 *  helpers (e.g. {@link managedPolicyLock}) are the ergonomic minters. */
export const admitLock = (
  producer: LockProducerId,
  label: string,
  detail?: string,
): PostureLock => {
  if (!ADMITTED_LOCK_PRODUCERS.has(producer)) throw new UnadmittedLockProducerError(producer)
  const reason = PRODUCER_REASON[producer]
  if (reason === undefined) throw new UnadmittedLockProducerError(producer)
  return {
    [LOCK_BRAND]: true,
    reason,
    producer,
    label,
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** Runtime guard: is `v` a genuinely-minted {@link PostureLock}? A hand-built
 *  object literal (which cannot carry the module-private brand symbol) returns
 *  `false`. */
export const isPostureLock = (v: unknown): v is PostureLock =>
  isRecord(v) && (v as Record<PropertyKey, unknown>)[LOCK_BRAND] === true

/* ------------------------------------------------------------------------- *
 * Producers (the ONLY exported minters).
 * ------------------------------------------------------------------------- */

/** The `managed_policy` producer. Emits a lock IFF the managed policy is
 *  enterprise-managed (`managedBy` of `admin`/`team`); an unmanaged/`user`
 *  policy or an absent policy yields `null`. Backed by the existing
 *  {@link ControlPolicy} — removing the managed policy removes the lock. */
export const managedPolicyLock = (control: ControlPolicy | undefined): PostureLock | null => {
  if (control?.managedBy === "admin" || control?.managedBy === "team") {
    return admitLock(
      "managed_policy",
      "Managed by enterprise policy",
      `managedBy=${control.managedBy}`,
    )
  }
  return null
}

/** Compute the producer-backed locks for a posture. Only admitted producers
 *  contribute; producer-free labels are never synthesized. */
export const resolveLocks = (control: ControlPolicy | undefined): readonly PostureLock[] => {
  const locks: PostureLock[] = []
  const managed = managedPolicyLock(control)
  if (managed !== null) locks.push(managed)
  return locks
}

/* ------------------------------------------------------------------------- *
 * Offered options.
 * ------------------------------------------------------------------------- */

/** The presets a surface may offer. Excludes the PARKED `full-access` rung and
 *  the `custom` sentinel by construction (see `OFFERED_PRESETS`). */
export const availablePresets = (): readonly PosturePreset[] => OFFERED_PRESETS

/* ------------------------------------------------------------------------- *
 * Effective resolution (reuses the existing reviewer SSOT — no remap).
 * ------------------------------------------------------------------------- */

/** Map a resolved sandbox policy to the reviewer-policy sandbox profile. Pure
 *  1:1 translation; introduces no new reviewer route. */
const sandboxProfileOf = (sandbox: ThreadPermission["sandboxPolicy"]): ReviewerSandboxProfile => {
  if (sandbox.type === "read-only") return "read-only"
  if (sandbox.type === "danger-full-access") return "danger-full-access"
  return sandbox.networkAccess === true ? "workspace-write-net" : "workspace-write"
}

/** Resolve the effective posture from a complete record. The reviewer route is
 *  resolved through the EXISTING {@link selectDefaultReviewer} policy with the
 *  thread's own authority present — E1 makes no fail-down assumption and adds no
 *  route. */
export const resolveEffective = (
  record: PostureRecord,
  availability: ReviewerAvailability,
): EffectivePosture => {
  const reviewerRoute: ReviewerTier = selectDefaultReviewer({
    threadPermission: record.threadPermission,
    // Unused when `threadPermission` is present; supplied for completeness.
    permissionMode: "default",
    sandboxProfile: sandboxProfileOf(record.threadPermission.sandboxPolicy),
    hasAutoReview: availability.hasAutoReview,
    hasGuardianReview: availability.hasGuardianReview,
    ...(availability.autoReviewEnabled !== undefined
      ? { autoReviewEnabled: availability.autoReviewEnabled }
      : {}),
  })
  return {
    threadPermission: record.threadPermission,
    reviewerRoute,
    askOutsidePlan: record.askOutsidePlan,
  }
}

/** Compose the canonical resolved posture: the domain revision, the requested
 *  view (patch + projected preset), the resolved effective view, and the
 *  producer-backed locks. This is the immutable value E2/E3 publish. */
export const buildResolvedPosture = (input: {
  record: PostureRecord
  revision: number
  requestedPatch: PosturePatch
  availability: ReviewerAvailability
  managedPolicy?: ControlPolicy | undefined
}): ResolvedPermissionPosture => {
  const effective = resolveEffective(input.record, input.availability)
  return {
    revision: input.revision,
    requested: buildRequested(input.record.threadPermission, input.requestedPatch),
    effective,
    locks: resolveLocks(input.managedPolicy),
  }
}
