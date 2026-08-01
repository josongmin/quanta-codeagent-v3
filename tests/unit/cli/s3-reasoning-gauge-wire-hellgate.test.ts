/**
 * S3 hellgate — the reasoning-token split composition-root wire.
 *
 * S3 forwards the OpenAI-Responses reasoning-token split wire→StreamEvent→
 * AgentEvent→SamplingUsage and the `ContextUsageHolder` can annotate `/context`
 * with it. This file pins the FINAL composition wire that was previously
 * deferred: a live `usage` AgentEvent flowing through the surface stream tee
 * must feed `holder.observeUsage(event.reasoningTokens)` so the gauge shows
 * "Reasoning" after a REAL turn — NOT just when the pure holder is poked in a
 * unit test.
 *
 * Producer→consumer→effect chain under test:
 *   config.stream.emit({type:"usage", reasoningTokens})   (loop emit-helpers)
 *     → TeeStream fans out to buildIndicatorPort            (surface tee)
 *       → holder.observeUsage({reasoningTokens})            (the wire)
 *         → holder.view().reasoningTokens                   (gauge input)
 *           → formatSegmentedUsage renders "Reasoning"      (/context)
 *
 * Red-on-injection: break the wire (drop the observe call / drop the field)
 * and the end-to-end assertions go RED — the tests are not tautological.
 */
import { describe, expect, test } from "bun:test"
import type { PromptAssembledSnapshot } from "../../../src/agent/context/usage-breakdown"
import type { IdleMonitor } from "../../../src/apps/cli/idle-monitor"
import { readCliFeatureConfig } from "../../../src/apps/cli/repl/cli-feature-config"
import { createContextUsageHolder } from "../../../src/apps/cli/repl/context-usage-snapshot"
import { buildIndicatorPort } from "../../../src/apps/cli/repl/factories/indicator-stream-port"
import { buildTurnIndicatorAndStream } from "../../../src/apps/cli/repl/factories/turn-indicator"
import {
  type BuildReplSlashCtxArgs,
  buildReplSlashCtx,
} from "../../../src/apps/cli/repl/slash-surface"
import { buildSurfaceDispatch } from "../../../src/apps/cli/repl/surface-compose/dispatch"
import type { SessionIoState } from "../../../src/apps/cli/session-cmd"
import type { TurnIndicator } from "../../../src/apps/cli/turn-indicator"
import type { AgentEvent, StreamPort } from "../../../src/stream"

/** A minimal-but-valid prompt-assembly snapshot so `holder.view()` is defined
 *  (the gauge fallback only shows before the first turn). */
const promptSnapshot = (model = "gpt-5"): PromptAssembledSnapshot => ({
  system: [{ type: "text", text: "x".repeat(400) }],
  layout: "single_block",
  repoRulesPresent: false,
  sessionCtxPresent: false,
  userAppendPresent: false,
  max: 200_000,
  model,
})

const noopIndicator = (): TurnIndicator => ({
  start: () => undefined,
  stop: () => undefined,
  updateUsage: () => undefined,
  markFirstChunk: () => undefined,
})

const recordingStream = (): { stream: StreamPort; events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  return { stream: { emit: (e) => events.push(e) }, events }
}

const recordingBar = () => ({
  setDefault: () => undefined,
  transient: () => undefined,
  clearTransient: () => undefined,
  teardown: () => undefined,
})

const usageEvent = (over: Partial<Extract<AgentEvent, { type: "usage" }>> = {}): AgentEvent => ({
  type: "usage",
  inputTokens: 1000,
  outputTokens: 500,
  model: "gpt-5",
  ...over,
})

describe("S3 wire — buildIndicatorPort feeds observeUsage from a live usage event", () => {
  test("a usage AgentEvent with reasoningTokens reaches observeUsage (wire, not inert)", () => {
    const observed: Array<{ reasoningTokens?: number }> = []
    const port = buildIndicatorPort(noopIndicator(), {
      observeUsage: (u) => observed.push({ ...u }),
    })
    port.emit(usageEvent({ reasoningTokens: 4200 }))
    // RED-ON-INJECTION: if `buildIndicatorPort` drops the `usageObserver?.observeUsage(...)`
    // call, `observed` stays empty and this fails.
    expect(observed).toEqual([{ reasoningTokens: 4200 }])
  })

  test("an explicit 0 split rides through the wire verbatim (not truthiness-dropped)", () => {
    const observed: Array<{ reasoningTokens?: number }> = []
    const port = buildIndicatorPort(noopIndicator(), {
      observeUsage: (u) => observed.push({ ...u }),
    })
    port.emit(usageEvent({ reasoningTokens: 0 }))
    expect(observed).toEqual([{ reasoningTokens: 0 }])
  })

  test("a usage event with NO split forwards an empty slice (Anthropic no-op, no synthetic 0)", () => {
    const observed: Array<{ reasoningTokens?: number }> = []
    const port = buildIndicatorPort(noopIndicator(), {
      observeUsage: (u) => observed.push({ ...u }),
    })
    port.emit(usageEvent()) // no reasoningTokens
    // The observer is still called once (single usage event), but WITHOUT a
    // fabricated reasoning value — `reasoningTokens` must be absent, not 0.
    expect(observed.length).toBe(1)
    expect("reasoningTokens" in (observed[0] ?? {})).toBe(false)
  })

  test("non-usage events never touch the observer", () => {
    let calls = 0
    const port = buildIndicatorPort(noopIndicator(), { observeUsage: () => calls++ })
    port.emit({ type: "assistant_text", delta: "hi" })
    port.emit({ type: "output_progress", outputTokens: 3, exact: false })
    expect(calls).toBe(0)
  })

  test("no observer wired ⇒ the port behaves exactly as before (no throw)", () => {
    const port = buildIndicatorPort(noopIndicator())
    expect(() => port.emit(usageEvent({ reasoningTokens: 9 }))).not.toThrow()
  })

  test("a throwing observer is swallowed in place (never poisons the recorder leg)", () => {
    const port = buildIndicatorPort(noopIndicator(), {
      observeUsage: () => {
        throw new Error("holder blew up")
      },
    })
    expect(() => port.emit(usageEvent({ reasoningTokens: 5 }))).not.toThrow()
  })
})

describe("S3 wire — end-to-end through buildTurnIndicatorAndStream into a real holder", () => {
  const feed = (): {
    holder: ReturnType<typeof createContextUsageHolder>
    turnStream: StreamPort
  } => {
    const holder = createContextUsageHolder()
    // TTY ⇒ indicator ON ⇒ the indicator port is teed (carries the observer).
    const cfg = readCliFeatureConfig({}, true, true)
    const { stream, events } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, recordingBar(), stream, {
      observeUsage: holder.observeUsage,
    })
    void events
    return { holder, turnStream }
  }

  test("indicator ON: a usage event on the tee threads reasoningTokens into the holder", () => {
    const { holder, turnStream } = feed()
    // A prompt must be assembled first so `view()` is non-undefined.
    holder.sink(promptSnapshot())
    turnStream.emit(usageEvent({ reasoningTokens: 12_000 }))
    // RED-ON-INJECTION: if the observer isn't threaded onto the indicator port
    // (or the port drops the observe call), the holder never sees the split and
    // `view().reasoningTokens` is undefined.
    expect(holder.view()?.reasoningTokens).toBe(12_000)
  })

  test("upstream recorder leg still sees the usage event (tee never starves it)", () => {
    const holder = createContextUsageHolder()
    const cfg = readCliFeatureConfig({}, true, true)
    const { stream, events } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, recordingBar(), stream, {
      observeUsage: holder.observeUsage,
    })
    const ev = usageEvent({ reasoningTokens: 7 })
    turnStream.emit(ev)
    expect(events).toEqual([ev])
  })

  test("indicator OFF (non-TTY): turnStream === stream, observer never fed (byte-identical)", () => {
    const holder = createContextUsageHolder()
    const cfg = readCliFeatureConfig({}, false, false) // non-TTY ⇒ indicator OFF
    const { stream } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, recordingBar(), stream, {
      observeUsage: holder.observeUsage,
    })
    // No tee allocated ⇒ literally the same stream ref (byte-identical).
    expect(turnStream).toBe(stream)
    holder.sink(promptSnapshot())
    turnStream.emit(usageEvent({ reasoningTokens: 999 }))
    // The reasoning split was never observed (indicator port not teed).
    expect(holder.view()?.reasoningTokens).toBeUndefined()
  })
})

describe("S3 correctness — turn-scoped split (no stale carry across turns)", () => {
  test("turn N reasoning does NOT leak onto turn N+1 whose usage omits the split", () => {
    const holder = createContextUsageHolder()
    // Turn N: reasoning model reports a split.
    holder.sink(promptSnapshot("gpt-5"))
    holder.observeUsage({ reasoningTokens: 3000 })
    expect(holder.view()?.reasoningTokens).toBe(3000)
    // Turn N+1: new prompt assembled (sink), then a usage event with NO split
    // (e.g. a same-session switch to a non-reasoning model). The stale 3000
    // MUST NOT annotate the new turn's window.
    holder.sink(promptSnapshot("gpt-4o"))
    // RED-ON-INJECTION: if `sink` does not clear the split, this is 3000.
    expect(holder.view()?.reasoningTokens).toBeUndefined()
    holder.observeUsage({}) // usage with no split
    expect(holder.view()?.reasoningTokens).toBeUndefined()
  })

  test("turn N+1 with its OWN split overwrites turn N's", () => {
    const holder = createContextUsageHolder()
    holder.sink(promptSnapshot("gpt-5"))
    holder.observeUsage({ reasoningTokens: 3000 })
    holder.sink(promptSnapshot("gpt-5"))
    holder.observeUsage({ reasoningTokens: 500 })
    expect(holder.view()?.reasoningTokens).toBe(500)
  })
})

/**
 * S3 render-root at the ACTUAL dispatch seam — the trap the earlier audit
 * missed: `buildSurfaceDispatch` builds the live `SlashContext` and its
 * `contextUsage` slot OVERRIDES the one projected from `slashCtx`. If that
 * override reads a reasoning-LESS holder (as it did before this fix — a second
 * `createPromptAssembledHolder` with no reasoning support), `/context` never
 * shows "Reasoning" no matter how the holder is fed. This pins that the live
 * dispatch `/context` renders the reasoning annotation from the reasoning-
 * capable holder.
 */
describe("S3 render-root — buildSurfaceDispatch /context renders Reasoning from the live holder", () => {
  const fakeIdle = (): IdleMonitor =>
    ({
      snooze: () => {},
      unsnooze: () => {},
      isSnoozed: () => false,
      markActive: () => {},
      isIdle: () => false,
      idleFor: () => 0,
    }) as unknown as IdleMonitor

  const minimalSlashArgs = (
    contextUsage: BuildReplSlashCtxArgs["contextUsage"],
  ): BuildReplSlashCtxArgs => ({
    skillsCb: undefined,
    idleMonitor: fakeIdle(),
    imageQueue: undefined,
    rewindState: undefined,
    mcpSurface: undefined,
    costPanel: undefined,
    planStore: undefined,
    branchProgress: undefined,
    getHistory: () => [],
    startSideConversation: (async () =>
      ({}) as never) as BuildReplSlashCtxArgs["startSideConversation"],
    isSideConversationWired: () => true,
    abortSignal: new AbortController().signal,
    debugHandle: undefined,
    llm: {} as BuildReplSlashCtxArgs["llm"],
    sessionId: "s3-dispatch",
    model: "gpt-5",
    inspect: undefined,
    replay: undefined,
    effort: {
      get: () => "medium",
      set: () => {},
      levels: ["low", "medium", "high"] as const,
      budgetTokens: () => undefined,
    },
    contextUsage,
  })

  const stubSessionIo: SessionIoState = {
    readSession: async () => null,
    writeSession: async () => undefined,
    mintNewId: () => "id",
  }

  const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
    const orig = process.stdout.write.bind(process.stdout)
    let buf = ""
    // biome-ignore lint/suspicious/noExplicitAny: test stdout capture shim.
    process.stdout.write = ((s: any) => {
      buf += String(s)
      return true
    }) as typeof process.stdout.write
    try {
      await fn()
    } finally {
      process.stdout.write = orig
    }
    return buf
  }

  test("dispatch /context shows Reasoning after a real turn feeds the holder", async () => {
    const holder = createContextUsageHolder()
    // Loop turn: onPromptAssembled → sink, then the tee's usage event →
    // observeUsage. Both go to the SAME holder the dispatch seam reads.
    holder.sink(promptSnapshot())
    holder.observeUsage({ reasoningTokens: 15_000 })
    const slashCtx = buildReplSlashCtx(minimalSlashArgs(() => holder.view()))
    const dispatch = buildSurfaceDispatch({
      slashCtx,
      convCheckpointSlot: undefined,
      sessionIo: stubSessionIo,
      // The live wiring: dispatch's OWN contextUsage slot reads the SAME holder.
      contextUsage: () => holder.view(),
      inboundMode: { current: "queue" },
      sessionCwd: process.cwd(),
    })
    const out = await captureStdout(async () => {
      await dispatch("/context")
    })
    // RED-ON-INJECTION: point dispatch.contextUsage at a reasoning-less holder
    // (e.g. re-introduce createPromptAssembledHolder) and "Reasoning" vanishes.
    expect(out).toContain("Reasoning")
    expect(out).toContain("15.0k")
  })

  test("dispatch /context omits Reasoning when no split was observed (byte-identical)", async () => {
    const holder = createContextUsageHolder()
    holder.sink(promptSnapshot()) // snapshot only, no reasoning
    const slashCtx = buildReplSlashCtx(minimalSlashArgs(() => holder.view()))
    const dispatch = buildSurfaceDispatch({
      slashCtx,
      convCheckpointSlot: undefined,
      sessionIo: stubSessionIo,
      contextUsage: () => holder.view(),
      inboundMode: { current: "queue" },
      sessionCwd: process.cwd(),
    })
    const out = await captureStdout(async () => {
      await dispatch("/context")
    })
    expect(out).not.toContain("Reasoning")
    // Sanity: the segmented breakdown DID render (so absence isn't just a
    // fallback/empty path masking the assertion).
    expect(out).toContain("System")
  })
})
