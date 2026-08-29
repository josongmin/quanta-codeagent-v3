/**
 * WS-C terminal-chrome kernel hellgate (jul-10 UI/UX structural fixes).
 *
 * Root cause pinned here: CLI terminal chrome had no single owner —
 *   - UUX-5-02: timeline-panel saved the cursor with SCO `ESC[s`/`ESC[u`
 *     while status-bar used DEC `ESC7`/`ESC8` (mixed protocols corrupt the
 *     layout on VSCode-integrated + legacy emulators).
 *   - UUX-5-04: input-lane set DECSTBM on stdout while status-bar set it on
 *     stderr — two independent owners fighting over ONE terminal-global
 *     scroll region (lane exit wrote a FULL reset, unpinning the status row).
 *   - UUX-5-03 / UUX-3-09: `onResize` handlers existed but ZERO SIGWINCH
 *     listeners existed anywhere — resize never propagated; the lane row was
 *     captured once at first keystroke and went stale across a resize.
 *
 * The kernel (`src/apps/cli/terminal-chrome.ts`) owns: DEC-only cursor
 * save/restore, the scroll-region (DECSTBM) manager (exactly ONE active
 * owner; second acquire suspends the first; release resumes), and the
 * singleton SIGWINCH registry (installed once, removable, non-TTY safe).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { makeLaneRenderer } from "../../../src/apps/cli/repl/session-loop/turn-helpers"
import { installStatusBar } from "../../../src/apps/cli/status-bar"
import {
  createScrollRegionManager,
  onTerminalResize,
  resizeSubscriberCount,
} from "../../../src/apps/cli/terminal-chrome"
import { createTimelinePanel } from "../../../src/apps/cli/timeline-panel"
import type { AgentEvent } from "../../../src/stream"
import { assertScanPopulation } from "../_shared/scan-population"

const ESC_CHAR = String.fromCharCode(27)
const DEC_SAVE = `${ESC_CHAR}7`
const DEC_RESTORE = `${ESC_CHAR}8`
const SCO_SAVE = `${ESC_CHAR}[s`
const SCO_RESTORE = `${ESC_CHAR}[u`

const turnEvent = (n: number): AgentEvent => ({ type: "turn_start", turn: n })

const makeFakeSink = (): { write: (s: string) => void; writes: string[] } => {
  const writes: string[] = []
  return { write: (s) => writes.push(s), writes }
}

// ---------------------------------------------------------------------------
// A — UUX-5-02: cursor save/restore protocol parity (DEC everywhere)
// ---------------------------------------------------------------------------

describe("cursor protocol parity — timeline + status-bar both DEC (UUX-5-02)", () => {
  test("timeline panel repaint uses DEC save/restore, never SCO", () => {
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
    const paint = sink.writes.find((w) => w.includes("turn 1"))
    expect(paint).toBeDefined()
    // DEC protocol — same family as status-bar's paintRow.
    expect(paint?.startsWith(DEC_SAVE)).toBe(true)
    expect(paint?.endsWith(DEC_RESTORE)).toBe(true)
    // SCO banned — this is the exact byte pair that leaks the status-row
    // suffix onto content lines in VSCode's integrated terminal.
    expect(paint).not.toContain(SCO_SAVE)
    expect(paint).not.toContain(SCO_RESTORE)
    panel.teardown()
  })

  test("timeline teardown erase frame uses DEC save/restore, never SCO", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 2,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    sink.writes.length = 0
    panel.teardown()
    const all = sink.writes.join("")
    expect(all).toContain(DEC_SAVE)
    expect(all).toContain(DEC_RESTORE)
    expect(all).not.toContain(SCO_SAVE)
    expect(all).not.toContain(SCO_RESTORE)
  })

  test("status-bar paint uses the SAME DEC protocol (parity witness)", () => {
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    const originalRows = process.stderr.rows
    const originalCols = process.stderr.columns
    Object.defineProperty(process.stderr, "rows", { value: 24, configurable: true })
    Object.defineProperty(process.stderr, "columns", { value: 80, configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    ;(process.stderr as any).write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      const bar = installStatusBar("parity-probe", {
        env: { TERM: "xterm-256color" },
        stderrIsTTY: true,
      })
      bar.teardown()
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(process.stderr as any).write = originalWrite
      Object.defineProperty(process.stderr, "rows", { value: originalRows, configurable: true })
      Object.defineProperty(process.stderr, "columns", { value: originalCols, configurable: true })
    }
    const paint = writes.find((w) => w.includes("parity-probe"))
    expect(paint).toBeDefined()
    expect(paint).toContain(DEC_SAVE)
    expect(paint).toContain(DEC_RESTORE)
    expect(paint).not.toContain(SCO_SAVE)
    expect(paint).not.toContain(SCO_RESTORE)
  })
})

// ---------------------------------------------------------------------------
// B — grep-gate: no SCO cursor save/restore literal under src/apps/cli
// ---------------------------------------------------------------------------

describe("SCO cursor save/restore grep-gate (src/apps/cli)", () => {
  test("no SCO ESC[s / ESC[u literal outside terminal-chrome.ts", () => {
    const root = join(import.meta.dir, "../../../src/apps/cli")
    // Source-text spellings of the SCO pair: `\x1b[s`, `[u`, `\e[s`,
    // `\033[u` (escaped forms) plus the `${ESC}s` / `${ESC}u` template
    // construction (how timeline-panel.ts spelled it) and a raw ESC byte.
    const escapedSco = /\\x1b\[[su]|\\u001b\[[su]|\\e\[[su]|\\033\[[su]/i
    const templateSco = /\$\{ESC\}[su]`/
    const rawSco = new RegExp(`${ESC_CHAR}\\[[su]`)
    const offenders: string[] = []
    const entries = readdirSync(root, { recursive: true }) as string[]
    // `expect(offenders).toEqual([])` is satisfied by an empty listing, so what
    // the listing reached is asserted first.
    assertScanPopulation(
      entries.filter((r) => String(r).endsWith(".ts")).map((r) => join(root, String(r))),
      root,
      {
        id: "tests/unit/cli/terminal-chrome-hellgate.test.ts#src-apps-cli",
        collectable: (n) => n.endsWith(".ts"),
      },
    )
    for (const rel of entries) {
      const relStr = String(rel)
      if (!relStr.endsWith(".ts")) continue
      if (relStr === "terminal-chrome.ts") continue // ONLY the kernel may name the banned bytes
      const abs = join(root, relStr)
      if (!statSync(abs).isFile()) continue
      const text = readFileSync(abs, "utf8")
      if (escapedSco.test(text) || templateSco.test(text) || rawSco.test(text)) {
        offenders.push(relStr)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C — UUX-5-04: scroll-region manager (exactly ONE active DECSTBM owner)
// ---------------------------------------------------------------------------

describe("scroll-region manager — single active owner (UUX-5-04)", () => {
  test("single owner: acquire writes establish, release writes release — nothing else", () => {
    const mgr = createScrollRegionManager()
    const sink = makeFakeSink()
    const h = mgr.acquireRegion("solo", {
      establish: () => "EST_SOLO",
      release: () => "REL_SOLO",
      write: sink.write,
    })
    expect(sink.writes).toEqual(["EST_SOLO"])
    expect(mgr.activeOwner()).toBe("solo")
    h.release()
    expect(sink.writes).toEqual(["EST_SOLO", "REL_SOLO"])
    expect(mgr.activeOwner()).toBeUndefined()
  })

  test("second acquire suspends the first; release resumes it (ordering)", () => {
    const mgr = createScrollRegionManager()
    const a = makeFakeSink()
    const b = makeFakeSink()
    const ha = mgr.acquireRegion("A", {
      establish: () => "EST_A",
      release: () => "REL_A",
      write: a.write,
    })
    const hb = mgr.acquireRegion("B", {
      establish: () => "EST_B",
      release: () => "REL_B",
      write: b.write,
    })
    // Suspend is byte-free (B's DECSTBM overwrites the terminal-global
    // region); exactly one owner is active.
    expect(a.writes).toEqual(["EST_A"])
    expect(b.writes).toEqual(["EST_B"])
    expect(mgr.activeOwner()).toBe("B")
    expect(ha.isActive()).toBe(false)
    expect(hb.isActive()).toBe(true)
    // Release of the active owner: its release bytes first, THEN the
    // suspended owner's region is re-established (resume).
    hb.release()
    expect(b.writes).toEqual(["EST_B", "REL_B"])
    expect(a.writes).toEqual(["EST_A", "EST_A"])
    expect(mgr.activeOwner()).toBe("A")
    expect(ha.isActive()).toBe(true)
    ha.release()
    expect(a.writes).toEqual(["EST_A", "EST_A", "REL_A"])
    expect(mgr.activeOwner()).toBeUndefined()
  })

  test("releasing a SUSPENDED owner is byte-free and is not resumed later", () => {
    const mgr = createScrollRegionManager()
    const a = makeFakeSink()
    const b = makeFakeSink()
    const ha = mgr.acquireRegion("A", {
      establish: () => "EST_A",
      release: () => "REL_A",
      write: a.write,
    })
    const hb = mgr.acquireRegion("B", {
      establish: () => "EST_B",
      release: () => "REL_B",
      write: b.write,
    })
    ha.release() // suspended — its region is not on the terminal; no bytes
    expect(a.writes).toEqual(["EST_A"])
    expect(mgr.activeOwner()).toBe("B")
    hb.release()
    // No EST_A resume — A already released.
    expect(a.writes).toEqual(["EST_A"])
    expect(b.writes).toEqual(["EST_B", "REL_B"])
    expect(mgr.activeOwner()).toBeUndefined()
  })

  test("double release is a no-op (idempotent)", () => {
    const mgr = createScrollRegionManager()
    const a = makeFakeSink()
    const b = makeFakeSink()
    const ha = mgr.acquireRegion("A", {
      establish: () => "EST_A",
      release: () => "REL_A",
      write: a.write,
    })
    const hb = mgr.acquireRegion("B", {
      establish: () => "EST_B",
      release: () => "REL_B",
      write: b.write,
    })
    hb.release()
    hb.release() // second release must NOT re-emit REL_B nor re-resume A
    expect(b.writes).toEqual(["EST_B", "REL_B"])
    expect(a.writes).toEqual(["EST_A", "EST_A"])
    ha.release()
    ha.release()
    expect(a.writes).toEqual(["EST_A", "EST_A", "REL_A"])
  })

  test("three owners: resume order is stack (LIFO) order", () => {
    const mgr = createScrollRegionManager()
    const log: string[] = []
    const spec = (name: string) => ({
      establish: () => `EST_${name}`,
      release: () => `REL_${name}`,
      write: (chunk: string) => log.push(chunk),
    })
    const ha = mgr.acquireRegion("A", spec("A"))
    const hb = mgr.acquireRegion("B", spec("B"))
    const hc = mgr.acquireRegion("C", spec("C"))
    hc.release()
    expect(mgr.activeOwner()).toBe("B")
    hb.release()
    expect(mgr.activeOwner()).toBe("A")
    ha.release()
    expect(log).toEqual([
      "EST_A",
      "EST_B",
      "EST_C",
      "REL_C",
      "EST_B", // resume B
      "REL_B",
      "EST_A", // resume A
      "REL_A",
    ])
  })

  test("refresh re-establishes ONLY when active (suspended refresh is byte-free)", () => {
    const mgr = createScrollRegionManager()
    const a = makeFakeSink()
    const b = makeFakeSink()
    const ha = mgr.acquireRegion("A", {
      establish: () => "EST_A",
      release: () => "REL_A",
      write: a.write,
    })
    ha.refresh()
    expect(a.writes).toEqual(["EST_A", "EST_A"])
    const hb = mgr.acquireRegion("B", {
      establish: () => "EST_B",
      release: () => "REL_B",
      write: b.write,
    })
    ha.refresh() // suspended — must not clobber B's region
    expect(a.writes).toEqual(["EST_A", "EST_A"])
    hb.release()
    ha.release()
    ha.refresh() // released — no-op
    expect(a.writes).toEqual(["EST_A", "EST_A", "EST_A", "REL_A"])
  })

  test("a throwing write sink cannot corrupt manager state", () => {
    const mgr = createScrollRegionManager()
    const b = makeFakeSink()
    const ha = mgr.acquireRegion("broken", {
      establish: () => "EST_X",
      release: () => "REL_X",
      write: () => {
        throw new Error("EPIPE")
      },
    })
    expect(mgr.activeOwner()).toBe("broken")
    const hb = mgr.acquireRegion("B", {
      establish: () => "EST_B",
      release: () => "REL_B",
      write: b.write,
    })
    expect(() => hb.release()).not.toThrow() // resume of "broken" throws inside
    expect(() => ha.release()).not.toThrow()
    expect(mgr.activeOwner()).toBeUndefined()
    expect(b.writes).toEqual(["EST_B", "REL_B"])
  })
})

// ---------------------------------------------------------------------------
// D — UUX-5-03 / UUX-3-09: singleton SIGWINCH registry + panel wiring
// ---------------------------------------------------------------------------

const setTty = (stream: NodeJS.WriteStream, value: boolean | undefined): void => {
  Object.defineProperty(stream, "isTTY", { value, configurable: true })
}

describe("SIGWINCH registry — singleton, removable, non-TTY safe (UUX-5-03)", () => {
  let originalStdoutTty: boolean | undefined
  let originalStderrTty: boolean | undefined
  let baselineListeners: number

  beforeEach(() => {
    originalStdoutTty = process.stdout.isTTY
    originalStderrTty = process.stderr.isTTY
    baselineListeners = process.listenerCount("SIGWINCH")
  })

  afterEach(() => {
    setTty(process.stdout, originalStdoutTty)
    setTty(process.stderr, originalStderrTty)
  })

  test("subscribers fire on SIGWINCH; unsubscribe removes; last unsubscribe uninstalls", () => {
    setTty(process.stdout, true)
    const calls: string[] = []
    const un1 = onTerminalResize(() => calls.push("one"))
    const un2 = onTerminalResize(() => calls.push("two"))
    // ONE process-level listener regardless of subscriber count (singleton).
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners + 1)
    process.emit("SIGWINCH")
    expect(calls).toEqual(["one", "two"])
    un1()
    process.emit("SIGWINCH")
    expect(calls).toEqual(["one", "two", "two"])
    un2()
    // Leak guard: the process listener is removed with the last subscriber
    // (REPL restarts must not accumulate SIGWINCH listeners).
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners)
    expect(resizeSubscriberCount()).toBe(0)
    process.emit("SIGWINCH")
    expect(calls).toEqual(["one", "two", "two"])
  })

  test("non-TTY (stdout AND stderr): no process listener is installed", () => {
    setTty(process.stdout, undefined)
    setTty(process.stderr, undefined)
    const un = onTerminalResize(() => undefined)
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners)
    un()
    expect(resizeSubscriberCount()).toBe(0)
  })

  test("a throwing callback does not starve later subscribers", () => {
    setTty(process.stdout, true)
    const calls: string[] = []
    const un1 = onTerminalResize(() => {
      throw new Error("boom")
    })
    const un2 = onTerminalResize(() => calls.push("survivor"))
    expect(() => process.emit("SIGWINCH")).not.toThrow()
    expect(calls).toEqual(["survivor"])
    un1()
    un2()
  })

  test("the SAME callback subscribed twice = two live subscriptions (audit #1)", () => {
    setTty(process.stdout, true)
    let n = 0
    const cb = (): void => {
      n += 1
    }
    const un1 = onTerminalResize(cb)
    const un2 = onTerminalResize(cb)
    expect(resizeSubscriberCount()).toBe(2)
    un1() // must NOT kill the second subscription nor uninstall the listener
    process.emit("SIGWINCH")
    expect(n).toBe(1)
    un2()
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners)
  })

  test("unsubscribe is idempotent (double-call cannot drop a sibling)", () => {
    setTty(process.stdout, true)
    const calls: string[] = []
    const un1 = onTerminalResize(() => calls.push("one"))
    const un2 = onTerminalResize(() => calls.push("two"))
    un1()
    un1() // double unsubscribe — must not uninstall while `two` is live
    process.emit("SIGWINCH")
    expect(calls).toEqual(["two"])
    un2()
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners)
  })

  test("timeline panel: resize subscription re-pins DECSTBM and teardown unsubscribes", () => {
    let rows = 20
    let registered: (() => void) | undefined
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
      resize: (cb) => {
        registered = cb
        return () => {
          registered = undefined
        }
      },
    })
    expect(registered).toBeDefined()
    rows = 40
    sink.writes.length = 0
    registered?.()
    expect(sink.writes.join("")).toContain(`${ESC_CHAR}[1;36r`) // 40 - 3 - 1
    panel.teardown()
    expect(registered).toBeUndefined() // leak guard across REPL restarts
  })

  test("timeline panel: real SIGWINCH end-to-end via the default registry", () => {
    setTty(process.stderr, true)
    let rows = 20
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
    })
    rows = 30
    sink.writes.length = 0
    process.emit("SIGWINCH")
    expect(sink.writes.join("")).toContain(`${ESC_CHAR}[1;26r`) // 30 - 3 - 1
    panel.teardown()
    expect(process.listenerCount("SIGWINCH")).toBe(baselineListeners)
  })

  test("disabled timeline panel (height=0) never subscribes to resize", () => {
    let subscribed = 0
    const panel = createTimelinePanel({
      height: 0,
      geometry: () => ({ rows: 24, cols: 80 }),
      write: () => undefined,
      color: false,
      resize: () => {
        subscribed += 1
        return () => undefined
      },
    })
    expect(subscribed).toBe(0)
    panel.teardown()
  })

  test("status bar: resize re-establishes the region and repaints the live text", () => {
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    let rows = 24
    const originalRows = process.stderr.rows
    const originalCols = process.stderr.columns
    Object.defineProperty(process.stderr, "rows", { get: () => rows, configurable: true })
    Object.defineProperty(process.stderr, "columns", { value: 80, configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    ;(process.stderr as any).write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    let registered: (() => void) | undefined
    try {
      const bar = installStatusBar("live-text", {
        env: { TERM: "xterm-256color" },
        stderrIsTTY: true,
        resize: (cb) => {
          registered = cb
          return () => {
            registered = undefined
          }
        },
      })
      expect(registered).toBeDefined()
      rows = 32
      writes.length = 0
      registered?.()
      const all = writes.join("")
      expect(all).toContain(`${ESC_CHAR}[1;31r`) // re-pinned region for new rows
      expect(all).toContain("live-text") // repaint of the current text
      bar.teardown()
      expect(registered).toBeUndefined() // unsubscribed on teardown
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(process.stderr as any).write = originalWrite
      Object.defineProperty(process.stderr, "rows", { value: originalRows, configurable: true })
      Object.defineProperty(process.stderr, "columns", { value: originalCols, configurable: true })
    }
  })

  test("input lane: resize recomputes the lane row and repaints (UUX-3-09)", () => {
    const mgr = createScrollRegionManager()
    let registered: (() => void) | undefined
    const writes: string[] = []
    const out = {
      rows: 24 as number | undefined,
      columns: 80 as number | undefined,
      write: (chunk: string) => {
        writes.push(chunk)
        return true
      },
    }
    const lane = makeLaneRenderer(out, {
      regionManager: mgr,
      resize: (cb) => {
        registered = cb
        return () => {
          registered = undefined
        }
      },
    })
    lane.render("abc")
    expect(writes.join("")).toContain(`${ESC_CHAR}[1;23r`) // region for rows=24
    expect(writes.join("")).toContain(`${ESC_CHAR}[24;1H`) // lane row = 24
    out.rows = 30
    writes.length = 0
    registered?.()
    const all = writes.join("")
    expect(all).toContain(`${ESC_CHAR}[1;29r`) // region refreshed for rows=30
    expect(all).toContain(`${ESC_CHAR}[30;1H`) // lane re-rendered on the NEW row
    expect(all).toContain("abc") // buffer preserved across the resize
    lane.teardown()
    expect(registered).toBeUndefined() // leak guard
  })

  test("input lane exit RESUMES the suspended chrome region (the UUX-5-04 fight, fixed)", () => {
    const mgr = createScrollRegionManager()
    const barSink = makeFakeSink()
    const bar = mgr.acquireRegion("status-bar", {
      establish: () => "BAR_REGION",
      release: () => "BAR_RESET",
      write: barSink.write,
    })
    const out = {
      rows: 24 as number | undefined,
      columns: 80 as number | undefined,
      write: (_chunk: string) => true,
    }
    const lane = makeLaneRenderer(out, {
      regionManager: mgr,
      resize: () => () => undefined,
    })
    lane.render("x")
    expect(mgr.activeOwner()).toBe("input-lane")
    lane.teardown()
    // Pre-fix behavior: exitLaneMode wrote a FULL DECSTBM reset and the
    // status bar's pin stayed dead until its next reinstall. The manager
    // resumes the suspended owner instead.
    expect(barSink.writes).toEqual(["BAR_REGION", "BAR_REGION"])
    expect(mgr.activeOwner()).toBe("status-bar")
    bar.release()
  })
})

// ---------------------------------------------------------------------------
// E — byte-compat: single-owner sequences identical to the legacy chrome
// ---------------------------------------------------------------------------

describe("byte-compat — single active owner emits the legacy byte sequences", () => {
  test("status bar solo: install + teardown bytes byte-identical to legacy", () => {
    const writes: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    const originalRows = process.stderr.rows
    const originalCols = process.stderr.columns
    Object.defineProperty(process.stderr, "rows", { value: 24, configurable: true })
    Object.defineProperty(process.stderr, "columns", { value: 80, configurable: true })
    // biome-ignore lint/suspicious/noExplicitAny: test seam
    ;(process.stderr as any).write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      const bar = installStatusBar("t", {
        env: { TERM: "xterm-256color" },
        stderrIsTTY: true,
        resize: () => () => undefined,
      })
      const installBytes = writes.join("")
      // Legacy setupScrollRegion: DECSTBM [1, rows-1] + park at (rows-1, 1),
      // then the initial paint.
      expect(installBytes.startsWith(`${ESC_CHAR}[1;23r${ESC_CHAR}[23;1H`)).toBe(true)
      writes.length = 0
      bar.teardown()
      // Legacy teardown: full reset + jump + erase + jump.
      expect(writes.join("")).toBe(`${ESC_CHAR}[r${ESC_CHAR}[24;1H${ESC_CHAR}[2K${ESC_CHAR}[24;1H`)
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      ;(process.stderr as any).write = originalWrite
      Object.defineProperty(process.stderr, "rows", { value: originalRows, configurable: true })
      Object.defineProperty(process.stderr, "columns", { value: originalCols, configurable: true })
    }
  })

  test("input lane solo: enter + render + exit bytes byte-identical to legacy", () => {
    const mgr = createScrollRegionManager()
    const writes: string[] = []
    const out = {
      rows: 24 as number | undefined,
      columns: 80 as number | undefined,
      write: (chunk: string) => {
        writes.push(chunk)
        return true
      },
    }
    const lane = makeLaneRenderer(out, {
      regionManager: mgr,
      resize: () => () => undefined,
    })
    lane.render("a")
    lane.teardown()
    // Legacy: enterLaneMode(24) → renderInputLane("a") → exitLaneMode(24).
    const legacy =
      `${ESC_CHAR}[1;23r${ESC_CHAR}[23;1H` + // enterLaneMode(24)
      `${ESC_CHAR}7${ESC_CHAR}[24;1H${ESC_CHAR}[2K» a${ESC_CHAR}8` + // render
      `${ESC_CHAR}[r${ESC_CHAR}[24;1H${ESC_CHAR}[2K` // exitLaneMode(24)
    expect(writes.join("")).toBe(legacy)
  })

  test("timeline panel solo: install + teardown bytes byte-identical to legacy", () => {
    const sink = makeFakeSink()
    const panel = createTimelinePanel({
      height: 3,
      geometry: () => ({ rows: 20, cols: 80 }),
      write: sink.write,
      now: () => 0,
      color: false,
      resize: () => () => undefined,
    })
    // Legacy pinScrollRegion: DECSTBM [1, rows-height-1] + park.
    expect(sink.writes.join("")).toBe(`${ESC_CHAR}[1;16r${ESC_CHAR}[16;1H`)
    sink.writes.length = 0
    panel.teardown()
    // Legacy teardown: erase panel rows (DEC-wrapped after the SCO fix) +
    // DECSTBM reset.
    expect(sink.writes.join("")).toBe(
      `${ESC_CHAR}7${ESC_CHAR}[17;1H${ESC_CHAR}[2K${ESC_CHAR}[18;1H${ESC_CHAR}[2K${ESC_CHAR}[19;1H${ESC_CHAR}[2K${ESC_CHAR}8${ESC_CHAR}[r`,
    )
  })
})
