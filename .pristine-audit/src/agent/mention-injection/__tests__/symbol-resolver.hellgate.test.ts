/**
 * ADR-0418 — `@symbol` resolver hellgate.
 *
 *   A. empty / hostile target ⇒ null               (2)
 *   B. lsp priority (hit / miss / unavailable)      (3)
 *   C. semantic priority                            (2)
 *   D. auto: LSP hit short-circuits semantic        (1)
 *   E. auto: LSP miss/throw ⇒ semantic fallback     (3)
 *   F. timeout per-strategy ⇒ null / fallback       (2)
 *   G. NO-THROW (sync throw, reject, non-array)      (3)
 *   H. body render + maxHits cap                     (2)
 *
 * Total = 18 cases (>= the required 15). Both lookup ports are stubs;
 * no real LSP / search-index is spun up.
 */

import { describe, expect, mock, test } from "bun:test"
import {
  createSymbolResolver,
  type SymbolHit,
  type SymbolLookupLspPort,
  type SymbolLookupSemanticPort,
} from "../symbol-resolver"

const hit = (path: string, line: number, snippet?: string): SymbolHit =>
  snippet === undefined ? { path, line } : { path, line, snippet }

const lspPort = (
  fn: (name: string) => Promise<readonly SymbolHit[] | null>,
): SymbolLookupLspPort => ({ findSymbol: fn })
const semPort = (
  fn: (name: string) => Promise<readonly SymbolHit[] | null>,
): SymbolLookupSemanticPort => ({ findSymbol: fn })

describe("createSymbolResolver — ADR-0418 hellgate", () => {
  // -------- A. empty / hostile target -------------------------------

  test("A1 — empty target ⇒ null", async () => {
    const r = createSymbolResolver({ lsp: lspPort(async () => [hit("a.ts", 1)]) })
    expect(await r("")).toBeNull()
  })

  test("A2 — non-string target (hostile cast) ⇒ null, no throw", async () => {
    const r = createSymbolResolver({ lsp: lspPort(async () => [hit("a.ts", 1)]) })
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast
    expect(await r(null as any)).toBeNull()
  })

  // -------- B. lsp priority ------------------------------------------

  test("B1 — priority=lsp hit ⇒ body from lsp", async () => {
    const r = createSymbolResolver({
      priority: "lsp",
      lsp: lspPort(async () => [hit("src/x.ts", 12, "export const Foo = 1")]),
    })
    const res = await r("Foo")
    expect(res).not.toBeNull()
    expect(res?.bodyText).toContain("symbol: Foo")
    expect(res?.bodyText).toContain("src/x.ts:12")
    expect(res?.bodyText).toContain("export const Foo = 1")
  })

  test("B2 — priority=lsp miss (empty) ⇒ null (no semantic fallback)", async () => {
    const semantic = mock(async () => [hit("nope.ts", 1)])
    const r = createSymbolResolver({
      priority: "lsp",
      lsp: lspPort(async () => []),
      semantic: semPort(semantic),
    })
    expect(await r("Foo")).toBeNull()
    expect(semantic).not.toHaveBeenCalled()
  })

  test("B3 — priority=lsp with no lsp port ⇒ null", async () => {
    const r = createSymbolResolver({ priority: "lsp" })
    expect(await r("Foo")).toBeNull()
  })

  // -------- C. semantic priority -------------------------------------

  test("C1 — priority=semantic hit ⇒ body from semantic (lsp untouched)", async () => {
    const lsp = mock(async () => [hit("wrong.ts", 1)])
    const r = createSymbolResolver({
      priority: "semantic",
      lsp: lspPort(lsp),
      semantic: semPort(async () => [hit("sem.ts", 3)]),
    })
    const res = await r("Foo")
    expect(res?.bodyText).toContain("sem.ts:3")
    expect(lsp).not.toHaveBeenCalled()
  })

  test("C2 — priority=semantic with no semantic port ⇒ null", async () => {
    const r = createSymbolResolver({
      priority: "semantic",
      lsp: lspPort(async () => [hit("x.ts", 1)]),
    })
    expect(await r("Foo")).toBeNull()
  })

  // -------- D. auto: LSP hit short-circuits --------------------------

  test("D1 — auto: LSP hit ⇒ semantic NOT consulted", async () => {
    const semantic = mock(async () => [hit("sem.ts", 9)])
    const r = createSymbolResolver({
      lsp: lspPort(async () => [hit("lsp.ts", 7)]),
      semantic: semPort(semantic),
    })
    const res = await r("Foo")
    expect(res?.bodyText).toContain("lsp.ts:7")
    expect(semantic).not.toHaveBeenCalled()
  })

  // -------- E. auto: LSP miss/throw ⇒ semantic fallback --------------

  test("E1 — auto: LSP empty ⇒ semantic fallback used", async () => {
    const r = createSymbolResolver({
      lsp: lspPort(async () => []),
      semantic: semPort(async () => [hit("sem.ts", 4)]),
    })
    expect((await r("Foo"))?.bodyText).toContain("sem.ts:4")
  })

  test("E2 — auto: LSP returns null ⇒ semantic fallback used", async () => {
    const r = createSymbolResolver({
      lsp: lspPort(async () => null),
      semantic: semPort(async () => [hit("sem.ts", 5)]),
    })
    expect((await r("Foo"))?.bodyText).toContain("sem.ts:5")
  })

  test("E3 — auto: LSP throws ⇒ semantic fallback used", async () => {
    const r = createSymbolResolver({
      lsp: lspPort(async () => {
        throw new Error("lsp crash")
      }),
      semantic: semPort(async () => [hit("sem.ts", 6)]),
    })
    expect((await r("Foo"))?.bodyText).toContain("sem.ts:6")
  })

  // -------- F. timeout -----------------------------------------------

  test("F1 — LSP hangs past timeout ⇒ auto falls back to semantic", async () => {
    const r = createSymbolResolver({
      timeoutMs: 20,
      lsp: lspPort(() => new Promise(() => {})), // never resolves
      semantic: semPort(async () => [hit("sem.ts", 8)]),
    })
    expect((await r("Foo"))?.bodyText).toContain("sem.ts:8")
  })

  test("F2 — both hang past timeout ⇒ null", async () => {
    const r = createSymbolResolver({
      timeoutMs: 20,
      lsp: lspPort(() => new Promise(() => {})),
      semantic: semPort(() => new Promise(() => {})),
    })
    expect(await r("Foo")).toBeNull()
  })

  // -------- G. NO-THROW ----------------------------------------------

  test("G1 — port throws synchronously (not a rejected promise) ⇒ null", async () => {
    const r = createSymbolResolver({
      priority: "lsp",
      lsp: {
        findSymbol() {
          throw new Error("sync throw before promise")
        },
      },
    })
    expect(await r("Foo")).toBeNull()
  })

  test("G2 — port rejects ⇒ null", async () => {
    const r = createSymbolResolver({
      priority: "lsp",
      lsp: lspPort(() => Promise.reject(new Error("rejected"))),
    })
    expect(await r("Foo")).toBeNull()
  })

  test("G3 — port returns non-array (hostile shape) ⇒ null", async () => {
    const r = createSymbolResolver({
      priority: "lsp",
      // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile non-array
      lsp: lspPort(async () => ({ not: "an array" }) as any),
    })
    expect(await r("Foo")).toBeNull()
  })

  // -------- H. body render + maxHits cap -----------------------------

  test("H1 — maxHits caps embedded hits with a `…and N more` line", async () => {
    const hits = Array.from({ length: 7 }, (_, i) => hit(`f${i}.ts`, i + 1))
    const r = createSymbolResolver({ priority: "lsp", maxHits: 3, lsp: lspPort(async () => hits) })
    const res = await r("Foo")
    expect(res?.bodyText).toContain("hits: 7")
    expect(res?.bodyText).toContain("f0.ts:1")
    expect(res?.bodyText).toContain("f2.ts:3")
    expect(res?.bodyText).not.toContain("f3.ts:4")
    expect(res?.bodyText).toContain("…and 4 more")
  })

  test("H2 — hit without snippet renders path:line only (no trailing newline body)", async () => {
    const r = createSymbolResolver({ priority: "lsp", lsp: lspPort(async () => [hit("a.ts", 2)]) })
    const res = await r("Foo")
    expect(res?.bodyText).toContain("a.ts:2")
    expect(res?.bodyText.endsWith("a.ts:2")).toBe(true)
  })
})
