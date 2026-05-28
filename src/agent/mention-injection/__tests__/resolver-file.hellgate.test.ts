/**
 * ADR-0413 — Resolver `file` kind dispatch hellgate (additive to ADR-0325).
 *
 *   A. file mention routes to resolveFile ONLY        (1)
 *   B. resolveFile null ⇒ skipped                     (1)
 *   C. resolveFile hit ⇒ fragment with kind=file      (1)
 *   D. resolveFile throws ⇒ swallowed (NO-THROW)      (1)
 *   E. file mention NEVER falls through to skill/etc  (1)
 *
 * Total = 5 cases. The existing resolver.hellgate.test.ts proves the
 * 3-kind dispatch is byte-identical (no edit there).
 */

import { describe, expect, mock, test } from "bun:test"
import { buildInjectionFragments, type MentionResolverPort } from "../resolver"
import type { ParsedMention } from "../types"

const span = (start: number, end: number) => ({ start, end })

const FILE_M: ParsedMention = {
  kind: "file",
  target: "src/x.ts",
  span: span(0, 13),
  raw: "@src/x.ts",
}

const base = (overrides: Partial<MentionResolverPort> = {}): MentionResolverPort => ({
  resolveSkill: () => null,
  resolvePlugin: () => null,
  resolveApp: () => null,
  resolveFile: () => null,
  ...overrides,
})

describe("buildInjectionFragments file kind — ADR-0413 hellgate", () => {
  test("A1 — file mention routes ONLY to resolveFile", () => {
    const resolveSkill = mock(() => ({ bodyText: "S-wrong" }))
    const resolvePlugin = mock(() => ({ bodyText: "P-wrong" }))
    const resolveApp = mock(() => ({ bodyText: "A-wrong" }))
    const resolveFile = mock(() => ({ bodyText: "FILE-body" }))
    const out = buildInjectionFragments([FILE_M], {
      resolveSkill,
      resolvePlugin,
      resolveApp,
      resolveFile,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.bodyText).toBe("FILE-body")
    expect(resolveFile).toHaveBeenCalledTimes(1)
    expect(resolveSkill).not.toHaveBeenCalled()
    expect(resolvePlugin).not.toHaveBeenCalled()
    expect(resolveApp).not.toHaveBeenCalled()
  })

  test("B1 — resolveFile returns null ⇒ fragment skipped", () => {
    expect(buildInjectionFragments([FILE_M], base({ resolveFile: () => null }))).toEqual([])
  })

  test("C1 — resolveFile hit ⇒ fragment carries origin span", () => {
    const out = buildInjectionFragments([FILE_M], base({ resolveFile: () => ({ bodyText: "B" }) }))
    expect(out).toHaveLength(1)
    expect(out[0]?.originSpan).toEqual(FILE_M.span)
    expect(out[0]?.target).toBe("src/x.ts")
  })

  test("D1 — resolveFile throws ⇒ swallowed, no escape", () => {
    const out = buildInjectionFragments(
      [FILE_M],
      base({
        resolveFile: () => {
          throw new Error("hostile fs")
        },
      }),
    )
    expect(out).toEqual([])
  })

  test("E1 — file mention with resolveFile absent ⇒ silently skipped (partial port)", () => {
    const partial = {
      resolveSkill: () => ({ bodyText: "S" }),
      resolvePlugin: () => null,
      resolveApp: () => null,
      // resolveFile missing entirely
      // biome-ignore lint/suspicious/noExplicitAny: deliberate partial-port hostile shape
    } as any as MentionResolverPort
    expect(buildInjectionFragments([FILE_M], partial)).toEqual([])
  })
})
