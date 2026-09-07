import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import { codexSpecRoute, type LLMPort, type StreamEvent, type StreamInput } from "@/llm"
import { LLMError, type LLMErrorKind } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for `recovery-router-codex-spec` (ADR-0214 / feature
 * 07-resilience/recovery-router-codex-spec). The 18-kind → 6-action
 * `codexSpecRoute` table had TABLE-ONLY unit coverage (`runAgent = 0`): a pure
 * `route(kind) → action` assertion with nothing proving the ROUTED action ever
 * takes effect in a live loop.
 *
 * This test BRIDGES the pure table to the live `runAgent` recovery FSM: for a
 * representative kind from each observable action bucket it drives the REAL loop
 * with a scripted `LLMError` carrying that `.kind`, and asserts the loop's
 * CROSS-TURN behaviour matches what `codexSpecRoute(kind)` predicts —
 * ground-truthed via the RecordingStream `recovery` events + the LLM call count
 * + the terminal outcome. `codexSpecRoute` itself is the ORACLE (the assertions
 * read the table, so a table edit that changes a route reshapes the expected
 * live behaviour — a genuine cross-check, not a duplicated literal).
 *
 * Coarsening (the loop's `classifyLLMError` is a 3-way retry/compact/fatal view
 * of the 6-action table): the codex actions collapse onto observable loop
 * outcomes as —
 *   retry_after_backoff | fallback_provider  ⇒  same-turn RETRY (a 2nd stream
 *                                                runs; recovery "backoff")
 *   reactive_compaction                       ⇒  reactive COMPACT (recovery
 *                                                "compact") — but ONLY when the
 *                                                loop's message-based PTL signal
 *                                                is present (see the deliberate-
 *                                                hold CONTROL below)
 *   fatal | hitl_handoff                       ⇒  TERMINAL error, NO retry
 */

/** One scripted step: throw a kinded LLMError, or yield events. Last step
 *  repeats if the loop calls more often than scripted. */
type Step = { throw: LLMError } | { events: StreamEvent[] }

class KindedScriptedLLM implements LLMPort {
  readonly model = "recovery-router-test-model"
  calls = 0
  private readonly steps: Step[]
  constructor(steps: Step[]) {
    this.steps = steps
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const step = this.steps.shift() ?? this.steps[this.steps.length - 1]
    if (step === undefined) throw new LLMError("script exhausted")
    if ("throw" in step) throw step.throw
    for (const e of step.events) yield e
  }
}

const rrConfig = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig =>
  cfg({
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    ...over,
  })

const recoveryReasons = (s: RecordingStream): string[] =>
  s.events.filter((e) => e.type === "recovery").map((e) => (e.type === "recovery" ? e.reason : ""))

// ── Bucket 1: codex retry-eligible actions ⇒ live same-turn backoff retry ────
// codexSpecRoute maps these to `retry_after_backoff` (rate_limit) or
// `fallback_provider` (overloaded/server_error/network). In the wired loop ALL
// of them are `classifyLLMError → "retryable"` ⇒ a same-turn backoff retry.
describe("recovery-router bridge — retry-eligible kinds drive a live same-turn retry", () => {
  const RETRY_KINDS: readonly LLMErrorKind[] = [
    "rate_limit",
    "overloaded",
    "server_error",
    "network",
  ]
  for (const kind of RETRY_KINDS) {
    const action = codexSpecRoute(kind)
    test(`${kind} → codex "${action}" ⇒ loop RETRIES then completes (turn not consumed)`, async () => {
      // ORACLE precondition: this kind is a retry-eligible codex action.
      expect(action === "retry_after_backoff" || action === "fallback_provider").toBe(true)
      const stream = new RecordingStream()
      const llm = new KindedScriptedLLM([
        { throw: new LLMError(`provider says ${kind}`, { kind }) },
        { events: text("recovered answer") },
      ])
      const out = await withTimeout(
        runAgent(rrConfig({ llm, stream, maxTurns: 1 })),
        15_000,
        `recovery-router-retry-${kind}`,
      )
      expect(out.reason).toBe("completed")
      // A SECOND stream ran (the retry) — the routed action took effect NEXT.
      expect(llm.calls).toBeGreaterThanOrEqual(2)
      // The same-turn retry did NOT burn the single turn slot.
      expect(out.turns).toBe(1)
      // The recovery was surfaced as a backoff (the live face of retry-*).
      expect(recoveryReasons(stream)).toContain("backoff")
    })
  }
})

// ── Bucket 2: codex reactive_compaction ⇒ live reactive compact ──────────────
describe("recovery-router bridge — context_window_exceeded drives reactive compaction", () => {
  test('context_window_exceeded → codex "reactive_compaction" ⇒ loop COMPACTS then completes', async () => {
    const kind: LLMErrorKind = "context_window_exceeded"
    expect(codexSpecRoute(kind)).toBe("reactive_compaction")
    const history = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first request" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "older turn one" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "second request" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "older turn two" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "third request" }] },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "older turn three" }],
      },
      { role: "user" as const, content: [{ type: "text" as const, text: "current request" }] },
    ]
    const stream = new RecordingStream()
    // The loop's PTL detection is message-based, so the kinded error also carries
    // the context-window wording the loop keys on (the two signals agree).
    const llm = new KindedScriptedLLM([
      { throw: new LLMError("400 prompt is too long for this model", { kind }) },
      { events: text("<summary>resume from here</summary>") },
      { events: text("final answer after compaction") },
    ])
    const out = await withTimeout(
      runAgent(rrConfig({ llm, stream, messages: history, maxTurns: 1 })),
      15_000,
      "recovery-router-compact",
    )
    expect(out.reason).toBe("completed")
    // reactive_compaction fired (NOT a plain retry/backoff) — the routed action.
    expect(recoveryReasons(stream)).toContain("compact")
    // The compaction did not consume the single turn slot.
    expect(out.turns).toBe(1)
    // The transcript prefix was collapsed into a continuation summary.
    const first = out.messages[0]
    const firstText = first?.content[0]?.type === "text" ? first.content[0].text : ""
    expect(firstText).toContain("continuation summary")
  })
})

// ── Bucket 3: codex fatal / hitl_handoff ⇒ live terminal error, NO retry ─────
describe("recovery-router bridge — fatal/hitl kinds terminate the loop with NO retry", () => {
  const TERMINAL_KINDS: readonly LLMErrorKind[] = [
    "bad_request",
    "not_found",
    "auth",
    "too_many_failed_attempts",
    "stream_corrupt",
  ]
  for (const kind of TERMINAL_KINDS) {
    const action = codexSpecRoute(kind)
    test(`${kind} → codex "${action}" ⇒ loop ERRORS on the FIRST call (never retries)`, async () => {
      // ORACLE precondition: codex routes this kind to a terminal action.
      expect(action === "fatal" || action === "hitl_handoff").toBe(true)
      const stream = new RecordingStream()
      const llm = new KindedScriptedLLM([
        { throw: new LLMError(`provider says ${kind}`, { kind }) },
        // A follow-up success that must NEVER be reached (no retry allowed).
        { events: text("must-not-be-reached") },
      ])
      const out = await withTimeout(
        runAgent(rrConfig({ llm, stream, maxTurns: 3 })),
        15_000,
        `recovery-router-fatal-${kind}`,
      )
      expect(out.reason).toBe("error")
      // TEETH: a terminal action means EXACTLY ONE stream call — no backoff retry.
      expect(llm.calls).toBe(1)
      // And NO backoff recovery was emitted (the loop did not treat it as retryable).
      expect(recoveryReasons(stream)).not.toContain("backoff")
    })
  }
})

describe("recovery-router bridge — typed router owns kinded outer recovery", () => {
  test("context_window_exceeded KIND with a non-PTL message ⇒ loop compacts from the typed route", async () => {
    const kind: LLMErrorKind = "context_window_exceeded"
    // The table SAYS reactive_compaction …
    expect(codexSpecRoute(kind)).toBe("reactive_compaction")
    const stream = new RecordingStream()
    const history = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first request" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "older response" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "second request" }] },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "older response two" }],
      },
      { role: "user" as const, content: [{ type: "text" as const, text: "third request" }] },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "older response three" }],
      },
      { role: "user" as const, content: [{ type: "text" as const, text: "current request" }] },
    ]
    const llm = new KindedScriptedLLM([
      { throw: new LLMError("some opaque provider failure", { kind }) },
      { events: text("summary after typed route") },
      { events: text("recovered after typed route") },
    ])
    const out = await withTimeout(
      runAgent(rrConfig({ llm, stream, messages: history, maxTurns: 3 })),
      15_000,
      "recovery-router-typed-compaction",
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(3)
    expect(recoveryReasons(stream)).toContain("compact")
    expect(recoveryReasons(stream)).not.toContain("backoff")
  })

  test("auth KIND ⇒ typed HITL terminal is surfaced without a retry", async () => {
    const stream = new RecordingStream()
    const llm = new KindedScriptedLLM([
      { throw: new LLMError("credentials need attention", { kind: "auth" }) },
      { events: text("must-not-be-reached") },
    ])
    const out = await withTimeout(
      runAgent(rrConfig({ llm, stream, maxTurns: 1 })),
      15_000,
      "recovery-router-typed-hitl",
    )
    expect(out.reason).toBe("error")
    expect(llm.calls).toBe(1)
    expect(
      stream.events.some(
        (event) => event.type === "error" && event.message.includes("operator intervention"),
      ),
    ).toBe(true)
  })
})
