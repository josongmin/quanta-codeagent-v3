import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runOneTurn } from "../../../../src/apps/cli/repl/turn-runner"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"
import type { TurnIndicator } from "../../../../src/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "../../../../src/apps/cli/turn-summary"

// HONEST SCOPE (relabelled): the post-refactor `runOneTurn` routes ALL output
// through injected sinks (status bar / indicator / summary collector), so it
// writes NOTHING to raw `process.stderr` itself. These 5 scenarios (the paths
// the prior inline `turn` closure covered) therefore assert `writes === []` —
// i.e. the runner does not bypass its sinks and write to stderr directly — while
// separately asserting the SINK received the expected message (e.g. `errMessages
// === ["aborted"]`). This catches a regression that writes to stderr directly
// (bypassing sinks); it does NOT compare byte content against a legacy reference
// array and CANNOT detect a sink emitting wrong bytes — that is the sinks' own
// tests' job. The "byte-identity baseline" name is retained for continuity but
// the guarantee is "runner is stderr-silent; sinks own output", not a byte diff.

// === stderr capture harness ===================================================

let writes: string[]
let originalWrite: typeof process.stderr.write

beforeEach(() => {
  writes = []
  originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((s: string) => {
    writes.push(s)
    return true
  }) as typeof process.stderr.write
})
afterEach(() => {
  process.stderr.write = originalWrite
})

// === stubs (force non-TTY path so indicator + cancel are no-ops) ==============

let stdinSwap: NodeJS.ReadStream
beforeEach(() => {
  stdinSwap = process.stdin
  Object.defineProperty(process, "stdin", {
    value: { isTTY: false } as Partial<NodeJS.ReadStream>,
    configurable: true,
  })
})
afterEach(() => {
  Object.defineProperty(process, "stdin", { value: stdinSwap, configurable: true })
})

const noopStatusBar: StatusBar = {
  setDefault: () => undefined,
  transient: () => undefined,
  clearTransient: () => undefined,
  teardown: () => undefined,
}
const noopIndicator: TurnIndicator = {
  start: () => undefined,
  stop: () => undefined,
  updateUsage: () => undefined,
  markFirstChunk: () => undefined,
}
const noopSummary: TurnSummaryCollector = {
  onEvent: () => undefined,
  render: () => "",
  reset: () => undefined,
  asStreamPort: () => ({ emit: () => undefined }),
}

const baseDeps = <R>(body: (signal: AbortSignal) => Promise<R>) => ({
  outerAbort: new AbortController(),
  statusBar: noopStatusBar,
  turnIndicator: noopIndicator,
  turnSummary: noopSummary,
  escWindowMs: 2000,
  body,
})

// === scenarios ===============================================================

describe("repl byte-identity baseline — 5 scenarios", () => {
  test("scenario 1: empty session (body returns immediately, no metrics, no summary) — ZERO stderr writes", async () => {
    await runOneTurn(
      baseDeps(async () => ({ messages: [], outcome: { id: "x" } })),
      {
        onAfterResult: () => undefined,
      },
    )
    expect(writes).toEqual([])
  })

  test("scenario 2: 1-turn happy path — onAfterResult fires, host can choose to write", async () => {
    // The legacy turn() inline wrote dashboard ONLY when metrics was wired
    // (default-OFF byte-identical). Mirror that: onAfterResult is the host
    // sink; with no host writes, no stderr lines should appear.
    let onAfterCalled = false
    await runOneTurn(
      baseDeps(async () => ({ messages: [{ role: "user", content: "hi" }] })),
      {
        onAfterResult: () => {
          onAfterCalled = true
        },
      },
    )
    expect(onAfterCalled).toBe(true)
    expect(writes).toEqual([])
  })

  test("scenario 3: abort mid-flight (outer-abort) — onError handles display; no other writes", async () => {
    const errMessages: string[] = []
    const deps = baseDeps(async (signal) => {
      return new Promise<{ messages: [] }>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })
    queueMicrotask(() => deps.outerAbort.abort())
    await runOneTurn(deps, {
      onError: (e) => errMessages.push((e as Error).message),
    })
    expect(errMessages).toEqual(["aborted"])
    expect(writes).toEqual([]) // sink owns the actual stderr write; runner itself is silent
  })

  test("scenario 4: indicator failure inside body — error path; sinks orchestrate display", async () => {
    const errors: string[] = []
    await runOneTurn(
      baseDeps(async () => {
        throw new Error("indicator down")
      }),
      {
        onError: (e) => errors.push((e as Error).message),
      },
    )
    expect(errors).toEqual(["indicator down"])
    // runner alone writes NOTHING; the host sink is responsible for the
    // stderr line (the legacy turn() inline wrote it via process.stderr.write
    // directly — Slice-C moved that responsibility to the sink).
    expect(writes).toEqual([])
  })

  test("scenario 5: idle (body returns immediately with empty messages) — ZERO stderr writes from runner", async () => {
    // T3 strengthening — REGRESSION CLASS CAUGHT: the prior version of
    // this test did NOT call `runOneTurn` at all (it just asserted
    // `writes` was empty, which is trivially true since `beforeEach`
    // resets it). A regression that made `runOneTurn` write a banner on
    // EVERY call would still pass.
    //
    // We rewrite to actually invoke the unit with the idle-equivalent
    // body (immediately resolves with empty messages, mirroring what
    // prompt-pipeline.ts would supply on a no-input turn) and verify
    // the runner emits ZERO stderr writes.
    const out = await runOneTurn(
      baseDeps(async () => ({ messages: [] })),
      {
        onAfterResult: () => undefined,
      },
    )
    expect(out.result).toEqual({ messages: [] })
    expect(out.turnAborted).toBe(false)
    expect(writes).toEqual([])
  })

  test("write sequence is DETERMINISTIC across two identical runs (re-run stability)", async () => {
    const runOnce = async (): Promise<string[]> => {
      writes = []
      await runOneTurn(
        baseDeps(async () => ({ messages: [] })),
        {
          onAfterResult: () => undefined,
        },
      )
      return [...writes]
    }
    const a = await runOnce()
    const b = await runOnce()
    expect(a).toEqual(b)
  })

  test("turn-summary reset is called in the finally path (safety-net invariant)", async () => {
    const events: string[] = []
    const sum: TurnSummaryCollector = {
      onEvent: () => undefined,
      render: () => "",
      reset: () => events.push("reset"),
      asStreamPort: () => ({ emit: () => undefined }),
    }
    await runOneTurn({ ...baseDeps(async () => "ok"), turnSummary: sum }, {})
    expect(events).toContain("reset")
  })

  test("indicator.start + stop bracket — every successful turn fires both", async () => {
    const events: string[] = []
    const ind: TurnIndicator = {
      start: () => events.push("start"),
      stop: () => events.push("stop"),
      updateUsage: () => undefined,
      markFirstChunk: () => undefined,
    }
    await runOneTurn({ ...baseDeps(async () => "ok"), turnIndicator: ind }, {})
    expect(events[0]).toBe("start")
    expect(events).toContain("stop")
  })
})
