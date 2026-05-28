/**
 * ADR-0422 — LSP `SymbolLookupLspPort` adapter hellgate.
 *
 *   A. empty / hostile name ⇒ null                         (2)
 *   B. no anchor file ⇒ null (no server to open)           (1)
 *   C. open ⇒ null (server unavailable) ⇒ null             (1)
 *   D. hit ⇒ projected SymbolHit[] (line +1, container)    (2)
 *   E. miss (null / [] payload) ⇒ null                     (2)
 *   F. throw (open throws / workspaceSymbol throws) ⇒ null (2)
 *   G. session ALWAYS stopped (finally) — hit + throw       (2)
 *   H. maxHits cap                                          (1)
 *
 * Total = 13 cases. A fake LspNavProvider / session is used; no real
 * language server is spawned.
 */

import { describe, expect, test } from "bun:test"
import type { LspNavProvider, LspNavSession, NavSymbolInfo, NavSymbolKind } from "@/tool"
import { createLspSymbolLookup } from "../symbol-lookup-lsp"

const sym = (
  name: string,
  line0: number,
  opts: { uri?: string; kind?: NavSymbolKind; container?: string } = {},
): NavSymbolInfo => ({
  name,
  kind: opts.kind ?? "function",
  range: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
  selectionRange: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
  ...(opts.uri !== undefined ? { uri: opts.uri } : {}),
  ...(opts.container !== undefined ? { containerName: opts.container } : {}),
})

interface FakeSession extends LspNavSession {
  stopped: () => number
}

const fakeSession = (
  workspaceSymbol: (q: string) => Promise<NavSymbolInfo[] | null>,
): FakeSession => {
  let stops = 0
  const notImpl = async (): Promise<never> => {
    throw new Error("not used in this test")
  }
  return {
    definition: notImpl,
    references: notImpl,
    hover: notImpl,
    typeDefinition: notImpl,
    implementation: notImpl,
    documentSymbol: notImpl,
    workspaceSymbol: (q) => workspaceSymbol(q),
    prepareRename: notImpl,
    stop: async () => {
      stops += 1
    },
    stopped: () => stops,
  }
}

const provider = (
  open: (file: string, cwd: string) => Promise<LspNavSession | null>,
): LspNavProvider => ({
  unavailableReason: () => "n/a",
  open: (file, cwd) => open(file, cwd),
})

describe("createLspSymbolLookup — ADR-0422 hellgate", () => {
  // -------- A. empty / hostile name ----------------------------------
  test("A1 — empty name ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => fakeSession(async () => [sym("X", 0)])),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("")).toBeNull()
  })

  test("A2 — non-string name (hostile cast) ⇒ null, no throw", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => fakeSession(async () => [sym("X", 0)])),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast
    expect(await port.findSymbol(123 as any)).toBeNull()
  })

  // -------- B. no anchor file ----------------------------------------
  test("B1 — no anchorFile ⇒ null (provider never opened)", async () => {
    let opened = 0
    const port = createLspSymbolLookup({
      provider: provider(async () => {
        opened += 1
        return fakeSession(async () => [sym("X", 0)])
      }),
      cwd: "/repo",
    })
    expect(await port.findSymbol("X")).toBeNull()
    expect(opened).toBe(0)
  })

  // -------- C. server unavailable ------------------------------------
  test("C1 — open ⇒ null (server unavailable) ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => null),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("X")).toBeNull()
  })

  // -------- D. hit ----------------------------------------------------
  test("D1 — hit ⇒ SymbolHit with 1-indexed line + uri path", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () =>
        fakeSession(async () => [sym("Foo", 11, { uri: "src/x.ts" })]),
      ),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    const hits = await port.findSymbol("Foo")
    expect(hits).not.toBeNull()
    expect(hits?.[0]?.path).toBe("src/x.ts")
    expect(hits?.[0]?.line).toBe(12) // 0-indexed 11 ⇒ 1-indexed 12
    expect(hits?.[0]?.snippet).toContain("Foo")
  })

  test("D2 — containerName folded into snippet", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () =>
        fakeSession(async () => [sym("bar", 4, { uri: "x.ts", kind: "method", container: "Foo" })]),
      ),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    const hits = await port.findSymbol("bar")
    expect(hits?.[0]?.snippet).toContain("Foo.bar")
    expect(hits?.[0]?.snippet).toContain("method")
  })

  // -------- E. miss ---------------------------------------------------
  test("E1 — workspaceSymbol ⇒ null ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => fakeSession(async () => null)),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("X")).toBeNull()
  })

  test("E2 — workspaceSymbol ⇒ [] ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => fakeSession(async () => [])),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("X")).toBeNull()
  })

  // -------- F. throw --------------------------------------------------
  test("F1 — open throws ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () => {
        throw new Error("boom")
      }),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("X")).toBeNull()
  })

  test("F2 — workspaceSymbol throws ⇒ null", async () => {
    const port = createLspSymbolLookup({
      provider: provider(async () =>
        fakeSession(async () => {
          throw new Error("server error")
        }),
      ),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    expect(await port.findSymbol("X")).toBeNull()
  })

  // -------- G. session always stopped --------------------------------
  test("G1 — session stopped after a hit", async () => {
    const session = fakeSession(async () => [sym("X", 0, { uri: "x.ts" })])
    const port = createLspSymbolLookup({
      provider: provider(async () => session),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    await port.findSymbol("X")
    expect(session.stopped()).toBe(1)
  })

  test("G2 — session stopped even when workspaceSymbol throws", async () => {
    const session = fakeSession(async () => {
      throw new Error("server error")
    })
    const port = createLspSymbolLookup({
      provider: provider(async () => session),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
    })
    await port.findSymbol("X")
    expect(session.stopped()).toBe(1)
  })

  // -------- H. maxHits cap -------------------------------------------
  test("H1 — maxHits caps the projected list", async () => {
    const many = Array.from({ length: 50 }, (_, i) => sym(`S${i}`, i, { uri: `f${i}.ts` }))
    const port = createLspSymbolLookup({
      provider: provider(async () => fakeSession(async () => many)),
      cwd: "/repo",
      anchorFile: "/repo/a.ts",
      maxHits: 3,
    })
    const hits = await port.findSymbol("S")
    expect(hits?.length).toBe(3)
  })
})
