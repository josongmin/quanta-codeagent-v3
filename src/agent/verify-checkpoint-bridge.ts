/** Verify-checkpoint bridge (ADR-0123) — callable seam that turns a
 *  caller's "verify just passed" signal into a `markVerified` call on the
 *  shadow ODB, advancing `SHADOW_LAST_VERIFIED_REF` for the workspace.
 *
 *  This is the OPT-IN side of Cursor's `markVerifiedV2` pattern: callers
 *  (apps/agent/run.ts, future loop hook) invoke `onVerifySuccess(...)`
 *  when they decide the turn is "known good". The bridge itself is
 *  plane-clean and never imports `@/agent/verify-guard` (which is user
 *  in-flight); the host wires `onVerifySuccess` at its own schedule.
 *
 *  Hard invariant: NO-THROW. Observability/instrumentation surfaces must
 *  never break the verify path. Any failure inside `markVerified`
 *  (uninitialized, spawn-failed, git-failed) is swallowed silently — the
 *  caller is not informed and the verify gate is unaffected.
 *
 *  Default-OFF: when `odb === undefined`, every call is a no-op. The
 *  caller can therefore wire the bridge unconditionally and have it
 *  become a real anchor only once `AgentConfig.shadowOdb` is set. */

import { errMessage, logger } from "@/shared"
import type { ShadowOdb } from "@/storage/shadow-odb"

/** Callable bridge: when verify-guard passes (callers wire this on
 *  success), marks the current worktree as verified. No-op when the
 *  underlying ODB port is absent. */
export interface VerifyCheckpointBridge {
  onVerifySuccess(workspace: string): Promise<void>
}

/** Build the bridge from an OPTIONAL `ShadowOdb`. `odb === undefined`
 *  ⇒ every call resolves immediately to no-op (default-OFF). When the
 *  port is wired, `onVerifySuccess` calls `markVerified(workspace)` and
 *  swallows any thrown error. */
export const defaultVerifyCheckpointBridge = (
  odb: ShadowOdb | undefined,
): VerifyCheckpointBridge => ({
  async onVerifySuccess(workspace) {
    if (odb === undefined) return
    try {
      await odb.markVerified(workspace)
    } catch (e) {
      // NO-THROW: observability instrumentation must never break the
      // verify path. A failing markVerified (e.g. uninitialized because
      // the caller hasn't registerHead'd yet, or spawn-failed on a
      // missing git binary) is logically a "no anchor available" —
      // future rewindToVerified calls will surface no-verified-anchor
      // through the typed-error channel, which is the correct UX.
      //
      // ALBB-21 — keep the no-throw contract but leave ONE greppable
      // breadcrumb so a swallowed anchor-advance failure is diagnosable
      // (previously the catch was empty: a silently un-advanced verified
      // anchor with no trace of WHY). `debug` level keeps it out of the
      // default operator stream while remaining discoverable.
      logger.debug("verify-checkpoint-bridge: markVerified failed (anchor not advanced)", {
        workspace,
        error: errMessage(e),
      })
    }
  },
})
