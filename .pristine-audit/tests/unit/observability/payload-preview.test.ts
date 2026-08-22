/**
 * jun-27 payload-preview — bounded span-attribute previews for the live trace UI.
 *
 * `previewPayload` turns an arbitrary tool/LLM payload into a short single-line
 * string attached to a span so an operator can click `handle_tool_call` /
 * `run_sampling_request` and see WHAT was sent. Pins: string passthrough,
 * object serialization, whitespace collapse, truncation with a drop-count
 * suffix, and the never-throw contract (a cyclic value must not crash the loop).
 */
import { describe, expect, test } from "bun:test"
import { PREVIEW_MAX, previewPayload } from "@/observability"

describe("previewPayload", () => {
  test("a short string passes through verbatim", () => {
    expect(previewPayload("ls -la")).toBe("ls -la")
  })

  test("an object is JSON-serialized", () => {
    expect(previewPayload({ command: "pytest", cwd: "/repo" })).toBe(
      '{"command":"pytest","cwd":"/repo"}',
    )
  })

  test("multi-line / multi-space content collapses to a single tidy line", () => {
    expect(previewPayload("line1\n  line2\t\tline3")).toBe("line1 line2 line3")
  })

  test("over-cap input truncates with a +N drop-count suffix", () => {
    const long = "x".repeat(PREVIEW_MAX + 50)
    const out = previewPayload(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.startsWith("x".repeat(PREVIEW_MAX))).toBe(true)
    expect(out).toContain("… (+50)")
  })

  test("a custom max bounds the output", () => {
    expect(previewPayload("abcdefghij", 4)).toBe("abcd… (+6)")
  })

  test("null / undefined collapse to empty string", () => {
    expect(previewPayload(undefined)).toBe("")
    expect(previewPayload(null)).toBe("")
  })

  test("NEVER throws on a cyclic value (observability must not crash the loop)", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => previewPayload(cyclic)).not.toThrow()
    // falls back to String(v) — a non-empty, bounded string
    expect(typeof previewPayload(cyclic)).toBe("string")
  })
})
