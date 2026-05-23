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
 *   `toolChoiceState.verifyGuardViolated = true` (ADR-0079, 1-turn TTL),
 *   `wm.append(message)` + `wm.append(metaUser(text))`, return blocked.
 */

import type { Message } from "@/llm"
import { decideVerifyGuard, type VerifyGuardState } from "../verify-guard"
import { guardBlocked, type TurnGuard, type TurnGuardContext, type TurnGuardResult } from "./chain"
import { isFinishAttempt, metaUser } from "./shared"

/** Build a `TurnGuard` instance backed by the existing per-session
 *  `VerifyGuardState`. The closure holds `state` + `cfg` so the chain itself
 *  stays state-free (the chain is reusable across turns; state migrates with
 *  the guard instance). */
export const createVerifyGuard = (args: {
  cfg: { maxTrips?: number; mustPass?: boolean }
  state: VerifyGuardState
}): TurnGuard => {
  const { cfg, state } = args
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
      if (!verdict.block || verdict.text === undefined) return undefined
      ctx.emit("unverified")
      // ADR-0079 — arm tool_choice:{kind:"any"} for the FORCED re-entry.
      ctx.toolChoiceState.verifyGuardViolated = true
      ctx.wm.append(ctx.message as Message)
      ctx.wm.append(metaUser(verdict.text))
      return guardBlocked()
    },
  }
}
