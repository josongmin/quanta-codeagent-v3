/**
 * ADR-0336 — Plugin resolver hellgate.
 *
 *   A. Registry absent / null lookup           (2)
 *   B. Hit with description ⇒ first line       (1)
 *   C. Hit without description ⇒ fallback      (2)
 *   D. NO-THROW invariant                      (1)
 *   E. Empty / whitespace target               (1)
 *   F. CRLF tolerance                          (1)
 *
 * Total = 8 cases (>= the required 6).
 */

import { describe, expect, test } from "bun:test"
import type { PluginManifest, PluginRegistryPort } from "@/agent/plugin-discovery"
import { createPluginResolver } from "../plugin-resolver"

const stubRegistry = (lookup: (id: string) => PluginManifest | null): PluginRegistryPort => ({
  lookup,
  list: () => [],
})

describe("createPluginResolver — ADR-0336/0418 async hellgate", () => {
  // -------- A. registry absent / null -----------------------------

  test("A1 — registry omitted ⇒ null", async () => {
    const resolve = createPluginResolver()
    expect(await resolve?.("any")).toBeNull()
  })

  test("A2 — registry.lookup returns null ⇒ null", async () => {
    const resolve = createPluginResolver(stubRegistry(() => null))
    expect(await resolve?.("missing")).toBeNull()
  })

  // -------- B. hit with description ------------------------------

  test("B1 — manifest with description ⇒ bodyText = first line", async () => {
    const resolve = createPluginResolver(
      stubRegistry(() => ({
        id: "github",
        name: "GitHub",
        description: "GitHub PR + issue review\nFurther body ignored.",
        capabilities: ["Read"],
      })),
    )
    expect(await resolve?.("github")).toEqual({
      bodyText: "GitHub PR + issue review",
    })
  })

  // -------- C. hit without description ⇒ fallback ----------------

  test("C1 — no description, no capabilities ⇒ bodyText = name", async () => {
    const resolve = createPluginResolver(
      stubRegistry(() => ({ id: "p", name: "Plain", capabilities: [] })),
    )
    expect(await resolve?.("p")).toEqual({ bodyText: "Plain" })
  })

  test("C2 — no description, capabilities present ⇒ name + capability list", async () => {
    const resolve = createPluginResolver(
      stubRegistry(() => ({
        id: "p",
        name: "Plug",
        capabilities: ["Read", "Write"],
      })),
    )
    expect(await resolve?.("p")).toEqual({
      bodyText: "Plug (capabilities: Read, Write)",
    })
  })

  // -------- D. NO-THROW invariant --------------------------------

  test("D1 — registry.lookup throws ⇒ null, no escape", async () => {
    const resolve = createPluginResolver(
      stubRegistry(() => {
        throw new Error("hostile")
      }),
    )
    expect(await resolve?.("anything")).toBeNull()
  })

  // -------- E. empty / whitespace target -------------------------

  test("E1 — empty target ⇒ null (no lookup call)", async () => {
    let called = false
    const resolve = createPluginResolver(
      stubRegistry(() => {
        called = true
        return null
      }),
    )
    expect(await resolve?.("")).toBeNull()
    expect(called).toBe(false)
  })

  // -------- F. CRLF tolerance ------------------------------------

  test("F1 — CRLF description ⇒ first line strips trailing CR", async () => {
    const resolve = createPluginResolver(
      stubRegistry(() => ({
        id: "p",
        name: "P",
        description: "first line\r\nbody",
        capabilities: [],
      })),
    )
    expect(await resolve?.("p")).toEqual({ bodyText: "first line" })
  })
})
