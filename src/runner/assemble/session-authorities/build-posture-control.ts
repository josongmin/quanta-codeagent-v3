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

import { createPostureAuthority } from "@/permission/posture/authority"
import { buildPostureControl, type PostureControl } from "@/permission/posture/control"
import type { PermissionDefaultsPort } from "@/permission/posture/ports"
import type { PostureRecord } from "@/permission/posture/types"
import { currentBehaviorDefaultRecord } from "@/permission/posture-persistence"
import type { PermissionMode } from "@/permission/types"
import {
  createPermissionModeAdapter,
  createSeededPosturePersistence,
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

export interface LivePosture {
  /** The E3 mode adapter — `base.permission.mode` proxies this (gate seam). */
  readonly modeState: PermissionModeSessionState
  /** The E4 front-door control — CLI `/posture` + the wire projection share it. */
  readonly control: PostureControl
}

/**
 * Build the live session's posture: ONE seeded authority (unmanaged ⇒
 * effectiveMode == `initialMode`, byte-identical to the legacy `runtime.mode`
 * seed) exposed BOTH as the E3 mode adapter and the E4 front-door control, plus a
 * process-local future-thread default store so `--default` scope is available.
 */
export const buildLivePosture = (initialMode: PermissionMode): LivePosture => {
  const authority = createPostureAuthority({
    threadId: LIVE_POSTURE_THREAD_ID,
    persistence: createSeededPosturePersistence(LIVE_POSTURE_THREAD_ID, initialMode),
    reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
  })
  const control = buildPostureControl({
    authority,
    defaults: createInMemoryPermissionDefaults(),
    reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
  })
  return {
    modeState: createPermissionModeAdapter(authority),
    control,
  }
}
