/**
 * Observability error-event regression — pins R-Phase1 P0-2 / P0-3 and
 * R-Phase2 P1-1 fixes.
 *
 * Two prior silent-failure paths in `prepareTurnContext`:
 *
 *   P0-2: proactive `maybeCompact` ⇒ if the summarizer LLM rejects (overloaded
 *         rate-limit, network failure, etc.) the exception propagated UNCAUGHT
 *         through `prepareTurnContext` and the turn aborted with NO `error`
 *         AgentEvent emitted. Probe/triage saw the turn just stop.
 *   P0-3: `resolveMemoryContext` ⇒ same shape — a failing embedder or store
 *         threw out of `recallContext`, the turn died with no observability.
 *
 * AFTER the fix: both sites convert their throw into a structured
 * `{type:"error", message: ...}` AgentEvent and degrade gracefully:
 *   - Compaction: skip this turn's proactive pass (reactive PTL remains the
 *     safety net for actual budget overruns).
 *   - Memory recall: degrade to "no memory context", same observable as a
 *     configured-but-empty store.
 *
 * P1-1: a SUCCESSFUL proactive compaction now also emits
 *   `{type:"recovery", reason:"compact", detail:"proactive"}` so trajectory
 *   consumers can distinguish proactive (top-of-turn threshold-driven) from
 *   reactive (PTL-driven) compactions. The reactive site already emits the
 *   `compact` reason; this closes the symmetry.
 *
 * The test uses real `runAgent` with a ScriptedLLM (mocks the model stream),
 * a `compactIfNeeded`-triggering token threshold of 0 (forces a compaction
 * attempt every turn), and an injected summarizer LLM that throws — driving
 * the P0-2 path. A separate test injects a memory store + embedder that throws
 * on `recall` for P0-3. P1-1 uses a "happy" summarizer LLM that returns a
 * shorter transcript.
 */
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import type { MentionResolverPort } from "@/agent/mention-injection"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { TypedHistoryEventStore } from "@/memory/typed-event"
import type { AgentEvent } from "@/stream"
import { cfg, ev, RecordingStream, ScriptedLLM, text, withTimeout } from "./_harness"

/** Summarizer LLM that always throws — drives the P0-2 error path. */
class ThrowingSummarizer implements LLMPort {
  readonly model = "throwing-summarizer"
  // biome-ignore lint/correctness/useYield: the throwing summarizer never yields events
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("summarizer-llm-unavailable")
  }
}

/** Summarizer LLM that emits a successful (very short) summary text — drives
 *  the P1-1 path where compaction succeeds and the proactive recovery event
 *  must fire. */
class HappySummarizer implements LLMPort {
  readonly model = "happy-summarizer"
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "compact-summary" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Minimal store + embedder that throw on the very first recall — drives the
 *  P0-3 error path. We satisfy the interface stubs but the recall path is the
 *  only one the loop calls in this test. */
const throwingStore: PersistentStorePort = {
  save: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
  get: async () => undefined,
  all: async () => [],
  recall: async () => {
    throw new Error("store-recall-unavailable")
  },
}

const noopEmbedder: EmbedderPort = {
  async embed(text: string[]): Promise<number[][]> {
    return text.map(() => [0.1, 0.2, 0.3])
  },
}

const findErrorEvent = (events: AgentEvent[], substring: string): AgentEvent | undefined =>
  events.find((e) => e.type === "error" && e.message.includes(substring))

const findRecoveryEvent = (
  events: AgentEvent[],
  reason: string,
  detail?: string,
): AgentEvent | undefined =>
  events.find(
    (e) =>
      e.type === "recovery" && e.reason === reason && (detail === undefined || e.detail === detail),
  )

describe("Observability — proactive compaction failure surfaces as error event (P0-2)", () => {
  test("summarizer LLM throws → `error` AgentEvent emitted, loop continues to completion", async () => {
    const llm = new ScriptedLLM([ev(text("done"))])
    const stream = new RecordingStream()
    // thresholdTokens:0 forces compaction to attempt on every turn. The
    // summarizer throws → before P0-2 fix the throw would bubble out and the
    // turn would abort; after the fix the error becomes a stream event and
    // the loop proceeds.
    // Need ≥ 2 assistant turns + a leading user/assistant pair for
    // `findBoundary(messages, keepTurns:1)` to return a boundary > 0 (i.e.
    // there's actually something to summarize). Threshold:0 forces the LLM
    // call so the throwing summarizer fires.
    const config = cfg({
      llm,
      stream,
      messages: [
        { role: "user", content: [{ type: "text", text: "seed turn 1" }] },
        { role: "assistant", content: [{ type: "text", text: "ack-1" }] },
        { role: "user", content: [{ type: "text", text: "seed turn 2" }] },
        { role: "assistant", content: [{ type: "text", text: "ack-2" }] },
        { role: "user", content: [{ type: "text", text: "continue please" }] },
      ] as Message[],
      compaction: {
        thresholdTokens: 0,
        keepRecentTurns: 1,
        summarizerLlm: new ThrowingSummarizer(),
      },
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "compaction-fail")
    // Loop reaches its terminal completion — the throw did NOT abort the run.
    expect(outcome.reason).toBe("completed")
    // Error event surfaces the failure for trajectory/probe consumption.
    const err = findErrorEvent(stream.events, "proactive compaction failed")
    expect(err).toBeDefined()
    if (err && err.type === "error") {
      expect(err.message).toContain("summarizer-llm-unavailable")
    }
  }, 15_000)
})

describe("Observability — memory recall failure surfaces as error event (P0-3)", () => {
  test("store.recall throws → `error` event emitted, turn continues without memory context", async () => {
    const llm = new ScriptedLLM([ev(text("done"))])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      stream,
      messages: [
        { role: "user", content: [{ type: "text", text: "what did we discuss last time?" }] },
      ] as Message[],
      store: throwingStore,
      embedder: noopEmbedder,
      memory: { recallLimit: 5 },
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "recall-fail")
    expect(outcome.reason).toBe("completed")
    const err = findErrorEvent(stream.events, "memory recall failed")
    expect(err).toBeDefined()
    if (err && err.type === "error") {
      expect(err.message).toContain("store-recall-unavailable")
    }
    // Loop produced its assistant text — the broken recall did NOT block it.
    const text0 = stream.events.find((e) => e.type === "assistant_text")
    expect(text0).toBeDefined()
  }, 15_000)
})

describe("Observability — successful proactive compaction emits recovery event (P1-1)", () => {
  test("happy summarizer + threshold:0 → recovery{reason:'compact',detail:'proactive'} fires", async () => {
    const llm = new ScriptedLLM([ev(text("done"))])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      stream,
      messages: [
        { role: "user", content: [{ type: "text", text: "long context turn 1" }] },
        { role: "assistant", content: [{ type: "text", text: "ack-1" }] },
        { role: "user", content: [{ type: "text", text: "another turn" }] },
        { role: "assistant", content: [{ type: "text", text: "ack-2" }] },
        { role: "user", content: [{ type: "text", text: "and one more" }] },
      ] as Message[],
      compaction: {
        thresholdTokens: 0,
        keepRecentTurns: 1,
        summarizerLlm: new HappySummarizer(),
      },
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "compaction-success")
    expect(outcome.reason).toBe("completed")
    // The proactive recovery event must surface so probe/triage can tell
    // proactive (threshold-driven) from reactive (PTL-driven) compactions.
    const rec = findRecoveryEvent(stream.events, "compact", "proactive")
    expect(rec).toBeDefined()
    if (rec && rec.type === "recovery") {
      expect(rec.reason).toBe("compact")
      expect(rec.detail).toBe("proactive")
    }
  }, 15_000)
})

/** A typed-history store double whose `append` never throws — kept so the
 *  install helper wires the context-events slot (it requires both `getSnapshot`
 *  AND `store`). The store's own behaviour is irrelevant here: we drive the
 *  failure through a throwing `getSnapshot`, which is the closure-entry input. */
const noopTypedStore = (): TypedHistoryEventStore =>
  ({ append: () => undefined }) as unknown as TypedHistoryEventStore

describe("Observability — INSTALLED codex-r2 context-events closure throw surfaces as error event (ALBB-09 site 2)", () => {
  test("throwing getSnapshot → `error` AgentEvent on stream (not only logger.warn), turn continues", async () => {
    const llm = new ScriptedLLM([ev(text("done"))])
    const stream = new RecordingStream()
    const config = cfg({ llm, stream })
    // Install the REAL codex-r2 context-events producer closure with a
    // getSnapshot that ALWAYS throws (the closure calls it FIRST thing every
    // turn, before the cursor-seed short-circuit, so a throw hits the
    // closure-entry catch on the very first invocation). The catch must RE-THROW
    // to the outer `resolveContextEventsForTurn` wrapper so its
    // `stream.emit({type:"error"})` fires — pre-fix the closure swallowed +
    // returned [] and NO error event ever reached the stream.
    installCodexR2Wires(config, {
      getSnapshot: () => {
        throw new Error("snapshot-boom")
      },
      store: noopTypedStore(),
    })
    expect(config.contextEventsForTurn).toBeDefined()

    const outcome = await withTimeout(runAgent(config), 10_000, "ctx-events-throw")
    expect(outcome.reason).toBe("completed")
    const err = findErrorEvent(stream.events, "context-events provider failed")
    expect(err).toBeDefined()
    if (err && err.type === "error") {
      expect(err.message).toContain("snapshot-boom")
    }
  }, 15_000)
})

describe("Observability — INSTALLED codex-r2 mention-injector closure throw surfaces as error event (ALBB-09 site 2)", () => {
  test("throwing mention resolver (closure-entry) → `error` AgentEvent on stream, turn continues", async () => {
    const llm = new ScriptedLLM([ev(text("done"))])
    const stream = new RecordingStream()
    // The user text references an `@file` mention so `parseMentions` yields a
    // mention; `pickResolver` (called OUTSIDE the per-mention safeCall) reads
    // `resolver.resolveFile` via a throwing getter → the throw escapes
    // `buildInjectionFragments` into the injector CLOSURE-ENTRY catch, which
    // must RE-THROW to `resolveMentionInjectionMessages` so its error emit fires.
    const config = cfg({
      llm,
      stream,
      messages: [
        { role: "user", content: [{ type: "text", text: "please read @src/x.ts now" }] },
      ] as Message[],
    })
    const hostileResolver = {
      get resolveFile(): never {
        throw new Error("resolver-boom")
      },
    } as unknown as MentionResolverPort
    installCodexR2Wires(config, { mentionResolver: hostileResolver })
    expect(config.mentionInjector).toBeDefined()

    const outcome = await withTimeout(runAgent(config), 10_000, "mention-throw")
    expect(outcome.reason).toBe("completed")
    // The closure-entry catch RE-THROWS to `resolveMentionInjectionMessages`,
    // which emits the `mention injection failed` error event. (We assert only the
    // outer-wrapper label, not the inner cause string — a global `parseMentions`
    // mock leaking from another test file can change WHICH inner call throws, but
    // the re-throw ⇒ error-event invariant holds either way.)
    const err = findErrorEvent(stream.events, "mention injection failed")
    expect(err).toBeDefined()
  }, 15_000)
})

describe("Observability — default-OFF byte-identical contract preserved", () => {
  test("no compaction config + no store → no error event, no recovery event (legacy path)", async () => {
    const llm = new ScriptedLLM([ev(text("clean run"))])
    const stream = new RecordingStream()
    const config = cfg({ llm, stream })

    const outcome = await withTimeout(runAgent(config), 10_000, "legacy-baseline")
    expect(outcome.reason).toBe("completed")
    // Neither the error-mapping nor the proactive-recovery branch fires when
    // their respective features are unconfigured.
    expect(stream.events.some((e) => e.type === "error")).toBe(false)
    expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false)
  }, 15_000)
})
