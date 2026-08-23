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
import type { PermissionContext, PermissionStore } from "@/permission"
import type { PostureControl } from "@/permission/posture/control"
import type { PermissionMode } from "@/permission/types"
import {
  buildLivePosture,
  type LivePostureDurableStore,
  type PermissionModeSessionState,
} from "@/runner/assemble/session-authorities"
import { gateOn } from "@/shared"

/** The composed live-posture runtime the bootstrap threads onto its result. */
export interface LivePostureRuntime {
  readonly permission: PermissionContext
  readonly permissionModeState: PermissionModeSessionState
  readonly postureControl: PostureControl
  readonly questionGuard: QuestionAvailabilityReader
}

/** Build the live-posture runtime: ONE authority behind the mode accessor, the E4
 *  control, and the E5 question guard. When `durable` is supplied the ONE authority
 *  reads/persists through the on-disk permission store keyed by the unique session
 *  id (RFC-05 E3 restart resume); absent ⇒ the legacy in-memory seed (byte-identical). */
export const buildLivePostureRuntime = (
  initialMode: PermissionMode,
  durable?: LivePostureDurableStore,
): LivePostureRuntime => {
  const livePosture = buildLivePosture(initialMode, durable)
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

/**
 * RFC-05 E3 (durable resume) — resolve the DURABLE binding for the deferred live
 * posture and install it. GATED + default-OFF: only when the surface supplied a
 * durable `loadPermissionStore` AND `QUANTA_POSTURE_DURABLE_RESUME` is on does the
 * ONE authority read/persist through the on-disk permission store keyed by the
 * RESOLVED per-session id (restart resume; a REAL per-session key — never the
 * shared `LIVE_POSTURE_THREAD_ID` constant concurrent processes would clobber).
 * OFF / no store ⇒ the legacy process-local in-memory seed ⇒ byte-identical. The
 * `bind` closure is the prologue's `PreparedSessionRuntime.bindLivePosture` — this
 * is where the forwarding `permission` handed to `buildLlm` gets its real backing
 * (ONE authority, no split-brain). Extracted from the assembler to keep it under
 * the god-function line cap.
 */
export const resolveDurableLivePosture = async (args: {
  readonly bind: (durable?: LivePostureDurableStore) => LivePostureRuntime
  readonly loadPermissionStore?: (() => Promise<PermissionStore | undefined>) | undefined
  readonly env: Record<string, string | undefined>
  readonly sessionId: string
}): Promise<LivePostureRuntime> => {
  const durableStore =
    args.loadPermissionStore !== undefined && gateOn(args.env, "QUANTA_POSTURE_DURABLE_RESUME")
      ? await args.loadPermissionStore()
      : undefined
  return args.bind(
    durableStore !== undefined ? { store: durableStore, sessionId: args.sessionId } : undefined,
  )
}
