/**
 * Hellgate — spinner-stall LIVE CLI composition (follow-up from e81010371).
 *
 * Root cause: `src/llm/spinner-stall/` shipped a detector + the
 * operator-notice bridge (`wireStallDetectorToOperatorNotices`) but had ZERO
 * live construction sites — adapters honor the optional `StreamInput.onChunk`
 * tick, yet no composition ever built a detector, so a mid-turn provider
 * stall stayed invisible to the operator (the exact agent-state-visibility
 * class this slice exists for).
 *
 * Fix under test: `apps/cli/repl/spinner-stall-live-wire.ts` — ONE
 * composition-root module, gated by the NEW default-OFF env gate
 * `QUANTA_SPINNER_STALL` (registered in `src/config/knob-inventory/host.ts`,
 * same discipline as `QUANTA_BG_TURN`). It constructs the detector + the
 * notice emitter, decorates the session `LLMPort` so every `stream()` call
 * registers a correlation / threads a composed `onChunk` tick / stops the
 * correlation on settle, and schedules ONE poll timer (injectable clock +
 * scheduler; torn down on session close).
 *
 *   §1 gate-ON: a STALLED fake stream yields exactly ONE warn operator
 *      notice (no spam across polls); a recovery chunk clears it (one info).
 *   §2 stream settle (completion OR throw) stops tracking — a poll long
 *      after settle emits nothing (no leaked correlation).
 *   §3 gate-OFF ⇒ `buildSpinnerStallLiveWire` returns undefined and NEVER
 *      schedules a timer (byte-identical posture; the session-setup identity
 *      pin lives in session-setup-hellgate.test.ts).
 *   §4 teardown cancels the poll timer exactly once (idempotent — no leaked
 *      interval on session close).
 *   §5 the wrapper COMPOSES a caller-supplied `onChunk` (never clobbers it)
 *      and preserves the inner port's metadata (`model` / `provider`).
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { DEFAULT_SPINNER_STALL_THRESHOLD_MS } from "@/llm/spinner-stall"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared/operator-notice"
import {
  buildSpinnerStallLiveWire,
  SPINNER_STALL_ENV_GATE,
  SPINNER_STALL_POLL_INTERVAL_MS,
} from "../../../../../src/apps/cli/repl/spinner-stall-live-wire"

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
})

const captureNotices = (): OperatorNotice[] => {
  const notices: OperatorNotice[] = []
  installOperatorNoticeSink((n) => notices.push(n))
  return notices
}

const T0 = 5_000_000

/** A fake provider adapter honoring the ADR-0234 `onChunk` contract: it calls
 *  `input.onChunk` before each yielded event (like the real adapters' raw-
 *  chunk tick), yields one event immediately, then goes SILENT until
 *  `releaseNext()` — the stall under test. */
const makeStallingLlm = (): {
  llm: LLMPort
  releaseNext: () => void
} => {
  let release: () => void = () => undefined
  const llm: LLMPort = {
    model: "fake-model",
    provider: "fake-provider",
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      input.onChunk?.()
      yield { type: "text_delta", delta: "first" }
      // …provider goes silent mid-turn (the stall) until released.
      await new Promise<void>((r) => {
        release = r
      })
      input.onChunk?.()
      yield { type: "text_delta", delta: "recovered" }
    },
  }
  return { llm, releaseNext: () => release() }
}

const emptyInput = (extra?: Partial<StreamInput>): StreamInput => ({
  messages: [],
  tools: [],
  ...extra,
})

/** Harness: build a gate-ON wire with a manual clock + captured poll fn. */
const makeWire = (): {
  now: { current: number }
  firePoll: () => void
  cancelled: unknown[]
  scheduled: Array<{ intervalMs: number }>
  wire: NonNullable<ReturnType<typeof buildSpinnerStallLiveWire>>
} => {
  const now = { current: T0 }
  const polls: Array<() => void> = []
  const scheduled: Array<{ intervalMs: number }> = []
  const cancelled: unknown[] = []
  const wire = buildSpinnerStallLiveWire(true, {
    clock: () => now.current,
    schedule: (fn, intervalMs) => {
      polls.push(fn)
      scheduled.push({ intervalMs })
      return "poll-handle"
    },
    cancel: (h) => cancelled.push(h),
  })
  if (wire === undefined) throw new Error("gate-ON wire must construct")
  return {
    now,
    firePoll: () => {
      for (const p of polls) p()
    },
    cancelled,
    scheduled,
    wire,
  }
}

describe("§1 gate-ON — stalled stream ⇒ exactly one warn notice; recovery clears", () => {
  test("stall warns ONCE (latched across polls); recovery chunk emits one info clear", async () => {
    const notices = captureNotices()
    const { now, firePoll, wire } = makeWire()
    const { llm, releaseNext } = makeStallingLlm()
    const wrapped = wire.wrapLlm(llm)

    const it = wrapped.stream(emptyInput())[Symbol.asyncIterator]()
    const first = await it.next()
    expect(first.done).toBe(false)

    // Pull the next event BEFORE the stall window so the fake provider is
    // genuinely in-flight (suspended at its silent await).
    const pending = it.next()

    // No stall yet ⇒ a poll inside the threshold emits nothing.
    now.current = T0 + DEFAULT_SPINNER_STALL_THRESHOLD_MS - 1
    firePoll()
    expect(notices).toHaveLength(0)

    // Cross the threshold ⇒ exactly ONE warn.
    now.current = T0 + DEFAULT_SPINNER_STALL_THRESHOLD_MS + 2_000
    firePoll()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.severity).toBe("warn")
    expect(notices[0]?.message).toContain("stall")

    // Still stalled on later polls ⇒ latched, no spam.
    now.current += 10_000
    firePoll()
    firePoll()
    expect(notices.filter((n) => n.severity === "warn")).toHaveLength(1)

    // Recovery: the provider ticks + yields again.
    releaseNext()
    const second = await pending
    expect(second.done).toBe(false)
    firePoll()
    const infos = notices.filter((n) => n.severity === "info")
    expect(infos).toHaveLength(1)
    expect(infos[0]?.message).toContain("clear")
    expect(notices.filter((n) => n.severity === "warn")).toHaveLength(1)

    // Drain to completion so the correlation is stopped (teardown hygiene).
    const done = await it.next()
    expect(done.done).toBe(true)
  })
})

describe("§2 settle stops tracking — no leaked correlation", () => {
  test("after stream completion, a poll far in the future emits nothing", async () => {
    const notices = captureNotices()
    const { now, firePoll, wire } = makeWire()
    const { llm, releaseNext } = makeStallingLlm()
    const wrapped = wire.wrapLlm(llm)

    const it = wrapped.stream(emptyInput())[Symbol.asyncIterator]()
    await it.next()
    const pending = it.next()
    releaseNext()
    await pending
    const done = await it.next()
    expect(done.done).toBe(true)

    now.current = T0 + 100 * DEFAULT_SPINNER_STALL_THRESHOLD_MS
    firePoll()
    expect(notices).toHaveLength(0)
  })

  test("an inner-stream THROW still stops tracking (finally-path stop)", async () => {
    const notices = captureNotices()
    const { now, firePoll, wire } = makeWire()
    const throwing: LLMPort = {
      // biome-ignore lint/correctness/useYield: the throw-before-yield path IS the case under test
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        throw new Error("provider died")
      },
    }
    const wrapped = wire.wrapLlm(throwing)
    const it = wrapped.stream(emptyInput())[Symbol.asyncIterator]()
    await expect(it.next()).rejects.toThrow("provider died")

    now.current = T0 + 100 * DEFAULT_SPINNER_STALL_THRESHOLD_MS
    firePoll()
    expect(notices).toHaveLength(0)
  })
})

describe("§3 gate-OFF — no wire, no timer", () => {
  test("enabled:false returns undefined and never schedules", () => {
    let scheduleCalls = 0
    const wire = buildSpinnerStallLiveWire(false, {
      schedule: () => {
        scheduleCalls += 1
        return "never"
      },
    })
    expect(wire).toBeUndefined()
    expect(scheduleCalls).toBe(0)
  })

  test("the gate env key is the registered knob literal", () => {
    // The knob-inventory entry (host.ts) declares this exact envKey; the
    // readsite-truthfulness ratchet requires the literal at the read site.
    expect(SPINNER_STALL_ENV_GATE).toBe("QUANTA_SPINNER_STALL")
  })
})

describe("§4 teardown — poll timer cancelled exactly once", () => {
  test("teardown cancels the scheduled handle; second call is a no-op", () => {
    const { cancelled, scheduled, wire } = makeWire()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.intervalMs).toBe(SPINNER_STALL_POLL_INTERVAL_MS)
    wire.teardown()
    expect(cancelled).toEqual(["poll-handle"])
    wire.teardown()
    expect(cancelled).toEqual(["poll-handle"])
  })
})

describe("§5 wrapper honesty — caller onChunk composed, metadata preserved", () => {
  test("a caller-supplied onChunk still fires (never clobbered)", async () => {
    captureNotices()
    const { wire } = makeWire()
    const { llm, releaseNext } = makeStallingLlm()
    const wrapped = wire.wrapLlm(llm)
    let callerTicks = 0
    const it = wrapped
      .stream(
        emptyInput({
          onChunk: () => {
            callerTicks += 1
          },
        }),
      )
      [Symbol.asyncIterator]()
    await it.next()
    expect(callerTicks).toBe(1)
    const pending = it.next()
    releaseNext()
    await pending
    expect(callerTicks).toBe(2)
    await it.next()
  })

  test("model/provider metadata forwarded onto the wrapped port", () => {
    const { wire } = makeWire()
    const { llm } = makeStallingLlm()
    const wrapped = wire.wrapLlm(llm)
    expect(wrapped.model).toBe("fake-model")
    expect(wrapped.provider).toBe("fake-provider")
    expect(wrapped).not.toBe(llm)
  })
})
