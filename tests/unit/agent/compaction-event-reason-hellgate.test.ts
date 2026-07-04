/**
 * jul-3 C2 — compaction typed-narrative reason HELL-GATE.
 *
 * Two fixes pinned here:
 *   (1) tier-1 MICROCOMPACTION now emits `reason:"cadence"` (was
 *       `context_limit`) — a cadence-gated cheap eviction must read distinctly
 *       from a limit-driven tier-2 summarize in the typed event stream.
 *   (2) the ON-DEMAND `/summarize-now` verb (`compactNowOnDemand`) now EMITS a
 *       `compaction_event { trigger:"user_requested", reason:"manual" }` — a
 *       hand-triggered summarize was previously INVISIBLE in the typed history
 *       (every other compaction site emits one).
 *
 * The microcompact path is driven through the REAL `maybeCompact` with the knob
 * ON + a bloated tool_result transcript so the cadence gate + floor actually
 * fire (`maybeMicrocompact` is a private const). The on-demand path is driven
 * directly. Both capture `compactionEventEmit`. Teeth are the reason literals
 * the pre-fix code would fail.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { compactNowOnDemand, maybeCompact } from "@/agent/loop/compaction-wire"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { CompactionEventVariant } from "@/memory/typed-event"
import { __resetRuntimeConfig } from "@/shared"

class FakeSummarizerLLM implements LLMPort {
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "SUMMARY" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const a = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })

/** Bloated tool_result transcript: 5 big stale dumps so the microcompact floor
 *  is cleared and the cadence pass actually shrinks something. */
const bloatedHistory = (): Message[] => {
  const out: Message[] = [u("start")]
  for (let i = 0; i < 5; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "text", text: `DECISION ${i}` },
        { type: "tool_use", id: `u${i}`, name: "Read", input: { path: `f${i}` } },
      ],
    })
    out.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `u${i}`, content: `dump:${"x".repeat(60_000)}` }],
    })
  }
  out.push(u("now answer"))
  return out
}

/** A multi-turn plain transcript so on-demand `findBoundary` yields a prefix. */
const manyTurns = (): Message[] => {
  const m: Message[] = []
  for (let i = 0; i < 8; i++) m.push(u(`task ${i}`), a(`work ${i}`))
  return m
}

const fakeWm = (initial: Message[]) => {
  const buf = [...initial]
  return {
    messages: buf,
    append: (x: Message) => buf.push(x),
    snapshot: () => buf,
    clear: () => {
      buf.length = 0
    },
    replace: (xs: Message[]) => {
      buf.length = 0
      buf.push(...xs)
    },
    tokenEstimate: () => 0,
  }
}

const captureCfg = (
  events: CompactionEventVariant[],
  // Loose bag (not Partial<AgentConfig>) so a test can OMIT `compaction` to
  // exercise the default-OFF path without tripping exactOptionalPropertyTypes.
  over: Record<string, unknown> = {},
): AgentConfig =>
  ({
    llm: new FakeSummarizerLLM(),
    system: "sys",
    cwd: "/tmp",
    compaction: {},
    stream: { emit: () => {} },
    compactionEventEmit: (e: CompactionEventVariant) => {
      if (e.kind === "compaction_event") events.push(e)
    },
    ...over,
  }) as unknown as AgentConfig

describe("C2(1) — tier-1 microcompaction emits reason:'cadence'", () => {
  const orig = {
    knob: process.env.QUANTA_MICROCOMPACT,
    floor: process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS,
    interval: process.env.QUANTA_MICROCOMPACT_INTERVAL_MS,
  }
  beforeEach(() => {
    process.env.QUANTA_MICROCOMPACT = "1"
    process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = "100"
    process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = "1"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    for (const [k, v] of [
      ["QUANTA_MICROCOMPACT", orig.knob],
      ["QUANTA_MICROCOMPACT_FLOOR_TOKENS", orig.floor],
      ["QUANTA_MICROCOMPACT_INTERVAL_MS", orig.interval],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    __resetRuntimeConfig()
  })

  test("a fired microcompaction emits a cadence-reason compaction_event (TEETH)", async () => {
    const events: CompactionEventVariant[] = []
    // Unique sessionId so the module-level cadence Map does not suppress the fire.
    const cfg = captureCfg(events, { sessionId: `s-${Math.random()}` })
    const wm = fakeWm(bloatedHistory())
    await maybeCompact({
      config: cfg,
      system: "sys",
      wm: wm as never,
      breaker: undefined,
      archive: undefined,
      turn: 1,
      bgController: undefined,
      resetClassifier: () => {},
      tokenBaselineBox: undefined,
    })
    const micro = events.find((e) => e.trigger === "pre_sampling" && e.messagesRemoved === 0)
    expect(micro).toBeDefined()
    // TEETH: pre-fix this was "context_limit" — indistinguishable from tier-2.
    expect(micro?.reason).toBe("cadence")
    expect(micro?.reason).not.toBe("context_limit")
  })
})

describe("C2(2) — compactNowOnDemand emits a user_requested/manual event", () => {
  test("on-demand summarize emits { trigger:'user_requested', reason:'manual' } (TEETH)", async () => {
    const events: CompactionEventVariant[] = []
    const cfg = captureCfg(events)
    const wm = fakeWm(manyTurns())
    const did = await compactNowOnDemand(cfg, wm as never)
    expect(did).toBe(true)
    const manual = events.find((e) => e.trigger === "user_requested")
    // TEETH: pre-fix compactNowOnDemand emitted NO typed event at all.
    expect(manual).toBeDefined()
    expect(manual?.reason).toBe("manual")
    // tokensBefore is measured on the PRE-compaction transcript (before wm.replace);
    // both are finite non-negative token estimates.
    expect(Number.isFinite(manual?.tokensBefore)).toBe(true)
    expect(manual?.tokensBefore).toBeGreaterThan(0)
  })

  test("no compaction config ⇒ no-op, no event emitted (default-OFF)", async () => {
    const events: CompactionEventVariant[] = []
    const cfg = captureCfg(events, { compaction: undefined })
    const wm = fakeWm(manyTurns())
    const did = await compactNowOnDemand(cfg, wm as never)
    expect(did).toBe(false)
    expect(events.length).toBe(0)
  })
})
