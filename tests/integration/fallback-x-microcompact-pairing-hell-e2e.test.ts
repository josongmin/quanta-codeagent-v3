/**
 * H5 SOTA++ hellgate — fallback provider SWAP × tier-1 microcompaction
 * (tool_result CONTENT eviction) cross-interaction, driven through the REAL
 * `runAgent` loop.
 *
 * # The adversarial scenario
 *
 * One turn, three forces stacked:
 *   1. The transcript carries a MULTI-tool prior history (many `tool_use`↔
 *      `tool_result` pairs, several with big stale dumps).
 *   2. `QUANTA_MICROCOMPACT=1` ⇒ `maybeCompact` runs the tier-1 pre-pass BEFORE
 *      the turn, which NULLs OUT the bodies of the OLD tool_results (keeps the
 *      block, keeps `tool_use_id`) and installs the shrunk transcript via
 *      `wm.replace`. The model turn is then dispatched against that emptied set.
 *   3. The PRIMARY provider yields a partial then throws an overload (529).
 *      `FallbackLLM` advances to the secondary and prefixes its stream with a
 *      `{type:"stream_reset"}` tombstone. `streamingTurn` discards the dead
 *      primary partial and re-accumulates only the fallback's output.
 *
 * The hazard H5 seals: the message sequence RE-SENT to the fallback provider
 * (the outbound assembly) is built from the SAME microcompacted transcript. If
 * eviction ever broke a pair (dropped a block instead of clearing content), or
 * the tombstone path ever leaked an orphan `tool_use` from the dead partial,
 * the fallback request is model-INVALID and the provider 400s.
 *
 * # The invariant + the ORACLE
 *
 * We capture the EXACT `StreamInput.messages` the FALLBACK provider's
 * `stream(input)` receives (the real outbound assembly) and assert, for that
 * array:
 *   - every `tool_use` block `id` has a matching `tool_result` `tool_use_id`
 *     AFTER it (no orphan use), AND every `tool_result` references a preceding
 *     `tool_use` (no orphan result) — even where the body is the cleared
 *     placeholder;
 *   - the array is model-valid per the production reconciler
 *     `reconcileToolPairing` (the wire SSOT both Anthropic + OpenAI 400-rules
 *     are encoded against). A correctly-paired array is returned by identity
 *     (same reference) — so `reconcile(msgs) === msgs` is a ZERO-heuristic,
 *     SSOT-backed proof of model-validity. No hand-rolled threshold.
 *
 * # red-on-injection
 *
 * A standalone unit (no loop) feeds `microcompactToolResults` then
 * `reconcileToolPairing`; mutating eviction to DROP a paired block (instead of
 * clearing its content) is shown to make the reconciler synthesize a stub /
 * change the reference — i.e. the oracle goes RED. This proves the assertion
 * has teeth (it is not vacuously green on any input).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import { FallbackLLM, type LLMPort, type Message, type StreamEvent, type StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig, LLMError, reconcileToolPairing } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { microcompactToolResults } from "@/agent/tool-result-evict"
import { defaultTools, ToolRegistry } from "@/tool"

// ── doubles ────────────────────────────────────────────────────────────────

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Yields the given events, THEN throws (a mid-stream provider death). Records
 *  the `StreamInput` it was called with so the outbound assembly is inspectable. */
class PartialThenThrow implements LLMPort {
  readonly model = "primary-model"
  readonly inputs: StreamInput[] = []
  calls = 0
  constructor(
    private readonly partial: StreamEvent[],
    private readonly error: unknown,
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    for (const e of this.partial) yield e
    throw this.error
  }
}

/** Plain scripted fallback provider; records every `StreamInput`. */
class Fallback implements LLMPort {
  readonly model = "fallback-model"
  readonly inputs: StreamInput[] = []
  calls = 0
  constructor(private readonly events: StreamEvent[]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    for (const e of this.events) yield e
  }
}

// ── transcript builders ──────────────────────────────────────────────────────

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/** A MULTI-tool prior history: each prior turn issues TWO tool_use blocks in a
 *  single assistant message, answered by a single user message carrying BOTH
 *  tool_result blocks with big stale dumps — exactly the pairing shape tier-1
 *  eviction must keep intact while emptying the bodies. */
const multiToolHistory = (turns: number): Message[] => {
  const out: Message[] = [userText("start the multi-tool task")]
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "text", text: `STEP ${i}: reasoning to keep verbatim` },
        { type: "tool_use", id: `a${i}`, name: "Read", input: { path: `fa${i}` } },
        { type: "tool_use", id: `b${i}`, name: "Read", input: { path: `fb${i}` } },
      ],
    })
    out.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `a${i}`, content: `dumpA${i}:${"x".repeat(40_000)}` },
        { type: "tool_result", tool_use_id: `b${i}`, content: `dumpB${i}:${"y".repeat(40_000)}` },
      ],
    })
  }
  out.push(userText("now produce the final answer"))
  return out
}

// ── pairing oracle (SSOT-backed) ─────────────────────────────────────────────

/** Collect every `tool_use` id and every `tool_result` id from a message
 *  array, in forward order, so the per-id matching can be asserted directly
 *  (independent of the reconciler — a second, structural witness). */
const collectPairIds = (
  messages: readonly Message[],
): { useIds: string[]; resultIds: string[] } => {
  const useIds: string[] = []
  const resultIds: string[] = []
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.push(b.id)
      else if (b.type === "tool_result") resultIds.push(b.tool_use_id)
    }
  }
  return { useIds, resultIds }
}

/** True iff EVERY tool_use id has a matching tool_result id AND vice-versa —
 *  the structural pairing invariant (orphan-free in both directions). */
const everyPairMatched = (messages: readonly Message[]): boolean => {
  const { useIds, resultIds } = collectPairIds(messages)
  const useSet = new Set(useIds)
  const resultSet = new Set(resultIds)
  for (const id of useIds) if (!resultSet.has(id)) return false
  for (const id of resultIds) if (!useSet.has(id)) return false
  return true
}

/** Model-validity via the production reconciler. A correctly-paired array is
 *  returned BY IDENTITY (same top-level reference, zero allocation), so the
 *  identity check is a zero-heuristic proof the wire would NOT 400. */
const isModelValid = (messages: readonly Message[]): boolean =>
  reconcileToolPairing(messages) === messages

// ── config ───────────────────────────────────────────────────────────────────

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 1,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const makeOverload = (): unknown => {
  const overload = new LLMError("529 Overloaded", { kind: "overloaded", statusCode: 529 })
  ;(overload as unknown as { status: number }).status = 529
  return overload
}

// ── knob save/restore ────────────────────────────────────────────────────────

const KNOBS = [
  "QUANTA_MICROCOMPACT",
  "QUANTA_MICROCOMPACT_FLOOR_TOKENS",
  "QUANTA_MICROCOMPACT_INTERVAL_MS",
  "QUANTA_MICROCOMPACT_KEEP_RECENT",
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KNOBS) saved[k] = process.env[k]
  __resetRuntimeConfig()
})
afterEach(() => {
  for (const k of KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const enableMicrocompact = (): void => {
  process.env.QUANTA_MICROCOMPACT = "1"
  process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = "100"
  process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = "1"
  process.env.QUANTA_MICROCOMPACT_KEEP_RECENT = "1"
  __resetRuntimeConfig()
}

describe("H5 — fallback swap × microcompact tool_result eviction pairing integrity", () => {
  test("microcompact empties tool_results, primary 529→fallback swap; fallback's outbound assembly is orphan-free + model-valid", async () => {
    enableMicrocompact()

    const primary = new PartialThenThrow(
      [{ type: "text_delta", delta: "DEAD-PARTIAL primary text that the tombstone must discard" }],
      makeOverload(),
    )
    const fallback = new Fallback([
      { type: "text_delta", delta: "FALLBACK final answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm,
        stream,
        messages: multiToolHistory(4),
        // Threshold high enough that tier-2 summarization NEVER crosses — only
        // tier-1 eviction shrinks the transcript, so we isolate the eviction ×
        // fallback interaction.
        compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
      }),
    )

    // The swap actually happened end-to-end.
    expect(out.reason).toBe("completed")
    expect(primary.calls).toBe(1)
    expect(fallback.calls).toBe(1)

    // tier-1 microcompaction actually fired (recovery:compact / microcompact).
    expect(
      stream.events.some(
        (e) => e.type === "recovery" && e.reason === "compact" && e.detail === "microcompact",
      ),
    ).toBe(true)

    // The OUTBOUND assembly the FALLBACK provider was re-sent.
    const sent = fallback.inputs[0]?.messages ?? []
    expect(sent.length).toBeGreaterThan(0)

    // Eviction actually emptied OLD tool_result bodies (so this is the real
    // hazard path, not a no-op pass-through).
    const clearedCount = sent
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
      ).length
    expect(clearedCount).toBeGreaterThan(0)

    // INVARIANT 1 — every tool_use id ↔ tool_result id matches both ways.
    const { useIds, resultIds } = collectPairIds(sent)
    expect(useIds.length).toBeGreaterThan(0)
    expect(everyPairMatched(sent)).toBe(true)
    // Each prior multi-tool turn contributed a use; all are still present.
    for (const id of ["a0", "b0", "a3", "b3"]) {
      expect(useIds).toContain(id)
      expect(resultIds).toContain(id)
    }

    // INVARIANT 2 — model-valid per the production wire SSOT (zero repair).
    expect(isModelValid(sent)).toBe(true)

    // The fallback assembly carried the post-reset answer context, never the
    // dead primary partial (tombstone discard is whole).
    const sentText = sent
      .flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    expect(sentText).not.toContain("DEAD-PARTIAL")
    // Reasoning text survived eviction verbatim.
    expect(sentText).toContain("STEP 0: reasoning to keep verbatim")
  })

  test("NO swap (primary succeeds) with microcompact ON ⇒ outbound assembly still orphan-free + model-valid (no-op control)", async () => {
    enableMicrocompact()

    const primary = new PartialThenThrow([], makeOverload()) // unused error: never thrown
    // Build a primary that SUCCEEDS so no fallback swap occurs.
    const ok = new Fallback([
      { type: "text_delta", delta: "primary answer, no swap" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    void primary
    const llm = new FallbackLLM({ providers: [ok] })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm,
        stream,
        messages: multiToolHistory(4),
        compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
      }),
    )

    expect(out.reason).toBe("completed")
    expect(ok.calls).toBe(1)

    const sent = ok.inputs[0]?.messages ?? []
    // microcompact still emptied old bodies on the no-swap path.
    const clearedCount = sent
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
      ).length
    expect(clearedCount).toBeGreaterThan(0)
    // Pairing + model-validity hold on the un-swapped path too (no regression
    // from the eviction alone).
    expect(everyPairMatched(sent)).toBe(true)
    expect(isModelValid(sent)).toBe(true)
  })

  test("microcompact OFF + fallback swap ⇒ pairing still intact (eviction not even in play)", async () => {
    // Knobs left default-OFF (beforeEach reset; no enableMicrocompact()).
    delete process.env.QUANTA_MICROCOMPACT
    __resetRuntimeConfig()

    const primary = new PartialThenThrow(
      [{ type: "text_delta", delta: "DEAD-PARTIAL" }],
      makeOverload(),
    )
    const fallback = new Fallback([
      { type: "text_delta", delta: "fallback answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const llm = new FallbackLLM({ providers: [primary, fallback] })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm,
        stream,
        messages: multiToolHistory(3),
        compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
      }),
    )

    expect(out.reason).toBe("completed")
    expect(fallback.calls).toBe(1)
    const sent = fallback.inputs[0]?.messages ?? []
    // Nothing was cleared (knob OFF) — the original bodies are intact.
    const cleared = sent
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
      )
    expect(cleared.length).toBe(0)
    // Pairing still whole through the swap on the un-evicted path.
    expect(everyPairMatched(sent)).toBe(true)
    expect(isModelValid(sent)).toBe(true)
  })

  // ── red-on-injection: prove the oracle has teeth ───────────────────────────
  test("RED-ON-INJECTION: eviction that DROPS a paired block (not clear) makes the SSOT oracle go RED", () => {
    const history = multiToolHistory(4)
    // Real eviction: clears CONTENT, keeps the block + its tool_use_id.
    const evicted = microcompactToolResults({
      messages: history,
      keepRecent: 1,
      tokensSavedFloor: 100,
    })
    expect(evicted.changed).toBe(true)
    // The REAL eviction output is orphan-free + model-valid (the property under
    // test). reconciler returns the SAME reference ⇒ no repair was needed.
    expect(everyPairMatched(evicted.messages as Message[])).toBe(true)
    expect(reconcileToolPairing(evicted.messages) === evicted.messages).toBe(true)

    // INJECTION — simulate the latent bug class this hellgate guards against:
    // an eviction that REMOVES a tool_result block instead of clearing its
    // content. Drop the first tool_result block from the evicted array.
    const broken: Message[] = (evicted.messages as Message[]).map((m) => ({
      ...m,
      content: m.content.filter(
        (b) => !(b.type === "tool_result" && b.tool_use_id === "a0"),
      ),
    }))
    // The structural witness must now see an orphan tool_use (`a0` with no result).
    expect(everyPairMatched(broken)).toBe(false)
    // And the SSOT reconciler must REPAIR it (synthesize a stub) ⇒ a DIFFERENT
    // reference + a synthesized placeholder ⇒ the model-valid oracle is RED.
    const repaired = reconcileToolPairing(broken)
    expect(repaired === broken).toBe(false)
    const repairedText = (repaired as Message[])
      .flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result")
      .map((b) => b.content)
      .join("\n")
    expect(repairedText).toContain("synthesized to keep the transcript valid")
  })
})
