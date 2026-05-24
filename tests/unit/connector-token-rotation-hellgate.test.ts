/**
 * Connector token rotation — hellgate (ADR-0160 Phase E).
 *
 * Seals 11 adversarial cases for per-connector token store + rotation:
 *   1.  read() returns undefined for missing id
 *   2.  rotate happy: callback returns new token, persisted
 *   3.  rotate passes current token to callback
 *   4.  in-flight rotate mutex: concurrent rotate(SAME id) coalesces
 *   5.  different ids rotate independently
 *   6.  refresh callback throws → TokenRotationError code=refresh-callback-failed
 *   7.  token store write throws → TokenRotationError code=store-write-failed
 *   8.  forget() deletes stored token (idempotent — second call is no-op)
 *   9.  isExpired: expiresAt absent → false
 *   10. isExpired: expiresAt in past → true; in future → false; exactly now → true
 *   11. in-flight cleanup: failed rotate releases mutex (next call retries)
 */

import { describe, expect, test } from "bun:test"
import type { ClockPort, TokenRecord, TokenStorePort } from "@/connectors"
import { createTokenRotator, TokenRotationError } from "@/connectors"

interface FakeStore extends TokenStorePort {
  readonly map: Map<string, TokenRecord>
  writeThrowOn: boolean
}

const makeFakeStore = (): FakeStore => {
  const map = new Map<string, TokenRecord>()
  return {
    map,
    writeThrowOn: false,
    read: async (id) => map.get(id),
    write: async (id, rec) => {
      if ((fakeStoreRef as { writeThrowOn?: boolean }).writeThrowOn === true) {
        throw new Error("disk full")
      }
      map.set(id, rec)
    },
    delete: async (id) => {
      map.delete(id)
    },
  }
}
// Self-reference for the throw flag (closure can't reach `this` from object literal cleanly).
let fakeStoreRef: FakeStore

const makeClock = (start = 0): ClockPort & { advance(ms: number): void } => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const sample: TokenRecord = { accessToken: "a", tokenType: "Bearer" }

describe("connector-token-rotation-hellgate", () => {
  test("HELL-1: read() returns undefined for missing id", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    expect(await r.read("nope")).toBeUndefined()
  })

  test("HELL-2: rotate happy → callback returns token, persisted", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    const newTok: TokenRecord = { accessToken: "new", tokenType: "Bearer" }
    const got = await r.rotate("c1", async () => newTok)
    expect(got).toEqual(newTok)
    expect(await fakeStoreRef.read("c1")).toEqual(newTok)
  })

  test("HELL-3: rotate passes current token to callback", async () => {
    fakeStoreRef = makeFakeStore()
    await fakeStoreRef.write("c1", sample)
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    let captured: TokenRecord | undefined
    await r.rotate("c1", async (cur) => {
      captured = cur
      return { accessToken: "n", tokenType: "Bearer" }
    })
    expect(captured).toEqual(sample)
  })

  test("HELL-4: concurrent rotate(SAME id) coalesces — one callback fires", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    let callbackCalls = 0
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      resolveGate = res
    })
    const refresh = async (): Promise<TokenRecord> => {
      callbackCalls += 1
      await gate
      return { accessToken: "ok", tokenType: "Bearer" }
    }
    const p1 = r.rotate("c1", refresh)
    const p2 = r.rotate("c1", refresh)
    const p3 = r.rotate("c1", refresh)
    if (resolveGate === undefined) throw new Error("gate")
    resolveGate()
    await Promise.all([p1, p2, p3])
    expect(callbackCalls).toBe(1)
  })

  test("HELL-5: different ids rotate independently — both callbacks fire", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    let n = 0
    await Promise.all([
      r.rotate("c1", async () => {
        n += 1
        return { accessToken: "1", tokenType: "Bearer" }
      }),
      r.rotate("c2", async () => {
        n += 1
        return { accessToken: "2", tokenType: "Bearer" }
      }),
    ])
    expect(n).toBe(2)
  })

  test("HELL-6: refresh callback throws → typed refresh-callback-failed", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    try {
      await r.rotate("c1", async () => {
        throw new Error("idp said no")
      })
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(TokenRotationError)
      if (e instanceof TokenRotationError) expect(e.code).toBe("refresh-callback-failed")
    }
  })

  test("HELL-7: store write throws → typed store-write-failed", async () => {
    fakeStoreRef = makeFakeStore()
    fakeStoreRef.writeThrowOn = true
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    try {
      await r.rotate("c1", async () => ({ accessToken: "x", tokenType: "Bearer" }))
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(TokenRotationError)
      if (e instanceof TokenRotationError) expect(e.code).toBe("store-write-failed")
    }
  })

  test("HELL-8: forget() is idempotent", async () => {
    fakeStoreRef = makeFakeStore()
    await fakeStoreRef.write("c1", sample)
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    await r.forget("c1")
    await r.forget("c1") // second call: no-op, no throw
    expect(await fakeStoreRef.read("c1")).toBeUndefined()
  })

  test("HELL-9: isExpired returns false when expiresAt absent", () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock(100) })
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer" })).toBe(false)
  })

  test("HELL-10: isExpired past/future/exact-now arms", () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock(100) })
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: 99 })).toBe(true)
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: 101 })).toBe(false)
    expect(r.isExpired({ accessToken: "a", tokenType: "Bearer", expiresAt: 100 })).toBe(true)
  })

  test("HELL-11: failed rotate releases mutex — next call retries fresh", async () => {
    fakeStoreRef = makeFakeStore()
    const r = createTokenRotator({ tokenStore: fakeStoreRef, clockPort: makeClock() })
    try {
      await r.rotate("c1", async () => {
        throw new Error("first fail")
      })
    } catch {
      // expected
    }
    // Second call must succeed — mutex was released.
    const ok = await r.rotate("c1", async () => ({ accessToken: "second", tokenType: "Bearer" }))
    expect(ok.accessToken).toBe("second")
  })
})
