/**
 * RFC-05 E4 — the LIVE session's posture FRONT-DOOR control, composed over the
 * SAME durable authority E3's `buildLivePermissionModeState` wraps.
 *
 * E3 (`build-posture.ts`, exclusive-lock file — NOT edited here) owns the
 * behavior-live permission-mode ADAPTER: `createPermissionModeAdapter(authority)`
 * is the `{ get, set }` view the per-turn gate reads through `base.permission.mode`.
 * E4 needs the SAME live authority to also back the RICHER front door (a lossless
 * patch + scope + the requested/effective/locks projection), so this sibling
 * composes ONE authority into BOTH:
 *   - the E3 mode adapter (`modeState`) — what `base.permission.mode` proxies, and
 *   - the E4 {@link PostureControl} (`control`) — what the CLI `/posture` selector
 *     and the wire `session.posture.set` host projection mutate through.
 *
 * Because both share the ONE authority, a `/posture` mutation advances the same
 * revision the gate reads: the very next turn observes the new effective posture.
 * This is a pure composition seam (no IO of its own) that the host composition
 * root calls in place of the mode-only `buildLivePermissionModeState`.
 */

import type { PermissionStore } from "@/permission/permission-store"
import {
  createPostureAuthority,
  createStorePermissionDefaults,
  type PostureAuthority,
} from "@/permission/posture/authority"
import { buildPostureControl, type PostureControl } from "@/permission/posture/control"
import type { PermissionDefaultsPort } from "@/permission/posture/ports"
import type { PostureRecord } from "@/permission/posture/types"
import { currentBehaviorDefaultRecord } from "@/permission/posture-persistence"
import type { PermissionMode } from "@/permission/types"
import {
  createPermissionModeAdapter,
  createSeededPosturePersistence,
  createStoreSeededPosturePersistence,
  LIVE_POSTURE_THREAD_ID,
  type PermissionModeSessionState,
} from "./build-posture"

/** A process-local future-thread DEFAULT store (the E2 "default" entry) for the
 *  live session. Seeded to the current-behavior default so an unset default reads
 *  as today's posture; the CLI `/posture --default` writes here. */
const createInMemoryPermissionDefaults = (): PermissionDefaultsPort => {
  let record: PostureRecord = currentBehaviorDefaultRecord()
  return {
    readDefault: () => record,
    writeDefault: async (next) => {
      record = next
    },
  }
}

/** RFC-05 E3 durable-resume binding: the SAME on-disk {@link PermissionStore}
 *  production already loads (`getDefaultPermissionStore()`) keyed by a REAL
 *  per-session id. When present, the live authority reads/persists the operator's
 *  posture through the store (E2's `createStorePosturePersistence` /
 *  `createStorePermissionDefaults`), so a restart RESTORES the last effective
 *  posture. Absent ⇒ the legacy process-local in-memory seed (byte-identical).
 *
 *  `sessionId` MUST be a unique per-session identity — NOT the constant
 *  `LIVE_POSTURE_THREAD_ID` — because the on-disk `permission-state.json` is
 *  SHARED across concurrent processes: two live sessions keyed by the same string
 *  would clobber each other's durable posture record. */
export interface LivePostureDurableStore {
  readonly store: PermissionStore
  readonly sessionId: string
}

export interface LivePosture {
  /** The E3 mode adapter — `base.permission.mode` proxies this (gate seam). */
  readonly modeState: PermissionModeSessionState
  /** The E4 front-door control — CLI `/posture` + the wire projection share it. */
  readonly control: PostureControl
  /** The ONE live authority backing BOTH the mode adapter and the control. The
   *  composition root adapts it into the E5 `livePostureQuestionReader` so the
   *  `request_user_input` guard re-reads the SAME live `askOutsidePlan` a
   *  `/posture ask off` mutates (H3). Exposed here because a `PostureControl`
   *  deliberately hides the raw authority; the question guard needs it. */
  readonly authority: PostureAuthority
}

/**
 * Build the live session's posture: ONE authority (unmanaged ⇒ effectiveMode ==
 * `initialMode` until a mutation) exposed as the E3 mode adapter, the E4
 * front-door control, AND the raw authority (for the E5 question reader) — one
 * authority, three views.
 *
 * Persistence axis (E3 durable resume):
 *   - `durable` PRESENT ⇒ the authority reads/persists through the on-disk
 *     {@link PermissionStore} keyed by the unique `durable.sessionId` (E2's store
 *     adapters), with an on-ABSENT `initialMode` seed so a fresh disk is
 *     byte-identical to today; a PERSISTED record RESTORES the last posture across
 *     a restart. The future-thread default reads/writes the store's SEPARATE
 *     default entry (`--default` scope is durable too).
 *   - `durable` ABSENT ⇒ the legacy process-local in-memory seed + default store,
 *     byte-identical to the pre-E3 behavior (nothing survives a restart).
 */
export const buildLivePosture = (
  initialMode: PermissionMode,
  durable?: LivePostureDurableStore,
): LivePosture => {
  const threadId = durable !== undefined ? durable.sessionId : LIVE_POSTURE_THREAD_ID
  const authority = createPostureAuthority({
    threadId,
    persistence:
      durable !== undefined
        ? createStoreSeededPosturePersistence(durable.store, durable.sessionId, initialMode)
        : createSeededPosturePersistence(LIVE_POSTURE_THREAD_ID, initialMode),
    reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
  })
  const control = buildPostureControl({
    authority,
    defaults:
      durable !== undefined
        ? createStorePermissionDefaults(durable.store)
        : createInMemoryPermissionDefaults(),
    reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
  })
  return {
    modeState: createPermissionModeAdapter(authority),
    control,
    authority,
  }
}
