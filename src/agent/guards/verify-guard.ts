/**
 * Verify-guard adapter (chain framework). Wraps the existing pure policy
 * `decideVerifyGuard` (ADR-0011, Tier 0 safety hardening). Body is BYTE-
 * IDENTICAL to the pre-refactor `verifyGuardStep` in `loop.ts:1119-1147` —
 * only the call-site shape changed (one ctx arg, chain return).
 *
 * Invariants (must hold or this refactor regresses ADR-0011):
 * - `config.verifyGuard === undefined` OR `state === undefined` ⇒
 *   `decide` returns `undefined` (pass-through). Default-OFF byte-identical.
 * - `!isFinishAttempt(action, message)` ⇒ pass-through (only fires at the
 *   two completion points the loop accepts: `action.do === "completed"` OR
 *   `action.do === "proceed"` with no `tool_use` blocks).
 * - When blocking: emit recovery=`"unverified"`, arm
 *   `toolChoiceState.verifyGuardViolated = true` (ADR-0079, 1-turn TTL — note
 *   this no longer forces tool_choice; it resolves to `auto`),
 *   `wm.append(message)` + `wm.append(metaUser(text))`, return blocked.
 */

import type { Message } from "@/llm"
import type { VerifyCheckpointBridge } from "../verify-checkpoint-bridge"
import { decideVerifyGuard, type VerifyGuardState } from "../verify-guard"
import { guardBlocked, type TurnGuard, type TurnGuardContext, type TurnGuardResult } from "./chain"
import { isFinishAttempt, metaUser } from "./shared"

/** Build a `TurnGuard` instance backed by the existing per-session
 *  `VerifyGuardState`. The closure holds `state` + `cfg` so the chain itself
 *  stays state-free (the chain is reusable across turns; state migrates with
 *  the guard instance).
 *
 *  ADR-0123 — optional `verifyCheckpoint` seam fires `onVerifySuccess(cwd)`
 *  EXACTLY when a finish attempt clears the verify policy (Cursor's
 *  `markVerifiedV2` pattern: anchor advances only on verified state). Absent
 *  ⇒ no invocation (byte-identical to pre-ADR). NO-AWAIT: the bridge is
 *  no-throw and observability-grade, so fire-and-forget keeps the guard
 *  adapter synchronous (matches the chain `decide` contract). */
export const createVerifyGuard = (args: {
  cfg: { maxTrips?: number; mustPass?: boolean }
  state: VerifyGuardState
  verifyCheckpoint?: { bridge: VerifyCheckpointBridge; cwd: string }
}): TurnGuard => {
  const { cfg, state, verifyCheckpoint } = args
  return {
    name: "verify",
    decide: (ctx: TurnGuardContext): TurnGuardResult | undefined => {
      // Body byte-identical to legacy `verifyGuardStep`. Pre-checks first.
      if (!isFinishAttempt(ctx.action, ctx.message)) return undefined
      const verdict = decideVerifyGuard({
        history: ctx.history,
        cfg,
        state,
      })
      if (!verdict.block || verdict.text === undefined) {
        // PASS path: a finish attempt cleared the verify policy. Fire the
        // checkpoint bridge so the shadow-ODB anchor advances to HEAD for
        // this workspace. NO-AWAIT (bridge is no-throw); the fire-and-forget
        // promise is intentional — the verify gate must not change shape on
        // a slow `git update-ref`.
        if (verifyCheckpoint !== undefined) {
          void verifyCheckpoint.bridge.onVerifySuccess(verifyCheckpoint.cwd)
        }
        return undefined
      }
      ctx.emit("unverified")
      // ADR-0079 — arm the 1-turn-TTL signal bit. This NO LONGER forces
      // tool_choice (resolveToolChoice maps it to `auto`); the steer is the
      // injected evidential nudge below, which the model may satisfy with a
      // verify tool OR a text answer. Bit kept for state-hygiene/observability.
      ctx.toolChoiceState.verifyGuardViolated = true
      ctx.wm.append(ctx.message as Message)
      ctx.wm.append(metaUser(verdict.text))
      return guardBlocked()
    },
  }
}
