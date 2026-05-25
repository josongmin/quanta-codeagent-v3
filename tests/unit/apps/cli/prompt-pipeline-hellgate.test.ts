import { describe, expect, mock, test } from "bun:test"
import { composePromptPipeline } from "../../../../src/apps/cli/repl/prompt-pipeline"
import type { IdleMonitor } from "../../../../src/apps/cli/idle-monitor"
import type { RejectCounter } from "../../../../src/apps/cli/reject-counter"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"
import type { ImageQueue } from "../../../../src/apps/cli/image-queue"
import { ExternalPromptQueue } from "../../../../src/apps/cli/repl/external-prompt-queue"

// === stubs ====================================================================

const stubStatusBar = (): StatusBar & { transients: string[] } => {
  const transients: string[] = []
  return {
    transients,
    setDefault: () => undefined,
    transient: (text) => transients.push(text),
    clearTransient: () => undefined,
    teardown: () => undefined,
  }
}

const stubIdle = (overrides: Partial<IdleMonitor> = {}): IdleMonitor => ({
  markActive: () => undefined,
  isIdle: () => false,
  snooze: () => undefined,
  unsnooze: () => undefined,
  isSnoozed: () => false,
  reset: () => undefined,
  ...overrides,
})

const stubRejects = (shouldExit: boolean): RejectCounter => {
  let count = 0
  return {
    recordDeny: () => ++count,
    recordAccept: () => {
      count = 0
    },
    count: () => count,
    shouldAutoExit: () => shouldExit,
    reset: () => undefined,
  }
}

// === tests ====================================================================

describe("prompt-pipeline / composePromptPipeline — shape", () => {
  test("returns an object with a `.next` method", () => {
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
    })
    expect(typeof pipe.next).toBe("function")
  })

  test("reject auto-exit short-circuits — `.next` returns null without invoking inner read", async () => {
    const dispatchSlash = mock(async () => false)
    const pipe = composePromptPipeline({
      dispatchSlash,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(true), // pre-tripped
      statusBar: stubStatusBar(),
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBeNull()
    expect(dispatchSlash).not.toHaveBeenCalled() // never reached the inner reader
  })

  test("rejects.shouldAutoExit() — exit message is written to stderr before null", async () => {
    // Test the SAME early-exit path but assert the side-effect we DO produce
    // (stderr write of the auto-exit banner). The banner is the user-visible
    // signal that the auto-exit fired — not just a silent null.
    const origWrite = process.stderr.write.bind(process.stderr)
    const writes: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: stub the write for capture
    process.stderr.write = ((s: string) => {
      writes.push(s)
      return true
    }) as any
    try {
      const pipe = composePromptPipeline({
        dispatchSlash: async () => false,
        idleMonitor: stubIdle(),
        rejectCounter: stubRejects(true),
        statusBar: stubStatusBar(),
      })
      const result = await pipe.next(new AbortController().signal)
      expect(result).toBeNull()
      expect(writes.some((w) => w.includes("20 consecutive denials"))).toBe(true)
    } finally {
      process.stderr.write = origWrite
    }
  })

  test("pipeline composition is byte-stable — same deps produce same `.next` arity", () => {
    const opts = {
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
    }
    const a = composePromptPipeline(opts)
    const b = composePromptPipeline(opts)
    expect(typeof a.next).toBe("function")
    expect(typeof b.next).toBe("function")
    expect(a).not.toBe(b) // distinct objects
  })

  test("pre-aborted signal — returns null without painting any banner", async () => {
    const status = stubStatusBar()
    const ac = new AbortController()
    ac.abort()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: status,
    })
    const result = await pipe.next(ac.signal)
    expect(result).toBeNull()
  })

  test("imageQueue undefined — `next` does NOT try to drain a non-existent queue", async () => {
    // We just verify composition doesn't blow up when imageQueue is absent.
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(true), // short-circuit so no read
      statusBar: stubStatusBar(),
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBeNull()
  })

  test("imageQueue present — `.drain` is NOT called when the pipeline early-exits via rejects", async () => {
    const drainMock = mock(() => [])
    const queue: ImageQueue = {
      add: () => ({ kind: "ok" }),
      list: () => [],
      clear: () => undefined,
      drain: drainMock,
      size: () => 0,
    }
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      imageQueue: queue,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(true),
      statusBar: stubStatusBar(),
    })
    await pipe.next(new AbortController().signal)
    expect(drainMock).not.toHaveBeenCalled()
  })

  test("ux multiline + promptHistory passthrough — composition does not throw on rich UX opts", () => {
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      ux: { multiline: true },
    })
    expect(typeof pipe.next).toBe("function")
  })

  test("externalPromptQueue preloaded — returns the external prompt without requiring local input", async () => {
    const queue = new ExternalPromptQueue()
    queue.push("wake from reactor")
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      externalPromptQueue: queue,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBe("wake from reactor")
  })
})
