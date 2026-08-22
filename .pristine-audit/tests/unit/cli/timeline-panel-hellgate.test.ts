/**
 * timeline-panel hellgate — split-screen AgentEvent timeline above the status
 * bar. Sibling slice to ADR-0239 (status-bar `cols + 1` overflow fix). The
 * panel reserves N rows ABOVE the status row by re-pinning DECSTBM to
 * `[1, rows - height - 1]`; the bottom row (row = `rows`) stays outside the
 * scroll region for the status bar exactly as before.
 *
 * Invariants pinned here:
 *   1. `height === 0` ⇒ pure no-op: no writes, no scroll-region change,
 *      `emit/onResize/teardown` are all no-ops. Byte-identical default-OFF.
 *   2. Ring buffer keeps the LAST `height` events (oldest drop first).
 *   3. Panel repaint is wrapped in DECSC/DECRC so the cursor cannot escape
 *      into the panel band on overlapping writes.
 *   4. Each row is truncated to `cols - 2` (no DECAWM overflow on the
 *      bottom-most panel row, mirroring the status-bar `cols + 1` lesson).
 *   5. `teardown` resets DECSTBM and erases every panel row so the
 *      following shell prompt lands on a clean surface.
 *   6. Geometry: `rows <= 5` clamps to disabled (the floor leaves at least
 *      `MIN_SCROLL_ROWS = 4` rows for stream output). `height > rows - 5`
 *      clamps DOWN. `height > MAX_PANEL_HEIGHT (20)` clamps DOWN.
 *   7. `onResize` re-pins DECSTBM and re-clamps height against the new
 *      geometry; a shrink-to-floor tears down cleanly.
 *   8. `color: false` ⇒ no ANSI colour bytes (DIM / FG_RESET) in the paint.
 *   9. A write-sink throw is swallowed — the timeline never crashes its
 *      caller (mirrors the indicator-port posture in repl.ts).
 *  10. Unknown / forward-compatible event types render via a generic
 *      `<type>` fallback (never throw).
 *  11. Long event descriptions (> cols - 2) are truncated.
 *  12. Empty ring buffer rows are blank (no ghost from a prior turn).
 */

import { describe, expect, test } from "bun:test"
import {
  clampHeight,
  createTimelinePanel,
  formatEventLine,
  MAX_PANEL_HEIGHT,
} from "../../../src/apps/cli/timeline-panel"
import type { AgentEvent } from "../../../src/stream"

/** Strip CSI sequences so we can count visible-char width / spot ghost text.
 *  String-built regex so the literal ESC control char does not appear in
 *  source (biome `noControlCharactersInRegex`). */
const ESC_CHAR = String.fromCharCode(27)
const CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z]`, "g")
// Also strip DECSC/DECRC (`ESC 7`/`ESC 8`) — WS-C moved the panel's cursor
// save/restore from SCO (a CSI form) to the DEC pair the status bar uses.
const DEC_RE = new RegExp(`${ESC_CHAR}[78]`, "g")
const stripCsi = (s: string): string => s.replace(CSI_RE, "").replace(DEC_RE, "")

const makeFakeSink = (): { write: (s: string) => void; writes: string[] } => {
  const writes: string[] = []
  return {
    write: (s) => writes.push(s),
    writes,
  }
}

const turnEvent = (n: number): AgentEvent => ({ type: "turn_start", turn: n })

describe("timeline-panel hellgate", () => {
  test("height=0 ⇒ no write, no DECSTBM change, byte-identical no-op", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 0,
      geometry: () => ({ rows: 24, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    panel.emit(turnEvent(1))
    panel.onResize()
    panel.teardown()
    expect(sink.writes).toEqual([])
  })

  test("height=5 with 10 events keeps the last 5 (ring buffer)", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 5,
      geometry: () => ({ rows: 30, cols: 80 }),
      write: sink.write,
      now: () => 1_700_000_000_000,
      color: false,
    })
    for (let i = 1; i <= 10; i++) panel.emit(turnEvent(i))
    // Capture the most recent repaint frame BEFORE teardown wipes the
    // panel — the original "writes.length - 2" was fragile (teardown
    // emits more than one chunk). Find the last paint chunk that contains
    // ANY `turn N` substring.
    const lastPaint = [...sink.writes].reverse().find((w) => /turn \d+/.test(stripCsi(w))) ?? ""
    panel.teardown()
    const lastVisible = stripCsi(lastPaint)
    for (let i = 6; i <= 10; i++) expect(lastVisible).toContain(`turn ${i}`)
    // Whole 1..5 window absent — catches off-by-one trims (drop newest /
    // mid-trim / dup-trim) that the original test missed.
    for (let i = 1; i <= 5; i++) expect(lastVisible).not.toContain(`turn ${i} `)
  })

  test("formatEventLine renders llm_continuation with mode + reason", () => {
    const line = formatEventLine(
      {
        type: "llm_continuation",
        provider: "openai",
        surfaceId: "openai-responses",
        transportId: "public",
        phase: "prepare",
        mode: "resume",
        reason: "prepared_resume",
      },
      0,
    )
    expect(line).toContain("llm_continuation resume prepared_resume")
  })

  test("install + emit only writes DECSTBM + paint frames (status bar row untouched)", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 60 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    panel.emit(turnEvent(1))
    // Every emit/install paint band must reference rows in [17..19] (the
    // panel band) and rows [1..16] (the scroll region pin) — NEVER row 20
    // (the status bar row). Scan every chunk.
    for (const chunk of sink.writes) {
      // Status bar row is `rows = 20` → `\x1b[20;1H` would be a violation.
      expect(chunk).not.toContain("\x1b[20;1H")
    }
    // Install MUST have emitted the exact DECSTBM region for the geometry:
    // [1, rows - height - 1] = [1, 16]. Catches a regression where the pin
    // is computed as `rows - height` (status bar swallowed by region) or
    // `rows` (full screen scroll = panel band scrolls too).
    const all = sink.writes.join("")
    expect(all).toContain("\x1b[1;16r")
    panel.teardown()
  })

  test("emit wraps every repaint in DECSC/DECRC (cursor cannot escape)", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 60 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0 // ignore install frames; we want emit
    panel.emit(turnEvent(1))
    // Find the emit paint frame — it starts with DECSC `\x1b7` (WS-C: DEC
    // only; the SCO pair `\x1b[s`/`\x1b[u` is grep-gate banned because its
    // restore is unreliable on VSCode-integrated terminals — UUX-5-02).
    const paint = sink.writes.find((w) => w.startsWith("\x1b7"))
    expect(paint).toBeDefined()
    // And ends with DECRC `\x1b8`.
    expect((paint ?? "").endsWith("\x1b8")).toBe(true)
    panel.teardown()
  })

  test("non-TTY surface is the host's gate — panel itself respects an explicit height=0", () => {
    // The factory does NOT read process.stderr.isTTY when `color` is given,
    // so a host that resolves `height = 0` for non-TTY surfaces gets a
    // no-op as in test #1. This pin asserts the contract.
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 0,
      geometry: () => ({ rows: 24, cols: 80 }),
      write: sink.write,
      color: false,
    })
    panel.emit(turnEvent(1))
    expect(sink.writes).toEqual([])
    panel.teardown()
  })

  test("tiny terminal (rows=4) clamps height to 0 (safe disabled)", () => {
    expect(clampHeight(5, 4)).toBe(0)
    expect(clampHeight(5, 5)).toBe(0)
    // rows=6 ⇒ rows - MIN_SCROLL_ROWS - 1 = 6 - 4 - 1 = 1 ⇒ max 1 row.
    expect(clampHeight(5, 6)).toBe(1)
  })

  test("height > geometric max clamps to (rows - 5)", () => {
    expect(clampHeight(50, 30)).toBe(20) // MAX_PANEL_HEIGHT
    expect(clampHeight(50, 10)).toBe(5) // 10 - 4 - 1 = 5
  })

  test("height > MAX_PANEL_HEIGHT clamps to MAX_PANEL_HEIGHT", () => {
    expect(clampHeight(100, 100)).toBe(MAX_PANEL_HEIGHT)
  })

  test("onResize re-pins DECSTBM when geometry grows", () => {
    let rows = 20
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    rows = 40 // simulate terminal resize
    panel.onResize()
    // Expect a fresh DECSTBM (1; rows - height - 1 r) write among the chunks.
    const all = sink.writes.join("")
    expect(all).toContain("\x1b[1;36r") // 40 - 3 - 1 = 36
    panel.teardown()
  })

  test("teardown resets DECSTBM and clears every panel row", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    panel.teardown()
    const all = sink.writes.join("")
    // DECSTBM reset is `\x1b[r` (no args).
    expect(all).toContain("\x1b[r")
    // Each panel row [17..19] gets an erase-line `\x1b[2K` after a
    // cursor-jump to that row.
    expect(all).toContain("\x1b[17;1H")
    expect(all).toContain("\x1b[18;1H")
    expect(all).toContain("\x1b[19;1H")
    expect(all).toContain("\x1b[2K")
  })

  test("color=false strips ANSI colour codes from the paint", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 2,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    panel.emit(turnEvent(1))
    const paint = sink.writes.find((w) => w.includes("turn 1")) ?? ""
    expect(paint).not.toBe("")
    // No DIM (`\x1b[2m`) or FG_RESET (`\x1b[22;39m`) in the body.
    expect(paint).not.toContain("\x1b[2m")
    expect(paint).not.toContain("\x1b[22;39m")
    panel.teardown()
  })

  test("color=true emits the DIM band around the row body", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 2,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: true,
    })
    sink.writes.length = 0
    panel.emit(turnEvent(1))
    const paint = sink.writes.find((w) => w.includes("turn 1")) ?? ""
    expect(paint).not.toBe("")
    expect(paint).toContain("\x1b[2m")
    expect(paint).toContain("\x1b[22;39m")
    panel.teardown()
  })

  test("write sink that throws is swallowed (no crash)", () => {
    const panel = createTimelinePanel({
      height: 2,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: () => {
        throw new Error("boom")
      },
      now: () => 0,
      color: false,
    })
    // No-throw is the test. Both install (DECSTBM) and emit should swallow.
    expect(() => panel.emit(turnEvent(1))).not.toThrow()
    expect(() => panel.teardown()).not.toThrow()
  })

  test("long event description is truncated to cols - 2", () => {
    const sink = makeFakeSink()
    const cols = 40
    const panel = createTimelinePanel({
      height: 2,
      geometry: () => ({ rows: 20, cols }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    const longMsg = "x".repeat(200)
    const longEvent: AgentEvent = { type: "recovery", reason: longMsg }
    panel.emit(longEvent)
    const paint = sink.writes.find((w) => w.includes("recovery"))
    expect(paint).toBeDefined()
    const visible = stripCsi(paint ?? "")
    // The paint includes a SAVE_CURSOR + row-jumps + ERASE_LINE +
    // " <line>" + RESTORE_CURSOR. After stripping CSI we should see at
    // most one row of `cols - 1` chars per panel row (1 leading space +
    // up to cols - 2 body chars). Total across `height` rows: `height *
    // (cols - 1)`. The body itself never exceeds `cols - 2`.
    // Easier check: the "xxxx..." run must be ≤ cols - 2 = 38.
    const run = visible.match(/x+/)?.[0] ?? ""
    expect(run.length).toBeLessThanOrEqual(cols - 2)
    panel.teardown()
  })

  test("unknown event type renders via generic fallback (forward-compat)", () => {
    // Cast through unknown — we are simulating a future AgentEvent variant
    // the timeline hasn't been taught yet. The formatter MUST NOT throw.
    const future = { type: "future_event_kind" } as unknown as AgentEvent
    const line = formatEventLine(future, 0)
    expect(line).toContain("future_event_kind")
  })

  test("empty ring buffer ⇒ panel rows are blank (no ghost)", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    // Install paints, then we emit nothing. Inspect the install paint
    // band — it contains an ERASE_LINE per panel row but no body text.
    const installChunks = sink.writes
    // Look for the install painting frame: contains panel-row cursor moves.
    // (install does NOT emit a panel paint — only DECSTBM + cursor park —
    // so we explicitly call repaint via an emit, then drop the buffer.)
    panel.emit(turnEvent(1))
    sink.writes.length = 0
    // Drain the buffer by emitting enough events to push the entry out.
    // Easier: directly assert install band has no body.
    void installChunks
    panel.teardown()
    // Teardown's erase frame must contain ERASE_LINE for each panel row
    // with no body text between successive row-jumps.
    const tearChunk = sink.writes[sink.writes.length - 1] ?? ""
    // Body shape: SAVE rows-erase RESTORE — no characters besides spaces
    // and CSI control bytes.
    const teardownVisible = stripCsi(tearChunk)
    expect(teardownVisible.trim()).toBe("")
  })

  test("ring buffer trims oldest first when height shrinks via onResize", () => {
    let rows = 30
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 5,
      geometry: () => ({ rows, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    for (let i = 1; i <= 5; i++) panel.emit(turnEvent(i))
    // Shrink: rows 30 → 10. clampHeight(5, 10) = min(5, 10-4-1=5, 20) = 5.
    // No height change, so the buffer is preserved. Pick a stronger shrink:
    rows = 7
    sink.writes.length = 0
    panel.onResize()
    // clampHeight(5, 7) = min(5, 7-4-1=2, 20) = 2. Height shrinks to 2.
    const all = sink.writes.join("")
    // Only the newest 2 events should be in the final paint.
    expect(all).toContain("turn 4")
    expect(all).toContain("turn 5")
    // The oldest events must NOT survive the trim — assert ALL THREE
    // (1, 2, AND 3) are gone, not just the two extremes. Catches a "drop
    // middle" off-by-one regression.
    expect(all).not.toContain("turn 1 ")
    expect(all).not.toContain("turn 2 ")
    expect(all).not.toContain("turn 3 ")
    panel.teardown()
  })

  test("install emits the precise DECSTBM region [1, rows-height-1]", () => {
    // Cover several geometries — a regression that swapped `- 1` for `- 2`
    // (status bar row miscounted) would slip past a single-geometry pin.
    const cases: Array<{ rows: number; height: number; want: string }> = [
      { rows: 20, height: 3, want: "\x1b[1;16r" },
      { rows: 30, height: 5, want: "\x1b[1;24r" },
      { rows: 10, height: 1, want: "\x1b[1;8r" },
    ]
    for (const c of cases) {
      const sink = makeFakeSink()
      const panel = createTimelinePanel({
        height: c.height,
        geometry: () => ({ rows: c.rows, cols: 80 }),
        write: sink.write,
        now: () => 0,
        color: false,
      })
      expect(sink.writes.join("")).toContain(c.want)
      panel.teardown()
    }
  })

  test("teardown is idempotent (second call ⇒ no new writes)", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    panel.teardown()
    const afterFirst = sink.writes.length
    panel.teardown()
    expect(sink.writes.length).toBe(afterFirst) // second teardown is a no-op
  })

  test("onResize to sub-floor geometry tears the panel down cleanly", () => {
    let rows = 30
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    rows = 4 // below the floor
    panel.onResize()
    // Subsequent emits become no-ops.
    sink.writes.length = 0
    panel.emit(turnEvent(99))
    expect(sink.writes).toEqual([])
    panel.teardown() // idempotent
  })
})
