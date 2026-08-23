/**
 * RFC-05 E4/E5 — the live session's posture RUNTIME: the ONE `buildLivePosture`
 * authority composed into the three views the bootstrap threads, plus the
 * `permission.mode` accessor over the SAME authority. Extracted from
 * `bootstrap-session.ts` (SRP + the god-module size cap) so the bootstrap body
 * calls one seam instead of inlining the construction.
 *
 * ONE authority, three consumers (no parallel mode cell, no second authority):
 *   - `permission` — the `{ get/set mode }` accessor the per-turn gate + surface
 *     mode-cycle write through (`get` reads the LIVE effectiveMode; `set` delegates
 *     to the authority so a mid-session change is a durable posture mutation the
 *     next turn reads);
 *   - `permissionModeState` — the SAME E3 delegating adapter the accessor proxies,
 *     threaded onto the base so the runtime/CLI share it;
 *   - `postureControl` — the E4 front-door control (host `session.posture.set` +
 *     CLI `/posture`) applying the FULL lossless patch under CAS;
 *   - `questionGuard` — the E5 `request_user_input` availability reader over the
 *     SAME authority's bound `askOutsidePlan`.
 *
 * Seeded from `initialMode` (unmanaged ⇒ effectiveMode == initialMode); with NO
 * posture mutation the mode/askOutsidePlan stay at the current-behavior default ⇒
 * evaluate()/dispatch/spec are byte-identical (the control + guard subtract only
 * when a posture actually denies).
 */

import { livePostureQuestionReader, type QuestionAvailabilityReader } from "@/agent/dispatch-guard"
import type { PermissionContext } from "@/permission"
import type { PostureControl } from "@/permission/posture/control"
import type { PermissionMode } from "@/permission/types"
import {
  buildLivePosture,
  type PermissionModeSessionState,
} from "@/runner/assemble/session-authorities"

/** The composed live-posture runtime the bootstrap threads onto its result. */
export interface LivePostureRuntime {
  readonly permission: PermissionContext
  readonly permissionModeState: PermissionModeSessionState
  readonly postureControl: PostureControl
  readonly questionGuard: QuestionAvailabilityReader
}

/** Build the live-posture runtime: ONE authority behind the mode accessor, the E4
 *  control, and the E5 question guard. */
export const buildLivePostureRuntime = (initialMode: PermissionMode): LivePostureRuntime => {
  const livePosture = buildLivePosture(initialMode)
  const permissionModeState = livePosture.modeState
  const permission: PermissionContext = {
    get mode() {
      return permissionModeState.get()
    },
    set mode(next) {
      permissionModeState.set(next)
    },
  }
  return {
    permission,
    permissionModeState,
    postureControl: livePosture.control,
    questionGuard: livePostureQuestionReader(livePosture.authority),
  }
}
