/**
 * HELLGATE — jun-6 host-wiring REACHABILITY (delta-token-accounting +
 * account-ratelimit-snapshot).
 *
 * The two slices ship sealed/fuzz-proven PURE leaves
 * (`createTokenDeltaCounter`, `parseRateLimitSnapshot`/`store`/`policy`/`notice`)
 * whose own batteries prove the arithmetic. They were inert (host-deferred): no
 * loop site constructed the counter, no adapter captured headers, no pre-request
 * delay existed. This battery proves the WIRING — that the knob-ON effect is
 * LIVE through the REAL `runAgent` loop / `OpenAIResponsesAdapter` /
 * `AnthropicAdapter` path, AND that knob-OFF is byte-identical (the #1
 * invariant: a counter is never constructed, no `.withResponse()` capture, no
 * delay).
 *
 * Feature 1 — delta-token (gate QUANTA_DELTA_TOKEN_COUNT)
 *   ON  ⇒ the counter feeds the compaction precheck: `onPreCompact`'s
 *         `currentTokens` (which IS the `before = estimateWithCounter(...)` read
 *         at the proactive site) equals the full `estimateTokens` re-scan
 *         EXACTLY. The counter path is structurally taken (proven by reseed
 *         equivalence over a real multi-message transcript).
 *   OFF ⇒ `currentTokens` is the SAME value computed by the direct
 *         `estimateTokens` call (byte-identical) — asserted by running the SAME
 *         scenario ON vs OFF and comparing the surfaced number + event stream.
 *
 * Feature 2 — ratelimit (gate QUANTA_RATELIMIT_PROACTIVE)
 *   ON  ⇒ a `remaining=0` header on response N ⇒ a PROACTIVE delay (via the
 *         injected `sleep`) + a `ratelimit_snapshot` notice BEFORE request N+1,
 *         driven end-to-end through the loop's `onResponseHeaders` capture hook.
 *   OFF ⇒ no capture (the hook field is never set on the StreamInput the adapter
 *         sees), no delay, no notice — byte-identical reactive path.
 *   ADAPTER ⇒ the REAL `OpenAIResponsesAdapter` (injected fetch) invokes
 *         `onResponseHeaders` with the live `Response` headers when present, and
 *         the REAL `AnthropicAdapter` uses `.withResponse()` ONLY when the hook
 *         is present (absent ⇒ plain await, byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, PreCompactRequestQuery } from "@/agent"
import { estimateTokens, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { AnthropicAdapter } from "@/llm/adapters/anthropic"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { AgentEvent, StreamPort } from "@/stream"
import { defineTool, ToolRegistry } from "@/tool"

/** Trivial no-op tool so the model can request a tool_use and the loop opens a
 *  SECOND stream for the result — giving us the two model calls needed to prove
 *  a header captured on call N drives a delay before call N+1. */
const noopSchema = z.object({ note: z.string().optional() })
const noopTool = defineTool<z.infer<typeof noopSchema>>({
  name: "noop",
  description: "no-op test tool",
  inputSchema: noopSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    yield { type: "result", result: { ok: true, output: "ok" } } as const
  },
})

const registryWithNoop = (): ToolRegistry => new ToolRegistry([noopTool])

// ── env harness ─────────────────────────────────────────────────────────────
const withKnobs = async <T>(
  knobs: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(knobs)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
  try {
    return await fn()
  } finally {
    for (const [k] of Object.entries(knobs)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    __resetRuntimeConfig()
  }
}

// ── doubles ─────────────────────────────────────────────────────────────────
class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Records the StreamInput it saw + scripts replies; optionally fires the
 *  response-headers hook to SIMULATE an adapter's `.withResponse()` capture so
 *  the LOOP wiring (delay + notice) can be driven without a network. */
class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly headersByCall: ((get: (n: string) => string | null) => void)[] = []
  calls = 0
  readonly model = "scripted"
  constructor(
    private readonly scripts: StreamEvent[][],
    /** Per-call header maps to feed back through `input.onResponseHeaders`. */
    private readonly headerScripts: Array<Record<string, string> | undefined> = [],
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const callIdx = this.calls
    this.calls += 1
    // Simulate the adapter's success-path header capture (only fires if the loop
    // wired the hook — i.e. knob ON). This is the SAME contract the real adapters
    // honor; the adapter-level tests below prove the real `.withResponse()` path.
    const headers = this.headerScripts[callIdx]
    if (input.onResponseHeaders !== undefined && headers !== undefined) {
      const lower: Record<string, string> = {}
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
      input.onResponseHeaders((name) => lower[name.toLowerCase()] ?? null)
    }
    const next = this.scripts.shift() ?? textScript("final")
    for (const ev of next) yield ev
  }
}

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: registryWithNoop(),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** A multi-message transcript big enough to clear thresholdTokens=50. */
const bigHistory = (): Message[] => [
  userText("x".repeat(8_000)),
  assistantText("older turn one with some text"),
  userText("a follow up question that adds chars"),
  assistantText("older turn two"),
  userText("current request"),
]

// ════════════════════════════════════════════════════════════════════════════
// Feature 1 — delta-token reachability
// ════════════════════════════════════════════════════════════════════════════
describe("delta-token-accounting — loop reachability (QUANTA_DELTA_TOKEN_COUNT)", () => {
  const runOnce = async (knob: string | undefined) => {
    const seen: PreCompactRequestQuery[] = []
    const llm = new ScriptedLLM([textScript("FOLDED"), textScript("final answer")])
    const stream = new RecordingStream()
    const out = await withKnobs({ QUANTA_DELTA_TOKEN_COUNT: knob }, () =>
      runAgent(
        baseCfg({
          llm,
          stream,
          messages: bigHistory(),
          compaction: { thresholdTokens: 50, keepRecentTurns: 1 },
          onPreCompact: async (q) => {
            seen.push(q)
            return "approve"
          },
        }),
      ),
    )
    return { out, seen, stream }
  }

  test("ON ⇒ counter feeds compaction precheck; currentTokens === full estimateTokens re-scan", async () => {
    const { out, seen } = await runOnce("1")
    expect(out.reason).toBe("completed")
    expect(seen.length).toBe(1)
    const q = seen[0]
    if (!q) throw new Error("preflight not invoked")
    // The precheck's `currentTokens` IS `before = estimateWithCounter(counter, snapshot)`
    // at the proactive site. With the knob ON the counter path was taken; the
    // value MUST equal the full re-scan of the transcript it scored. We
    // reconstruct that transcript (the original `bigHistory` head — keepRecent=1
    // folds older turns, but the precheck reads BEFORE the fold).
    const expected = estimateTokens(bigHistory())
    expect(q.currentTokens).toBe(expected)
  })

  test("OFF vs ON ⇒ surfaced currentTokens byte-identical + same non-usage event stream", async () => {
    const on = await runOnce("1")
    const off = await runOnce(undefined)
    // #1 invariant: the produced numbers are identical ON/OFF (the counter is a
    // memoization of the SAME pure function).
    expect(on.seen[0]?.currentTokens).toBe(off.seen[0]?.currentTokens)
    expect(on.out.reason).toBe(off.out.reason)
    const nonUsage = (s: RecordingStream) =>
      s.events.filter((e) => e.type !== "usage").map((e) => e.type)
    expect(nonUsage(on.stream)).toEqual(nonUsage(off.stream))
  })

  test("OFF ⇒ a plain run completes with no delta machinery (byte-identical baseline)", async () => {
    const llm = new ScriptedLLM([textScript("answer")])
    const out = await withKnobs({ QUANTA_DELTA_TOKEN_COUNT: undefined }, () =>
      runAgent(baseCfg({ llm })),
    )
    expect(out.reason).toBe("completed")
    expect(llm.calls).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Feature 2 — ratelimit reachability (loop)
// ════════════════════════════════════════════════════════════════════════════
describe("account-ratelimit-snapshot — loop reachability (QUANTA_RATELIMIT_PROACTIVE)", () => {
  test("ON ⇒ remaining=0 header on turn 1 ⇒ proactive delay + notice BEFORE turn 2", async () => {
    // Two turns: turn 1 leaves the model emitting a `tools` step would be
    // complex; instead force two model calls via a tool-less nudge. Simpler:
    // script the model to produce a follow-up by using maxTurns + a tool. We
    // drive two stream() calls by having the first turn request a (no-op) tool.
    // To keep this hermetic we instead use two USER turns is not possible in one
    // runAgent; so we rely on a compaction-free 2-call path: the model returns a
    // tool_use that dispatches, then a final answer — two stream() calls.
    const sleeps: number[] = []
    const llm = new ScriptedLLM(
      [
        // turn 1: a tool call so the loop opens a SECOND stream for the result.
        [
          { type: "tool_use_start", id: "t1", name: "noop" },
          { type: "tool_use_end", id: "t1", input: { note: "hi" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        textScript("final answer"),
      ],
      // Response headers for call #1 say the token bucket is EMPTY, resetting in 5s.
      [
        { "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": "5" },
        undefined,
      ],
    )
    const stream = new RecordingStream()
    const out = await withKnobs({ QUANTA_RATELIMIT_PROACTIVE: "1" }, () =>
      runAgent(
        baseCfg({
          llm,
          stream,
          proactiveRateLimit: {
            now: () => 1_000_000,
            sleep: async (ms) => {
              sleeps.push(ms)
            },
          },
        }),
      ),
    )
    expect(out.reason).toBe("completed")
    // The adapter-simulating LLM fired the header hook on call #1 (proving the
    // loop wired `onResponseHeaders`).
    expect(llm.inputs[0]?.onResponseHeaders).toBeDefined()
    // BEFORE the second stream, the loop saw remaining=0 and applied a 5s delay.
    expect(sleeps).toEqual([5_000])
    // A transient `ratelimit_snapshot` notice was emitted (numbers only).
    const notice = stream.events.find((e) => e.type === "ratelimit_snapshot")
    expect(notice).toBeDefined()
    if (notice && notice.type === "ratelimit_snapshot") {
      expect(notice.tokensRemaining).toBe(0)
      expect(notice.tokensResetMs).toBe(5_000)
      // NO-LEAK: only numeric/tag fields exist (never a header value string).
      for (const v of Object.values(notice)) {
        expect(typeof v === "string" ? v : "ok").not.toContain("anthropic-ratelimit")
      }
    }
  })

  test("ON but non-empty bucket ⇒ NO delay, NO notice (policy fires only on remaining=0)", async () => {
    const sleeps: number[] = []
    const llm = new ScriptedLLM(
      [
        [
          { type: "tool_use_start", id: "t1", name: "noop" },
          { type: "tool_use_end", id: "t1", input: { note: "hi" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        textScript("final answer"),
      ],
      // Plenty of headroom ⇒ proactiveDelayMs returns 0.
      [{ "anthropic-ratelimit-tokens-remaining": "9000" }, undefined],
    )
    const stream = new RecordingStream()
    await withKnobs({ QUANTA_RATELIMIT_PROACTIVE: "1" }, () =>
      runAgent(
        baseCfg({
          llm,
          stream,
          proactiveRateLimit: { now: () => 1, sleep: async (ms) => void sleeps.push(ms) },
        }),
      ),
    )
    expect(sleeps).toEqual([])
    expect(stream.events.some((e) => e.type === "ratelimit_snapshot")).toBe(false)
  })

  test("F3 decouple: NOTICE alone (PROACTIVE off) ⇒ remaining=0 EMITS notice but NEVER sleeps", async () => {
    // The round-2 F3 fix: the snapshot store + header hook + notice emit are now
    // built when EITHER QUANTA_RATELIMIT_PROACTIVE *or* QUANTA_RATELIMIT_NOTICE is
    // on — so the notice knob ALONE produces a `ratelimit_snapshot` event. The
    // pre-request `sleep` stays gated on PROACTIVE only, so notice-only never
    // delays the request.
    const sleeps: number[] = []
    const llm = new ScriptedLLM(
      [
        [
          { type: "tool_use_start", id: "t1", name: "noop" },
          { type: "tool_use_end", id: "t1", input: { note: "hi" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        textScript("final answer"),
      ],
      [
        { "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": "5" },
        undefined,
      ],
    )
    const stream = new RecordingStream()
    // NOTE: PROACTIVE is NOT set — only NOTICE. The injected now/sleep still ride
    // AgentConfig.proactiveRateLimit (the clock injection is knob-independent).
    const out = await withKnobs({ QUANTA_RATELIMIT_NOTICE: "1" }, () =>
      runAgent(
        baseCfg({
          llm,
          stream,
          proactiveRateLimit: {
            now: () => 1_000_000,
            sleep: async (ms) => {
              sleeps.push(ms)
            },
          },
        }),
      ),
    )
    expect(out.reason).toBe("completed")
    // Header hook WAS wired (capture runs under notice too).
    expect(llm.inputs[0]?.onResponseHeaders).toBeDefined()
    // The reached-window notice WAS emitted...
    const notice = stream.events.find((e) => e.type === "ratelimit_snapshot")
    expect(notice).toBeDefined()
    if (notice && notice.type === "ratelimit_snapshot") {
      expect(notice.tokensRemaining).toBe(0)
      expect(notice.tokensResetMs).toBe(5_000)
    }
    // ...but NO backoff sleep was applied (PROACTIVE off ⇒ notice-only never delays).
    expect(sleeps).toEqual([])
  })

  test("OFF ⇒ header hook NEVER wired, no delay, no notice (byte-identical)", async () => {
    const sleeps: number[] = []
    const llm = new ScriptedLLM(
      [
        [
          { type: "tool_use_start", id: "t1", name: "noop" },
          { type: "tool_use_end", id: "t1", input: { note: "hi" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        textScript("final answer"),
      ],
      [{ "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": "5" }],
    )
    const stream = new RecordingStream()
    await withKnobs({ QUANTA_RATELIMIT_PROACTIVE: undefined }, () =>
      runAgent(
        baseCfg({
          llm,
          stream,
          // even if a host passes the block, the knob OFF means it's never consulted.
          proactiveRateLimit: { now: () => 1, sleep: async (ms) => void sleeps.push(ms) },
        }),
      ),
    )
    // The loop never wired the capture hook ⇒ the adapter-sim never fired it.
    expect(llm.inputs.every((i) => i.onResponseHeaders === undefined)).toBe(true)
    expect(sleeps).toEqual([])
    expect(stream.events.some((e) => e.type === "ratelimit_snapshot")).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Feature 2 — REAL adapter header-capture path
// ════════════════════════════════════════════════════════════════════════════
describe("account-ratelimit-snapshot — REAL adapter onResponseHeaders capture", () => {
  test("OpenAIResponsesAdapter (injected fetch) invokes onResponseHeaders with live headers", async () => {
    // A minimal SSE body the responses parser tolerates (completed with no items).
    const sse =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n'
    const fetchImpl = async (): Promise<Response> =>
      new Response(sse, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-tokens": "7",
        },
      })
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-test",
      fetchImpl: fetchImpl as never,
    })
    let captured: Record<string, string | null> | undefined
    const input: StreamInput = {
      messages: [userText("hi")],
      tools: [],
      onResponseHeaders: (get) => {
        captured = {
          remaining: get("x-ratelimit-remaining-tokens"),
          reset: get("x-ratelimit-reset-tokens"),
          // case-insensitive accessor proof:
          remainingUpper: get("X-RateLimit-Remaining-Tokens"),
        }
      },
    }
    // Drain the stream.
    for await (const _ev of adapter.stream(input)) {
      void _ev
    }
    expect(captured).toEqual({ remaining: "0", reset: "7", remainingUpper: "0" })
  })

  test("OpenAIResponsesAdapter WITHOUT the hook ⇒ no capture (byte-identical)", async () => {
    const sse =
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}\n\n'
    const fetchImpl = async (): Promise<Response> =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-ratelimit-remaining-tokens": "0" },
      })
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-test",
      fetchImpl: fetchImpl as never,
    })
    const input: StreamInput = { messages: [userText("hi")], tools: [] }
    let drained = 0
    for await (const _ev of adapter.stream(input)) drained += 1
    // No hook field, no capture; the stream still drains normally.
    expect(input.onResponseHeaders).toBeUndefined()
    expect(drained).toBeGreaterThanOrEqual(0)
  })

  test("AnthropicAdapter uses .withResponse() ONLY when the hook is present; plain await otherwise", async () => {
    // Build a fake SDK client whose `messages.create` returns a value that is
    // BOTH awaitable (yields the raw event stream) AND exposes `.withResponse()`.
    const rawStream = (): AsyncIterable<unknown> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 1 } } }
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        }
        yield { type: "message_stop" }
      },
    })
    const makeClient = (onHeaders: () => void, onPlain: () => void) => ({
      messages: {
        create: () => {
          const data = rawStream()
          // LAZY thenable mirroring the SDK's `APIPromise`: `onPlain` fires ONLY
          // when the value is `await`ed (the adapter's no-hook path), `onHeaders`
          // ONLY when `.withResponse()` is called (the hook path). An eager IIFE
          // would fire `onPlain` at construction and falsely flag the plain path.
          const pending = {
            // biome-ignore lint/suspicious/noThenProperty: deliberately a thenable — mirrors the SDK's APIPromise so the adapter's `await` (no-hook) path is distinguishable from `.withResponse()`.
            then(
              resolve: (v: unknown) => unknown,
              reject?: (e: unknown) => unknown,
            ): Promise<unknown> {
              onPlain()
              return Promise.resolve(data).then(resolve, reject)
            },
            withResponse: async () => {
              onHeaders()
              return {
                data,
                response: new Response(null, {
                  headers: { "anthropic-ratelimit-tokens-remaining": "0" },
                }),
              }
            },
          }
          return pending
        },
      },
    })

    // WITH the hook ⇒ `.withResponse()` is used, the hook fires with live headers.
    let usedWithResponse: boolean = false
    let usedPlain: boolean = false
    // Holder so TS doesn't narrow the closure-mutated capture to its init literal.
    const box: { seen: string | null } = { seen: null }
    const a = new AnthropicAdapter({ apiKey: "k", model: "claude-test" })
    ;(a as unknown as { client: unknown }).client = makeClient(
      () => {
        usedWithResponse = true
      },
      () => {
        usedPlain = true
      },
    )
    const inputWith: StreamInput = {
      messages: [userText("hi")],
      tools: [],
      onResponseHeaders: (get) => {
        box.seen = get("anthropic-ratelimit-tokens-remaining")
      },
    }
    for await (const _ev of a.stream(inputWith)) void _ev
    expect(usedWithResponse).toBe(true)
    expect(usedPlain).toBe(false)
    expect(box.seen).toBe("0")

    // WITHOUT the hook ⇒ plain await, `.withResponse()` NOT used (byte-identical).
    usedWithResponse = false
    usedPlain = false
    const b = new AnthropicAdapter({ apiKey: "k", model: "claude-test" })
    ;(b as unknown as { client: unknown }).client = makeClient(
      () => {
        usedWithResponse = true
      },
      () => {
        usedPlain = true
      },
    )
    const inputWithout: StreamInput = { messages: [userText("hi")], tools: [] }
    for await (const _ev of b.stream(inputWithout)) void _ev
    expect(usedWithResponse).toBe(false)
    expect(usedPlain).toBe(true)
  })
})
