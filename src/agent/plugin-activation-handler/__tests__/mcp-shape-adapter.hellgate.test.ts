/**
 * ADR-0340 — `adaptMcpServersToSpec` hellgate.
 *
 * Coverage (≥ 8):
 *   A. undefined input                     → []
 *   B. empty array                          → []
 *   C. non-array (object) input             → []
 *   D. single full entry                    → { name, spec: { command, args: [] } }
 *   E. multiple full entries — order kept   → 3 entries, input order
 *   F. entry missing command                → dropped
 *   G. entry with empty-string command      → dropped
 *   H. entry missing name                   → dropped
 *   I. entry with empty-string name         → dropped
 *   J. null / undefined entries skipped     → 1 entry from [null, valid, undefined]
 *   K. mix of valid + drop                  → only valid retained, order preserved
 *   L. args is always []                    → never invents positional args
 */

import { describe, expect, test } from "bun:test"
import type { PluginMcpServer } from "@/agent/plugin-discovery"
import { adaptMcpServersToSpec } from "../mcp-shape-adapter"

describe("adaptMcpServersToSpec — ADR-0340 hellgate", () => {
  test("A. undefined input ⇒ []", () => {
    expect(adaptMcpServersToSpec(undefined)).toEqual([])
  })

  test("B. empty array ⇒ []", () => {
    expect(adaptMcpServersToSpec([])).toEqual([])
  })

  test("C. non-array (object cast) ⇒ []", () => {
    // biome-ignore lint/suspicious/noExplicitAny: hostile input fuzz
    expect(adaptMcpServersToSpec({} as any)).toEqual([])
  })

  test("D. single full entry ⇒ canonical spec", () => {
    const input: readonly PluginMcpServer[] = [{ name: "fs", command: "/usr/bin/node" }]
    expect(adaptMcpServersToSpec(input)).toEqual([
      { name: "fs", spec: { command: "/usr/bin/node", args: [] } },
    ])
  })

  test("E. multiple full entries ⇒ input order preserved", () => {
    const input: readonly PluginMcpServer[] = [
      { name: "fs", command: "/a" },
      { name: "git", command: "/b" },
      { name: "shell", command: "/c" },
    ]
    const out = adaptMcpServersToSpec(input)
    expect(out.map((e) => e.name)).toEqual(["fs", "git", "shell"])
  })

  test("F. entry missing command ⇒ dropped", () => {
    const input: readonly PluginMcpServer[] = [{ name: "fs" }]
    expect(adaptMcpServersToSpec(input)).toEqual([])
  })

  test("G. entry with empty-string command ⇒ dropped", () => {
    const input: readonly PluginMcpServer[] = [{ name: "fs", command: "" }]
    expect(adaptMcpServersToSpec(input)).toEqual([])
  })

  test("H. entry with non-string command ⇒ dropped", () => {
    // biome-ignore lint/suspicious/noExplicitAny: hostile-input fuzz
    const input = [{ name: "fs", command: 42 as any }] as unknown as PluginMcpServer[]
    expect(adaptMcpServersToSpec(input)).toEqual([])
  })

  test("I. entry with empty-string name ⇒ dropped", () => {
    const input: readonly PluginMcpServer[] = [{ name: "", command: "/a" }]
    expect(adaptMcpServersToSpec(input)).toEqual([])
  })

  test("J. null / undefined entries silently skipped", () => {
    // biome-ignore lint/suspicious/noExplicitAny: hostile-input fuzz
    const input = [null, { name: "ok", command: "/x" }, undefined] as any
    const out = adaptMcpServersToSpec(input)
    expect(out).toEqual([{ name: "ok", spec: { command: "/x", args: [] } }])
  })

  test("K. mix of valid + drop ⇒ valid retained in input order", () => {
    const input: readonly PluginMcpServer[] = [
      { name: "fs", command: "/a" },
      { name: "no-cmd" },
      { name: "git", command: "/b" },
      { name: "", command: "/c" },
      { name: "shell", command: "/d" },
    ]
    expect(adaptMcpServersToSpec(input).map((e) => e.name)).toEqual(["fs", "git", "shell"])
  })

  test("L. spec.args is always [] (never invents positional args)", () => {
    const input: readonly PluginMcpServer[] = [{ name: "x", command: "/y" }]
    const out = adaptMcpServersToSpec(input)
    expect(out[0]?.spec.args).toEqual([])
  })

  test("M. fresh array per call (no aliasing into input)", () => {
    const input: readonly PluginMcpServer[] = [{ name: "x", command: "/y" }]
    const out1 = adaptMcpServersToSpec(input)
    const out2 = adaptMcpServersToSpec(input)
    expect(out1).not.toBe(out2)
  })
})
