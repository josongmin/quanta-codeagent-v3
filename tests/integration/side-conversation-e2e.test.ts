/**
 * ADR-0049 side-conversation seam — end-to-end behavior.
 *
 * Pins three properties that the unit tests cannot exercise as a single
 * scenario:
 *
 *   (1) A side conversation runs in PARALLEL with the main thread's LLM call
 *       — both `stream()` calls are issued concurrently and neither awaits the
 *       other. The side conv must NEVER block the main turn.
 *   (2) The side conversation emits a structured-log line carrying the
 *       canonical `quanta.thread.side=true` attribute (`codex.thread.side`
 *       parity, ADR-0049). The vocabulary key is asserted directly, not
 *       paraphrased, so a future rename surfaces immediately.
 *   (3) The main thread's stream is NOT interrupted by the side conv:
 *       the parent stream yields all of its events, finishes with
 *       `message_stop`, and the assembled assistant text is intact.
 *
 * Why "integration": this test wires together the side-conversation seam
 * (`src/agent/side-conversation.ts`), the structured logger
 * (`src/observability/logger.ts`), the canonical attribute vocabulary
 * (`src/observability/vocabulary.ts`), and the streaming LLM port — that is
 * a cross-slice contract, even though the LLM port itself is a fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runSideConversation } from "@/agent/side-conversation"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { QUANTA_ATTRS } from "@/observability/vocabulary"

/** Marker thrown if the parent stream is awaited "out of order" — used to
 *  prove parallelism (see {@link controlledStream}). */
class StreamOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StreamOrderError"
  }
}

/** Build an async iterable that emits each chunk only after the prior chunk's
 *  consumer has resolved a gate — this gives the test deterministic control
 *  over interleaving. The first chunk is gated by the FIRST gate, etc. */
const controlledStream = (
  chunks: StreamEvent[],
  gates: Promise<void>[],
  onYield: (idx: number) => void,
): AsyncIterable<StreamEvent> => {
  if (chunks.length !== gates.length) {
    throw new StreamOrderError("chunks and gates must be the same length")
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        const gate = gates[i]
        if (gate === undefined) throw new StreamOrderError(`missing gate ${i}`)
        await gate
        const chunk = chunks[i]
        if (chunk === undefined) throw new StreamOrderError(`missing chunk ${i}`)
        onYield(i)
        yield chunk
      }
    },
  }
}

interface GateSet {
  gates: Promise<void>[]
  release: (() => void)[]
}

const makeGates = (n: number): GateSet => {
  const release: (() => void)[] = []
  const gates: Promise<void>[] = []
  for (let i = 0; i < n; i++) {
    let r: (() => void) | undefined
    const p = new Promise<void>((resolve) => {
      r = () => {
        resolve()
      }
    })
    if (r === undefined) throw new StreamOrderError("resolver missing")
    release.push(r)
    gates.push(p)
  }
  return { gates, release }
}

// ---------------------------------------------------------------------------
// stderr capture (the logger writes one JSON line per call to process.stderr)
// ---------------------------------------------------------------------------

interface StderrCapture {
  lines: string[]
  restore: () => void
}

const captureStderr = (): StderrCapture => {
  const lines: string[] = []
  // Cast the surface to a permissive shape so we can monkey-patch + restore
  // without fighting Node's overloaded `write` signature. We forward to the
  // original after capturing, so bun's reporter is unaffected.
  const target = process.stderr as unknown as {
    write: (chunk: string | Uint8Array, ...rest: unknown[]) => boolean
  }
  const original = target.write.bind(process.stderr) as (
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => boolean
  target.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string") {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("{") && line.includes('"event"')) lines.push(line)
      }
    }
    return original(chunk, ...rest)
  }
  return {
    lines,
    restore: () => {
      target.write = original
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let cap: StderrCapture

beforeEach(() => {
  cap = captureStderr()
})

afterEach(() => {
  cap.restore()
})

describe("side conversation runs in parallel with parent — no interruption", () => {
  test("parent stream + side conv interleave; parent finishes uninterrupted", async () => {
    // Parent thread will yield 4 events (text, text, usage, message_stop) under
    // gate control. Side conv will yield its 3 events (text, usage, stop) under
    // its own gates. The test releases them in an INTERLEAVED order:
    //
    //   parent[0] → side[0] → parent[1] → side[1] → parent[2] → parent[3] → side[2]
    //
    // Both consumers must make forward progress as their gates open — if the
    // side conv were inadvertently serializing the parent (or vice versa), one
    // of the awaits below would deadlock and the test would time out.
    const parentGates = makeGates(4)
    const sideGates = makeGates(3)

    const parentYielded: number[] = []
    const sideYielded: number[] = []

    const parentEvents: StreamEvent[] = [
      { type: "text_delta", delta: "Working on it" },
      { type: "text_delta", delta: " — almost there." },
      { type: "usage", inputTokens: 100, outputTokens: 50, model: "parent-model" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const sideEvents: StreamEvent[] = [
      { type: "text_delta", delta: "It matches digit sequences." },
      { type: "usage", inputTokens: 20, outputTokens: 10, model: "side-model" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]

    const parentLlm: LLMPort = {
      model: "parent-model",
      stream: () => controlledStream(parentEvents, parentGates.gates, (i) => parentYielded.push(i)),
    }
    const sideLlm: LLMPort = {
      model: "side-model",
      stream: () => controlledStream(sideEvents, sideGates.gates, (i) => sideYielded.push(i)),
    }

    // Drive the parent stream manually — collect events as they arrive.
    const parentInput: StreamInput = {
      messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
      tools: [],
    }
    const parentCollected: StreamEvent[] = []
    const parentDone = (async () => {
      for await (const ev of parentLlm.stream(parentInput)) {
        parentCollected.push(ev)
      }
    })()

    // Kick the side conversation in parallel — it returns a Promise.
    const sideDone = runSideConversation({
      parentThreadId: "thread-main-001",
      question: "what does \\d+ mean?",
      llm: sideLlm,
    })

    // Interleave releases. After each release we yield to the microtask queue
    // (await null) so the async iterator advances before the next release.
    parentGates.release[0]?.()
    await Promise.resolve()
    sideGates.release[0]?.()
    await Promise.resolve()
    parentGates.release[1]?.()
    await Promise.resolve()
    sideGates.release[1]?.()
    await Promise.resolve()
    parentGates.release[2]?.()
    await Promise.resolve()
    parentGates.release[3]?.()
    await Promise.resolve()
    sideGates.release[2]?.()

    const sideResult = await sideDone
    await parentDone

    // (a) Both streams yielded every event in order.
    expect(parentYielded).toEqual([0, 1, 2, 3])
    expect(sideYielded).toEqual([0, 1, 2])

    // (b) Parent collected all four events — NOT interrupted.
    expect(parentCollected).toHaveLength(4)
    const assembled = assembleFromEvents(parentCollected)
    expect(assembled.stopReason).toBe("end_turn")
    const text = assembled.message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(text).toBe("Working on it — almost there.")

    // (c) Side conv returned its own answer + tokens, independent of parent.
    expect(sideResult.answer).toBe("It matches digit sequences.")
    expect(sideResult.tokens).toEqual({ input: 20, output: 10 })
  })
})

describe("telemetry — side conv emits quanta.thread.side=true span", () => {
  test("structured log line carries the canonical vocabulary attribute", async () => {
    // Minimal fake LLM: yields a text + usage + stop. We only care about the
    // log line emitted by runSideConversation.
    const llm: LLMPort = {
      model: "side-model",
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", delta: "ok" } as StreamEvent
          yield {
            type: "usage",
            inputTokens: 3,
            outputTokens: 4,
            model: "side-model",
          } as StreamEvent
          yield { type: "message_stop", stop_reason: "end_turn" } as StreamEvent
        },
      }),
    }

    await runSideConversation({
      parentThreadId: "thread-parent-XYZ",
      question: "ping?",
      llm,
    })

    // Find the side_conversation_completed line; assert it carries the
    // canonical attribute key (NOT paraphrased — straight from the vocabulary).
    const sideLines = cap.lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((rec): rec is Record<string, unknown> => rec !== null)
      .filter((rec) => rec.event === "side_conversation_completed")

    expect(sideLines.length).toBeGreaterThanOrEqual(1)
    const rec = sideLines[0]
    if (!rec) throw new Error("side log missing")
    const fields = rec.fields as Record<string, unknown>
    const recAttrs = fields.attrs as Record<string, unknown>

    // Canonical attribute key, byte-for-byte from the vocabulary.
    expect(QUANTA_ATTRS.thread.side).toBe("quanta.thread.side")
    expect(recAttrs[QUANTA_ATTRS.thread.side]).toBe(true)
    // Parent thread id is recorded — never forwarded as an LLM message, but it
    // IS on the side span so traces can be joined to the parent.
    expect(recAttrs[QUANTA_ATTRS.thread.parentId]).toBe("thread-parent-XYZ")
    // Kind label = "side-conversation".
    expect(recAttrs[QUANTA_ATTRS.turn.kind]).toBe("side-conversation")
    // Token usage faithfully recorded.
    expect(fields.inputTokens).toBe(3)
    expect(fields.outputTokens).toBe(4)
  })
})
