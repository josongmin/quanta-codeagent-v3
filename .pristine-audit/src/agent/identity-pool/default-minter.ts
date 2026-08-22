/**
 * Default `IdentityMinter` impl (ADR-0247).
 *
 * Round-robin probe across the frozen 39-entry pool, skipping in-use entries.
 * The cursor is internal state — a fresh `createDefaultIdentityMinter()`
 * always starts at index 0, so test runs are deterministic.
 *
 * No IO, no clock, no shared global state. Each minter instance owns its own
 * cursor + in-use set.
 */

import { NICKNAME_TABLE, POOL_SIZE } from "./nickname-table"
import { type IdentityMinter, MintError, ReleaseError } from "./port"
import { type AgentNickname, type AgentRole, type MintedIdentity, NONE_NICKNAME } from "./types"

/** Build a fresh `IdentityMinter`. Each call yields an independent minter
 *  with its own cursor + in-use set (no module-level mutable state). */
export const createDefaultIdentityMinter = (): IdentityMinter => {
  const inUse = new Set<AgentNickname>()
  // Round-robin cursor — advances to the index AFTER the last successful mint.
  // Starts at 0 so the first explorer/worker/reviewer mint deterministically
  // returns `NICKNAME_TABLE[0]` ("Euler").
  let cursor = 0

  const mint = (role: AgentRole): MintedIdentity => {
    if (role === "none") {
      // The `"__none__"` sentinel does NOT consume a pool slot. Production
      // share is 28% — the inline "no subagent identity" case must be O(1)
      // and free of pool pressure.
      return { nickname: NONE_NICKNAME, role: "none" }
    }
    // Probe up to POOL_SIZE entries starting at `cursor`. If every slot is
    // in use, throw MintError — callers must release before retrying.
    for (let probe = 0; probe < POOL_SIZE; probe++) {
      const idx = (cursor + probe) % POOL_SIZE
      // SAFETY: idx is bounded by POOL_SIZE and NICKNAME_TABLE has POOL_SIZE
      // entries — narrowed via the `satisfies readonly AgentNickname[]` in
      // nickname-table.ts. The `as` cast is the smallest possible widening
      // away from `readonly AgentNickname[]`'s indexed-access undefined.
      const candidate = NICKNAME_TABLE[idx] as AgentNickname
      if (!inUse.has(candidate)) {
        inUse.add(candidate)
        cursor = (idx + 1) % POOL_SIZE
        return { nickname: candidate, role }
      }
    }
    throw new MintError(inUse.size, POOL_SIZE)
  }

  const release = (nickname: AgentNickname): void => {
    if (nickname === NONE_NICKNAME) {
      // Releasing the sentinel is a no-op — it never consumed a slot.
      return
    }
    if (!inUse.has(nickname)) {
      throw new ReleaseError(nickname)
    }
    inUse.delete(nickname)
  }

  const inUseSnapshot = (): ReadonlySet<AgentNickname> => {
    // Defensive copy — caller mutation cannot poison internal state.
    return new Set(inUse)
  }

  return { mint, release, inUse: inUseSnapshot }
}
