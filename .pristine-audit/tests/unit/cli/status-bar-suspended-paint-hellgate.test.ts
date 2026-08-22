/**
 * ★ HELLGATE — WS-C follow-up (jul-10 audit R1, MED): a SUSPENDED status bar
 *   must not paint over the active region owner's bottom row.
 *
 * Pinned bug: the WS-C kernel made DECSTBM *ownership* single (the mid-turn
 * input lane suspends the status bar), but the status bar's CONTENT paints
 * bypassed the manager — `paintRow` wrote SAVE_CURSOR + jump-to-bottom-row
 * unconditionally. `transient("Press Esc again…")` (fired by the turn-cancel
 * FSM exactly while the operator types in the lane), transient-expiry reverts,
 * and the resize repaint all landed on the SAME physical bottom row the lane
 * renders its input buffer on — the exact UUX-5-04 fight, half-fixed.
 *
 * Contract under test:
 *   1. While suspended: transient / setDefault / clearTransient / resize
 *      repaints are BYTE-FREE (state still tracked).
 *   2. On resume (the suspending owner releases): the bar repaints its LIVE
 *      text via the kernel's onResume hook.
 *   3. Paired control: while active, paints behave byte-identically to before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installStatusBar } from "../../../src/apps/cli/status-bar"
import { createScrollRegionManager } from "../../../src/apps/cli/terminal-chrome"

describe("status-bar suspended-paint hellgate", () => {
  let writes: string[]
  let originalWrite: typeof process.stderr.write
  let originalCols: number | undefined
  let originalRows: number | undefined

  beforeEach(() => {
    writes = []
    originalWrite = process.stderr.write.bind(process.stderr)
    originalCols = process.stderr.columns
    originalRows = process.stderr.rows
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
      Object.defineProperty(process.stderr, "columns", { value: originalCols, configurable: true })
    }
    if (originalRows !== undefined) {
      Object.defineProperty(process.stderr, "rows", { value: originalRows, configurable: true })
    }
  })

  const install = () => {
    const manager = createScrollRegionManager()
    let resizeCb: (() => void) | undefined
    const bar = installStatusBar("default text", {
      env: {},
      stderrIsTTY: true,
      regionManager: manager,
      resize: (cb) => {
        resizeCb = cb
        return () => {
          resizeCb = undefined
        }
      },
    })
    const laneWrites: string[] = []
    const suspendWithLane = () =>
      manager.acquireRegion("input-lane", {
        establish: () => "\x1b[1;23r",
        release: () => "\x1b[r",
        write: (c) => laneWrites.push(c),
        // The lane renders the operator's input on the physical bottom row —
        // the ONLY interactive occluder of the status row.
        occupiesBottomRow: true,
      })
    return { bar, manager, suspendWithLane, fireResize: () => resizeCb?.(), laneWrites }
  }

  test("suspended: transient paints NOTHING on stderr (the lane owns the bottom row)", () => {
    const { bar, suspendWithLane } = install()
    suspendWithLane()
    const before = writes.length
    bar.transient("Press Esc again within 2s to cancel")
    expect(writes.slice(before)).toEqual([])
  })

  test("suspended: setDefault + clearTransient paint nothing", () => {
    const { bar, suspendWithLane } = install()
    suspendWithLane()
    const before = writes.length
    bar.setDefault("new default")
    bar.clearTransient()
    expect(writes.slice(before)).toEqual([])
  })

  test("suspended: the resize repaint is also byte-free", () => {
    const { bar, suspendWithLane, fireResize } = install()
    suspendWithLane()
    const before = writes.length
    fireResize()
    expect(writes.slice(before)).toEqual([])
    bar.teardown()
  })

  test("resume: releasing the lane repaints the bar's LIVE text (state tracked while suspended)", () => {
    const { bar, suspendWithLane } = install()
    const lane = suspendWithLane()
    bar.setDefault("live after suspend") // byte-free, state only
    const before = writes.length
    lane.release()
    const resumed = writes.slice(before).join("")
    expect(resumed).toContain("live after suspend")
  })

  test("paired control: while ACTIVE, transient + revert paint normally", () => {
    const { bar } = install()
    const before = writes.length
    bar.transient("hot notice")
    expect(writes.slice(before).join("")).toContain("hot notice")
    bar.clearTransient()
    expect(writes.join("")).toContain("default text")
  })

  test("suspended transient that EXPIRES while suspended never paints; resume shows the default", async () => {
    const { bar, suspendWithLane } = install()
    const lane = suspendWithLane()
    const before = writes.length
    bar.transient("ephemeral", 10)
    await new Promise((r) => setTimeout(r, 30))
    expect(writes.slice(before)).toEqual([]) // expiry repaint also gated
    lane.release()
    expect(writes.slice(before).join("")).toContain("default text")
  })

  // Adversarial self-audit v2: the first fix gated on `isActive` (ownership),
  // which would have silenced the status bar for the WHOLE session whenever
  // the timeline panel (a later, NON-bottom-row acquirer) was installed. The
  // collision is ROW-based: only a bottom-row occluder (the lane) gates a
  // bottom-row painter (the status bar).

  test("status bar suspended by the TIMELINE (non-occluding) keeps painting", () => {
    const { bar, manager } = install()
    // Timeline-like owner: later acquirer, does NOT occupy the bottom row.
    manager.acquireRegion("timeline-panel", {
      establish: () => "\x1b[1;20r",
      release: () => "\x1b[r",
      write: () => undefined,
    })
    const before = writes.length
    bar.transient("still visible under timeline")
    expect(writes.slice(before).join("")).toContain("still visible under timeline")
  })

  test("stacked status<timeline<lane: lane release frees the bar even though the TIMELINE resumes", () => {
    const { bar, manager } = install()
    manager.acquireRegion("timeline-panel", {
      establish: () => "\x1b[1;20r",
      release: () => "\x1b[r",
      write: () => undefined,
    })
    const lane = manager.acquireRegion("input-lane", {
      establish: () => "\x1b[1;23r",
      release: () => "\x1b[r",
      write: () => undefined,
      occupiesBottomRow: true,
    })
    bar.setDefault("tracked under lane") // occluded ⇒ byte-free
    const before = writes.length
    expect(writes.slice(0, before).join("")).not.toContain("tracked under lane")
    lane.release() // resumes the TIMELINE (not the bar) — freed hook must still fire
    expect(writes.slice(before).join("")).toContain("tracked under lane")
  })
})

// ── disjoint-row owner: the timeline band must NOT be gated by the lane ──────

describe("timeline keeps painting under the lane (v2 row semantics)", () => {
  test("timeline suspended by the lane KEEPS painting (band rows don't overlap the lane row)", async () => {
    const { createTimelinePanel } = await import("../../../src/apps/cli/timeline-panel")
    const { createScrollRegionManager } = await import("../../../src/apps/cli/terminal-chrome")
    const manager = createScrollRegionManager()
    const panelWrites: string[] = []
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 24, cols: 80 }),
      write: (c: string) => panelWrites.push(c),
      now: () => 0,
      color: false,
      regionManager: manager,
      resize: () => () => undefined,
    })
    manager.acquireRegion("input-lane", {
      establish: () => "\x1b[1;23r",
      release: () => "\x1b[r",
      write: () => undefined,
      occupiesBottomRow: true,
    })
    const before = panelWrites.length
    panel.emit({ type: "tool_call", name: "shell", id: "t1", input: {} } as never)
    expect(panelWrites.slice(before).join("")).toContain("shell") // live during lane
    panel.teardown()
  })
})
