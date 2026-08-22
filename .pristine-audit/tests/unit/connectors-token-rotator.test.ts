/**
 * Connectors — TokenRotator port semantics unit (ADR-0160 Phase E).
 *
 * Cross-checks the rotator API beyond hellgate: TokenRotator interface shape,
 * read pass-through, forget semantics, expiry math edge cases.
 */

import { describe, expect, test } from "bun:test"
import type { ClockPort, TokenRecord, TokenStorePort } from "@/connectors"
import { createTokenRotator } from "@/connectors"

const newStore = (): TokenStorePort & { map: Map<string, TokenRecord> } => {
  const map = new Map<string, TokenRecord>()
  return {
    map,
    read: async (id) => map.get(id),
    write: async (id, r) => {
      map.set(id, r)
    },
    delete: async (id) => {
      map.delete(id)
    },
  }
}

const clockOf = (start = 0): ClockPort & { set(v: number): void } => {
  let now = start
  return {
    now: () => now,
    set: (v) => {
      now = v
    },
  }
}

describe("connectors / token-rotator", () => {
  test("UNIT-1: read pass-through reads from store", async () => {
    const store = newStore()
    store.map.set("c1", { accessToken: "x", tokenType: "Bearer" })
    const r = createTokenRotator({ tokenStore: store, clockPort: clockOf() })
    expect((await r.read("c1"))?.accessToken).toBe("x")
  })

  test("UNIT-2: rotate persists then returns new token", async () => {
    const store = newStore()
    const r = createTokenRotator({ tokenStore: store, clockPort: clockOf() })
    const got = await r.rotate("c1", async () => ({ accessToken: "n", tokenType: "Bearer" }))
    expect(got.accessToken).toBe("n")
    expect(store.map.get("c1")?.accessToken).toBe("n")
  })

  test("UNIT-3: rotate replaces existing record (no merge)", async () => {
    const store = newStore()
    store.map.set("c1", { accessToken: "old", refreshToken: "rt-old", tokenType: "Bearer" })
    const r = createTokenRotator({ tokenStore: store, clockPort: clockOf() })
    await r.rotate("c1", async () => ({ accessToken: "new", tokenType: "Bearer" }))
    const stored = store.map.get("c1")
    expect(stored?.accessToken).toBe("new")
    expect(stored?.refreshToken).toBeUndefined() // not merged from old
  })

  test("UNIT-4: forget on missing id is no-op (no throw)", async () => {
    const store = newStore()
    const r = createTokenRotator({ tokenStore: store, clockPort: clockOf() })
    await r.forget("nope")
    expect(store.map.size).toBe(0)
  })

  test("UNIT-5: isExpired strict at expiresAt (>= clock now)", () => {
    const clk = clockOf(100)
    const r = createTokenRotator({ tokenStore: newStore(), clockPort: clk })
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: 100 })).toBe(true)
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: 101 })).toBe(false)
  })

  test("UNIT-6: isExpired returns false when expiresAt absent", () => {
    const r = createTokenRotator({
      tokenStore: newStore(),
      clockPort: clockOf(Number.MAX_SAFE_INTEGER),
    })
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer" })).toBe(false)
  })

  test("UNIT-7: isExpired tracks clock advance", () => {
    const clk = clockOf(0)
    const r = createTokenRotator({ tokenStore: newStore(), clockPort: clk })
    const t: TokenRecord = { accessToken: "a", tokenType: "Bearer", expiresAt: 1_000 }
    expect(r.isExpired(t)).toBe(false)
    clk.set(999)
    expect(r.isExpired(t)).toBe(false)
    clk.set(1_000)
    expect(r.isExpired(t)).toBe(true)
  })

  test("UNIT-8: rotate then read returns the rotated record", async () => {
    const store = newStore()
    const r = createTokenRotator({ tokenStore: store, clockPort: clockOf() })
    await r.rotate("c1", async () => ({
      accessToken: "fresh",
      tokenType: "Bearer",
      expiresAt: 999_999,
    }))
    const back = await r.read("c1")
    expect(back?.accessToken).toBe("fresh")
    expect(back?.expiresAt).toBe(999_999)
  })
})
