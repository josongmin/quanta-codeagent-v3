/**
 * HELLGATE — delta-token LOOP WIRING e2e (RFC jun-6-delta-token-accounting host
 * wiring). The pure counter and its arithmetic are sealed elsewhere
 * (`delta-token-identity-hellgate`, `delta-token-property-fuzz-r2-hellgate`).
 * This battery proves the WIRING is LIVE and DRIFT-FREE through the REAL
 * `createRunAgentContext` composition root + `runAgent` loop:
 *
 *   (a) knob ON  ⇒ `createRunAgentContext` decorates the wm; `wm.tokenTotal()`
 *       equals `estimateTokens(wm.snapshot())` at EVERY step — after appends,
 *       after a `replace` (compaction/fork reseed), after a `clear` reseed, and
 *       after an out-of-band in-place rewrite (`tokenReseed`). A seeded fuzz
 *       sequence asserts total()≡estimateTokens after every mutation.
 *   (b) knob OFF ⇒ NO `tokenTotal`/`tokenReseed` methods (raw wm); read sites
 *       fall back to `estimateTokens`, byte-identical.
 *   (c) the compaction-wire `before`/precheck `currentTokens` gate equals a full
 *       re-scan ON and OFF (surfaced number identical) through the real loop.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, PreCompactRequestQuery } from "@/agent"
import { charsOf, estimateTokens, runAgent } from "@/agent"
import { createRunAgentContext } from "@/agent/loop/session-bootstrap"
import { emitUserPromptSubmitHook } from "@/agent/loop/session-hooks"
import { decorateWithDeltaCounter } from "@/agent/token-delta/wm-decorator"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { AgentEvent, StreamPort } from "@/stream"
import { defineTool, ToolRegistry } from "@/tool"

// ── knob harness ─────────────────────────────────────────────────────────────
const withKnob = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const KEY = "QUANTA_DELTA_TOKEN_COUNT"
  const saved = process.env[KEY]
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  __resetRuntimeConfig()
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
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

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted"
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts.shift() ?? textScript("final")
    for (const ev of next) yield ev
  }
}

const noopSchema = z.object({ note: z.string().optional() })
const noopTool = defineTool<z.infer<typeof noopSchema>>({
  name: "noop",
  description: "no-op",
  inputSchema: noopSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    yield { type: "result", result: { ok: true, output: "ok" } } as const
  },
})

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry([noopTool]),
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

type DeltaWm = import("@/memory").WorkingMemory<Message> & {
  tokenTotal?(): number
  tokenReseed?(): void
}

// ════════════════════════════════════════════════════════════════════════════
// (a) ON ⇒ real composition root decorates wm; total() ≡ estimateTokens always
// ════════════════════════════════════════════════════════════════════════════
describe("createRunAgentContext wires the delta counter (knob ON)", () => {
  test("tokenTotal() === estimateTokens(snapshot()) after append/replace/clear/rewrite", async () => {
    await withKnob("1", async () => {
      const ctx = await createRunAgentContext(
        baseCfg({ llm: new ScriptedLLM([]), messages: [userText("seed-prompt")] }),
      )
      const wm = ctx.wm as DeltaWm
      // The decorator IS present (knob ON).
      expect(typeof wm.tokenTotal).toBe("function")
      expect(typeof wm.tokenReseed).toBe("function")

      const check = (): void => {
        expect(wm.tokenTotal?.()).toBe(estimateTokens([...wm.snapshot()]))
      }
      check() // seed
      wm.append(assistantText("first reply with some chars"))
      check()
      wm.append(userText("y".repeat(2000)))
      check()
      // replace = compaction/fork reseed point.
      wm.replace([userText("<conversation summary>\nfolded"), userText("recent")])
      check()
      wm.append(assistantText("post-compaction turn"))
      check()
      // out-of-band in-place rewrite that bypasses append/replace → tokenReseed.
      wm.messages[0] = userText("<conversation summary>\nfolded REWRITTEN longer text here")
      wm.tokenReseed?.()
      check()
      // clear reseed.
      wm.clear()
      check()
      expect(wm.tokenTotal?.()).toBe(0)
    })
  })

  test("seeded fuzz: total() ≡ estimateTokens after EVERY mutation (no drift)", async () => {
    await withKnob("1", async () => {
      const ctx = await createRunAgentContext(
        baseCfg({ llm: new ScriptedLLM([]), messages: [userText("seed")] }),
      )
      const wm = ctx.wm as DeltaWm
      // Deterministic LCG (no Math.random).
      let s = 0x1234_5678 >>> 0
      const rng = (): number => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 0x100000000
      }
      for (let i = 0; i < 400; i++) {
        const op = Math.floor(rng() * 4)
        const len = 1 + Math.floor(rng() * 80)
        if (op === 0) {
          wm.append(userText("a".repeat(len)))
        } else if (op === 1) {
          wm.append(assistantText("b".repeat(len)))
        } else if (op === 2) {
          // replace with a fresh small set (reseed).
          wm.replace([userText("r".repeat(len)), assistantText("s".repeat(len))])
        } else {
          // out-of-band rewrite of message 0 (if any), then reseed.
          const snap = [...wm.snapshot()]
          if (snap.length > 0) {
            wm.messages[0] = userText("c".repeat(len))
            wm.tokenReseed?.()
          }
        }
        // Invariant after every mutation: memoized total === full re-scan.
        const snap = [...wm.snapshot()]
        expect(wm.tokenTotal?.()).toBe(estimateTokens(snap))
        // And the pre-ceil contract: ceil(charsOf/4) === estimateTokens.
        expect(estimateTokens(snap)).toBe(Math.ceil(charsOf(snap) / 4))
      }
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// (a') the user_prompt_submit in-place rewrite auto-reseeds (no drift)
// ════════════════════════════════════════════════════════════════════════════
describe("emitUserPromptSubmitHook in-place rewrite keeps the counter drift-free", () => {
  test("after a longer updatedPrompt, tokenTotal() === estimateTokens(snapshot())", async () => {
    const inner = createWorkingMemory<Message>([assistantText("prior"), userText("short")])
    const wm = decorateWithDeltaCounter(inner)
    // Before the rewrite the counter is anchored.
    expect(wm.tokenTotal()).toBe(estimateTokens([...wm.snapshot()]))
    const cfg = {
      llm: { stream: async function* () {} },
      registry: new ToolRegistry([]),
      stream: new RecordingStream(),
      maxTurns: 1,
      signal: new AbortController().signal,
      hooks: {
        emit: async () => ({ deny: null, updatedPrompt: "a much longer rewritten prompt body" }),
      },
    } as unknown as AgentConfig
    const denied = await emitUserPromptSubmitHook(cfg, wm, "s1")
    expect(denied).toBeNull()
    // The in-place `wm.messages[i] = …` bypassed append/replace, but the hook's
    // `tokenReseed()` re-anchored — so NO drift.
    expect(wm.tokenTotal()).toBe(estimateTokens([...wm.snapshot()]))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// (b) OFF ⇒ raw wm, no methods, byte-identical
// ════════════════════════════════════════════════════════════════════════════
describe("createRunAgentContext leaves wm raw (knob OFF) — byte-identical", () => {
  test("no tokenTotal/tokenReseed methods; snapshot semantics unchanged", async () => {
    await withKnob(undefined, async () => {
      const ctx = await createRunAgentContext(
        baseCfg({ llm: new ScriptedLLM([]), messages: [userText("seed")] }),
      )
      const wm = ctx.wm as DeltaWm
      expect(wm.tokenTotal).toBeUndefined()
      expect(wm.tokenReseed).toBeUndefined()
      // The OFF read path IS estimateTokens directly.
      const before = wm.tokenTotal?.() ?? estimateTokens([...wm.snapshot()])
      expect(before).toBe(estimateTokens([...wm.snapshot()]))
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// (c) the REAL loop's compaction precheck currentTokens === full re-scan ON & OFF
// ════════════════════════════════════════════════════════════════════════════
describe("compaction precheck gate reads a full-rescan-equal value (ON and OFF)", () => {
  const bigHistory = (): Message[] => [
    userText("x".repeat(8_000)),
    assistantText("older turn one with some text"),
    userText("a follow up question that adds chars"),
    assistantText("older turn two"),
    userText("current request"),
  ]

  const runOnce = async (knob: string | undefined) => {
    const seen: PreCompactRequestQuery[] = []
    const llm = new ScriptedLLM([textScript("FOLDED"), textScript("final answer")])
    const stream = new RecordingStream()
    const out = await withKnob(knob, () =>
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

  test("ON ⇒ currentTokens === estimateTokens(full pre-compaction transcript)", async () => {
    const { out, seen } = await runOnce("1")
    expect(out.reason).toBe("completed")
    expect(seen.length).toBe(1)
    expect(seen[0]?.currentTokens).toBe(estimateTokens(bigHistory()))
  })

  test("ON vs OFF ⇒ surfaced currentTokens byte-identical", async () => {
    const on = await runOnce("1")
    const off = await runOnce(undefined)
    expect(on.seen[0]?.currentTokens).toBe(off.seen[0]?.currentTokens)
    expect(on.out.reason).toBe(off.out.reason)
    const nonUsage = (s: RecordingStream) =>
      s.events.filter((e) => e.type !== "usage").map((e) => e.type)
    expect(nonUsage(on.stream)).toEqual(nonUsage(off.stream))
  })

  // ── Part A SACRED: full event-stream byte-identity (ON ≡ OFF ≡ pre-wiring) ──
  // The `?? estimateTokens` fallback is the OFF path; an OFF run is therefore the
  // pre-wiring loop verbatim. We assert the ENTIRE non-usage event stream is
  // DEEP-equal (`.toEqual`, not just event-type list) between ON and OFF — so the
  // decorator/counter cannot perturb a single surfaced field. Usage events carry
  // provider-side counters orthogonal to the counter and are excluded.
  test("ON vs OFF ⇒ FULL non-usage event stream deep-equal (no perturbation)", async () => {
    const on = await runOnce("1")
    const off = await runOnce(undefined)
    const nonUsage = (s: RecordingStream): AgentEvent[] =>
      s.events.filter((e) => e.type !== "usage")
    expect(nonUsage(on.stream)).toEqual(nonUsage(off.stream))
    // The full PreCompact query (every numeric field, not just currentTokens) is
    // byte-identical — proving the gate inputs the decorator surfaces never drift.
    expect(on.seen).toEqual(off.seen)
  })

  // ── Part B: STALE-LOW-COUNT → MISSED-COMPACTION vector ─────────────────────
  // The threshold DECISION is made INSIDE compactIfNeeded off a FRESH full
  // re-scan (`currentTokens = estimateTokens(input.messages)`), NOT off the
  // counter's `before`. So even a hypothetically stale-low `tokenTotal()` cannot
  // suppress a compaction. We prove the decision fires identically ON vs OFF at a
  // transcript sized to straddle the threshold, AND that `before` (the counter
  // read) equals the independent full re-scan at that instant — i.e. there is no
  // stale-low read in the first place (every non-append mutation reseeds).
  test("threshold gate fires identically ON & OFF; before === full re-scan (no stale-low miss)", async () => {
    // Sized so estimateTokens(history) is comfortably above the 50-token gate:
    // a stale-low counter that under-counted would (wrongly) skip compaction.
    const on = await runOnce("1")
    const off = await runOnce(undefined)
    // Both compact exactly once (the gate FIRED in both) — no missed compaction.
    expect(on.seen.length).toBe(1)
    expect(off.seen.length).toBe(1)
    // The counter read fed to the gate equals the independent full re-scan of the
    // pre-compaction transcript — so the surfaced `before` is NOT stale-low.
    expect(on.seen[0]?.currentTokens).toBe(estimateTokens(bigHistory()))
    expect(on.seen[0]?.currentTokens).toBeGreaterThan(50)
  })
})
