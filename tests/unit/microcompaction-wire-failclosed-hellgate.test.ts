/**
 * DOF-40 fail-closed hardening — WIRE level, through the REAL `maybeCompact`.
 *
 * The pure-core refusal (`microcompaction-tuning-failclosed-hellgate`) is only
 * useful if the WIRE fails CLOSED on it. This drives the actual `maybeCompact`
 * with `QUANTA_MICROCOMPACT` ON and asserts:
 *
 *   ON-PROOF (real effect through the gate): valid tuning ⇒ tier-1 actually
 *     fires — old tool dumps are cleared IN the live wm (observed via wm.replace),
 *     recovery:{compact,microcompact} emitted. Not a helper return: we read the
 *     post-pass wm content.
 *
 *   FAIL-CLOSED (paired control): the SAME transcript with INVALID tuning
 *     (`microcompactKeepRecent = 0`, injected via a `runtimeConfig` spy standing in
 *     for the missing per-session injection path the audit flagged) ⇒ the wire
 *     emits a VISIBLE `recovery:{compact,microcompact-refused}` signal and leaves
 *     the transcript UNTOUCHED (zero evictions). Never a silent wrong eviction.
 *
 *   OFF-IDENTITY: knob unset ⇒ no pre-pass, no recovery event, transcript
 *     byte-identical (same object refs as input).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { maybeCompact } from "@/agent/loop/compaction-wire"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import * as shared from "@/shared"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"

class FakeSummarizerLLM implements LLMPort {
  readonly model = "scripted"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "SUMMARY" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/** 5 big stale dumps so the floor is cleared and the pass shrinks something. */
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
      content: [
        { type: "tool_result", tool_use_id: `u${i}`, content: `dump:${"x".repeat(60_000)}` },
      ],
    })
  }
  out.push(u("now answer"))
  return out
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

const cfg = (over: Record<string, unknown> = {}): AgentConfig =>
  ({
    llm: new FakeSummarizerLLM(),
    system: "sys",
    cwd: "/tmp",
    compaction: {},
    stream: new RecordingStream(),
    ...over,
  }) as unknown as AgentConfig

const clearedCount = (msgs: readonly Message[]): number =>
  msgs
    .flatMap((m) => m.content)
    .filter(
      (b) => b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
    ).length

const drive = async (config: AgentConfig, wm: ReturnType<typeof fakeWm>) =>
  maybeCompact({
    config,
    system: "sys",
    wm: wm as never,
    breaker: undefined,
    archive: undefined,
    turn: 1,
    bgController: undefined,
    resetClassifier: () => {},
    tokenBaselineBox: undefined,
  })

describe("DOF-40 microcompact wire fail-closed", () => {
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

  test("ON-PROOF: valid tuning ⇒ real eviction observed in the live wm", async () => {
    const stream = new RecordingStream()
    const config = cfg({ stream, sessionId: `s-${Math.random()}` })
    const wm = fakeWm(bloatedHistory())
    await drive(config, wm)
    // REAL EFFECT: the wm content itself is now clearing old dumps (not a return).
    expect(clearedCount(wm.snapshot())).toBeGreaterThan(0)
    // BOUNDED: the last (keepRecent=3 default) tool_results stay intact.
    const results = wm
      .snapshot()
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result")
    const lastThreeCleared = results
      .slice(-3)
      .filter((b) => b.content.startsWith("[Old tool result content cleared]")).length
    expect(lastThreeCleared).toBe(0)
    // Visible tier-1 recovery event with the microcompact detail.
    expect(
      stream.events.some(
        (e) => e.type === "recovery" && e.reason === "compact" && e.detail === "microcompact",
      ),
    ).toBe(true)
  })

  test("FAIL-CLOSED: invalid keepRecent=0 ⇒ VISIBLE refusal, transcript UNTOUCHED", async () => {
    // Stand in for the missing per-session injection path: force runtimeConfig to
    // hand the wire an out-of-bounds keepRecent. The core throws; the wire must
    // fail closed, NOT silently evict the whole working set.
    const base = shared.runtimeConfig()
    const spy = spyOn(shared, "runtimeConfig").mockReturnValue({
      ...base,
      microcompact: true,
      microcompactKeepRecent: 0,
      microcompactFloorTokens: 100,
      microcompactIntervalMs: 1,
    } as never)
    try {
      const stream = new RecordingStream()
      const config = cfg({ stream, sessionId: `s-refuse-${Math.random()}` })
      const before = bloatedHistory()
      const wm = fakeWm(before)
      await drive(config, wm)
      // VISIBLE: a refusal signal was emitted...
      expect(
        stream.events.some(
          (e) =>
            e.type === "recovery" && e.reason === "compact" && e.detail === "microcompact-refused",
        ),
      ).toBe(true)
      // ...and NOTHING was evicted (fail CLOSED, not evict-all).
      expect(clearedCount(wm.snapshot())).toBe(0)
      // And crucially it did NOT emit the SUCCESS detail (no silent wrong evict).
      expect(stream.events.some((e) => e.type === "recovery" && e.detail === "microcompact")).toBe(
        false,
      )
    } finally {
      spy.mockRestore()
    }
  })

  test("OFF-IDENTITY: knob unset ⇒ no pre-pass, no event, transcript byte-identical", async () => {
    delete process.env.QUANTA_MICROCOMPACT
    __resetRuntimeConfig()
    const stream = new RecordingStream()
    const config = cfg({ stream, sessionId: `s-off-${Math.random()}` })
    const before = bloatedHistory()
    const wm = fakeWm(before)
    const snapBefore = [...wm.snapshot()]
    await drive(config, wm)
    // Same object references, in the same order — byte-identical (no replace).
    const after = wm.snapshot()
    expect(after.length).toBe(snapBefore.length)
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(snapBefore[i])
    expect(clearedCount(after)).toBe(0)
    // No microcompact recovery event of ANY detail.
    expect(
      stream.events.some(
        (e) =>
          e.type === "recovery" &&
          (e.detail === "microcompact" || e.detail === "microcompact-refused"),
      ),
    ).toBe(false)
  })
})
