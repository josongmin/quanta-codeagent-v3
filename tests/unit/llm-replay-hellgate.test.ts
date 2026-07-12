/**
 * Hellgate for ADR-0192 — LLM session record/replay.
 *
 * Sections:
 *  A. JSONL store (6)
 *  B. Recording adapter (7)
 *  C. Replay adapter (6)
 *  D. Hash stability (3)
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StreamEvent, StreamInput } from "@/llm"
import { defaultResponsesContinuationStore, type LLMPort } from "@/llm"
import {
  defaultHashRequest,
  jsonlReplayStore,
  type RecordedInteraction,
  ReplayMissError,
  type ReplayStore,
  recordingLlmPort,
  replayLlmPort,
  stableStringify,
} from "@/llm/replay"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TMP_ROOT = mkdtempSync(join(tmpdir(), "quanta-replay-"))
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

let tmpCounter = 0
function tmpPath(): string {
  tmpCounter += 1
  return join(TMP_ROOT, `cassette-${tmpCounter}.jsonl`)
}

function req(text: string, extra: Partial<StreamInput> = {}): StreamInput {
  return {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [],
    ...extra,
  }
}

function rec(id: string, request: StreamInput, events: StreamEvent[]): RecordedInteraction {
  return {
    id,
    request,
    events,
    metadata: { recordedAt: 0, model: "test-model", durationMs: 1 },
  }
}

function stubInner(
  events: StreamEvent[],
  opts: { model?: string; throwAt?: number } = {},
): LLMPort {
  return {
    ...(opts.model !== undefined ? { model: opts.model } : { model: "stub-model" }),
    stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      async function* gen(): AsyncIterable<StreamEvent> {
        for (let i = 0; i < events.length; i++) {
          if (opts.throwAt !== undefined && i === opts.throwAt) {
            throw new Error(`boom at ${i}`)
          }
          const ev = events[i]
          if (ev !== undefined) yield ev
        }
      }
      return gen()
    },
  }
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

// ---------------------------------------------------------------------------
// A. JSONL store (6)
// ---------------------------------------------------------------------------

describe("A. jsonlReplayStore", () => {
  test("1. append + load roundtrip", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    const r1 = rec("id-1", req("hello"), [{ type: "text_delta", delta: "hi" }])
    const r2 = rec("id-2", req("world"), [{ type: "message_stop", stop_reason: "end_turn" }])
    await store.append(r1)
    await store.append(r2)
    const loaded = await store.load()
    expect(loaded.length).toBe(2)
    expect(loaded[0]?.id).toBe("id-1")
    expect(loaded[1]?.id).toBe("id-2")
    expect(loaded[0]?.events[0]).toEqual({ type: "text_delta", delta: "hi" })
  })

  test("2. match exact: identical request finds the record", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    const request = req("find me")
    await store.append(rec(defaultHashRequest(request, "exact"), request, []))
    const hit = await store.match(request, { policy: "exact" })
    expect(hit).not.toBeNull()
    expect(hit?.request.messages[0]?.content[0]).toEqual({ type: "text", text: "find me" })
  })

  test("3. match miss returns null when no record matches", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    await store.append(rec("only", req("present"), []))
    const miss = await store.match(req("absent"), { policy: "exact" })
    expect(miss).toBeNull()
  })

  test("4. messages-only policy ignores system / tool drift", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    const recorded: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "same body" }] }],
      tools: [{ name: "old", description: "old", input_schema: {} }],
      system: "old system",
    }
    await store.append(rec("m1", recorded, []))
    const incomingDifferentScaffolding: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "same body" }] }],
      tools: [{ name: "new", description: "new", input_schema: { p: 1 } }],
      system: "new system",
    }
    expect(await store.match(incomingDifferentScaffolding, { policy: "exact" })).toBeNull()
    expect(
      await store.match(incomingDifferentScaffolding, { policy: "messages-only" }),
    ).not.toBeNull()
  })

  test("5. fuzzy-content policy hashes message text only", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    const a: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello   world\n" }] }],
      tools: [],
    }
    await store.append(rec("f1", a, []))
    const b: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: " hello world " }] }],
      tools: [],
    }
    expect(await store.match(b, { policy: "fuzzy-content" })).not.toBeNull()
  })

  test("6. used marker — same request twice gets two distinct hits; reset re-arms", async () => {
    const store = jsonlReplayStore({ path: tmpPath() })
    const request = req("twice")
    const id = defaultHashRequest(request, "exact")
    await store.append(rec(id, request, [{ type: "text_delta", delta: "first" }]))
    await store.append(rec(id, request, [{ type: "text_delta", delta: "second" }]))
    const first = await store.match(request)
    const second = await store.match(request)
    const third = await store.match(request)
    expect(first?.events[0]).toEqual({ type: "text_delta", delta: "first" })
    expect(second?.events[0]).toEqual({ type: "text_delta", delta: "second" })
    expect(third).toBeNull()
    store.reset()
    const fourth = await store.match(request)
    expect(fourth?.events[0]).toEqual({ type: "text_delta", delta: "first" })
  })
})

// ---------------------------------------------------------------------------
// B. Recording adapter (7)
// ---------------------------------------------------------------------------

describe("B. recordingLlmPort", () => {
  let store: ReturnType<typeof jsonlReplayStore>

  beforeEach(() => {
    store = jsonlReplayStore({ path: tmpPath() })
  })

  test("7. wraps inner.stream — events forwarded unchanged", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "a" },
      { type: "text_delta", delta: "b" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const port = recordingLlmPort({ inner: stubInner(events), store })
    const out = await drain(port.stream(req("hi")))
    expect(out).toEqual(events)
  })

  test("8. store.append called on completion with all events", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "x" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const port = recordingLlmPort({ inner: stubInner(events, { model: "m1" }), store })
    await drain(port.stream(req("hi")))
    const loaded = await store.load()
    expect(loaded.length).toBe(1)
    expect(loaded[0]?.events).toEqual(events)
    expect(loaded[0]?.metadata.model).toBe("m1")
    expect(loaded[0]?.metadata.partial).toBeUndefined()
  })

  test("9. success path ignores sidecar append failure", async () => {
    let appendCalls = 0
    const failingStore: ReplayStore = {
      append: async () => {
        appendCalls += 1
        throw new Error("cassette disk full")
      },
      match: async () => null,
      load: async () => [],
      save: async () => {},
      reset: () => {},
    }
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "live" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const port = recordingLlmPort({ inner: stubInner(events), store: failingStore })
    // Caller contract (the point of this test): a sidecar append failure on a
    // SUCCESSFUL stream is NEVER surfaced — the caller still gets the live events.
    expect(await drain(port.stream(req("hi")))).toEqual(events)
    // F7: the failure is no longer swallowed SILENTLY. After the first append
    // throws, the recorder attempts a minimal degraded sentinel (a visible
    // hole-marker) — a second append — which also throws here and is likewise
    // swallowed. So 2 attempts, but still no error surfaced to the caller.
    expect(appendCalls).toBe(2)
  })

  test("10. append failure does not mask the original stream error", async () => {
    let appendCalls = 0
    const failingStore: ReplayStore = {
      append: async () => {
        appendCalls += 1
        throw new Error("cassette disk full")
      },
      match: async () => null,
      load: async () => [],
      save: async () => {},
      reset: () => {},
    }
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "p1" },
      { type: "text_delta", delta: "p2" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const port = recordingLlmPort({ inner: stubInner(events, { throwAt: 2 }), store: failingStore })
    let thrown: unknown = null
    try {
      await drain(port.stream(req("partial")))
    } catch (err) {
      thrown = err
    }
    expect(appendCalls).toBe(1)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("boom at 2")
  })

  test("11. inner.stream throws → partial events still recorded", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "p1" },
      { type: "text_delta", delta: "p2" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const port = recordingLlmPort({ inner: stubInner(events, { throwAt: 2 }), store })
    let thrown: unknown = null
    try {
      await drain(port.stream(req("partial")))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    const loaded = await store.load()
    expect(loaded.length).toBe(1)
    expect(loaded[0]?.events.length).toBe(2)
    expect(loaded[0]?.metadata.partial).toBe(true)
    expect(loaded[0]?.metadata.error).toContain("boom at 2")
  })

  test("12. PII scrubber applied before append", async () => {
    const events: StreamEvent[] = [{ type: "text_delta", delta: "secret: abc123" }]
    const port = recordingLlmPort({
      inner: stubInner(events),
      store,
      scrubber: (r) => ({
        ...r,
        events: r.events.map((ev) =>
          ev.type === "text_delta" ? { type: "text_delta", delta: `[SCRUBBED]:${ev.delta}` } : ev,
        ),
      }),
    })
    await drain(port.stream(req("hi")))
    const loaded = await store.load()
    expect(loaded[0]?.events[0]).toEqual({
      type: "text_delta",
      delta: "[SCRUBBED]:secret: abc123",
    })
  })

  test("13. multiple calls produce multiple appends", async () => {
    const port = recordingLlmPort({
      inner: stubInner([{ type: "message_stop", stop_reason: "end_turn" }]),
      store,
    })
    await drain(port.stream(req("one")))
    await drain(port.stream(req("two")))
    await drain(port.stream(req("three")))
    const loaded = await store.load()
    expect(loaded.length).toBe(3)
    const texts = loaded.map((r) => {
      const block = r.request.messages[0]?.content[0]
      return block?.type === "text" ? block.text : ""
    })
    expect(texts).toEqual(["one", "two", "three"])
  })

  test("14. recording strips ephemeral runtime-only request fields", async () => {
    const port = recordingLlmPort({
      inner: stubInner([{ type: "message_stop", stop_reason: "end_turn" }]),
      store,
    })
    const ctrl = new AbortController()
    const responsesStore = defaultResponsesContinuationStore()
    await drain(
      port.stream(
        req("ephemeral", {
          signal: ctrl.signal,
          onChunk: () => {},
          onCheckpoint: () => {},
          responsesContinuation: { store: responsesStore },
          turnTimingCapture: {
            markRequestSent: () => {},
          },
        }),
      ),
    )
    const loaded = await store.load()
    expect(loaded[0]?.request.signal).toBeUndefined()
    expect(loaded[0]?.request.onChunk).toBeUndefined()
    expect(loaded[0]?.request.onCheckpoint).toBeUndefined()
    expect(loaded[0]?.request.turnTimingCapture).toBeUndefined()
    expect(loaded[0]?.request.responsesContinuation).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C. Replay adapter (6)
// ---------------------------------------------------------------------------

describe("C. replayLlmPort", () => {
  let store: ReturnType<typeof jsonlReplayStore>

  beforeEach(() => {
    store = jsonlReplayStore({ path: tmpPath() })
  })

  test("12. hit yields recorded events in order", async () => {
    const request = req("replay me")
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "1" },
      { type: "text_delta", delta: "2" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    await store.append(rec(defaultHashRequest(request, "exact"), request, events))
    const port = replayLlmPort({ store })
    const out = await drain(port.stream(request))
    expect(out).toEqual(events)
  })

  test("13. miss + throw → throws ReplayMissError carrying the request", async () => {
    const port = replayLlmPort({ store, onMiss: "throw" })
    let caught: unknown = null
    try {
      await drain(port.stream(req("no cassette")))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReplayMissError)
    const e = caught as ReplayMissError
    expect(e.policy).toBe("exact")
    expect(e.request.messages[0]?.content[0]).toEqual({ type: "text", text: "no cassette" })
  })

  test("14. miss + passthrough → fallback called", async () => {
    let fallbackCalls = 0
    const fallback: LLMPort = {
      model: "fb",
      stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        fallbackCalls += 1
        async function* gen(): AsyncIterable<StreamEvent> {
          yield { type: "text_delta", delta: "from-fallback" }
        }
        return gen()
      },
    }
    const port = replayLlmPort({ store, onMiss: "passthrough", fallback })
    const out = await drain(port.stream(req("any")))
    expect(fallbackCalls).toBe(1)
    expect(out).toEqual([{ type: "text_delta", delta: "from-fallback" }])
    const loaded = await store.load()
    expect(loaded.length).toBe(0) // passthrough does NOT record
  })

  test("15. miss + record-and-passthrough → store.append called after", async () => {
    const fallback = stubInner([
      { type: "text_delta", delta: "live" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const port = replayLlmPort({ store, onMiss: "record-and-passthrough", fallback })
    const out = await drain(port.stream(req("expand cassette")))
    expect(out.length).toBe(2)
    const loaded = await store.load()
    expect(loaded.length).toBe(1)
    expect(loaded[0]?.events.length).toBe(2)
  })

  test("16. reset re-arms replay of the same recording", async () => {
    const request = req("twice")
    const events: StreamEvent[] = [{ type: "text_delta", delta: "once" }]
    await store.append(rec(defaultHashRequest(request, "exact"), request, events))
    const port = replayLlmPort({ store })
    expect(await drain(port.stream(request))).toEqual(events)
    let caught: unknown = null
    try {
      await drain(port.stream(request))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReplayMissError)
    store.reset()
    expect(await drain(port.stream(request))).toEqual(events)
  })

  test("17. signal forwarded to fallback on passthrough", async () => {
    let observedSignal: AbortSignal | undefined
    const fallback: LLMPort = {
      stream(input: StreamInput): AsyncIterable<StreamEvent> {
        observedSignal = input.signal
        async function* gen(): AsyncIterable<StreamEvent> {
          yield { type: "message_stop", stop_reason: "end_turn" }
        }
        return gen()
      },
    }
    const port = replayLlmPort({ store, onMiss: "passthrough", fallback })
    const ac = new AbortController()
    const input: StreamInput = { ...req("with signal"), signal: ac.signal }
    await drain(port.stream(input))
    expect(observedSignal).toBe(ac.signal)
  })
})

// ---------------------------------------------------------------------------
// D. Hash stability (3)
// ---------------------------------------------------------------------------

describe("D. hash stability", () => {
  test("18. same request twice → same hash (stable JSON.stringify)", () => {
    const r = req("stable", {
      system: "sys",
      tools: [{ name: "t", description: "d", input_schema: { a: 1 } }],
    })
    expect(defaultHashRequest(r, "exact")).toBe(defaultHashRequest(r, "exact"))
  })

  test("19. key reorder produces same hash (sorted keys)", () => {
    // Build two equivalent StreamInputs where object keys are inserted in
    // different orders. JSON.stringify alone is order-sensitive; stableStringify
    // must defeat that.
    const a = stableStringify({ b: 1, a: 2, nested: { y: 9, x: 8 } })
    const b = stableStringify({ a: 2, b: 1, nested: { x: 8, y: 9 } })
    expect(a).toBe(b)

    const r1: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{ name: "x", description: "d", input_schema: { a: 1, b: 2 } }],
      system: "sys",
    }
    const r2: StreamInput = {
      system: "sys",
      tools: [{ input_schema: { b: 2, a: 1 }, description: "d", name: "x" }],
      messages: [{ content: [{ type: "text", text: "hello" }], role: "user" }],
    }
    expect(defaultHashRequest(r1, "exact")).toBe(defaultHashRequest(r2, "exact"))
  })

  test("20. slight content change → different hash", () => {
    const a = defaultHashRequest(req("hello"), "exact")
    const b = defaultHashRequest(req("hello!"), "exact")
    expect(a).not.toBe(b)
  })
})
