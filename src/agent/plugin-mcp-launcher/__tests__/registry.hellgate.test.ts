/**
 * ADR-0338 — `createInMemoryPluginMcpRegistry` hellgate.
 *
 * Coverage:
 *   A. empty registry ⇒ handlesFor returns []                 (1)
 *   B. track + handlesFor                                     (2)
 *   C. shutdownAll clears state                               (2)
 *   D. multi-plugin isolation                                 (2)
 *   E. duplicate serverId is a no-op (idempotency)            (1)
 *   F. shutdownAll tolerates a throwing handle (NO-THROW)     (1)
 *   G. handlesFor return is a snapshot (mutation-safe)        (1)
 *   H. hasServerId tracks across plugins                      (1)
 *
 * Total ≥ 11 cases.
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryPluginMcpRegistry } from "../registry"
import type { McpServerHandle } from "../types"

const handle = (serverId: string, onShutdown?: () => void | Promise<void>): McpServerHandle => ({
  serverId,
  ready: true,
  shutdown: async () => {
    if (onShutdown !== undefined) await onShutdown()
  },
})

describe("ADR-0338 registry §A — empty state", () => {
  test("empty registry ⇒ handlesFor returns []", () => {
    const reg = createInMemoryPluginMcpRegistry()
    expect(reg.handlesFor("plugin-a")).toEqual([])
    expect(reg.hasServerId("plugin-a::s1")).toBe(false)
  })
})

describe("ADR-0338 registry §B — track + handlesFor", () => {
  test("track 1 ⇒ handlesFor lists it; hasServerId true", () => {
    const reg = createInMemoryPluginMcpRegistry()
    const h = handle("plugin-a::s1")
    reg.track("plugin-a", h)
    expect(reg.handlesFor("plugin-a")).toEqual([h])
    expect(reg.hasServerId("plugin-a::s1")).toBe(true)
  })

  test("track N ⇒ insertion-order preserved", () => {
    const reg = createInMemoryPluginMcpRegistry()
    const h1 = handle("plugin-a::s1")
    const h2 = handle("plugin-a::s2")
    const h3 = handle("plugin-a::s3")
    reg.track("plugin-a", h1)
    reg.track("plugin-a", h2)
    reg.track("plugin-a", h3)
    const got = reg.handlesFor("plugin-a")
    expect(got).toEqual([h1, h2, h3])
  })
})

describe("ADR-0338 registry §C — shutdownAll", () => {
  test("calls shutdown on every handle + clears state", async () => {
    const reg = createInMemoryPluginMcpRegistry()
    let aShut = 0
    let bShut = 0
    reg.track(
      "plugin-a",
      handle("plugin-a::s1", () => void aShut++),
    )
    reg.track(
      "plugin-b",
      handle("plugin-b::s1", () => void bShut++),
    )
    await reg.shutdownAll()
    expect(aShut).toBe(1)
    expect(bShut).toBe(1)
    expect(reg.handlesFor("plugin-a")).toEqual([])
    expect(reg.handlesFor("plugin-b")).toEqual([])
    expect(reg.hasServerId("plugin-a::s1")).toBe(false)
  })

  test("shutdownAll on empty ⇒ resolves no-op", async () => {
    const reg = createInMemoryPluginMcpRegistry()
    await reg.shutdownAll() // must not throw
    expect(reg.handlesFor("anything")).toEqual([])
  })
})

describe("ADR-0338 registry §D — multi-plugin isolation", () => {
  test("each plugin's handles are independent", () => {
    const reg = createInMemoryPluginMcpRegistry()
    const a = handle("plugin-a::s1")
    const b = handle("plugin-b::s1")
    reg.track("plugin-a", a)
    reg.track("plugin-b", b)
    expect(reg.handlesFor("plugin-a")).toEqual([a])
    expect(reg.handlesFor("plugin-b")).toEqual([b])
  })

  test("unrelated plugin lookups return []", () => {
    const reg = createInMemoryPluginMcpRegistry()
    reg.track("plugin-a", handle("plugin-a::s1"))
    expect(reg.handlesFor("plugin-z")).toEqual([])
  })
})

describe("ADR-0338 registry §E — duplicate serverId", () => {
  test("re-track with same serverId ⇒ no duplicate stored", () => {
    const reg = createInMemoryPluginMcpRegistry()
    const h1 = handle("plugin-a::s1")
    const h2 = handle("plugin-a::s1") // same id, different object
    reg.track("plugin-a", h1)
    reg.track("plugin-a", h2)
    const got = reg.handlesFor("plugin-a")
    expect(got).toHaveLength(1)
    expect(got[0]).toBe(h1) // first wins
  })
})

describe("ADR-0338 registry §F — NO-THROW shutdown", () => {
  test("a throwing handle.shutdown ⇒ others still shut down", async () => {
    const reg = createInMemoryPluginMcpRegistry()
    let goodShut = 0
    reg.track(
      "plugin-a",
      handle("plugin-a::bad", () => {
        throw new Error("boom")
      }),
    )
    reg.track(
      "plugin-a",
      handle("plugin-a::good", () => void goodShut++),
    )
    await reg.shutdownAll() // must not throw
    expect(goodShut).toBe(1)
    expect(reg.handlesFor("plugin-a")).toEqual([])
  })
})

describe("ADR-0338 registry §G — handlesFor snapshot", () => {
  test("mutating the returned array ⇒ internal state unaffected", () => {
    const reg = createInMemoryPluginMcpRegistry()
    const h = handle("plugin-a::s1")
    reg.track("plugin-a", h)
    const got = reg.handlesFor("plugin-a") as McpServerHandle[]
    // Caller-side mutation:
    got.length = 0
    // Internal state is still intact:
    expect(reg.handlesFor("plugin-a")).toEqual([h])
  })
})

describe("ADR-0338 registry §H — hasServerId cross-plugin", () => {
  test("hasServerId works regardless of which plugin owns the id", () => {
    const reg = createInMemoryPluginMcpRegistry()
    reg.track("plugin-a", handle("plugin-a::s1"))
    expect(reg.hasServerId("plugin-a::s1")).toBe(true)
    expect(reg.hasServerId("plugin-b::s1")).toBe(false)
    reg.track("plugin-b", handle("plugin-b::s1"))
    expect(reg.hasServerId("plugin-b::s1")).toBe(true)
  })
})
