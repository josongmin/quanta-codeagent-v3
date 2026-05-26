/**
 * ADR-0311/0313 hellgate R2 — DeliveryStore cap / FIFO eviction + idempotency
 * key derivation under fuzz. R1 covered basic re-fire dedup; R2 targets:
 *   - cap = 1024 EXACT (FIFO eviction order),
 *   - 1025th add evicts oldest,
 *   - duplicate add does NOT consume a slot,
 *   - empty / whitespace ids ignored silently,
 *   - empty action string still yields a valid 16-hex key,
 *   - same (id, action) → same key (determinism, 1000 trials),
 *   - distinct (id, action) → distinct keys (1000-trial fuzz; collision
 *     probability bounded),
 *   - seed via opts.seed (validated shape),
 *   - persistPath option does not crash even when not honored by the slice.
 */

import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"

import { computeIdempotencyKey, createDeliveryStore } from "@/integrations/github"

describe("ADR-0311/0313 hellgate R2 — delivery cap + key fuzz", () => {
  test("cap=1024 exact: 1024 adds remain, 1025th evicts oldest", () => {
    const s = createDeliveryStore({ maxEntries: 1024 })
    for (let i = 0; i < 1024; i++) s.add(`d-${i}`)
    expect(s.has("d-0")).toBe(true)
    expect(s.snapshot().length).toBe(1024)

    s.add("d-1024")
    expect(s.has("d-0")).toBe(false) // FIFO evicted
    expect(s.has("d-1")).toBe(true)
    expect(s.has("d-1024")).toBe(true)
    expect(s.snapshot().length).toBe(1024)
  })

  test("duplicate add does NOT reset FIFO position (insertion order preserved)", () => {
    const s = createDeliveryStore({ maxEntries: 3 })
    s.add("a")
    s.add("b")
    s.add("c")
    // Re-add a — should be no-op, NOT move 'a' to most-recent.
    s.add("a")
    s.add("d")
    // If 'a' had been moved to most-recent, 'b' would have been evicted.
    // Since duplicates are no-ops, 'a' (oldest) was evicted.
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(true)
    expect(s.has("c")).toBe(true)
    expect(s.has("d")).toBe(true)
  })

  test("empty deliveryId is silently ignored (no slot consumed)", () => {
    const s = createDeliveryStore({ maxEntries: 2 })
    s.add("")
    s.add("a")
    s.add("b")
    s.add("c") // evicts 'a' if '' was ignored
    expect(s.snapshot()).toEqual(["b", "c"])
    expect(s.has("")).toBe(false)
  })

  test("empty action string still produces a 16-hex key", () => {
    const k = computeIdempotencyKey("d-1", "")
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })

  test("empty deliveryId still produces a 16-hex key", () => {
    const k = computeIdempotencyKey("", "act")
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })

  test("same (id, action) ⇒ same key — 1000 trials", () => {
    for (let i = 0; i < 1000; i++) {
      const id = `d-${i}`
      const act = `a-${i}`
      expect(computeIdempotencyKey(id, act)).toBe(computeIdempotencyKey(id, act))
    }
  })

  test("distinct (id, action) ⇒ no collisions in 1000-trial random fuzz", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = randomBytes(8).toString("hex")
      const act = randomBytes(4).toString("hex")
      const k = computeIdempotencyKey(id, act)
      expect(seen.has(k)).toBe(false)
      seen.add(k)
    }
    expect(seen.size).toBe(1000)
  })

  test("opts.seed populates store; non-string entries are filtered", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing tolerance
    const seed = ["a", "b", null, 5, undefined, "c"] as any
    const s = createDeliveryStore({ seed, maxEntries: 10 })
    expect(s.has("a")).toBe(true)
    expect(s.has("b")).toBe(true)
    expect(s.has("c")).toBe(true)
    expect(s.snapshot().length).toBe(3)
  })

  test("seed respects cap (truncates when seed > maxEntries)", () => {
    const seed = ["a", "b", "c", "d", "e"]
    const s = createDeliveryStore({ seed, maxEntries: 3 })
    expect(s.snapshot().length).toBe(3)
    // FIFO ⇒ first 2 evicted ⇒ keeps c, d, e.
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(false)
    expect(s.has("c")).toBe(true)
    expect(s.has("d")).toBe(true)
    expect(s.has("e")).toBe(true)
  })

  test("persistPath is documented but does not crash when set", () => {
    expect(() =>
      createDeliveryStore({ persistPath: "/tmp/nonexistent.json", maxEntries: 8 }),
    ).not.toThrow()
  })

  test("maxEntries=0 is clamped to 1 (smallest legal cap)", () => {
    const s = createDeliveryStore({ maxEntries: 0 })
    s.add("a")
    expect(s.has("a")).toBe(true)
    s.add("b") // evicts 'a' immediately
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(true)
  })

  test("whitespace-only delivery id is treated as VALID (we don't trim)", () => {
    // The store only rejects length===0; a single space is a 1-char id.
    const s = createDeliveryStore({ maxEntries: 10 })
    s.add(" ")
    s.add("a")
    expect(s.has(" ")).toBe(true)
    expect(s.has("a")).toBe(true)
    expect(s.snapshot().length).toBe(2)
  })
})
