import { describe, expect, test } from "bun:test"
import {
  cancellableStream,
  createCancellationController,
  fromAbortSignal,
  toAbortSignal,
} from "@/agent/streaming-cancellation"
import type { StreamEvent } from "@/llm"

/**
 * Hellgate for ADR-0183 streaming-cancellation slice (typed cancellation
 * controller + AbortSignal round-trip + cleanup orchestration + cancellable
 * LLM stream wrap with salvage).
 */

const makeAsyncIter = <T>(items: T[], opts?: { onCancel?: () => void; signal?: AbortSignal }): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      if (opts?.signal?.aborted) {
        opts.onCancel?.()
        return
      }
      yield item
    }
  },
})

const makeControlledStream = (): { iter: AsyncIterable<StreamEvent>; push: (ev: StreamEvent) => void; close: () => void } => {
  let resolve: ((v: { done: true } | { done: false; value: StreamEvent }) => void) | null = null
  const queue: StreamEvent[] = []
  let closed = false
  return {
    iter: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as StreamEvent
            continue
          }
          if (closed) return
          await new Promise<void>((r) => {
            resolve = (v) => {
              resolve = null
              if (!v.done) queue.push(v.value)
              r()
            }
          })
        }
      },
    },
    push: (ev) => {
      if (resolve) resolve({ done: false, value: ev })
      else queue.push(ev)
    },
    close: () => {
      closed = true
      if (resolve) resolve({ done: true })
    },
  }
}

describe("A. CancellationSignal contract", () => {
  test("HELL-A1: initial state aborted=false, cause=null, abortedAt=null", () => {
    const c = createCancellationController()
    expect(c.signal.aborted).toBe(false)
    expect(c.signal.cause).toBeNull()
    expect(c.signal.abortedAt).toBeNull()
  })

  test("HELL-A2: cancel('user-abort') → aborted=true, cause='user-abort'", () => {
    const c = createCancellationController()
    c.cancel("user-abort")
    expect(c.signal.aborted).toBe(true)
    expect(c.signal.cause).toBe("user-abort")
  })

  test("HELL-A3: listener fires synchronously on cancel", () => {
    const c = createCancellationController()
    let fired = false
    c.signal.addEventListener("abort", () => { fired = true })
    c.cancel("budget-breach")
    expect(fired).toBe(true)
  })

  test("HELL-A4: multiple listeners all fire once", () => {
    const c = createCancellationController()
    let n = 0
    c.signal.addEventListener("abort", () => { n++ })
    c.signal.addEventListener("abort", () => { n++ })
    c.signal.addEventListener("abort", () => { n++ })
    c.cancel("timeout")
    expect(n).toBe(3)
  })

  test("HELL-A5: removeEventListener prevents call", () => {
    const c = createCancellationController()
    let fired = false
    const handler = () => { fired = true }
    c.signal.addEventListener("abort", handler)
    c.signal.removeEventListener("abort", handler)
    c.cancel("external")
    expect(fired).toBe(false)
  })

  test("HELL-A6: listener added AFTER abort still fires synchronously", () => {
    const c = createCancellationController()
    c.cancel("external")
    let fired = false
    c.signal.addEventListener("abort", () => { fired = true })
    expect(fired).toBe(true)
  })
})

describe("B. Controller idempotency", () => {
  test("HELL-B1: cancel twice same cause → no-op second call", () => {
    const c = createCancellationController()
    let fires = 0
    c.signal.addEventListener("abort", () => { fires++ })
    c.cancel("user-abort")
    c.cancel("user-abort")
    expect(fires).toBe(1)
  })

  test("HELL-B2: cancel different cause → FIRST wins", () => {
    const c = createCancellationController()
    c.cancel("user-abort")
    c.cancel("budget-breach")
    expect(c.signal.cause).toBe("user-abort")
  })

  test("HELL-B3: abortedAt set on first cancel only", () => {
    let t = 1000
    const c = createCancellationController({ now: () => t })
    c.cancel("user-abort")
    const first = c.signal.abortedAt
    t = 5000
    c.cancel("budget-breach")
    expect(c.signal.abortedAt).toBe(first)
  })
})

describe("C. fromAbortSignal / toAbortSignal", () => {
  test("HELL-C1: fromAbortSignal pre-aborted → cause='external', aborted=true", () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const sig = fromAbortSignal(ctrl.signal)
    expect(sig.aborted).toBe(true)
    expect(sig.cause).toBe("external")
  })

  test("HELL-C2: toAbortSignal — cancel controller → AbortSignal aborts", () => {
    const c = createCancellationController()
    const ab = toAbortSignal(c.signal)
    expect(ab.aborted).toBe(false)
    c.cancel("user-abort")
    expect(ab.aborted).toBe(true)
  })

  test("HELL-C3: explicit cause on fromAbortSignal honored", () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const sig = fromAbortSignal(ctrl.signal, "host-shutdown")
    expect(sig.cause).toBe("host-shutdown")
  })
})

describe("D. CleanupHandler orchestration", () => {
  test("HELL-D1: registerCleanup + cancel + finalize → handler called with cause + partial", async () => {
    const c = createCancellationController()
    let calledCause: string | null = null
    c.registerCleanup({
      name: "h1",
      cleanup: async (cause) => { calledCause = cause },
    })
    c.cancel("user-abort")
    await c.finalize(null)
    expect(calledCause).not.toBeNull()
    if (calledCause === null) {
      throw new Error("cleanup handler did not receive a cancellation cause")
    }
    expect(calledCause === "user-abort").toBe(true)
  })

  test("HELL-D2: multiple handlers all called", async () => {
    const c = createCancellationController()
    const calls: string[] = []
    c.registerCleanup({ name: "h1", cleanup: async () => { calls.push("h1") } })
    c.registerCleanup({ name: "h2", cleanup: async () => { calls.push("h2") } })
    c.registerCleanup({ name: "h3", cleanup: async () => { calls.push("h3") } })
    c.cancel("user-abort")
    await c.finalize(null)
    expect(calls.sort()).toEqual(["h1", "h2", "h3"])
  })

  test("HELL-D3: handler throws → captured in cleanupErrors, others continue", async () => {
    const c = createCancellationController()
    let h2Called = false
    c.registerCleanup({
      name: "boom",
      cleanup: async () => { throw new Error("oops") },
    })
    c.registerCleanup({
      name: "good",
      cleanup: async () => { h2Called = true },
    })
    c.cancel("external")
    const outcome = await c.finalize(null)
    expect(outcome.cleanupSucceeded).toBe(false)
    expect(outcome.cleanupErrors.length).toBe(1)
    expect(outcome.cleanupErrors[0]).toContain("boom")
    expect(h2Called).toBe(true)
  })

  test("HELL-D4: deregister fn removes handler", async () => {
    const c = createCancellationController()
    let called = false
    const dereg = c.registerCleanup({
      name: "h1",
      cleanup: async () => { called = true },
    })
    dereg()
    c.cancel("external")
    await c.finalize(null)
    expect(called).toBe(false)
  })

  test("HELL-D5: finalize without cancel → synthesizes 'external' cause", async () => {
    const c = createCancellationController()
    const outcome = await c.finalize(null)
    expect(outcome.cause).toBe("external")
    expect(c.signal.aborted).toBe(true)
  })

  test("HELL-D6: finalize idempotent (cached outcome)", async () => {
    const c = createCancellationController()
    let cleanupCalls = 0
    c.registerCleanup({ name: "h", cleanup: async () => { cleanupCalls++ } })
    c.cancel("external")
    const o1 = await c.finalize(null)
    const o2 = await c.finalize(null)
    expect(cleanupCalls).toBe(1)
    expect(o1).toBe(o2)
  })
})

describe("E. cancellableStream salvage", () => {
  test("HELL-E1: 3 text_deltas → partial.partialText joined", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([
      { type: "text_delta", delta: "Hello, " },
      { type: "text_delta", delta: "world" },
      { type: "text_delta", delta: "!" },
    ])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    expect(stream.partial().partialText).toBe("Hello, world!")
  })

  test("HELL-E2: complete tool_use → partial.toolUses[0] parsed", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: { path: "/x" } },
    ])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    const p = stream.partial()
    expect(p.toolUses.length).toBe(1)
    expect(p.toolUses[0]?.name).toBe("read")
    expect(p.toolUses[0]?.input).toEqual({ path: "/x" })
    expect(p.hasUsableToolUses).toBe(true)
  })

  test("HELL-E3: incomplete tool_use (no end) → toolUses[0] absent", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([
      { type: "tool_use_start", id: "t1", name: "read" },
      // No tool_use_end
    ])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    expect(stream.partial().toolUses.length).toBe(0)
    expect(stream.partial().hasUsableToolUses).toBe(false)
  })

  test("HELL-E4: usage accumulated", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([
      { type: "usage", inputTokens: 100, outputTokens: 50, model: "x" } as StreamEvent,
    ])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    expect(stream.partial().usage.inputTokens).toBe(100)
    expect(stream.partial().usage.outputTokens).toBe(50)
  })

  test("HELL-E5: outcome() returns null when not cancelled", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([{ type: "text_delta", delta: "ok" }])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    expect(await stream.outcome()).toBeNull()
  })

  test("HELL-E6: outcome() resolves after cancel", async () => {
    const c = createCancellationController()
    const { iter, push, close } = makeControlledStream()
    const stream = cancellableStream({ source: iter, controller: c })
    const consume = (async () => {
      for await (const _ of stream) { /* consume */ }
    })()
    push({ type: "text_delta", delta: "partial" })
    await new Promise((r) => setTimeout(r, 5))
    c.cancel("user-abort")
    close()
    await consume
    const outcome = await stream.outcome()
    expect(outcome).not.toBeNull()
    expect(outcome?.cause).toBe("user-abort")
    expect(outcome?.partial?.partialText).toBe("partial")
    // The controller's signal is latched aborted after cancel.
    expect(c.signal.aborted).toBe(true)
  })

  test("HELL-E7: stream_reset tombstone resets accumulator", async () => {
    const c = createCancellationController()
    const source = makeAsyncIter<StreamEvent>([
      { type: "text_delta", delta: "discarded" },
      { type: "stream_reset" },
      { type: "text_delta", delta: "fresh" },
    ])
    const stream = cancellableStream({ source, controller: c })
    for await (const _ of stream) { /* consume */ }
    expect(stream.partial().partialText).toBe("fresh")
  })

  test("HELL-E8: cancel propagates through controller.finalize", async () => {
    const c = createCancellationController()
    let cleanupRan = false
    c.registerCleanup({ name: "h", cleanup: async () => { cleanupRan = true } })
    const { iter, push, close } = makeControlledStream()
    const stream = cancellableStream({ source: iter, controller: c })
    const consume = (async () => {
      for await (const _ of stream) { /* consume */ }
    })()
    push({ type: "text_delta", delta: "a" })
    await new Promise((r) => setTimeout(r, 5))
    c.cancel("user-abort")
    close()
    await consume
    await stream.outcome()
    expect(cleanupRan).toBe(true)
    // The cancel call latched signal.aborted — propagation invariant.
    expect(c.signal.aborted).toBe(true)
  })
})
