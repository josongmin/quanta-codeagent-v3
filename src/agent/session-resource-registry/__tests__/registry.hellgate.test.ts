/**
 * ADR-0345 — `SessionResourceRegistry` hellgate.
 *
 * Coverage:
 *   A. empty registry: peek/size                                (1)
 *   B. getOrCreate first call mints + tracks                    (1)
 *   C. getOrCreate same id ⇒ SAME instance (core invariant)     (1)
 *   D. getOrCreate distinct ids ⇒ distinct instances            (1)
 *   E. peek hit ⇒ same reference; size unchanged                (1)
 *   F. peek miss ⇒ null                                         (1)
 *   G. evict + idempotent                                       (1)
 *   H. clear drops every entry                                  (1)
 *   I. LRU: maxEntries=2 + 3rd id ⇒ oldest evicted              (1)
 *   J. LRU touch: getOrCreate refreshes lastTouched ordering    (1)
 *   K. TTL: idleTtlMs + advance ⇒ expired sweep on next access  (1)
 *   L. TTL + LRU together: TTL sweep runs before LRU            (1)
 *   M. clock seam determinism (now() mock controls eviction)    (1)
 *   N. peek does NOT bump lastTouched (read-only contract)      (1)
 *
 *  Total = 14 cases.
 */

import { describe, expect, test } from "bun:test"
import { createInMemorySessionResourceRegistry } from "../in-memory-registry"

describe("ADR-0345 §A — empty registry", () => {
  test("peek on empty ⇒ null; size = 0", () => {
    const reg = createInMemorySessionResourceRegistry()
    expect(reg.peek("s1")).toBeNull()
    expect(reg.size()).toBe(0)
  })
})

describe("ADR-0345 §B — getOrCreate mints", () => {
  test("first call mints fresh pair + tracks", () => {
    const reg = createInMemorySessionResourceRegistry()
    const r = reg.getOrCreate("s1")
    expect(r.store).toBeDefined()
    expect(r.cache).toBeDefined()
    expect(typeof r.store.append).toBe("function")
    expect(typeof r.cache.getOrBuild).toBe("function")
    expect(reg.size()).toBe(1)
  })
})

describe("ADR-0345 §C — same id reuse (core invariant)", () => {
  test("getOrCreate twice with same id ⇒ SAME instance refs", () => {
    const reg = createInMemorySessionResourceRegistry()
    const a = reg.getOrCreate("s1")
    const b = reg.getOrCreate("s1")
    expect(a).toBe(b)
    expect(a.store).toBe(b.store)
    expect(a.cache).toBe(b.cache)
    // and the underlying state is shared: append on one is visible on the other.
    a.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    expect(b.store.snapshot().length).toBe(1)
  })
})

describe("ADR-0345 §D — distinct ids", () => {
  test("getOrCreate('a') !== getOrCreate('b')", () => {
    const reg = createInMemorySessionResourceRegistry()
    const a = reg.getOrCreate("a")
    const b = reg.getOrCreate("b")
    expect(a).not.toBe(b)
    expect(a.store).not.toBe(b.store)
    expect(a.cache).not.toBe(b.cache)
    expect(reg.size()).toBe(2)
  })
})

describe("ADR-0345 §E — peek hit", () => {
  test("peek returns same ref; size unchanged", () => {
    const reg = createInMemorySessionResourceRegistry()
    const a = reg.getOrCreate("s1")
    const sizeBefore = reg.size()
    const peeked = reg.peek("s1")
    expect(peeked).toBe(a)
    expect(reg.size()).toBe(sizeBefore)
  })
})

describe("ADR-0345 §F — peek miss", () => {
  test("peek on unknown id ⇒ null", () => {
    const reg = createInMemorySessionResourceRegistry()
    reg.getOrCreate("s1")
    expect(reg.peek("s2")).toBeNull()
  })
})

describe("ADR-0345 §G — evict", () => {
  test("evict drops entry + idempotent on unknown id", () => {
    const reg = createInMemorySessionResourceRegistry()
    reg.getOrCreate("s1")
    expect(reg.peek("s1")).not.toBeNull()
    reg.evict("s1")
    expect(reg.peek("s1")).toBeNull()
    expect(reg.size()).toBe(0)
    // idempotent
    reg.evict("s1")
    reg.evict("never-existed")
    expect(reg.size()).toBe(0)
  })
})

describe("ADR-0345 §H — clear", () => {
  test("clear drops every entry", () => {
    const reg = createInMemorySessionResourceRegistry()
    reg.getOrCreate("s1")
    reg.getOrCreate("s2")
    reg.getOrCreate("s3")
    expect(reg.size()).toBe(3)
    reg.clear()
    expect(reg.size()).toBe(0)
    expect(reg.peek("s1")).toBeNull()
    expect(reg.peek("s2")).toBeNull()
    expect(reg.peek("s3")).toBeNull()
  })
})

describe("ADR-0345 §I — LRU max cap", () => {
  test("maxEntries=2 + 3rd id ⇒ oldest evicted", () => {
    let t = 100
    const reg = createInMemorySessionResourceRegistry({ maxEntries: 2, now: () => t })
    reg.getOrCreate("a") // lastTouched=100
    t = 200
    reg.getOrCreate("b") // lastTouched=200
    t = 300
    reg.getOrCreate("c") // lastTouched=300 → evicts 'a' (oldest)
    expect(reg.peek("a")).toBeNull()
    expect(reg.peek("b")).not.toBeNull()
    expect(reg.peek("c")).not.toBeNull()
    expect(reg.size()).toBe(2)
  })
})

describe("ADR-0345 §J — LRU touch refreshes", () => {
  test("getOrCreate on existing id bumps it past the LRU axe", () => {
    let t = 100
    const reg = createInMemorySessionResourceRegistry({ maxEntries: 2, now: () => t })
    reg.getOrCreate("a") // lastTouched=100
    t = 200
    reg.getOrCreate("b") // lastTouched=200
    t = 300
    reg.getOrCreate("a") // lastTouched bumps to 300 — 'b' is now oldest
    t = 400
    reg.getOrCreate("c") // evicts 'b' (oldest @ 200), not 'a' (@ 300)
    expect(reg.peek("a")).not.toBeNull()
    expect(reg.peek("b")).toBeNull()
    expect(reg.peek("c")).not.toBeNull()
  })
})

describe("ADR-0345 §K — TTL sweep", () => {
  test("idleTtlMs=100 + advance ⇒ expired evicted on next access", () => {
    let t = 100
    const reg = createInMemorySessionResourceRegistry({ idleTtlMs: 100, now: () => t })
    reg.getOrCreate("a") // lastTouched=100
    // Same-tick peek still hits.
    expect(reg.peek("a")).not.toBeNull()
    // Advance 200ms (≥ idleTtlMs).
    t = 300
    // Next access triggers sweep → 'a' is gone.
    expect(reg.peek("a")).toBeNull()
    expect(reg.size()).toBe(0)
  })
})

describe("ADR-0345 §L — TTL + LRU together", () => {
  test("TTL sweep runs before LRU; expired entries cleared first", () => {
    let t = 100
    const reg = createInMemorySessionResourceRegistry({
      maxEntries: 2,
      idleTtlMs: 50,
      now: () => t,
    })
    reg.getOrCreate("a") // lastTouched=100
    t = 110
    reg.getOrCreate("b") // lastTouched=110
    // Advance past TTL for 'a' AND 'b' both (Δ ≥ 50 from each)
    t = 200
    // Adding 'c' first sweeps TTL (drops 'a' + 'b'), then inserts 'c'.
    reg.getOrCreate("c") // lastTouched=200, size becomes 1 (not 3, not LRU-evicted)
    expect(reg.peek("a")).toBeNull()
    expect(reg.peek("b")).toBeNull()
    expect(reg.peek("c")).not.toBeNull()
    expect(reg.size()).toBe(1)
  })
})

describe("ADR-0345 §M — clock seam determinism", () => {
  test("now() mock fully controls eviction timing", () => {
    let t = 0
    const reg = createInMemorySessionResourceRegistry({ idleTtlMs: 10, now: () => t })
    reg.getOrCreate("x") // lastTouched=0
    t = 5
    expect(reg.peek("x")).not.toBeNull() // 5 < 10, still alive
    t = 9
    expect(reg.peek("x")).not.toBeNull() // 9 < 10, still alive (boundary exclusive)
    t = 10
    expect(reg.peek("x")).toBeNull() // 10 ≥ 10, evicted
  })
})

describe("ADR-0345 §N — peek does NOT bump lastTouched (read-only)", () => {
  test("peek between getOrCreates leaves LRU order unchanged", () => {
    let t = 100
    const reg = createInMemorySessionResourceRegistry({ maxEntries: 2, now: () => t })
    reg.getOrCreate("a") // lastTouched=100
    t = 200
    reg.getOrCreate("b") // lastTouched=200
    // Peek 'a' — if peek bumped lastTouched, 'a' would now be newest.
    t = 250
    reg.peek("a") // read-only, MUST NOT touch lastTouched
    t = 300
    reg.getOrCreate("c") // evicts 'a' (still oldest @ 100), not 'b' (@ 200)
    expect(reg.peek("a")).toBeNull()
    expect(reg.peek("b")).not.toBeNull()
    expect(reg.peek("c")).not.toBeNull()
  })
})
