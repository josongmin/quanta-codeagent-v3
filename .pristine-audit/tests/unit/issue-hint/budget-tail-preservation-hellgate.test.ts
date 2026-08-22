/**
 * Hellgate: T05A — Issue-Hint Tail Preservation (audit L3 C-11 / C-12).
 *
 * PROOF RAIL: over-budget code snippets and tracebacks whose HIGH-SIGNAL TAIL
 * (the final exception line / wrong result / final assertion) MUST survive
 * compaction. The previous head+tail compressors had a latent bug: when the
 * reserved tail alone met/exceeded the 4 KiB budget (`headBudget <= 0`), the
 * fallback returned `head + ellipsis` and SILENTLY DROPPED THE TAIL — losing
 * exactly the line that drives localization, in exactly the case where the
 * body is largest.
 *
 * Both extractors now share ONE budget collector (`budget-collector.ts`) that
 * reserves the tail FIRST and never drops it, and surfaces compaction as
 * OBSERVABLE metadata. These cases are RED against the old forked compressors
 * and GREEN against the shared collector.
 *
 * Axes:
 *   - shared collector: tail-alone-exceeds-budget keeps the tail (not head-only)
 *   - shared collector: observable overflow record populated on compaction
 *   - shared collector: no overflow → null + byte-identical body
 *   - shared collector: degenerate budget never returns head-only
 *   - code fences: pathological final line survives + overflow observable
 *   - tracebacks: pathological exception line survives + overflow observable
 *   - ellipsis precedes the surviving tail (truncation stays visible)
 *   - single shared policy: both extractors agree on the same boundary
 */
import { describe, expect, test } from "bun:test"
import {
  collectBudgeted,
  extractCodeFenceSegments,
  extractCodeFences,
  extractTracebackSegments,
  extractTracebacks,
} from "../../../src/agent/issue-hint"

const MAX = 4 * 1024
const ELLIPSIS = "\n…\n"

describe("T05A budget collector — tail preservation hellgate", () => {
  test("h01: tail-ALONE-exceeds-budget keeps the tail (the C-11/C-12 core bug)", () => {
    // A single final line bigger than the whole budget. Old code: headBudget<=0
    // → head+ellipsis only, tail GONE. New code: tail survives (front-trimmed).
    const head = "h".repeat(2000)
    const exceptionTail = `${"E".repeat(MAX + 500)}__PINPOINT_EXCEPTION__`
    const body = `${head}\n${exceptionTail}`
    const seg = collectBudgeted(body, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    // The single MOST important token — the very end of the exception line —
    // MUST survive. Old fallback dropped it entirely.
    expect(seg.text).toContain("__PINPOINT_EXCEPTION__")
    expect(seg.text.length).toBeLessThanOrEqual(MAX)
    // Tail-biased: the head must NOT be what fills the budget here.
    expect(seg.text.startsWith("h".repeat(100))).toBe(false)
    // Ellipsis precedes the surviving tail (truncation visible).
    expect(seg.text.includes("…")).toBe(true)
  })

  test("h02: overflow record is OBSERVABLE and tailLength > 0 on compaction", () => {
    const body = `${"a".repeat(MAX)}\nFINAL_LINE_MARKER`
    const seg = collectBudgeted(body, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    expect(seg.overflow).not.toBeNull()
    const ov = seg.overflow
    if (ov === null) throw new Error("overflow must be observable")
    expect(ov.originalLength).toBe(body.length)
    expect(ov.tailLength).toBeGreaterThan(0)
    expect(ov.droppedLength).toBeGreaterThan(0)
    expect(ov.headLength + ov.tailLength + ov.droppedLength).toBe(ov.originalLength)
    expect(seg.text).toContain("FINAL_LINE_MARKER")
  })

  test("h03: under-budget body → overflow null + byte-identical text", () => {
    const body = "small\nbody\nhere"
    const seg = collectBudgeted(body, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    expect(seg.overflow).toBeNull()
    expect(seg.text).toBe(body)
  })

  test("h04: degenerate budget (smaller than the ellipsis) never returns head-only", () => {
    const body = `${"h".repeat(500)}\nTAILTOKEN`
    // maxBytes smaller than the ellipsis marker — pathological budget.
    const seg = collectBudgeted(body, { maxBytes: 2, tailLines: 10, ellipsis: ELLIPSIS })
    expect(seg.text.length).toBeLessThanOrEqual(2)
    // Whatever survives must come from the TAIL, never the head.
    expect(seg.text.startsWith("h")).toBe(false)
    expect(seg.overflow).not.toBeNull()
  })

  test("h05: code fence — pathological final exception line survives compaction", () => {
    const head = "x".repeat(3000)
    const finalLine = `${"Z".repeat(MAX)}__FENCE_EXCEPTION_TAIL__`
    const body = `${head}\n${finalLine}`
    const text = `\`\`\`python\n${body}\n\`\`\``
    // String API (back-compat shape) still carries the tail.
    const strs = extractCodeFences(text)
    expect(strs.length).toBe(1)
    expect(strs[0] ?? "").toContain("__FENCE_EXCEPTION_TAIL__")
    expect((strs[0] ?? "").length).toBeLessThanOrEqual(MAX)
    // Observable variant exposes the overflow.
    const segs = extractCodeFenceSegments(text)
    expect(segs.length).toBe(1)
    expect(segs[0]?.overflow).not.toBeNull()
    expect(segs[0]?.body).toContain("__FENCE_EXCEPTION_TAIL__")
  })

  test("h06: traceback — pathological exception line survives compaction", () => {
    const frames = Array.from({ length: 50 }, (_, i) => `  File "f.py", line ${i}`).join("\n")
    const finalLine = `${"Q".repeat(MAX)}ValueError: __TB_EXCEPTION_TAIL__`
    const block = `Traceback (most recent call last):\n${frames}\n${finalLine}`
    const strs = extractTracebacks(block)
    expect(strs.length).toBe(1)
    expect(strs[0] ?? "").toContain("__TB_EXCEPTION_TAIL__")
    expect((strs[0] ?? "").length).toBeLessThanOrEqual(MAX)
    const segs = extractTracebackSegments(block)
    expect(segs.length).toBe(1)
    expect(segs[0]?.overflow).not.toBeNull()
    expect(segs[0]?.body).toContain("__TB_EXCEPTION_TAIL__")
  })

  test("h07: normal over-budget (tail fits) keeps head + ellipsis + full tail", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}-padding-xxxxxxxx`)
    lines.push("LAST_LINE_MARKER")
    const body = lines.join("\n")
    const seg = collectBudgeted(body, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    expect(seg.text.length).toBeLessThanOrEqual(MAX)
    expect(seg.text).toContain("LAST_LINE_MARKER")
    expect(seg.text.startsWith("line-0-")).toBe(true) // head present
    expect(seg.text).toContain("…")
    expect(seg.overflow).not.toBeNull()
    expect(seg.overflow?.tailLines).toBeGreaterThan(0)
  })

  test("h08: both extractors share ONE policy — identical boundary on identical body", () => {
    // The same over-budget body fed through both surfaces must compact to the
    // same bytes (modulo each extractor's own wrapping), proving a single
    // shared collector, not two forked truncators.
    const head = "p".repeat(3000)
    const tail = `${"T".repeat(MAX)}__SHARED_TAIL__`
    const raw = `${head}\n${tail}`
    const viaFence = extractCodeFences(`\`\`\`\n${raw}\n\`\`\``)[0] ?? ""
    const viaTb = extractTracebacks(`Traceback (most recent call last):\n${raw}`)[0] ?? ""
    // Both surface the same load-bearing tail token.
    expect(viaFence).toContain("__SHARED_TAIL__")
    expect(viaTb).toContain("__SHARED_TAIL__")
    // Direct collector call on the same body yields the same compacted text the
    // fence path produced (fence body == raw here; tb prepends a header line).
    const direct = collectBudgeted(raw, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    expect(viaFence).toBe(direct.text)
  })

  test("h09: tail never head-only — assert NO head prefix when tail saturates budget", () => {
    // Regression lock on the exact failure mode: head must be absent, ellipsis
    // leads, tail follows.
    const head = "H".repeat(1000)
    const tail = "Y".repeat(MAX - 1) // tail alone < MAX but tail+ellipsis > MAX
    const body = `${head}\n${tail}`
    const seg = collectBudgeted(body, { maxBytes: MAX, tailLines: 10, ellipsis: ELLIPSIS })
    expect(seg.text.length).toBeLessThanOrEqual(MAX)
    expect(seg.text.includes("H".repeat(50))).toBe(false)
    // The tail content dominates the output.
    expect(seg.text).toContain("Y".repeat(100))
    expect(seg.overflow?.headLength).toBe(0)
  })
})
