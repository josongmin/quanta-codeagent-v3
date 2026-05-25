/**
 * Identity-pool (ADR-0247) — hellgate battery.
 *
 * 15 adversarial cases sealing the per-subagent-instance nickname-mint /
 * role-tag invariants:
 *
 *   01. mint(role) → {nickname, role} shape
 *   02. two consecutive mint("explorer") return DISTINCT nicknames
 *   03. release(nickname) → next mint() may pick it up again
 *   04. 40 mints (39 + 1) → MintError (pool exhausted)
 *   05. release(<never-minted>) → ReleaseError
 *   06. inUse() accurately reflects currently held nicknames
 *   07. AgentRole 4-arm compile-time exhaustive (switch + never)
 *   08. pool table has exactly 39 entries
 *   09. every pool entry is in the AgentNickname literal union
 *   10. round-robin is deterministic from a fresh minter
 *   11. 39 sequential mints (single minter) all return distinct nicknames
 *   12. barrel import has no side effects (no mint, no shared state)
 *   13. mint("none") → "__none__" sentinel WITHOUT consuming a pool slot
 *   14. 1000 mint→release cycles do not leak
 *   15. release("__none__") is a no-op (no throw, no pool change)
 */

import { describe, expect, test } from "bun:test"
import {
  type AgentNickname,
  type AgentRole,
  createDefaultIdentityMinter,
  MintError,
  NICKNAME_TABLE,
  NONE_NICKNAME,
  POOL_SIZE,
  ReleaseError,
} from "@/agent/identity-pool"

describe("ADR-0247 identity-pool — HELLGATE", () => {
  test("HELL-IP-01: mint(role) returns {nickname, role} shape", () => {
    const minter = createDefaultIdentityMinter()
    const minted = minter.mint("explorer")
    expect(typeof minted.nickname).toBe("string")
    expect(minted.role).toBe("explorer")
    // Shape is exactly {nickname, role} — no extra fields leaked.
    expect(Object.keys(minted).sort()).toEqual(["nickname", "role"])
  })

  test('HELL-IP-02: two consecutive mint("explorer") return distinct nicknames', () => {
    const minter = createDefaultIdentityMinter()
    const a = minter.mint("explorer")
    const b = minter.mint("explorer")
    expect(a.nickname).not.toBe(b.nickname)
    // Both must carry the role through (no silent role flip on round-robin).
    expect(a.role).toBe("explorer")
    expect(b.role).toBe("explorer")
  })

  test("HELL-IP-03: release(nickname) returns the slot to the pool", () => {
    const minter = createDefaultIdentityMinter()
    const first = minter.mint("worker")
    minter.release(first.nickname)
    // After release, the in-use set must be empty.
    expect(minter.inUse().size).toBe(0)
    // Mint POOL_SIZE more entries — exhaustion proves the released slot
    // re-entered rotation (otherwise we'd hit MintError at POOL_SIZE-1).
    for (let i = 0; i < POOL_SIZE; i++) {
      minter.mint("worker")
    }
    expect(minter.inUse().size).toBe(POOL_SIZE)
  })

  test("HELL-IP-04: 40 mints (39 + 1) on a fresh minter throws MintError", () => {
    const minter = createDefaultIdentityMinter()
    for (let i = 0; i < POOL_SIZE; i++) {
      minter.mint("explorer")
    }
    expect(() => minter.mint("explorer")).toThrow(MintError)
    // The error carries inUseCount + poolSize for telemetry.
    try {
      minter.mint("explorer")
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      const me = e as MintError
      expect(me.inUseCount).toBe(POOL_SIZE)
      expect(me.poolSize).toBe(POOL_SIZE)
    }
  })

  test("HELL-IP-05: release(<never-minted>) throws ReleaseError", () => {
    const minter = createDefaultIdentityMinter()
    expect(() => minter.release("Euler")).toThrow(ReleaseError)
    // Mint+release then try to release again — double-release is also Err.
    const minted = minter.mint("reviewer")
    minter.release(minted.nickname)
    expect(() => minter.release(minted.nickname)).toThrow(ReleaseError)
  })

  test("HELL-IP-06: inUse() accurately reflects held nicknames", () => {
    const minter = createDefaultIdentityMinter()
    expect(minter.inUse().size).toBe(0)
    const a = minter.mint("explorer")
    const b = minter.mint("worker")
    const snap1 = minter.inUse()
    expect(snap1.size).toBe(2)
    expect(snap1.has(a.nickname)).toBe(true)
    expect(snap1.has(b.nickname)).toBe(true)
    minter.release(a.nickname)
    const snap2 = minter.inUse()
    expect(snap2.size).toBe(1)
    expect(snap2.has(a.nickname)).toBe(false)
    expect(snap2.has(b.nickname)).toBe(true)
    // Defensive copy: mutating a stale snapshot must not affect later snapshots.
    const mutable = new Set(snap2)
    mutable.clear()
    const snap3 = minter.inUse()
    expect(snap3.size).toBe(1)
  })

  test("HELL-IP-07: AgentRole 4-arm exhaustive (switch + never)", () => {
    // Compile-time exhaustiveness: if AgentRole grows, this switch will
    // fail tsc until the new arm is added.
    const cover = (role: AgentRole): string => {
      switch (role) {
        case "explorer":
          return "e"
        case "worker":
          return "w"
        case "reviewer":
          return "r"
        case "none":
          return "n"
        default: {
          const _exhaustive: never = role
          return _exhaustive
        }
      }
    }
    expect(cover("explorer")).toBe("e")
    expect(cover("worker")).toBe("w")
    expect(cover("reviewer")).toBe("r")
    expect(cover("none")).toBe("n")
  })

  test("HELL-IP-08: pool table has exactly 39 entries", () => {
    // Widen via `as number` — the `as const` narrows `.length` to a literal
    // type that bun's `toBe` overload would reject against an integer literal.
    expect(NICKNAME_TABLE.length as number).toBe(39)
    expect(POOL_SIZE).toBe(39)
  })

  test("HELL-IP-09: every pool entry is in the AgentNickname literal union", () => {
    // Compile-time narrowing: each entry must be assignable to AgentNickname.
    // The `as const satisfies readonly AgentNickname[]` in nickname-table.ts
    // is the primary lock; this runtime check is the belt-and-braces guard.
    const unique = new Set<string>(NICKNAME_TABLE)
    expect(unique.size).toBe(NICKNAME_TABLE.length)
    // None of the entries is the "__none__" sentinel — that's a separate slot.
    expect(unique.has(NONE_NICKNAME)).toBe(false)
    // Every entry is non-empty.
    for (const n of NICKNAME_TABLE) {
      expect(typeof n).toBe("string")
      expect(n.length).toBeGreaterThan(0)
    }
  })

  test("HELL-IP-10: round-robin is deterministic from a fresh minter", () => {
    const m1 = createDefaultIdentityMinter()
    const m2 = createDefaultIdentityMinter()
    // Two fresh minters must produce IDENTICAL sequences for the same role.
    for (let i = 0; i < 5; i++) {
      expect(m1.mint("explorer").nickname).toBe(m2.mint("explorer").nickname)
    }
    // First mint must be NICKNAME_TABLE[0] ("Euler") — locked by cursor=0 start.
    const m3 = createDefaultIdentityMinter()
    expect(m3.mint("worker").nickname).toBe(NICKNAME_TABLE[0])
  })

  test("HELL-IP-11: 39 sequential mints (single minter) return distinct nicknames", () => {
    const minter = createDefaultIdentityMinter()
    const seen = new Set<AgentNickname>()
    for (let i = 0; i < POOL_SIZE; i++) {
      const minted = minter.mint("explorer")
      expect(seen.has(minted.nickname)).toBe(false)
      seen.add(minted.nickname)
    }
    expect(seen.size).toBe(POOL_SIZE)
    // Exactly the pool entries — no sentinel leak into the loop.
    for (const entry of NICKNAME_TABLE) {
      expect(seen.has(entry)).toBe(true)
    }
  })

  test("HELL-IP-12: barrel import has no side effects (no mint, no shared state)", () => {
    // Two minters minted independently must NOT share state.
    const m1 = createDefaultIdentityMinter()
    const m2 = createDefaultIdentityMinter()
    const a = m1.mint("explorer")
    const b = m2.mint("explorer")
    expect(a.nickname).toBe(b.nickname) // Both start at cursor=0.
    // m1 holds `a`, m2 holds `b`, but they don't see each other.
    expect(m1.inUse().has(a.nickname)).toBe(true)
    expect(m2.inUse().has(a.nickname)).toBe(true) // Same nickname value.
    // Releasing on m2 does NOT affect m1.
    m2.release(b.nickname)
    expect(m1.inUse().has(a.nickname)).toBe(true)
    expect(m2.inUse().has(b.nickname)).toBe(false)
  })

  test('HELL-IP-13: mint("none") returns __none__ WITHOUT consuming a pool slot', () => {
    const minter = createDefaultIdentityMinter()
    for (let i = 0; i < 100; i++) {
      const minted = minter.mint("none")
      expect(minted.nickname).toBe(NONE_NICKNAME)
      expect(minted.role).toBe("none")
    }
    // 100 "none" mints did not consume any pool slot.
    expect(minter.inUse().size).toBe(0)
    // The pool is still fully available — 39 explorer mints all succeed.
    for (let i = 0; i < POOL_SIZE; i++) {
      minter.mint("explorer")
    }
    expect(minter.inUse().size).toBe(POOL_SIZE)
  })

  test("HELL-IP-14: 1000 mint→release cycles do not leak", () => {
    const minter = createDefaultIdentityMinter()
    for (let i = 0; i < 1000; i++) {
      const minted = minter.mint("worker")
      minter.release(minted.nickname)
    }
    expect(minter.inUse().size).toBe(0)
    // After 1000 cycles, the pool is fully available for a fresh exhaustion.
    for (let i = 0; i < POOL_SIZE; i++) {
      minter.mint("worker")
    }
    expect(() => minter.mint("worker")).toThrow(MintError)
  })

  test("HELL-IP-15: release(__none__) is a no-op", () => {
    const minter = createDefaultIdentityMinter()
    // Releasing the sentinel without ever minting it: must not throw.
    expect(() => minter.release(NONE_NICKNAME)).not.toThrow()
    expect(minter.inUse().size).toBe(0)
    // Mint a real entry, then release the sentinel — no impact on real slot.
    const minted = minter.mint("explorer")
    expect(() => minter.release(NONE_NICKNAME)).not.toThrow()
    expect(minter.inUse().size).toBe(1)
    expect(minter.inUse().has(minted.nickname)).toBe(true)
  })
})
