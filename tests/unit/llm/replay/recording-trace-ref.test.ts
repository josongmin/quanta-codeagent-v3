/**
 * Unit tests: `getActiveTraceRef` DI threading in `recordingLlmPort` (jul-12
 * OTel unification, C4).
 *
 * Verifies that:
 *  (a) when a stub `getActiveTraceRef` returns an active span, its
 *      `{traceId,spanId,parentSpanId}` is stamped into the recorded turn
 *      metadata (and absent — no keys — when the provider returns undefined /
 *      is omitted);
 *  (b) THE LOAD-BEARING INVARIANT: the cassette id (replay hash) is
 *      BYTE-IDENTICAL with vs without trace metadata. Trace ids live in
 *      metadata, which `defaultHashRequest` never reads, so they can never
 *      invalidate a cross-box cassette match.
 */

import { describe, expect, it } from "bun:test"
import type { LLMPort } from "@/llm/ports"
import { recordingLlmPort } from "@/llm/replay/recording-llm"
import type { RecordedInteraction, ReplayStore } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

const fakeLlm = (): LLMPort => ({
  model: "test-model",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "message_stop" } as StreamEvent
    }
    return gen()
  },
})

const memStore = (): ReplayStore & { records: RecordedInteraction[] } => {
  const records: RecordedInteraction[] = []
  return {
    records,
    async append(r: RecordedInteraction) {
      records.push(r)
    },
    async match() {
      return null
    },
    async load() {
      return records
    },
    async save() {},
    reset() {},
  }
}

const minimalInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
})

async function drain(iter: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ev of iter) {
    // intentional no-op drain
  }
}

const TRACE = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" }
const TRACE_WITH_PARENT = { ...TRACE, parentSpanId: "00f067aa0ba902b7" }

describe("recordingLlmPort getActiveTraceRef (C4)", () => {
  it("stamps traceId/spanId/parentSpanId into metadata when a span is active", async () => {
    const store = memStore()
    const port = recordingLlmPort({
      inner: fakeLlm(),
      store,
      getActiveTraceRef: () => TRACE_WITH_PARENT,
    })

    await drain(port.stream(minimalInput()))

    expect(store.records).toHaveLength(1)
    const { metadata } = store.records[0] as NonNullable<(typeof store.records)[0]>
    expect(metadata.traceId).toBe(TRACE_WITH_PARENT.traceId)
    expect(metadata.spanId).toBe(TRACE_WITH_PARENT.spanId)
    expect(metadata.parentSpanId).toBe(TRACE_WITH_PARENT.parentSpanId)
  })

  it("omits parentSpanId when the active span is a root (undefined parent)", async () => {
    const store = memStore()
    const port = recordingLlmPort({ inner: fakeLlm(), store, getActiveTraceRef: () => TRACE })

    await drain(port.stream(minimalInput()))

    const { metadata } = store.records[0] as NonNullable<(typeof store.records)[0]>
    expect(metadata.traceId).toBe(TRACE.traceId)
    expect(metadata.spanId).toBe(TRACE.spanId)
    expect("parentSpanId" in metadata).toBe(false)
  })

  it("stamps NO trace keys when the provider returns undefined (no active span)", async () => {
    const store = memStore()
    const port = recordingLlmPort({ inner: fakeLlm(), store, getActiveTraceRef: () => undefined })

    await drain(port.stream(minimalInput()))

    const { metadata } = store.records[0] as NonNullable<(typeof store.records)[0]>
    expect("traceId" in metadata).toBe(false)
    expect("spanId" in metadata).toBe(false)
    expect("parentSpanId" in metadata).toBe(false)
  })

  it("stamps NO trace keys when the provider is omitted (byte-identical baseline)", async () => {
    const store = memStore()
    const port = recordingLlmPort({ inner: fakeLlm(), store })

    await drain(port.stream(minimalInput()))

    const { metadata } = store.records[0] as NonNullable<(typeof store.records)[0]>
    expect("traceId" in metadata).toBe(false)
    expect("spanId" in metadata).toBe(false)
    expect("parentSpanId" in metadata).toBe(false)
  })

  it("a throwing provider never fails the turn and stamps no trace keys", async () => {
    const store = memStore()
    const port = recordingLlmPort({
      inner: fakeLlm(),
      store,
      getActiveTraceRef: () => {
        throw new Error("provider boom")
      },
    })

    // Must NOT throw — recording is a sidecar; a throwing provider degrades to
    // no-trace, never surfaces as an LLM failure.
    await drain(port.stream(minimalInput()))

    expect(store.records).toHaveLength(1)
    const { metadata } = store.records[0] as NonNullable<(typeof store.records)[0]>
    expect("traceId" in metadata).toBe(false)
    expect("spanId" in metadata).toBe(false)
  })

  // ── THE LOAD-BEARING ASSERTION ────────────────────────────────────────────
  it("REPLAY HASH is byte-identical WITH vs WITHOUT trace metadata", async () => {
    const storeWith = memStore()
    const storeWithout = memStore()
    const input = minimalInput()

    const portWith = recordingLlmPort({
      inner: fakeLlm(),
      store: storeWith,
      getActiveTraceRef: () => TRACE_WITH_PARENT,
    })
    const portWithout = recordingLlmPort({ inner: fakeLlm(), store: storeWithout })

    await drain(portWith.stream(input))
    await drain(portWithout.stream(input))

    expect(storeWith.records).toHaveLength(1)
    expect(storeWithout.records).toHaveLength(1)

    const withRec = storeWith.records[0] as NonNullable<(typeof storeWith.records)[0]>
    const withoutRec = storeWithout.records[0] as NonNullable<(typeof storeWithout.records)[0]>

    // Proof #1: the WITH record genuinely carries the trace metadata (guards
    // against a vacuous pass where nothing was ever stamped).
    expect(withRec.metadata.traceId).toBe(TRACE_WITH_PARENT.traceId)
    expect(withRec.metadata.spanId).toBe(TRACE_WITH_PARENT.spanId)
    expect("traceId" in withoutRec.metadata).toBe(false)

    // Proof #2 (LOAD-BEARING): despite the metadata delta, the cassette KEY is
    // identical — trace ids live in metadata, which the request hash ignores.
    expect(withRec.id).toBe(withoutRec.id)
  })
})
