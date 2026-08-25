import { describe, expect, mock, test } from "bun:test"
import type { IdleMonitor } from "../../../../src/apps/cli/idle-monitor"
import type { ImageQueue } from "../../../../src/apps/cli/image-queue"
import type { NotificationPort } from "../../../../src/apps/cli/notify"
import type { RejectCounter } from "../../../../src/apps/cli/reject-counter"
import { ExternalPromptQueue } from "../../../../src/apps/cli/repl/external-prompt-queue"
import { composePromptPipeline } from "../../../../src/apps/cli/repl/prompt-pipeline"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"

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

const stubRejects = (shouldExit: boolean, limit?: number): RejectCounter => {
  let count = 0
  return {
    recordDeny: () => ++count,
    recordAccept: () => {
      count = 0
    },
    count: () => count,
    shouldAutoExit: () => shouldExit,
    reset: () => undefined,
    ...(limit !== undefined ? { limit } : {}),
  }
}

const withCapturedStderr = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; writes: string[] }> => {
  const originalWrite = process.stderr.write.bind(process.stderr)
  const writes: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stderr.write
  try {
    return { result: await run(), writes }
  } finally {
    process.stderr.write = originalWrite
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
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write
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
    const markActive = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      externalPromptQueue: queue,
      idleMonitor: stubIdle({ markActive }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBe("wake from reactor")
    expect(markActive).not.toHaveBeenCalled()
  })

  test("a raw local key edge is forwarded before the draft line is accepted", async () => {
    const onLocalActivity = mock(() => undefined)
    const markActive = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ markActive }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      onLocalActivity,
      readPromptLine: async (_signal, _ux, onActivity) => {
        onActivity?.()
        return "draft submitted"
      },
    })

    expect(await pipe.next(new AbortController().signal)).toBe("draft submitted")
    expect(onLocalActivity).toHaveBeenCalledTimes(1)
    expect(markActive).toHaveBeenCalled()
  })

  test("local blank input is skipped and the next typed user input is returned", async () => {
    const lines = ["", "typed after blank"]
    const dispatchSlash = mock(async () => false)
    const onLocalPromptAccepted = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      onLocalPromptAccepted,
      readPromptLine: async () => lines.shift() ?? null,
    })
    const { result, writes } = await withCapturedStderr(() =>
      pipe.next(new AbortController().signal),
    )
    expect(result).toBe("typed after blank")
    expect(dispatchSlash).toHaveBeenCalledTimes(1)
    expect(dispatchSlash).toHaveBeenCalledWith("typed after blank")
    expect(onLocalPromptAccepted).toHaveBeenCalledTimes(1)
    expect(writes).toContain("\n")
  })

  test("local slash input is dispatched and the pipeline keeps reading until user text arrives", async () => {
    const lines = ["/help", "typed after slash"]
    const dispatchSlash = mock(async (input: string) => input === "/help")
    const onLocalInput = mock(() => undefined)
    const onLocalInputSettled = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      onLocalInput,
      onLocalInputSettled,
      readPromptLine: async () => lines.shift() ?? null,
    })
    const { result, writes } = await withCapturedStderr(() =>
      pipe.next(new AbortController().signal),
    )
    expect(result).toBe("typed after slash")
    expect(dispatchSlash).toHaveBeenCalledTimes(2)
    expect(dispatchSlash).toHaveBeenNthCalledWith(1, "/help")
    expect(dispatchSlash).toHaveBeenNthCalledWith(2, "typed after slash")
    expect(onLocalInput).toHaveBeenCalledTimes(2)
    expect(onLocalInputSettled).toHaveBeenCalledTimes(1)
    expect(writes).toContain("\n")
  })

  test("local /exit returns null without dispatching slash handling", async () => {
    const dispatchSlash = mock(async () => false)
    const onLocalPromptAccepted = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      onLocalPromptAccepted,
      readPromptLine: async () => "/exit",
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBeNull()
    expect(dispatchSlash).not.toHaveBeenCalled()
    expect(onLocalPromptAccepted).not.toHaveBeenCalled()
  })

  test("local typed user input returns straight through the production pipeline", async () => {
    const dispatchSlash = mock(async () => false)
    const onLocalPromptAccepted = mock(() => undefined)
    const pipe = composePromptPipeline({
      dispatchSlash,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      onLocalPromptAccepted,
      readPromptLine: async () => "typed user input",
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBe("typed user input")
    expect(dispatchSlash).toHaveBeenCalledTimes(1)
    expect(dispatchSlash).toHaveBeenCalledWith("typed user input")
    expect(onLocalPromptAccepted).toHaveBeenCalledTimes(1)
  })
})

// === RFC-09 wire-level tests (A idle notify + B warning preamble) ============

interface CountingNotify extends NotificationPort {
  idle: number
  active: number
  disposed: number
}

const stubNotify = (): CountingNotify => {
  const port: CountingNotify = {
    idle: 0,
    active: 0,
    disposed: 0,
    onTurnComplete: () => undefined,
    onIdleAwaitingInput: () => {
      port.idle++
    },
    markActive: () => {
      port.active++
    },
    dispose: () => {
      port.disposed++
    },
  }
  return port
}

describe("RFC-09 A — idle-notify wired through composePromptPipeline", () => {
  test("idle gate fires onIdleAwaitingInput + markActive on accepted prompt", async () => {
    const notify = stubNotify()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      notify,
      notifyCwdBasename: "proj",
      readPromptLine: async () => "typed",
    })
    const result = await pipe.next(new AbortController().signal)
    expect(result).toBe("typed")
    expect(notify.idle).toBe(1) // idle entry notified
    expect(notify.active).toBe(1) // accepted prompt reset the latch
  })

  test("NOT idle ⇒ no idle notify (markActive still fires on accept)", async () => {
    const notify = stubNotify()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => false }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      notify,
      notifyCwdBasename: "proj",
      readPromptLine: async () => "typed",
    })
    await pipe.next(new AbortController().signal)
    expect(notify.idle).toBe(0)
    expect(notify.active).toBe(1)
  })
})

describe("RFC-09 B — context warning preamble wired through composePromptPipeline", () => {
  test("non-empty warning is written as a one-line preamble before the prompt", async () => {
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      contextWarning: () => "⚠ context 91% of compaction limit — 곧 자동 요약됩니다",
      readPromptLine: async () => "typed",
    })
    const { result, writes } = await withCapturedStderr(() =>
      pipe.next(new AbortController().signal),
    )
    expect(result).toBe("typed")
    expect(writes.some((w) => w.includes("곧 자동 요약됩니다"))).toBe(true)
  })

  test("empty warning ⇒ NO preamble write (byte-identical to absent)", async () => {
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      contextWarning: () => "",
      readPromptLine: async () => "typed",
    })
    const { writes } = await withCapturedStderr(() => pipe.next(new AbortController().signal))
    expect(writes.some((w) => w.includes("⚠"))).toBe(false)
  })
})

describe("RFC-09 — DEFAULT-OFF byte-identical anchor", () => {
  test("absent notify + absent contextWarning ⇒ same stderr as before the feature", async () => {
    // Capture the production pipeline output with the RFC-09 deps OMITTED.
    const pipeBaseline = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      readPromptLine: async () => "typed",
    })
    const baseline = await withCapturedStderr(() => pipeBaseline.next(new AbortController().signal))

    // Same deps but with a notify port + a contextWarning that returns "" —
    // the empty/no-op path must produce the EXACT same stderr bytes.
    const notify = stubNotify()
    const pipeOff = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true }),
      rejectCounter: stubRejects(false),
      statusBar: stubStatusBar(),
      notify,
      notifyCwdBasename: "proj",
      contextWarning: () => "",
      readPromptLine: async () => "typed",
    })
    const withOffWires = await withCapturedStderr(() => pipeOff.next(new AbortController().signal))

    expect(withOffWires.result).toBe(baseline.result)
    expect(withOffWires.writes).toEqual(baseline.writes)
  })
})

// =============================================================================
// #22 — repl-banners WIRED: idle/reject banners reflect the RESOLVED threshold
// (QUANTA_IDLE_MS / QUANTA_REJECT_LIMIT) instead of the hardcoded "60s" / "20".
// Closes the UI-lie bug class: an operator who overrides the env saw a banner
// number that disagreed with the actual behaviour.
// =============================================================================

import { createIdleMonitor } from "../../../../src/apps/cli/idle-monitor"
import { createRejectCounter } from "../../../../src/apps/cli/reject-counter"

describe("#22 — idle/reject banners interpolate the resolved threshold", () => {
  test("idle banner shows idle.thresholdMs (override ⇒ NOT the hardcoded 60s)", async () => {
    const statusBar = stubStatusBar()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true, thresholdMs: 30_000 }),
      rejectCounter: stubRejects(false),
      statusBar,
      readPromptLine: async () => "typed",
    })
    await pipe.next(new AbortController().signal)
    expect(statusBar.transients.some((t) => t.includes("idle 30s"))).toBe(true)
    expect(statusBar.transients.some((t) => t.includes("idle 60s"))).toBe(false)
  })

  test("PAIRED control — a DIFFERENT threshold yields a DIFFERENT banner number", async () => {
    const statusBar = stubStatusBar()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true, thresholdMs: 90_000 }),
      rejectCounter: stubRejects(false),
      statusBar,
      readPromptLine: async () => "typed",
    })
    await pipe.next(new AbortController().signal)
    expect(statusBar.transients.some((t) => t.includes("idle 90s"))).toBe(true)
  })

  test("reject-exit banner shows rejects.limit (override ⇒ NOT the hardcoded 20)", async () => {
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle(),
      rejectCounter: stubRejects(true, 5),
      statusBar: stubStatusBar(),
    })
    const { writes } = await withCapturedStderr(() => pipe.next(new AbortController().signal))
    expect(writes.some((w) => w.includes("5 consecutive denials"))).toBe(true)
    expect(writes.some((w) => w.includes("20 consecutive denials"))).toBe(false)
  })

  test("default fallback — stub WITHOUT threshold/limit keeps 60s/20 (byte-identical)", async () => {
    const statusBar = stubStatusBar()
    const pipe = composePromptPipeline({
      dispatchSlash: async () => false,
      idleMonitor: stubIdle({ isIdle: () => true }),
      rejectCounter: stubRejects(false),
      statusBar,
      readPromptLine: async () => "typed",
    })
    await pipe.next(new AbortController().signal)
    expect(statusBar.transients.some((t) => t.includes("idle 60s"))).toBe(true)
  })
})

describe("#22 — monitors expose their resolved threshold (SSOT source)", () => {
  test("createIdleMonitor exposes idleThresholdMs as `thresholdMs`", () => {
    const m = createIdleMonitor({ idleThresholdMs: 30_000, loadSnoozeFromDisk: false })
    expect(m.thresholdMs).toBe(30_000)
  })
  test("createRejectCounter exposes threshold as `limit`", () => {
    expect(createRejectCounter({ threshold: 5 }).limit).toBe(5)
  })
})
