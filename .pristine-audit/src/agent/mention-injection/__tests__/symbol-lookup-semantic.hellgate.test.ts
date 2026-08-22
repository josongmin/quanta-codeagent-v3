/**
 * ADR-0422 — semantic `SymbolLookupSemanticPort` adapter hellgate.
 *
 *   A. empty / hostile name ⇒ null                            (2)
 *   B. embed ⇒ empty vector ⇒ null (no query)                 (1)
 *   C. hit ⇒ projected SymbolHit[] (path + startLine + text)  (2)
 *   D. miss (null / [] query) ⇒ null                          (2)
 *   E. metadata without path ⇒ dropped; all-dropped ⇒ null    (2)
 *   F. throw (embed throws / query throws) ⇒ null             (2)
 *   G. topK forwarded to index.query                          (1)
 *
 * Total = 12 cases. Fake index + embed; no real search backend.
 */

import { describe, expect, test } from "bun:test"
import {
  createSemanticSymbolLookup,
  type SemanticQueryPort,
  type SemanticSearchHitLike,
} from "../symbol-lookup-semantic"

const hit = (id: string, text: string, meta?: Record<string, unknown>): SemanticSearchHitLike =>
  meta === undefined ? { id, text } : { id, text, metadata: meta }

const index = (
  query: (vec: readonly number[], k: number) => Promise<readonly SemanticSearchHitLike[]>,
): SemanticQueryPort => ({ query })

describe("createSemanticSymbolLookup — ADR-0422 hellgate", () => {
  // -------- A. empty / hostile ---------------------------------------
  test("A1 — empty name ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [hit("a", "x", { path: "a.ts", startLine: 1 })]),
      embed: async () => [1, 0, 0],
    })
    expect(await port.findSymbol("")).toBeNull()
  })

  test("A2 — non-string name (hostile cast) ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => []),
      embed: async () => [1],
    })
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast
    expect(await port.findSymbol({} as any)).toBeNull()
  })

  // -------- B. empty vector ------------------------------------------
  test("B1 — embed ⇒ empty vector ⇒ null (index not queried)", async () => {
    let queried = 0
    const port = createSemanticSymbolLookup({
      index: index(async () => {
        queried += 1
        return [hit("a", "x", { path: "a.ts" })]
      }),
      embed: async () => [],
    })
    expect(await port.findSymbol("Foo")).toBeNull()
    expect(queried).toBe(0)
  })

  // -------- C. hit ----------------------------------------------------
  test("C1 — hit ⇒ SymbolHit with metadata path + startLine", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [
        hit("a", "export const Foo = 1\nmore", { path: "src/foo.ts", startLine: 42 }),
      ]),
      embed: async () => [1, 2, 3],
    })
    const hits = await port.findSymbol("Foo")
    expect(hits).not.toBeNull()
    expect(hits?.[0]?.path).toBe("src/foo.ts")
    expect(hits?.[0]?.line).toBe(42)
    expect(hits?.[0]?.snippet).toBe("export const Foo = 1")
  })

  test("C2 — startLine 0/missing ⇒ defaults to line 1", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [hit("a", "x", { path: "a.ts" })]),
      embed: async () => [1],
    })
    const hits = await port.findSymbol("Foo")
    expect(hits?.[0]?.line).toBe(1)
  })

  // -------- D. miss ---------------------------------------------------
  test("D1 — query ⇒ [] ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => []),
      embed: async () => [1],
    })
    expect(await port.findSymbol("Foo")).toBeNull()
  })

  test("D2 — query ⇒ null (hostile) ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile null
      index: index(async () => null as any),
      embed: async () => [1],
    })
    expect(await port.findSymbol("Foo")).toBeNull()
  })

  // -------- E. metadata-less hits dropped ----------------------------
  test("E1 — hit without path is dropped; remaining kept", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [
        hit("a", "no path"),
        hit("b", "has path", { path: "b.ts", startLine: 3 }),
      ]),
      embed: async () => [1],
    })
    const hits = await port.findSymbol("Foo")
    expect(hits?.length).toBe(1)
    expect(hits?.[0]?.path).toBe("b.ts")
  })

  test("E2 — all hits without path ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [hit("a", "x"), hit("b", "y", { startLine: 5 })]),
      embed: async () => [1],
    })
    expect(await port.findSymbol("Foo")).toBeNull()
  })

  // -------- F. throw --------------------------------------------------
  test("F1 — embed throws ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => [hit("a", "x", { path: "a.ts" })]),
      embed: async () => {
        throw new Error("embed boom")
      },
    })
    expect(await port.findSymbol("Foo")).toBeNull()
  })

  test("F2 — query throws ⇒ null", async () => {
    const port = createSemanticSymbolLookup({
      index: index(async () => {
        throw new Error("query boom")
      }),
      embed: async () => [1],
    })
    expect(await port.findSymbol("Foo")).toBeNull()
  })

  // -------- G. topK forwarded ----------------------------------------
  test("G1 — topK forwarded to index.query", async () => {
    let seenK = -1
    const port = createSemanticSymbolLookup({
      index: index(async (_vec, k) => {
        seenK = k
        return [hit("a", "x", { path: "a.ts", startLine: 1 })]
      }),
      embed: async () => [1],
      topK: 9,
    })
    await port.findSymbol("Foo")
    expect(seenK).toBe(9)
  })
})
