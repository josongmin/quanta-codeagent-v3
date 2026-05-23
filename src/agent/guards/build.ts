/**
 * Build a `TurnGuard[]` chain from the per-session state already constructed
 * by `session-resources.buildVerifyGuard` / `buildCloseoutGuard`. Empty array
 * is the default-OFF byte-identical sentinel: `runGuardChain([])` returns
 * `undefined` immediately, so `applyAction` falls through to the legacy
 * completed/nudge/proceed path verbatim.
 *
 * Order is LOAD-BEARING: VerifyGuard first, CloseoutGuard second. Matches the
 * pre-refactor `verifyGuardStep` → `closeoutGuardStep` call ordering in
 * `loop.ts:1238-1261`. Documented invariant: "verify trips first on the
 * same finish, closeout fires the NEXT finish-attempt" (closeout-guard.ts
 * module header + loop.ts:1156-1159 + 1248-1251).
 */

import type { CloseoutGuardState } from "../closeout-guard"
import type { AgentConfig } from "../types"
import type { VerifyGuardState } from "../verify-guard"
import type { TurnGuard } from "./chain"
import { createCloseoutGuard } from "./closeout-guard"
import { createVerifyGuard } from "./verify-guard"

export const buildGuardChain = (args: {
  config: AgentConfig
  verifyGuardState: VerifyGuardState | undefined
  closeoutGuardState: CloseoutGuardState | undefined
}): readonly TurnGuard[] => {
  const { config, verifyGuardState, closeoutGuardState } = args
  const out: TurnGuard[] = []
  // VerifyGuard: only when BOTH config + per-session state are present (the
  // legacy step skipped on either-undefined, so we mirror that gate here).
  if (config.verifyGuard !== undefined && verifyGuardState !== undefined) {
    out.push(createVerifyGuard({ cfg: config.verifyGuard, state: verifyGuardState }))
  }
  // CloseoutGuard: only when `cfg.closeoutGuard.enabled === true` AND state
  // present. `buildCloseoutGuard` already gates state creation on
  // `enabled === true`, but we still guard cfg here so the chain is robust
  // to callers who hand-construct the args bag with a stale state.
  if (config.closeoutGuard !== undefined && closeoutGuardState !== undefined) {
    out.push(
      createCloseoutGuard({
        cfg: config.closeoutGuard,
        state: closeoutGuardState,
      }),
    )
  }
  return out
}
