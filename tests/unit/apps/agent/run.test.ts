/**
 * RFC may-22-unified-agent-runtime / Phase 4 — `runAgentLifecycle` contract.
 *
 * Pins the exit-code mapping table and SIGINT install/uninstall symmetry.
 * Tests are hermetic — `runAgent` is stubbed via `RunLifecycleDeps`, and the
 * SIGINT handler set is exercised via an injected `signalSource`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig, AgentOutcome, StopReason } from "@/agent"
import {
  exitCodeForOutcome,
  runAgentLifecycle,
  runAgentLifecycleWith,
} from "@/../src/apps/agent/run"

/** Build an opaque AgentConfig — the wrapper doesn't read any field except
 *  `signal`. We hand it an aborted controller in some tests. */
const stubConfig = (signal: AbortSignal = new AbortController().signal): AgentConfig =>
  ({
    signal,
  }) as unknown as AgentConfig

const stubOutcome = (reason: StopReason): AgentOutcome => ({
  reason,
  turns: 0,
  messages: [],
})

/** Fake SIGINT source — tests can drive `emitSigint()` to fire the handler. */
const makeSignalSource = (): {
  on: (event: "SIGINT", listener: () => void) => unknown
  off: (event: "SIGINT", listener: () => void) => unknown
  emitSigint: () => void
  installCount: () => number
  uninstallCount: () => number
} => {
  const handlers = new Set<() => void>()
  let installs = 0
  let uninstalls = 0
  return {
    on: (_e, l) => {
      installs++
      handlers.add(l)
      return undefined
    },
    off: (_e, l) => {
      uninstalls++
      handlers.delete(l)
      return undefined
    },
    emitSigint: () => {
      for (const h of [...handlers]) h()
    },
    installCount: () => installs,
    uninstallCount: () => uninstalls,
  }
}

describe("exitCodeForOutcome — exit code table", () => {
  test("completed → 0", () => {
    expect(exitCodeForOutcome(stubOutcome("completed"))).toBe(0)
  })

  test("max_turns → 1", () => {
    expect(exitCodeForOutcome(stubOutcome("max_turns"))).toBe(1)
  })

  test("budget_exhausted → 2", () => {
    expect(exitCodeForOutcome(stubOutcome("budget_exhausted"))).toBe(2)
  })

  test("aborted → 130 (SIGINT convention)", () => {
    expect(exitCodeForOutcome(stubOutcome("aborted"))).toBe(130)
  })

  test("error → 1", () => {
    expect(exitCodeForOutcome(stubOutcome("error"))).toBe(1)
  })
})

describe("runAgentLifecycle — outcome → exit code", () => {
  test("completed outcome yields exit 0", async () => {
    const sigSrc = makeSignalSource()
    const out = await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("completed"),
      signalSource: sigSrc,
    })
    expect(out.exitCode).toBe(0)
    expect(out.outcome?.reason).toBe("completed")
  })

  test("max_turns outcome yields exit 1", async () => {
    const sigSrc = makeSignalSource()
    const out = await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("max_turns"),
      signalSource: sigSrc,
    })
    expect(out.exitCode).toBe(1)
  })

  test("budget_exhausted outcome yields exit 2", async () => {
    const sigSrc = makeSignalSource()
    const out = await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("budget_exhausted"),
      signalSource: sigSrc,
    })
    expect(out.exitCode).toBe(2)
  })

  test("aborted outcome yields exit 130", async () => {
    const sigSrc = makeSignalSource()
    const out = await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("aborted"),
      signalSource: sigSrc,
    })
    expect(out.exitCode).toBe(130)
  })

  test("error outcome yields exit 1", async () => {
    const sigSrc = makeSignalSource()
    const out = await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("error"),
      signalSource: sigSrc,
    })
    expect(out.exitCode).toBe(1)
  })
})

describe("runAgentLifecycle — SIGINT handler lifecycle", () => {
  test("install + uninstall are symmetric on success", async () => {
    const sigSrc = makeSignalSource()
    await runAgentLifecycle(stubConfig(), {
      runAgent: async () => stubOutcome("completed"),
      signalSource: sigSrc,
    })
    expect(sigSrc.installCount()).toBe(1)
    expect(sigSrc.uninstallCount()).toBe(1)
  })

  test("finally cleans up handler even when runAgent throws", async () => {
    const sigSrc = makeSignalSource()
    await expect(
      runAgentLifecycle(stubConfig(), {
        runAgent: async () => {
          throw new Error("boom")
        },
        signalSource: sigSrc,
      }),
    ).rejects.toThrow("boom")
    expect(sigSrc.installCount()).toBe(1)
    expect(sigSrc.uninstallCount()).toBe(1)
  })
})

describe("runAgentLifecycleWith — SIGINT triggers controller.abort", () => {
  test("emitting SIGINT aborts the wrapper's controller signal", async () => {
    const sigSrc = makeSignalSource()
    const controller = new AbortController()

    // Run a fake agent that polls the signal until aborted.
    const cfgNoSig = {} as Omit<AgentConfig, "signal">
    const pending = runAgentLifecycleWith(cfgNoSig, controller, {
      runAgent: async (cfg) => {
        // Wait one microtask, then verify the signal is reachable.
        await Promise.resolve()
        // Caller fires SIGINT externally; here we just synthesize that.
        sigSrc.emitSigint()
        await Promise.resolve()
        return {
          reason: cfg.signal.aborted ? "aborted" : "completed",
          turns: 0,
          messages: [],
        }
      },
      signalSource: sigSrc,
    })

    const out = await pending
    expect(controller.signal.aborted).toBe(true)
    expect(out.outcome?.reason).toBe("aborted")
    expect(out.exitCode).toBe(130)
  })

  test("handler removed in finally for controller variant", async () => {
    const sigSrc = makeSignalSource()
    const controller = new AbortController()
    await runAgentLifecycleWith({} as Omit<AgentConfig, "signal">, controller, {
      runAgent: async () => stubOutcome("completed"),
      signalSource: sigSrc,
    })
    expect(sigSrc.installCount()).toBe(1)
    expect(sigSrc.uninstallCount()).toBe(1)
  })
})
