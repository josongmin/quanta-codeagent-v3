/**
 * IdentityMinter port (ADR-0247).
 *
 * Closed surface for the per-subagent-instance identity mint/release lifecycle.
 * Pure-by-contract: implementations MUST NOT touch IO, the clock, or any
 * shared global state. Each `createDefaultIdentityMinter()` instance owns its
 * own pool cursor + in-use set, so a fresh minter always starts deterministic.
 *
 * Production callers (ADR-0140 background scheduler, ADR-0030 mid-turn
 * steering, fork-session) wire this through the agent config; tests inject
 * hand-rolled minters where round-robin determinism matters.
 */

import { QuantaError } from "@/shared"
import type { AgentNickname, AgentRole, MintedIdentity } from "./types"

/** Thrown by `mint()` when the 39-entry pool is fully in-use. The scheduler
 *  is expected to bound concurrent subagents far below 39; this exists so
 *  callers cannot silently re-use a name when they accidentally exceed the
 *  cap. */
export class MintError extends QuantaError {
  readonly inUseCount: number
  readonly poolSize: number
  constructor(inUseCount: number, poolSize: number) {
    super(
      "identity_pool_exhausted",
      `IdentityMinter pool exhausted (${inUseCount}/${poolSize} in use). ` +
        `Release a nickname via release(nickname) before minting another.`,
    )
    this.inUseCount = inUseCount
    this.poolSize = poolSize
  }
}

/** Thrown by `release()` when the caller passes a nickname that the minter
 *  does not currently hold. A double-release or a release of a name the
 *  minter never minted is a programmer error, not an expected domain
 *  failure — surfacing it loudly catches the bug at the offending site. */
export class ReleaseError extends QuantaError {
  readonly nickname: AgentNickname
  constructor(nickname: AgentNickname) {
    super(
      "identity_pool_release_unknown",
      `IdentityMinter.release(${JSON.stringify(nickname)}) — nickname is ` +
        `not currently held. Double-release or release of a never-minted ` +
        `nickname.`,
    )
    this.nickname = nickname
  }
}

/** The closed-port surface. */
export interface IdentityMinter {
  /** Mint a new identity for a subagent of `role`. For `role === "none"`,
   *  returns the `"__none__"` sentinel without consuming a pool slot. For
   *  the other 3 roles, advances a round-robin cursor across the 39-entry
   *  pool, skipping in-use entries. Throws {@link MintError} on exhaustion. */
  mint(role: AgentRole): MintedIdentity

  /** Release a previously-minted nickname back to the pool. The sentinel
   *  `"__none__"` is accepted as a no-op. Throws {@link ReleaseError} for
   *  any other nickname the minter does not currently hold. */
  release(nickname: AgentNickname): void

  /** Snapshot of currently-held nicknames. The returned set is a defensive
   *  copy — caller mutation cannot poison the minter's internal state. */
  inUse(): ReadonlySet<AgentNickname>
}
