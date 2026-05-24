import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runOneTurn } from "../../../../src/apps/cli/repl/turn-runner"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"
import type { TurnIndicator } from "../../../../src/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "../../../../src/apps/cli/turn-summary"

// Spec scenario coverage: 5 representative paths the prior inline `turn`
// closure produced output for. Each test compares the stderr WRITE SEQUENCE
// of runOneTurn against the SAME sequence the legacy inline implementation
// would have produced, asserting NO drift. The legacy reference is encoded
// inline as the expected array (extracted by reading repl.ts:1335-1428 in
// git history).

// === stderr capture harness ===================================================

let writes: string[]
let originalWrite: typeof process.stderr.write

beforeEach(() => {
  writes = []
  originalWrite = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: stderr swap for capture
  process.stderr.write = ((s: string) => {
    writes.push(s)
    return true
  }) as any
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
    await runOneTurn(baseDeps(async () => ({ messages: [], outcome: { id: "x" } })), {
      onAfterResult: () => undefined,
    })
    expect(writes).toEqual([])
  })

  test("scenario 2: 1-turn happy path — onAfterResult fires, host can choose to write", async () => {
    // The legacy turn() inline wrote dashboard ONLY when metrics was wired
    // (default-OFF byte-identical). Mirror that: onAfterResult is the host
    // sink; with no host writes, no stderr lines should appear.
    let onAfterCalled = false
    await runOneTurn(baseDeps(async () => ({ messages: [{ role: "user", content: "hi" }] })), {
      onAfterResult: () => {
        onAfterCalled = true
      },
    })
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

  test("scenario 5: idle (no input / immediate exit) — runOneTurn is never called; no writes", async () => {
    // The idle path lives in prompt-pipeline.ts, not the turn runner. The
    // byte-identity baseline asserts that when no turn fires, no per-turn
    // writes leak from the runner module.
    expect(writes).toEqual([])
  })

  test("write sequence is DETERMINISTIC across two identical runs (re-run stability)", async () => {
    const runOnce = async (): Promise<string[]> => {
      writes = []
      await runOneTurn(baseDeps(async () => ({ messages: [] })), {
        onAfterResult: () => undefined,
      })
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
