/**
 * ADR-0336 — `createInMemoryPluginRegistry` hellgate.
 *
 *   A. Empty registry behaviour                  (2)
 *   B. Lookup hit / miss                         (1)
 *   C. Lookup boundary (empty / whitespace id)   (1)
 *   D. Duplicate id ⇒ last-write-wins            (1)
 *   E. Snapshot isolation (mutate caller array)  (1)
 *
 * Total = 6 cases (>= the required 4).
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryPluginRegistry, emptyPluginRegistry } from "../in-memory-registry"
import type { PluginManifest } from "../types"

const mk = (id: string, name = id): PluginManifest => ({
  id,
  name,
  capabilities: [],
})

describe("createInMemoryPluginRegistry — ADR-0336 hellgate", () => {
  // -------- A. empty registry -------------------------------------

  test("A1 — emptyPluginRegistry.lookup returns null for any id", () => {
    expect(emptyPluginRegistry.lookup("anything")).toBeNull()
  })

  test("A2 — emptyPluginRegistry.list returns []", () => {
    expect(emptyPluginRegistry.list()).toEqual([])
  })

  // -------- B. lookup hit / miss ----------------------------------

  test("B1 — lookup returns manifest for known id, null for unknown", () => {
    const reg = createInMemoryPluginRegistry([mk("a"), mk("b")])
    expect(reg.lookup("a")?.id).toBe("a")
    expect(reg.lookup("missing")).toBeNull()
  })

  // -------- C. lookup boundary -----------------------------------

  test("C1 — empty / whitespace id ⇒ null", () => {
    const reg = createInMemoryPluginRegistry([mk("a")])
    expect(reg.lookup("")).toBeNull()
    expect(reg.lookup("   ")).toBeNull()
  })

  // -------- D. duplicate id ---------------------------------------

  test("D1 — duplicate id: last-write-wins", () => {
    const reg = createInMemoryPluginRegistry([
      { id: "x", name: "first", capabilities: [] },
      { id: "x", name: "second", capabilities: [] },
    ])
    expect(reg.lookup("x")?.name).toBe("second")
    expect(reg.list()).toHaveLength(1)
  })

  // -------- E. snapshot isolation --------------------------------

  test("E1 — mutating caller's array post-construction does not leak", () => {
    const arr: PluginManifest[] = [mk("a")]
    const reg = createInMemoryPluginRegistry(arr)
    arr.push(mk("b"))
    expect(reg.lookup("b")).toBeNull()
    expect(reg.list()).toHaveLength(1)
  })
})
