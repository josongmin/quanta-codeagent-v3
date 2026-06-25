/**
 * Closeout-guard adapter (chain framework). Wraps the existing pure policy
 * `decideCloseoutGuard` (ADR-0017 closeout reminder). Body is BYTE-IDENTICAL
 * to the pre-refactor `closeoutGuardStep` in `loop.ts:1160-1187` — only the
 * call-site shape changed (one ctx arg, chain return).
 *
 * Invariants (must hold or this refactor regresses ADR-0017):
 * - `config.closeoutGuard === undefined` OR `state === undefined` ⇒
 *   `decide` returns `undefined` (pass-through). Default-OFF byte-identical.
 * - `!isFinishAttempt(action, message)` ⇒ pass-through.
 * - Order matters: this guard is registered AFTER VerifyGuard in
 *   `buildGuardChain` so verify trips first on a co-firing turn; closeout
 *   fires the NEXT finish-attempt (matches the legacy "ordered STRICTLY
 *   AFTER verify-guard" comment in `loop.ts:1248-1251`).
 * - When blocking: emit recovery=`"closeout"`, arm
 *   `toolChoiceState.closeoutAttempted = true` (ADR-0079, 1-turn TTL),
 *   `wm.append(message)` + `wm.append(metaUser(text))`, return blocked.
 */

import type { Message } from "@/llm"
import { type CloseoutGuardState, decideCloseoutGuard } from "../closeout-guard"
import { guardBlocked, type TurnGuard, type TurnGuardContext, type TurnGuardResult } from "./chain"
import { isFinishAttempt, metaUser } from "./shared"

export const createCloseoutGuard = (args: {
  cfg: { enabled?: boolean; fourRule?: boolean }
  state: CloseoutGuardState
}): TurnGuard => {
  const { cfg, state } = args
  return {
    name: "closeout",
    decide: (ctx: TurnGuardContext): TurnGuardResult | undefined => {
      // Body byte-identical to legacy `closeoutGuardStep`.
      if (!isFinishAttempt(ctx.action, ctx.message)) return undefined
      const verdict = decideCloseoutGuard({ cfg, state })
      if (!verdict.block || verdict.text === undefined) return undefined
      ctx.emit("closeout")
      // ADR-0079 — arm tool_choice:{kind:"none"} for the FORCED re-entry.
      ctx.toolChoiceState.closeoutAttempted = true
      ctx.wm.append(ctx.message as Message)
      ctx.wm.append(metaUser(verdict.text))
      return guardBlocked()
    },
  }
}
