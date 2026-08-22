/**
 * jul-08 parallel-lane CLI progress — bus + port + renderer hellgate.
 *
 * Pins the display pipeline for concurrent candidates:
 *   1. BUS — emit is a no-op with no subscriber (byte-identical fork sites);
 *      subscribe/unsubscribe works; a throwing renderer never breaks siblings.
 *   2. PORT — laneProgressPort emits a `turn` per stream() and a `tool` per
 *      tool_use_start, passes stream events through UNCHANGED, counts turns.
 *   3. RENDERER — non-TTY emits prefixed log lines (start/tool/done, NOT bare
 *      turns); TTY installs a coordinated stderr that erases+redraws the panel
 *      around other writes; the gate disables cleanly; stop() restores the ports.
 *
 * Strong-test discipline: real effects (captured stderr, forwarded events),
 * paired controls (TTY vs non-TTY, gate on/off), and the pass-through assertion
 * is red-on-injection — dropping/altering an event would fail the equality.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { startLaneProgressRenderer } from "@/apps/bench/lane-progress-renderer"
import type { StreamEvent, StreamInput } from "@/llm/types"
import {
  type LaneProgressEvent,
  laneProgress,
  laneProgressPort,
} from "@/runner/batch/eval/lane-progress"
import {
  __resetTerminalIo,
  getTerminalIo,
  setTerminalIo,
  type TerminalIo,
} from "@/shared/terminal-io"

const GATE = "QUANTA_BENCH_LANE_PROGRESS"
let savedGate: string | undefined
beforeEach(() => {
  savedGate = process.env[GATE]
  delete process.env[GATE]
})
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]
  else process.env[GATE] = savedGate
  __resetTerminalIo()
})

const capturingIo = (isTTY: boolean): { io: TerminalIo; out: string[] } => {
  const out: string[] = []
  const io: TerminalIo = {
    stdout: () => {},
    stderr: (c) => out.push(c),
    stdoutIsTTY: false,
    stderrIsTTY: isTTY,
  }
  return { io, out }
}

async function drain(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ── 1. bus ───────────────────────────────────────────────────────────────────
describe("1. laneProgress bus", () => {
  test("emit is a no-op with no subscriber", () => {
    expect(laneProgress.active).toBe(false)
    expect(() => laneProgress.emit({ kind: "start", lane: "x" })).not.toThrow()
  })
  test("subscribe receives events; unsubscribe stops them", () => {
    const seen: LaneProgressEvent[] = []
    const unsub = laneProgress.subscribe((e) => seen.push(e))
    expect(laneProgress.active).toBe(true)
    laneProgress.emit({ kind: "start", lane: "a" })
    unsub()
    laneProgress.emit({ kind: "start", lane: "b" })
    expect(seen).toEqual([{ kind: "start", lane: "a" }])
    expect(laneProgress.active).toBe(false)
  })
  test("a throwing listener never breaks a sibling listener", () => {
    const seen: string[] = []
    const u1 = laneProgress.subscribe(() => {
      throw new Error("boom")
    })
    const u2 = laneProgress.subscribe((e) => seen.push(e.lane))
    laneProgress.emit({ kind: "start", lane: "ok" })
    u1()
    u2()
    expect(seen).toEqual(["ok"])
  })
})

// ── 2. laneProgressPort ──────────────────────────────────────────────────────
describe("2. laneProgressPort", () => {
  const events: StreamEvent[] = [
    { type: "text_delta", delta: "hi" },
    { type: "tool_use_start", id: "t1", name: "edit" },
    { type: "tool_use_end", id: "t1", input: {} },
  ]
  const inner = {
    model: "m",
    stream: (_i: StreamInput): AsyncIterable<StreamEvent> => {
      async function* g() {
        for (const e of events) yield e
      }
      return g()
    },
  }

  test("emits a turn per stream() and a tool per tool_use_start; events pass through unchanged", async () => {
    const seen: LaneProgressEvent[] = []
    const unsub = laneProgress.subscribe((e) => seen.push(e))
    const p = laneProgressPort(inner, "repair-breadth#0")
    const forwarded = await drain(p.stream({ messages: [], tools: [] }))
    unsub()
    expect(forwarded).toEqual(events) // red-on-injection: any drop/alter fails
    expect(seen).toEqual([
      { kind: "turn", lane: "repair-breadth#0", turn: 1 },
      { kind: "tool", lane: "repair-breadth#0", turn: 1, tool: "edit" },
    ])
  })

  test("turn counter increments across stream() calls", async () => {
    const turns: number[] = []
    const unsub = laneProgress.subscribe((e) => {
      if (e.kind === "turn") turns.push(e.turn ?? -1)
    })
    const p = laneProgressPort(inner, "L")
    await drain(p.stream({ messages: [], tools: [] }))
    await drain(p.stream({ messages: [], tools: [] }))
    unsub()
    expect(turns).toEqual([1, 2])
  })
})

// ── 3. renderer ──────────────────────────────────────────────────────────────
describe("3. startLaneProgressRenderer", () => {
  test("gate off ⇒ never subscribes (bus stays inert)", () => {
    process.env[GATE] = "0"
    const { io } = capturingIo(true)
    setTerminalIo(io)
    const stop = startLaneProgressRenderer(() => 0)
    expect(laneProgress.active).toBe(false)
    stop()
  })

  test("non-TTY ⇒ prefixed log lines for start/tool/done, NOT bare turns", () => {
    const { io, out } = capturingIo(false)
    setTerminalIo(io)
    const stop = startLaneProgressRenderer(() => 0)
    laneProgress.emit({ kind: "start", lane: "repair-breadth#1" })
    laneProgress.emit({ kind: "turn", lane: "repair-breadth#1", turn: 1 })
    laneProgress.emit({ kind: "tool", lane: "repair-breadth#1", turn: 1, tool: "edit" })
    laneProgress.emit({ kind: "done", lane: "repair-breadth#1", ok: true, patchBytes: 42 })
    stop()
    const text = out.join("")
    expect(text).toContain("[repair-breadth#1] ▷ start")
    expect(text).toContain("[repair-breadth#1] ✎ edit")
    expect(text).toContain("[repair-breadth#1] ✓ done · 42B")
    // bare "turn" must NOT produce a line (too noisy for a flat log)
    expect(text).not.toContain("turn 1)\n⑂ [repair-breadth#1] ⑂") // no standalone turn line
    expect((text.match(/⑂ \[/g) ?? []).length).toBe(3) // start + tool + done only
  })

  test("TTY ⇒ panel drawn with the lane, and other stderr writes are coordinated", () => {
    const { io, out } = capturingIo(true)
    setTerminalIo(io)
    const stop = startLaneProgressRenderer(() => 1000)
    laneProgress.emit({ kind: "start", lane: "verify-select#2" })
    laneProgress.emit({ kind: "tool", lane: "verify-select#2", turn: 3, tool: "read" })
    // a foreign stderr write (as a logger would do) must go through the wrapped
    // port that erases + rewrites the panel around it.
    const before = out.length
    __currentStderr()("some log line\n")
    const written = out.slice(before).join("")
    stop()
    const all = out.join("")
    expect(all).toContain("verify-select#2") // panel shows the lane
    expect(all).toContain("read") // and its current tool
    expect(written).toContain("some log line") // foreign write passed through
    expect(written).toContain("\x1b[") // wrapped with ANSI erase/redraw
  })

  test("stop() restores the original terminal ports", () => {
    const { io } = capturingIo(true)
    setTerminalIo(io)
    const stop = startLaneProgressRenderer(() => 0)
    laneProgress.emit({ kind: "start", lane: "L" })
    // while running, the active stderr is the coordinated wrapper (≠ original)
    expect(__currentStderr()).not.toBe(io.stderr)
    stop()
    // restored
    expect(__currentStderr()).toBe(io.stderr)
    expect(laneProgress.active).toBe(false)
  })
})

// helper: read the currently-installed stderr writer (SSOT = getTerminalIo)
function __currentStderr(): (c: string) => void {
  return getTerminalIo().stderr
}
