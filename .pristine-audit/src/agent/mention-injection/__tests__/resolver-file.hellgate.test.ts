/**
 * ADR-0418 — Resolver `file` + `symbol` kind dispatch hellgate (async).
 *
 *   A. file mention routes to resolveFile ONLY        (1)
 *   B. resolveFile null ⇒ skipped                     (1)
 *   C. resolveFile hit ⇒ fragment with kind=file      (1)
 *   D. resolveFile throws ⇒ swallowed (NO-THROW)      (1)
 *   E. file mention NEVER falls through (partial)     (1)
 *   F. symbol mention routes to resolveSymbol ONLY    (1)
 *   G. symbol resolver reject ⇒ swallowed             (1)
 *
 * Total = 7 cases. The existing resolver.hellgate.test.ts proves the
 * 3-kind dispatch is unchanged.
 */

import { describe, expect, mock, test } from "bun:test"
import { buildInjectionFragments, type MentionResolverPort } from "../resolver"
import type { ParsedMention } from "../types"

const span = (start: number, end: number) => ({ start, end })

const FILE_M: ParsedMention = {
  kind: "file",
  target: "src/x.ts",
  span: span(0, 9),
  raw: "@src/x.ts",
}
const SYMBOL_M: ParsedMention = {
  kind: "symbol",
  target: "FooBar",
  span: span(0, 7),
  raw: "@FooBar",
}

const base = (overrides: Partial<MentionResolverPort> = {}): MentionResolverPort => ({
  resolveSkill: async () => null,
  resolvePlugin: async () => null,
  resolveApp: async () => null,
  resolveFile: async () => null,
  resolveSymbol: async () => null,
  ...overrides,
})

describe("buildInjectionFragments file/symbol kind — ADR-0418 hellgate", () => {
  test("A1 — file mention routes ONLY to resolveFile", async () => {
    const resolveSkill = mock(async () => ({ bodyText: "S-wrong" }))
    const resolvePlugin = mock(async () => ({ bodyText: "P-wrong" }))
    const resolveApp = mock(async () => ({ bodyText: "A-wrong" }))
    const resolveSymbol = mock(async () => ({ bodyText: "SYM-wrong" }))
    const resolveFile = mock(async () => ({ bodyText: "FILE-body" }))
    const out = await buildInjectionFragments([FILE_M], {
      resolveSkill,
      resolvePlugin,
      resolveApp,
      resolveFile,
      resolveSymbol,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.bodyText).toBe("FILE-body")
    expect(resolveFile).toHaveBeenCalledTimes(1)
    expect(resolveSkill).not.toHaveBeenCalled()
    expect(resolvePlugin).not.toHaveBeenCalled()
    expect(resolveApp).not.toHaveBeenCalled()
    expect(resolveSymbol).not.toHaveBeenCalled()
  })

  test("B1 — resolveFile returns null ⇒ fragment skipped", async () => {
    expect(
      await buildInjectionFragments([FILE_M], base({ resolveFile: async () => null })),
    ).toEqual([])
  })

  test("C1 — resolveFile hit ⇒ fragment carries origin span", async () => {
    const out = await buildInjectionFragments(
      [FILE_M],
      base({ resolveFile: async () => ({ bodyText: "B" }) }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.originSpan).toEqual(FILE_M.span)
    expect(out[0]?.target).toBe("src/x.ts")
  })

  test("D1 — resolveFile throws ⇒ swallowed, no escape", async () => {
    const out = await buildInjectionFragments(
      [FILE_M],
      base({
        resolveFile: async () => {
          throw new Error("hostile fs")
        },
      }),
    )
    expect(out).toEqual([])
  })

  test("E1 — file mention with resolveFile absent ⇒ silently skipped (partial port)", async () => {
    const partial = {
      resolveSkill: async () => ({ bodyText: "S" }),
      resolvePlugin: async () => null,
      resolveApp: async () => null,
      // resolveFile + resolveSymbol missing entirely
      // biome-ignore lint/suspicious/noExplicitAny: deliberate partial-port hostile shape
    } as any as MentionResolverPort
    expect(await buildInjectionFragments([FILE_M], partial)).toEqual([])
  })

  test("F1 — symbol mention routes ONLY to resolveSymbol", async () => {
    const resolveFile = mock(async () => ({ bodyText: "FILE-wrong" }))
    const resolveSymbol = mock(async () => ({ bodyText: "SYM-body" }))
    const out = await buildInjectionFragments([SYMBOL_M], base({ resolveFile, resolveSymbol }))
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.bodyText).toBe("SYM-body")
    expect(resolveSymbol).toHaveBeenCalledTimes(1)
    expect(resolveFile).not.toHaveBeenCalled()
  })

  test("G1 — resolveSymbol rejects ⇒ swallowed, no escape", async () => {
    const out = await buildInjectionFragments(
      [SYMBOL_M],
      base({ resolveSymbol: () => Promise.reject(new Error("lsp down")) }),
    )
    expect(out).toEqual([])
  })
})
