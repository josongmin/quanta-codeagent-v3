/**
 * status-bar paint invariant — total visible width of every paint frame
 * MUST equal the terminal column count, never `cols + 1`. The +1 overflow
 * triggers DECAWM auto-wrap on the bottom row (outside the DECSTBM scroll
 * region) which scrolls the whole screen up by one line per frame — turning
 * the status row into a vertical waterfall of ghosts in the scroll region.
 * Regression seen at 80ms paint cadence with the turn indicator (each tick
 * left a stale "streaming · …" line behind in the scroll buffer).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installStatusBar } from "../../../src/apps/cli/status-bar"

/** Strip CSI sequences (`ESC [ … final-byte`) so the remaining run-length
 *  is the visible-char width the terminal would actually advance the
 *  cursor by. */
const stripCsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

describe("status-bar paintRow visible-width invariant", () => {
  let writes: string[]
  let originalWrite: typeof process.stderr.write
  let originalCols: number | undefined
  let originalRows: number | undefined

  beforeEach(() => {
    writes = []
    originalWrite = process.stderr.write.bind(process.stderr)
    originalCols = process.stderr.columns
    originalRows = process.stderr.rows
    // Pin a known geometry — the invariant must hold for any cols.
    Object.defineProperty(process.stderr, "columns", { value: 80, configurable: true })
    Object.defineProperty(process.stderr, "rows", { value: 24, configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    ;(process.stderr as any).write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    ;(process.stderr as any).write = originalWrite
    if (originalCols !== undefined) {
      Object.defineProperty(process.stderr, "columns", {
        value: originalCols,
        configurable: true,
      })
    }
    if (originalRows !== undefined) {
      Object.defineProperty(process.stderr, "rows", {
        value: originalRows,
        configurable: true,
      })
    }
  })

  test("short text padded to exactly cols visible chars (not cols + 1)", () => {
    const bar = installStatusBar("hello")
    bar.teardown()
    // initial paint is in writes[1] (writes[0] is the DECSTBM setup pair).
    const paint = writes.find((w) => w.includes("hello"))
    expect(paint).toBeDefined()
    // The paint sequence includes a cursor-move, ERASE_LINE, color-on,
    // " hello" + pad, color-off. The visible-width slice is everything
    // between the last CSI before "hello" and the next CSI after the pad.
    // Easier: strip CSI and count.
    const visible = stripCsi(paint!)
    // 80 cols — invariant says we never exceed it.
    expect(visible.length).toBeLessThanOrEqual(80)
    // And we should fully fill the row (so the dim band actually spans
    // the full width instead of leaving a trailing default-bg gap).
    expect(visible.length).toBe(80)
  })

  test("text exactly cols-wide is sliced to cols-1 (leaves room for leading space)", () => {
    const longText = "x".repeat(80)
    const bar = installStatusBar(longText)
    bar.teardown()
    const paint = writes.find((w) => w.includes("xxxx"))
    expect(paint).toBeDefined()
    const visible = stripCsi(paint!)
    expect(visible.length).toBe(80)
    // 1 leading space + 79 'x' = 80. The 80th 'x' is sliced off.
    expect(visible).toBe(` ${"x".repeat(79)}`)
  })

  test("text wider than cols is truncated, never wraps", () => {
    const longText = "y".repeat(200)
    const bar = installStatusBar(longText)
    bar.teardown()
    const paint = writes.find((w) => w.includes("yyyy"))
    expect(paint).toBeDefined()
    const visible = stripCsi(paint!)
    expect(visible.length).toBe(80)
  })
})
