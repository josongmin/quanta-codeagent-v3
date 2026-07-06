/**
 * Unit tests: `callCtx` threading in `recordingLlmPort`.
 *
 * Verifies that optional instanceId/runId/attempt fields are stamped into
 * recorded turn metadata when callCtx is provided, are absent (key not present)
 * when callCtx is omitted, and do NOT influence the cassette hash/id.
 */

import { describe, expect, it } from "bun:test"
import type { LLMPort } from "@/llm/ports"
import { recordingLlmPort } from "@/llm/replay/recording-llm"
import type { RecordedInteraction, ReplayStore } from "@/llm/replay/types"
import type { StreamEvent, StreamInput } from "@/llm/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake LLM port — yields one message_stop event then completes. */
const fakeLlm = (): LLMPort => ({
  model: "test-model",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "message_stop" } as StreamEvent
    }
    return gen()
  },
})

/** Minimal in-memory ReplayStore — collects appended records. */
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

/** Minimal valid StreamInput for recording. */
const minimalInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
})

/** Drain an AsyncIterable to trigger the recording commit. */
async function drain(iter: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ev of iter) {
    // intentional no-op drain
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recordingLlmPort callCtx", () => {
  it("records instanceId/runId/attempt in metadata when callCtx provided", async () => {
    const store = memStore()
    const port = recordingLlmPort({
      inner: fakeLlm(),
      store,
      callCtx: { instanceId: "psf__requests-5414", runId: "run-123", attempt: 0 },
    })

    await drain(port.stream(minimalInput()))

    expect(store.records).toHaveLength(1)
    const rec0 = store.records[0]
    expect(rec0).toBeDefined()
    const { metadata } = rec0 as NonNullable<typeof rec0>
    expect(metadata.instanceId).toBe("psf__requests-5414")
    expect(metadata.runId).toBe("run-123")
    expect(metadata.attempt).toBe(0)
  })

  it("metadata has no instanceId/runId/attempt keys when callCtx is absent", async () => {
    const store = memStore()
    const port = recordingLlmPort({ inner: fakeLlm(), store })

    await drain(port.stream(minimalInput()))

    expect(store.records).toHaveLength(1)
    const rec0 = store.records[0]
    expect(rec0).toBeDefined()
    const { metadata } = rec0 as NonNullable<typeof rec0>
    expect("instanceId" in metadata).toBe(false)
    expect("runId" in metadata).toBe(false)
    expect("attempt" in metadata).toBe(false)
  })

  it("callCtx does not affect the record id (hash is request-only)", async () => {
    const storeWith = memStore()
    const storeWithout = memStore()
    const input = minimalInput()

    const portWith = recordingLlmPort({
      inner: fakeLlm(),
      store: storeWith,
      callCtx: { instanceId: "psf__requests-5414", runId: "run-123", attempt: 0 },
    })
    const portWithout = recordingLlmPort({ inner: fakeLlm(), store: storeWithout })

    await drain(portWith.stream(input))
    await drain(portWithout.stream(input))

    expect(storeWith.records).toHaveLength(1)
    expect(storeWithout.records).toHaveLength(1)
    expect(storeWith.records[0]?.id).toBe(storeWithout.records[0]?.id)
  })
})
