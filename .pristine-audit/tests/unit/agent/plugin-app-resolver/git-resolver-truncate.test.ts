/**
 * git-resolver body truncation (agent-subsystems finding [26]). The cap is
 * named `maxBytes`/`DEFAULT_GIT_MAX_BYTES` (~32 KiB) but a regression measured
 * and sliced UTF-16 CODE UNITS, so a CJK/emoji-heavy git body could exceed the
 * byte cap by 2–4× and a code-unit slice could split a surrogate pair. These
 * pin the byte-accurate, surrogate-safe contract.
 */
import { describe, expect, test } from "bun:test"
import { createGitResolver } from "@/agent/plugin-app-resolver/git-resolver"

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8")
const isWellFormed = (s: string): boolean =>
  typeof (s as { isWellFormed?: () => boolean }).isWellFormed === "function"
    ? (s as unknown as { isWellFormed(): boolean }).isWellFormed()
    : !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))

const resolverWith = (body: string, maxBytes: number) =>
  createGitResolver({ provider: async () => body, maxBytes })

describe("git-resolver truncate — byte-accurate, surrogate-safe", () => {
  test("truncates on the UTF-8 BYTE budget, not UTF-16 code units", async () => {
    const cap = 60
    // 56 code units (< cap) but ~140 UTF-8 bytes (>> cap): a code-unit measure
    // would NOT truncate and forward the whole over-cap body.
    const body = Array.from({ length: 14 }, () => "한가다").join("\n")
    expect(body.length).toBeLessThan(cap)
    expect(utf8(body)).toBeGreaterThan(cap)
    const out = await resolverWith(body, cap)("status")
    expect(out).not.toBeNull()
    expect(utf8(out?.bodyText ?? "")).toBeLessThanOrEqual(cap + 48) // body cap + marker
  })

  test("byte-boundary slice never splits a surrogate pair (well-formed output)", async () => {
    // ODD cap ⇒ a code-unit slice lands MID surrogate-pair (each emoji is 2
    // units), producing a lone surrogate under the old code.
    const cap = 51
    const body = "😀".repeat(60) // 2 UTF-16 units, 4 UTF-8 bytes each ⇒ 240 bytes
    const out = await resolverWith(body, cap)("diff")
    expect(out).not.toBeNull()
    expect(isWellFormed(out?.bodyText ?? "")).toBe(true)
  })
})
