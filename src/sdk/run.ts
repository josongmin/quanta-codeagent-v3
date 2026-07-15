/**
 * `@/sdk/run` — `AgentRun`: the value `agent.run()` returns (Phase 3).
 *
 * It is BOTH an `AsyncIterable<AgentEvent>` (stream every event) AND a
 * `PromiseLike<AgentOutcome>` (await just the result). One run, either shape.
 *
 * Backpressure reality: the loop's `StreamPort.emit` is SYNC/void, and
 * `runAgent` runs to completion independently of whoever iterates — so we
 * cannot truly block the producer. We buffer up to `bufferSize` events and
 * DROP-OLDEST past the cap (recording `droppedEvents`). Sync `hooks`/`onEvent`
 * receive every event with no drop. For lossless streaming, size the buffer to
 * the run or consume via hooks.
 */

import type { AgentOutcome } from "@/agent"
import { errMessage } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { isError, isText, isThinking, isToolCall, isToolResult, isUsage } from "./events"

type Variant<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>

export interface RunHooks {
  onText?(delta: string): void
  onThinking?(delta: string): void
  onToolCall?(e: Variant<"tool_call">): void
  onToolResult?(e: Variant<"tool_result">): void
  onUsage?(e: Variant<"usage">): void
  onError?(e: Variant<"error">): void
  onDone?(o: AgentOutcome): void
}

export interface AgentRun extends AsyncIterable<AgentEvent>, PromiseLike<AgentOutcome> {
  /** ALBB-12 claim 3 — count of events the bounded buffer DROPPED (drop-oldest
   *  overflow). `> 0` ⇒ an iterate-only consumer whose buffer overflowed saw a
   *  LOSSY stream (partial history). Sync `hooks`/`onEvent` never drop; size the
   *  buffer to the run or consume via hooks for lossless streaming. */
  readonly droppedEvents: number
}

export const DEFAULT_EVENT_BUFFER = 1024

const dispatchHooks = (e: AgentEvent, h: RunHooks | undefined): void => {
  if (h === undefined) return
  if (isText(e)) h.onText?.(e.delta)
  else if (isThinking(e)) h.onThinking?.(e.delta)
  else if (isToolCall(e)) h.onToolCall?.(e)
  else if (isToolResult(e)) h.onToolResult?.(e)
  else if (isUsage(e)) h.onUsage?.(e)
  else if (isError(e)) h.onError?.(e)
}

/** Single-producer / single-consumer async event channel with a bounded,
 *  drop-oldest buffer. */
class EventChannel {
  private readonly buffer: AgentEvent[] = []
  private readonly waiters: ((r: IteratorResult<AgentEvent>) => void)[] = []
  private closed = false
  private failure: unknown = undefined
  private consumed = false
  droppedEvents = 0

  constructor(private readonly cap: number) {}

  push(e: AgentEvent): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w !== undefined) {
      w({ value: e, done: false })
      return
    }
    if (this.buffer.length >= this.cap) {
      this.buffer.shift()
      this.droppedEvents++
    }
    this.buffer.push(e)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const w of this.waiters.splice(0)) {
      w({ value: undefined as never, done: true })
    }
  }

  fail(err: unknown): void {
    if (this.closed) return
    this.failure = err
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    // Single-consumer: a second `for await` on the same run would round-robin
    // the stream (each loop sees a PARTIAL sequence). Fail loud instead.
    if (this.consumed) {
      throw new Error("AgentRun is single-consumer: iterate it exactly once")
    }
    this.consumed = true
    for (;;) {
      const buffered = this.buffer.shift()
      if (buffered !== undefined) {
        yield buffered
        continue
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      const r = await new Promise<IteratorResult<AgentEvent>>((res) => this.waiters.push(res))
      if (r.done === true) {
        if (this.failure !== undefined) throw this.failure
        return
      }
      yield r.value
    }
  }
}

/**
 * Wire a run: build the loop-facing {@link StreamPort} onto an event channel,
 * start `runOutcome(stream)`, and expose the dual iterable/promise handle.
 */
export const makeAgentRun = (
  runOutcome: (stream: StreamPort) => Promise<AgentOutcome>,
  hooks: RunHooks | undefined,
  onEvent: ((e: AgentEvent) => void) | undefined,
  bufferSize: number = DEFAULT_EVENT_BUFFER,
): AgentRun => {
  const channel = new EventChannel(bufferSize)
  const stream: StreamPort = {
    emit(e) {
      dispatchHooks(e, hooks)
      onEvent?.(e)
      channel.push(e)
    },
  }

  const outcomePromise = runOutcome(stream).then(
    (o) => {
      hooks?.onDone?.(o)
      channel.close()
      return o
    },
    (err: unknown) => {
      // Surface the terminal failure to a hooks-ONLY consumer (never iterates,
      // never awaits) — otherwise `void .catch` below would swallow it silently.
      hooks?.onError?.({
        type: "error",
        message: errMessage(err),
      })
      channel.fail(err)
      throw err
    },
  )
  // Mark handled so an iterate-only consumer (never awaits) does not trip an
  // unhandledRejection warning; a real `await run` still sees the rejection via
  // its own `.then` chain below.
  void outcomePromise.catch(() => undefined)

  return {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    // ALBB-12 claim 3 — delegate to the live channel counter (a getter so a
    // consumer reading it AFTER the run settles sees the final drop count).
    get droppedEvents() {
      return channel.droppedEvents
    },
    // biome-ignore lint/suspicious/noThenProperty: AgentRun is intentionally a PromiseLike thenable so `await run()` resolves the outcome (Phase 3.2 dual iterable/promise shape).
    then: (onF, onR) => outcomePromise.then(onF, onR),
  }
}
