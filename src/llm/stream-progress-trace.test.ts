/**
 * TDD — per-LLM-stream PROGRESS HEARTBEAT trace (jun-26).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * When an LLM turn STALLS mid-stream — e.g. a content-less stream waiting on data
 * (the same cassette case the empty-stream breaker addresses) or a very slow turn
 * — NOTHING is logged. The bench `run.log` only gets a line when a TOOL ACTION
 * completes, so a turn stuck INSIDE the LLM stream is invisible: "troubleshooting
 * blind." The trace decorator emits a periodic HEARTBEAT during stream
 * consumption that keeps firing even while the async generator is awaiting the
 * next event, so a stall shows up as idle-time growing with zero content.
 *
 * These tests drive an INJECTED timer + clock so they are deterministic (no real
 * setInterval / wall clock). The KEY test is STALL: a stream that yields one
 * telemetry event then awaits forever must produce ≥2 heartbeats with idle
 * climbing and content=0 — proving the stall is now VISIBLE.
 */
import { describe, expect, mock, test } from "bun:test"
import type { StreamEvent, StreamInput } from "@/llm"
import type { LLMPort } from "./ports"
import {
  DEFAULT_STREAM_TRACE_INTERVAL_MS,
  type TraceTimer,
  withStreamProgressTrace,
} from "./stream-progress-trace"

const TELEMETRY_CONTINUATION: StreamEvent = {
  type: "llm_continuation",
  surfaceId: "openai-responses",
  transportId: "chatgpt-oauth",
  phase: "prepare",
  mode: "full",
  reason: "no_prompt_cache_key",
}

const REQ: StreamInput = {
  messages: [{ role: "user", content: [{ type: "text", text: "write a repro test" }] }],
  tools: [],
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

/** A manually-driven timer: `withStreamProgressTrace` schedules a single
 *  repeating callback via {@link TraceTimer}; the test fires it explicitly so
 *  there is no real wall-clock dependency. `cleared` records that the decorator
 *  cancelled it on completion. */
class ManualTimer {
  private cb: (() => void) | null = null
  private intervalMs = 0
  cleared = false
  readonly setTimer: TraceTimer["setTimer"] = (cb, ms) => {
    this.cb = cb
    this.intervalMs = ms
    return 1 as unknown as ReturnType<TraceTimer["setTimer"]>
  }
  readonly clearTimer: TraceTimer["clearTimer"] = () => {
    this.cleared = true
    this.cb = null
  }
  /** Fire the scheduled heartbeat callback `n` times. */
  tick(n = 1): void {
    for (let i = 0; i < n; i++) this.cb?.()
  }
  get scheduled(): boolean {
    return this.cb !== null
  }
  get interval(): number {
    return this.intervalMs
  }
}

/** A scripted port whose `stream()` yields a fixed event list per call. */
class ScriptedPort implements LLMPort {
  readonly model = "scripted-model-abc"
  calls = 0
  constructor(private readonly events: StreamEvent[]) {}
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const events = this.events
    async function* gen(): AsyncIterable<StreamEvent> {
      for (const ev of events) yield ev
    }
    return gen()
  }
}

/** Collect every logged heartbeat line (the `[stream-trace]` prose) via an
 *  injected `log` sink. Returns the captured messages so assertions can match
 *  the prose without grepping the global logger. */
const makeLogSink = () => {
  const lines: string[] = []
  const log = mock((msg: string, _meta?: unknown) => {
    lines.push(msg)
  })
  return { log, lines }
}

const heartbeats = (lines: string[]): string[] =>
  lines.filter((l) => l.startsWith("[stream-trace] route="))
const summaries = (lines: string[]): string[] => lines.filter((l) => l.startsWith("[stream-trace] done"))

describe("withStreamProgressTrace — stall visibility (THE KEY TEST)", () => {
  test("STALL: telemetry then awaits forever → heartbeats keep firing, idle climbs, content=0", async () => {
    // Inner stream: yield ONE telemetry event, then await a controllable gate
    // that the test never resolves until it has driven the timer — modelling a
    // stream stuck inside `await` for the next event.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner: LLMPort = {
      model: "scripted-model-abc",
      stream() {
        async function* gen(): AsyncIterable<StreamEvent> {
          yield TELEMETRY_CONTINUATION
          await gate // stall here — never yields again until released
        }
        return gen()
      },
    }
    const timer = new ManualTimer()
    const sink = makeLogSink()
    // Injected clock: starts at 1000, advances 10s on every read so each
    // heartbeat sees elapsed/idle climbing deterministically.
    let clock = 1000
    const now = () => {
      const t = clock
      clock += 10_000
      return t
    }
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 10_000,
      now,
      timer,
      log: sink.log,
    })

    // Start consuming in the background; it will hang on `gate`.
    const consumed: StreamEvent[] = []
    const drive = (async () => {
      for await (const ev of guarded.stream(REQ)) consumed.push(ev)
    })()

    // Let the first (telemetry) event flow and the timer get scheduled. A
    // macrotask turn lets the async generator deliver its first event before the
    // `await gate` stall.
    await new Promise((r) => setTimeout(r, 0))
    expect(consumed).toEqual([TELEMETRY_CONTINUATION])
    expect(timer.scheduled).toBe(true)

    // Drive the heartbeat timer ≥3 times WHILE the generator is awaiting.
    timer.tick(3)

    const hbs = heartbeats(sink.lines)
    // ≥2 heartbeat lines emitted while stalled — the stall is now VISIBLE.
    expect(hbs.length).toBeGreaterThanOrEqual(2)
    // Every heartbeat reports content=0 (only telemetry arrived).
    for (const l of hbs) expect(l).toContain("content=0")
    // Idle is GROWING across heartbeats (the whole point: a stall shows idle
    // climbing). Parse the `idle=<n>s` field and assert monotonic increase.
    const idles = hbs.map((l) => {
      const m = l.match(/idle=(\d+)s/)
      return m ? Number(m[1]) : -1
    })
    expect(idles.every((v) => v >= 0)).toBe(true)
    expect(idles[idles.length - 1]).toBeGreaterThan(idles[0] as number)

    // Resolve the stall so the test does not hang; drain the generator.
    release()
    await drive
    // Final summary emitted exactly once + timer cleared.
    expect(summaries(sink.lines).length).toBe(1)
    expect(timer.cleared).toBe(true)
  })
})

describe("withStreamProgressTrace — red-on-injection (the trace is what surfaces it)", () => {
  test("intervalMs=0 (disabled) → ZERO heartbeats even for a multi-event stream", async () => {
    const inner = new ScriptedPort([
      TELEMETRY_CONTINUATION,
      { type: "text_delta", delta: "x" },
    ])
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 0, // DISABLED
      timer,
      log: sink.log,
    })
    const out = await collect(guarded.stream(REQ))
    // Even if a test tried to fire the timer, nothing is scheduled.
    timer.tick(5)
    expect(out).toHaveLength(2)
    expect(heartbeats(sink.lines)).toHaveLength(0)
    // No heartbeat AND no summary when disabled (telemetry fully off).
    expect(summaries(sink.lines)).toHaveLength(0)
    expect(timer.scheduled).toBe(false)
  })

  test("WITHOUT the decorator, the bare inner stream logs nothing (baseline)", async () => {
    const inner = new ScriptedPort([TELEMETRY_CONTINUATION])
    const sink = makeLogSink()
    // Consume the inner port DIRECTLY — no trace decorator.
    await collect(inner.stream(REQ))
    expect(sink.lines).toHaveLength(0)
  })
})

describe("withStreamProgressTrace — byte-identical passthrough", () => {
  test("a normal stream of N content events → consumer receives EXACTLY those N in order", async () => {
    const events: StreamEvent[] = [
      TELEMETRY_CONTINUATION,
      { type: "text_delta", delta: "FILE" },
      { type: "tool_use_start", id: "1", name: "edit" },
      { type: "tool_use_delta", id: "1", delta: "{" },
      { type: "tool_use_end", id: "1", input: {} },
      { type: "usage", inputTokens: 10, outputTokens: 2, model: "m" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const inner = new ScriptedPort(events)
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 10_000,
      timer,
      log: sink.log,
    })
    const out = await collect(guarded.stream(REQ))
    // Reference-equal events in the SAME order — nothing added/dropped/reordered.
    expect(out).toEqual(events)
    expect(out).toHaveLength(events.length)
    for (let i = 0; i < events.length; i++) expect(out[i]).toBe(events[i])
  })

  test("a summary line is emitted on clean completion", async () => {
    const inner = new ScriptedPort([
      { type: "text_delta", delta: "hi" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 10_000,
      timer,
      log: sink.log,
    })
    await collect(guarded.stream(REQ))
    const sums = summaries(sink.lines)
    expect(sums).toHaveLength(1)
    expect(sums[0]).toContain("ok")
    expect(timer.cleared).toBe(true)
  })

  test("an inner error propagates AND emits an error summary, timer cleared", async () => {
    const boom: LLMPort = {
      model: "scripted-model-abc",
      stream() {
        async function* gen(): AsyncIterable<StreamEvent> {
          yield TELEMETRY_CONTINUATION
          throw new Error("kaboom-from-inner")
        }
        return gen()
      },
    }
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(boom, {
      intervalMs: 10_000,
      timer,
      log: sink.log,
    })
    await expect(collect(guarded.stream(REQ))).rejects.toThrow("kaboom-from-inner")
    const sums = summaries(sink.lines)
    expect(sums).toHaveLength(1)
    expect(sums[0]).toContain("error")
    expect(sums[0]).toContain("kaboom-from-inner")
    expect(timer.cleared).toBe(true)
  })
})

describe("withStreamProgressTrace — content-vs-telemetry counting", () => {
  test("heartbeat/summary content count matches isStreamEventContentful", async () => {
    // 2 content events (text + tool_use_start), 3 telemetry events.
    const events: StreamEvent[] = [
      TELEMETRY_CONTINUATION, // telemetry
      { type: "text_delta", delta: "a" }, // content
      { type: "usage", inputTokens: 1, outputTokens: 1, model: "m" }, // telemetry
      { type: "tool_use_start", id: "1", name: "edit" }, // content
      { type: "message_stop", stop_reason: "end_turn" }, // telemetry
    ]
    const inner = new ScriptedPort(events)
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 10_000,
      timer,
      log: sink.log,
    })
    await collect(guarded.stream(REQ))
    const sum = summaries(sink.lines)[0] ?? ""
    expect(sum).toContain("events=5")
    expect(sum).toContain("content=2")
  })
})

describe("withStreamProgressTrace — fast turn, no spam", () => {
  test("a stream that completes before one interval → ZERO heartbeats", async () => {
    const inner = new ScriptedPort([
      TELEMETRY_CONTINUATION,
      { type: "text_delta", delta: "done fast" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const timer = new ManualTimer()
    const sink = makeLogSink()
    const guarded = withStreamProgressTrace(inner, {
      intervalMs: 10_000,
      timer,
      log: sink.log,
    })
    // Consume fully WITHOUT ever firing the timer (the stream finished before
    // an interval elapsed in real time).
    await collect(guarded.stream(REQ))
    // No heartbeat lines — only the (cheap) summary.
    expect(heartbeats(sink.lines)).toHaveLength(0)
    // Timer was cleared at completion (never allowed to fire).
    expect(timer.cleared).toBe(true)
  })
})

describe("withStreamProgressTrace — defaults", () => {
  test("DEFAULT_STREAM_TRACE_INTERVAL_MS is ~10s and exported", () => {
    expect(DEFAULT_STREAM_TRACE_INTERVAL_MS).toBe(10_000)
  })

  test("absent intervalMs ⇒ default interval is scheduled (default ON)", async () => {
    const timer = new ManualTimer()
    const sink = makeLogSink()
    // A stream that we keep open long enough to observe the schedule.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner: LLMPort = {
      model: "m",
      stream() {
        async function* gen(): AsyncIterable<StreamEvent> {
          yield TELEMETRY_CONTINUATION
          await gate
        }
        return gen()
      },
    }
    const guarded = withStreamProgressTrace(inner, { timer, log: sink.log })
    const drive = (async () => {
      for await (const _ of guarded.stream(REQ)) {
        // drain
      }
    })()
    await new Promise((r) => setTimeout(r, 0))
    expect(timer.scheduled).toBe(true)
    expect(timer.interval).toBe(DEFAULT_STREAM_TRACE_INTERVAL_MS)
    release()
    await drive
  })
})
