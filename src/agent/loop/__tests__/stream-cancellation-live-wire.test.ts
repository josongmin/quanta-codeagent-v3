/**
 * Live ADR-0177 wire: this is intentionally an agent-loop test, not a unit
 * test of `cancellableStream`. It proves a typed controller reaches the
 * provider signal, stops `streamingTurn` as an abort, and settles cleanup with
 * the partial stream data before the run returns.
 */
import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import { createCancellationController } from "@/agent/streaming-cancellation"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { createStreamCancellationWire } from "../stream-cancellation-wire"

class AbortAwareLLM implements LLMPort {
  readonly started: Promise<void>
  #resolveStarted!: () => void
  seenSignal: AbortSignal | undefined

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve
    })
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenSignal = input.signal
    this.#resolveStarted()
    yield { type: "text_delta", delta: "partial" }
    await new Promise<void>((resolve) => {
      if (input.signal?.aborted) resolve()
      else input.signal?.addEventListener("abort", resolve, { once: true })
    })
    // A provider can still yield one final event while unwinding. The live
    // cancellation wrapper must not pass it into normal turn assembly.
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const baseConfig = (llm: LLMPort): AgentConfig => ({
  llm,
  registry: new ToolRegistry(defaultTools),
  stream: { emit: () => {} } as StreamPort,
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [user("cancel the sample")],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 1,
  signal: new AbortController().signal,
})

describe("ADR-0177 live sampling cancellation wire", () => {
  test("absent slot preserves the raw source/signal path", async () => {
    const session = new AbortController().signal
    expect(createStreamCancellationWire({ sessionSignal: session, controller: undefined })).toBe(
      undefined,
    )
  })

  test("typed cancel aborts the real provider stream and settles salvaged cleanup", async () => {
    const llm = new AbortAwareLLM()
    const controller = createCancellationController()
    const cleaned: Array<{ cause: string; partial: string | null }> = []
    controller.registerCleanup({
      name: "capture-partial",
      cleanup: async (cause, partial) => {
        cleaned.push({ cause, partial: partial?.partialText ?? null })
      },
    })

    const run = runAgent({ ...baseConfig(llm), streamCancellation: controller })
    await llm.started
    // Let the first yielded chunk traverse the live wrapper before firing the
    // controller. `started` is signalled just before that yield.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    controller.cancel("user-abort")
    const outcome = await run

    expect(llm.seenSignal?.aborted).toBe(true)
    expect(outcome.reason).toBe("aborted")
    expect(cleaned).toEqual([{ cause: "user-abort", partial: "partial" }])
  })
})
