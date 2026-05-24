/**
 * Connectors — in-memory registry unit (ADR-0160 Phase B).
 *
 * Verifies the in-memory registry is order-preserving, immutable to caller
 * mutation, and behaves as a test fake equivalent to the REST adapter surface.
 */

import { describe, expect, test } from "bun:test"
import type { Connector } from "@/connectors"
import { createInMemoryConnectorRegistry } from "@/connectors"

const c1: Connector = { id: "a", displayName: "A", host: "a.example", auth: "none" }
const c2: Connector = { id: "b", displayName: "B", host: "b.example", auth: "none" }
const c3: Connector = {
  id: "c",
  displayName: "C",
  host: "c.example",
  auth: "oauth",
  oauthIssuer: "https://c.example",
}

describe("connectors / in-memory registry", () => {
  test("UNIT-1: list preserves seed order", async () => {
    const r = createInMemoryConnectorRegistry([c1, c2, c3])
    expect(await r.list()).toEqual([c1, c2, c3])
  })

  test("UNIT-2: get returns connector by id", async () => {
    const r = createInMemoryConnectorRegistry([c1, c2])
    expect(await r.get("a")).toEqual(c1)
    expect(await r.get("b")).toEqual(c2)
  })

  test("UNIT-3: get returns undefined for missing id", async () => {
    const r = createInMemoryConnectorRegistry([c1])
    expect(await r.get("missing")).toBeUndefined()
  })

  test("UNIT-4: refresh always returns cached-fresh", async () => {
    const r = createInMemoryConnectorRegistry([c1])
    expect(await r.refresh()).toBe("cached-fresh")
    expect(await r.refresh()).toBe("cached-fresh")
  })

  test("UNIT-5: empty seed → list is empty", async () => {
    const r = createInMemoryConnectorRegistry([])
    expect(await r.list()).toEqual([])
    expect(await r.get("anything")).toBeUndefined()
  })

  test("UNIT-6: external mutation of seed array does NOT affect registry", async () => {
    const seed = [c1, c2]
    const r = createInMemoryConnectorRegistry(seed)
    seed.push(c3)
    const listed = await r.list()
    expect(listed).toEqual([c1, c2])
    expect(await r.get("c")).toBeUndefined()
  })

  test("UNIT-7: list returns frozen snapshot (deep readonly compile guard)", async () => {
    const r = createInMemoryConnectorRegistry([c1])
    const out = await r.list()
    expect(Object.isFrozen(out)).toBe(true)
  })

  test("UNIT-8: get is case-sensitive", async () => {
    const r = createInMemoryConnectorRegistry([c1])
    expect(await r.get("A")).toBeUndefined()
    expect(await r.get("a")).toEqual(c1)
  })
})
