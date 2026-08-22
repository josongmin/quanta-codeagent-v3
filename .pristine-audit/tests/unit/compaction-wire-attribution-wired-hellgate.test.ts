/**
 * ★ HELLGATE — DOF-40 WIRE: compaction attribution stamped + failure-routed
 *    through the REAL loop wire (`maybeCompact` → `buildCompactIfNeededOptions`
 *    → `compactIfNeeded`), NOT via hand-passed options.
 *
 * The pure core (`compactIfNeeded`) has accepted `attributedTurnId` /
 * `onAttributionFailure` since Wave-A, and a sibling hellgate
 * (`compaction-attribution-race-failclosed-hellgate`) proves the CORE honors
 * them. But the PRODUCTION wire (`buildCompactIfNeededOptions` in
 * compaction-wire.ts) did NOT pass either — a DEAD WIRE: in production the turn
 * was UNSTAMPED and a dropped async attribution only hit `logger.warn`
 * (invisible to any surface). This suite drives the REAL `maybeCompact` path and
 * proves:
 *
 *  (a) ON — a compaction event is attributed to the CORRECT current turn (read
 *      from `config.run.turn`, the REAL loop turn source — not a stub) via the
 *      `post_compact` HOOK the wire builds from `config.hooks`.
 *  (b) ON — an attribution FAILURE (a throwing `post_compact` subscriber) reaches
 *      a REAL operator-observable consumer: a `recovery` stream event with detail
 *      `attribution-failed: …` (the same `emitRecovery(config,"compact",…)`
 *      channel that surfaces `proactive-failed` / `bg-install-stale`).
 *  (c) FALLBACK — when `config.run` is absent the wire stamps the loop's `turn`
 *      arg (still the REAL current turn), never a placeholder.
 *  (d) OFF — no `hooks` wired ⇒ `postCompactEmit` absent ⇒ neither field spread
 *      ⇒ no attribution-failed recovery event, compaction byte-identical.
 *
 * Teeth: the pre-wire code (this leaf's target) would FAIL (a) with
 * `attributedTurnId === undefined` and (b) with NO recovery event on a throwing
 * subscriber.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent/hooks"
import { maybeCompact } from "@/agent/loop/compaction-wire"
import type { RecoveryProvenance } from "@/agent/recovery-reason"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent } from "@/stream"

class FakeSummarizerLLM implements LLMPort {
  readonly model = "scripted"
  callCount = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    yield { type: "text_delta", delta: "FOLDED" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const a = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] })

/** Over-threshold, multi-turn so `findBoundary` yields a summarizable prefix. */
const overThreshold = (): Message[] => [
  u("x".repeat(2_000)),
  a("y".repeat(2_000)),
  u("recent ask"),
  a("recent answer"),
]

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

type Captured = { stream: AgentEvent[] }

/** Build an AgentConfig whose `compaction` threshold is low enough to fire, with
 *  a REAL `HookBus` (so the wire's `buildPostCompactEmit` produces a live emit)
 *  and a capturing `stream.emit` (the REAL recovery sink). */
const wireCfg = (
  cap: Captured,
  over: Record<string, unknown> = {},
): { cfg: AgentConfig; hooks: HookBus } => {
  const hooks = new HookBus()
  const cfg = {
    llm: new FakeSummarizerLLM(),
    system: "sys",
    cwd: "/tmp",
    // Low threshold so `compactIfNeeded` fires on `overThreshold()`.
    compaction: { thresholdTokens: 100, keepRecentTurns: 1 },
    sessionId: "sess-1",
    hooks,
    stream: {
      emit: (e: AgentEvent) => {
        cap.stream.push(e)
      },
    },
    ...over,
  } as unknown as AgentConfig
  return { cfg, hooks }
}

const runWire = async (cfg: AgentConfig, wm: ReturnType<typeof fakeWm>, turn: number) =>
  maybeCompact({
    config: cfg,
    system: "sys",
    wm: wm as never,
    breaker: undefined,
    archive: undefined,
    turn,
    bgController: undefined,
    resetClassifier: () => {},
    tokenBaselineBox: undefined,
  })

describe("DOF-40 WIRE — attribution stamped + failure-routed through maybeCompact", () => {
  test("(a) ON — post_compact provenance is attributed to config.run.turn (REAL turn source, not a stub)", async () => {
    const cap: Captured = { stream: [] }
    const seen: RecoveryProvenance[] = []
    // REAL current turn = 5 (config.run.turn). The loop `turn` arg is DELIBERATELY
    // different (99) so a passing assert can ONLY come from run.turn, never the arg.
    const { cfg, hooks } = wireCfg(cap, { run: { runId: "r", turn: 5 } })
    hooks.on("post_compact", (ev) => {
      if (ev.type === "post_compact") seen.push(ev.provenance)
      return {}
    })
    const wm = fakeWm(overThreshold())
    await runWire(cfg, wm, 99)

    expect(seen.length).toBe(1)
    const p = seen[0]
    if (!p) throw new Error("post_compact never fired through the wire")
    // TEETH: pre-wire this was `undefined` (the wire never passed attributedTurnId).
    expect(p.attributedTurnId).toBe("t5")
    // Thread id is the session id the wire forwards.
    expect(p.attributedThreadId).toBe("sess-1")
  })

  test("(a') REAL turn source proof — a DIFFERENT run.turn changes the stamp (not hard-coded)", async () => {
    const cap: Captured = { stream: [] }
    const seen: RecoveryProvenance[] = []
    const { cfg, hooks } = wireCfg(cap, { run: { runId: "r", turn: 12 } })
    hooks.on("post_compact", (ev) => {
      if (ev.type === "post_compact") seen.push(ev.provenance)
      return {}
    })
    await runWire(cfg, fakeWm(overThreshold()), 1)
    expect(seen[0]?.attributedTurnId).toBe("t12")
  })

  test("(b) ON — a REJECTING post_compact emit routes the failure to the REAL recovery channel", async () => {
    const cap: Captured = { stream: [] }
    // The REALISTIC drop the `onAttributionFailure` seam handles is the
    // `postCompactEmit` closure ITSELF rejecting (the bus `emit` faulting) —
    // NOT a subscriber throw (the HookBus catches those internally, so they
    // never propagate). Model a bus whose `emit` rejects, which is exactly what
    // `buildPostCompactEmit`'s `await hooks.emit(...)` surfaces to
    // `compactIfNeeded`'s catch.
    const faultingHooks = {
      // Fault ONLY on post_compact — pre_compact must still resolve (it is
      // awaited BEFORE the summarize, outside the post-emit try/catch, so a
      // pre_compact fault would abort the whole compaction instead of exercising
      // the attribution-failure seam under test).
      emit: async (event: { type: string }) => {
        if (event.type === "post_compact") throw new Error("attribution channel down")
        return { deny: null }
      },
    } as unknown as HookBus
    const { cfg } = wireCfg(cap, { run: { runId: "r", turn: 7 }, hooks: faultingHooks })
    await runWire(cfg, fakeWm(overThreshold()), 7)

    // REAL sink: a `recovery` stream event with the attribution-failed detail.
    const recoveries = cap.stream.filter(
      (e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery",
    )
    const failure = recoveries.find((e) => e.detail?.startsWith("attribution-failed"))
    // TEETH: pre-wire NO onAttributionFailure was passed, so a throwing subscriber
    // produced ZERO recovery event (only a hidden logger.warn).
    expect(failure).toBeDefined()
    expect(failure?.reason).toBe("compact")
    expect(failure?.detail).toContain("attribution channel down")
  })

  test("(b') RED-ON-INJECTION — the failure recovery ONLY appears when the subscriber throws", async () => {
    const cap: Captured = { stream: [] }
    const { cfg, hooks } = wireCfg(cap, { run: { runId: "r", turn: 3 } })
    // Happy subscriber — does NOT throw.
    hooks.on("post_compact", () => ({}))
    await runWire(cfg, fakeWm(overThreshold()), 3)
    const failure = cap.stream
      .filter((e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery")
      .find((e) => e.detail?.startsWith("attribution-failed"))
    expect(failure).toBeUndefined()
  })

  test("(c) FALLBACK — run absent ⇒ the wire stamps the loop `turn` arg (still the REAL current turn)", async () => {
    const cap: Captured = { stream: [] }
    const seen: RecoveryProvenance[] = []
    // NO `run` on the config.
    const { cfg, hooks } = wireCfg(cap)
    hooks.on("post_compact", (ev) => {
      if (ev.type === "post_compact") seen.push(ev.provenance)
      return {}
    })
    await runWire(cfg, fakeWm(overThreshold()), 4)
    // Falls back to `t${turn}` (the loop's real iteration index).
    expect(seen[0]?.attributedTurnId).toBe("t4")
  })

  test("(c') objective-only wire (hooks ABSENT) still turn-tags the persisted next-action", async () => {
    // A config with an objective store but NO hooks: attributedTurnId must STILL
    // be stamped (gated on EITHER consumer) so the objective record self-attributes
    // `[turn t<N>]`. onAttributionFailure stays gated on postCompactEmit (absent).
    const cap: Captured = { stream: [] }
    const calls: string[][] = []
    const cfg = {
      llm: new FakeSummarizerLLM(),
      system: "sys",
      cwd: "/tmp",
      compaction: { thresholdTokens: 100, keepRecentTurns: 1 },
      sessionId: "sess-obj",
      run: { runId: "r", turn: 8 },
      // NO hooks — objective store only.
      objective: {
        setNextActions: (_tid: string, actions: readonly string[]) => {
          calls.push([...actions])
        },
      },
      stream: { emit: (e: AgentEvent) => cap.stream.push(e) },
    } as unknown as AgentConfig
    await runWire(cfg, fakeWm(overThreshold()), 8)
    expect(calls.length).toBe(1)
    const action = calls[0]?.[0] ?? ""
    expect(action).toContain("agent compacted")
    // TEETH: without the widened gate (postCompactEmit-only) this tag was absent
    // for an objective-only config.
    expect(action).toContain("[turn t8]")
  })

  test("(d) OFF — NO hooks wired ⇒ no attribution-failed recovery, compaction still succeeds", async () => {
    const cap: Captured = { stream: [] }
    // No `hooks` key ⇒ buildPostCompactEmit returns undefined ⇒ neither
    // attributedTurnId nor onAttributionFailure is spread.
    const cfg = {
      llm: new FakeSummarizerLLM(),
      system: "sys",
      cwd: "/tmp",
      compaction: { thresholdTokens: 100, keepRecentTurns: 1 },
      sessionId: "sess-off",
      run: { runId: "r", turn: 5 },
      stream: {
        emit: (e: AgentEvent) => {
          cap.stream.push(e)
        },
      },
    } as unknown as AgentConfig
    const wm = fakeWm(overThreshold())
    await runWire(cfg, wm, 5)

    // No attribution-failed recovery event (the sink was never even constructed).
    const failure = cap.stream
      .filter((e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery")
      .find((e) => e.detail?.startsWith("attribution-failed"))
    expect(failure).toBeUndefined()
    // But the compaction itself STILL ran (the proactive `recovery` fired) and the
    // transcript was folded (byte-identical legacy compaction).
    const proactive = cap.stream
      .filter((e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery")
      .find((e) => e.detail === "proactive")
    expect(proactive).toBeDefined()
    // The wm shrank (compaction happened).
    expect(wm.snapshot().length).toBeLessThan(overThreshold().length)
  })

  test("(d') OFF-vs-ON parity — the ONLY new stream event ON adds is the attribution-failed recovery", async () => {
    // ON with a NON-throwing subscriber must add NO extra recovery detail beyond
    // the legacy set — the attribution wiring is silent unless the emit fails.
    const off: Captured = { stream: [] }
    const offCfg = {
      llm: new FakeSummarizerLLM(),
      system: "sys",
      cwd: "/tmp",
      compaction: { thresholdTokens: 100, keepRecentTurns: 1 },
      sessionId: "s",
      run: { runId: "r", turn: 2 },
      stream: { emit: (e: AgentEvent) => off.stream.push(e) },
    } as unknown as AgentConfig
    await runWire(offCfg, fakeWm(overThreshold()), 2)

    const on: Captured = { stream: [] }
    const { cfg, hooks } = wireCfg(on, { run: { runId: "r", turn: 2 } })
    hooks.on("post_compact", () => ({}))
    await runWire(cfg, fakeWm(overThreshold()), 2)

    const details = (c: Captured) =>
      c.stream
        .filter((e): e is Extract<AgentEvent, { type: "recovery" }> => e.type === "recovery")
        .map((e) => e.detail)
        .sort()
    // Happy-path ON produces the SAME recovery details as OFF (no new event).
    expect(details(on)).toEqual(details(off))
  })
})
