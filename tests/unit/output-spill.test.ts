import { describe, expect, test } from "bun:test"
import {
  capToolOutput,
  DEFAULT_TOOL_OUTPUT_MAX,
  envMaxChars,
  HEAD_CHARS,
  resolveMaxChars,
  TAIL_CHARS,
} from "../../src/tool/output-spill"

function collectingWrite() {
  const calls: Array<{ path: string; data: string }> = []
  return {
    calls,
    write: (path: string, data: string) => {
      calls.push({ path, data })
    },
  }
}

describe("resolveMaxChars / envMaxChars", () => {
  test("0, unset, negative, NaN fall back to default", () => {
    expect(resolveMaxChars(0)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(undefined)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(-5)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(Number.NaN)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
  })

  test("positive value is honored (floored)", () => {
    expect(resolveMaxChars(1234)).toBe(1234)
    expect(resolveMaxChars(50.9)).toBe(50)
  })

  test("env override: valid positive used, else default", () => {
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "500" })).toBe(500)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "0" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "abc" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({})).toBe(DEFAULT_TOOL_OUTPUT_MAX)
  })
})

describe("capToolOutput — under cap", () => {
  test("output at/under cap is returned byte-identical, no write", () => {
    const { write, calls } = collectingWrite()
    const small = "hello world"
    const r = capToolOutput(small, { maxChars: 100, spillDir: "/tmp/x", write })
    expect(r.output).toBe(small)
    expect(r.spillPath).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test("exactly at cap boundary is untouched", () => {
    const { write, calls } = collectingWrite()
    const exact = "a".repeat(50)
    const r = capToolOutput(exact, { maxChars: 50, spillDir: "/tmp/x", write })
    expect(r.output).toBe(exact)
    expect(calls).toHaveLength(0)
  })
})

describe("capToolOutput — over cap", () => {
  test("persists full content and returns excerpt + marker", () => {
    const { write, calls } = collectingWrite()
    const big = `${"A".repeat(20_000)}MIDDLE${"Z".repeat(20_000)}`
    const r = capToolOutput(big, { maxChars: 100, spillDir: "/tmp/spill", write })

    // full content written exactly once, untruncated
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toBe(big)
    expect(calls[0]?.path).toBe(r.spillPath)
    expect(r.spillPath).toMatch(/^\/tmp\/spill\/[0-9a-f-]{36}\.txt$/)

    // marker faithfully echoes CC's <persisted-output> wrapper
    expect(r.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(r.output.endsWith("</persisted-output>")).toBe(true)
    // includes spill path, original char count, and how-to-read
    expect(r.output).toContain(r.spillPath as string)
    expect(r.output).toContain(`${big.length} chars`)
    expect(r.output.toLowerCase()).toContain("read")

    // marker is far smaller than original
    expect(r.output.length).toBeLessThan(big.length)
  })

  test("head/tail boundaries: keeps first HEAD_CHARS and last TAIL_CHARS", () => {
    const { write } = collectingWrite()
    const head = "H".repeat(HEAD_CHARS)
    const mid = "M".repeat(5_000)
    const tail = "T".repeat(TAIL_CHARS)
    const big = head + mid + tail
    const r = capToolOutput(big, { maxChars: 10, spillDir: "/tmp/s", write })

    expect(r.output).toContain(head)
    expect(r.output).toContain(tail)
    // the omitted middle should not appear in full
    expect(r.output).not.toContain(mid)
    expect(r.output).toContain(`${mid.length} chars omitted`)
  })

  test("no head/tail overlap when over cap but shorter than HEAD+TAIL", () => {
    const { write } = collectingWrite()
    // length 100, cap 10 → over cap, but < HEAD_CHARS+TAIL_CHARS
    const big = "x".repeat(60) + "y".repeat(40)
    const r = capToolOutput(big, { maxChars: 10, spillDir: "/tmp/s", write })
    expect(r.spillPath).toBeDefined()
    // 0 chars omitted: head covers whole string, tail empty
    expect(r.output).toContain("0 chars omitted")
    expect(r.output).toContain(big)
  })

  test("env override drives the cap end-to-end", () => {
    const { write, calls } = collectingWrite()
    const out = "q".repeat(1000)
    const max = envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "500" })
    const r = capToolOutput(out, { maxChars: max, spillDir: "/tmp/s", write })
    expect(calls).toHaveLength(1)
    expect(r.output).toContain("500-char")
  })
})
