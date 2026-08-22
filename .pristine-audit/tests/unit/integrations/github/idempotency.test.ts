/**
 * ADR-0311 / ADR-0313 — idempotency primitives.
 */

import { describe, expect, test } from "bun:test"

import { computeIdempotencyKey, createDeliveryStore } from "@/integrations/github"

describe("computeIdempotencyKey", () => {
  test("same input ⇒ same key", () => {
    const a = computeIdempotencyKey("d1", "issue_comment.created")
    const b = computeIdempotencyKey("d1", "issue_comment.created")
    expect(a).toBe(b)
  })

  test("different action ⇒ different key", () => {
    const a = computeIdempotencyKey("d1", "issue_comment.created")
    const b = computeIdempotencyKey("d1", "issue_comment.edited")
    expect(a).not.toBe(b)
  })

  test("16 hex chars", () => {
    const k = computeIdempotencyKey("delivery-id-xyz", "action")
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })

  test("non-string args treated as empty", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing tolerance
    const k = computeIdempotencyKey(undefined as any, undefined as any)
    expect(typeof k).toBe("string")
    expect(k.length).toBe(16)
  })
})

describe("createDeliveryStore", () => {
  test("add/has roundtrip", () => {
    const s = createDeliveryStore()
    expect(s.has("d1")).toBe(false)
    s.add("d1")
    expect(s.has("d1")).toBe(true)
  })

  test("cap=2 evicts oldest", () => {
    const s = createDeliveryStore({ maxEntries: 2 })
    s.add("a")
    s.add("b")
    s.add("c")
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(true)
    expect(s.has("c")).toBe(true)
  })

  test("default cap is 1024", () => {
    const s = createDeliveryStore()
    for (let i = 0; i < 1100; i++) s.add(`d-${i}`)
    expect(s.has("d-0")).toBe(false)
    expect(s.has("d-1099")).toBe(true)
  })

  test("empty / non-string ids are ignored", () => {
    const s = createDeliveryStore()
    s.add("")
    // biome-ignore lint/suspicious/noExplicitAny: testing tolerance
    s.add(undefined as any)
    expect(s.snapshot().length).toBe(0)
  })

  test("seed populates initial state", () => {
    const s = createDeliveryStore({ seed: ["s1", "s2"] })
    expect(s.has("s1")).toBe(true)
    expect(s.has("s2")).toBe(true)
  })
})
