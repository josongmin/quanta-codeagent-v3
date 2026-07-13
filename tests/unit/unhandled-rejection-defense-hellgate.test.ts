/**
 * OWNER-LOCAL HELLGATE — feature `unhandled-rejection-defense` (L4).
 *
 * The CLI entry wires a process-level `unhandledRejection` handler as a
 * last-resort safety net for promise rejections that escape the agent loop's
 * try/catch boundaries. Two CRITICAL contracts had integration-only coverage
 * and NO fault-injected unit observation before this battery:
 *
 *   (a) On an escaped rejection it emits EXACTLY ONE stderr diagnostic line and
 *       DELIBERATELY does NOT end process lifetime (no `process.exit`). The loop
 *       owns process lifetime + owes trajectory finalisation; exiting here would
 *       lose in-flight state.
 *   (b) The handler is wired to the CLI entry EXACTLY ONCE (idempotent install).
 *
 * These tests feed a fake rejection event into the extracted pure handler with
 * an injected fake logger and an injected `exit` SPY, and assert the real
 * effects. The `exit` spy is injected via a proxy target the handler could call
 * (it structurally cannot), so a red-on-injection edit that adds a
 * `process.exit(1)` is observable here.
 */

import { describe, expect, mock, test } from "bun:test"
import {
  installUnhandledRejectionDefense,
  makeUnhandledRejectionHandler,
  type RejectionListenerTarget,
} from "@/apps/cli/unhandled-rejection-defense"

/** Fake logger capturing every `error(...)` call so we can assert the exact
 *  count + content of diagnostic lines. */
const makeFakeLogger = () => {
  const lines: string[] = []
  return {
    lines,
    error: (msg: string) => {
      lines.push(msg)
    },
  }
}

describe("unhandled-rejection-defense — CRITICAL contract (a): log once, never exit", () => {
  test("an escaped rejection emits EXACTLY ONE diagnostic line naming the reason", () => {
    const log = makeFakeLogger()
    const handler = makeUnhandledRejectionHandler({ logger: log })

    handler(new Error("escaped background flush"))

    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]).toContain("unhandled rejection")
    expect(log.lines[0]).toContain("escaped background flush")
  })

  test("the handler NEVER calls process.exit — exit spy stays untouched", () => {
    // Global effect observation: install a spy over the REAL process.exit for
    // the duration of the call. If the handler ever ends process lifetime this
    // fires. (`exit` is not a dep of the handler by design — this pins that the
    // structural guarantee actually holds at runtime.)
    const log = makeFakeLogger()
    const exitSpy = mock((_code?: number) => undefined as never)
    const realExit = process.exit
    // biome-ignore lint/suspicious/noExplicitAny: test seam over process.exit
    ;(process as any).exit = exitSpy
    try {
      const handler = makeUnhandledRejectionHandler({ logger: log })
      handler(new Error("must not exit"))
    } finally {
      process.exit = realExit
    }

    expect(exitSpy).not.toHaveBeenCalled()
    // and it still produced its single diagnostic line
    expect(log.lines).toHaveLength(1)
  })

  test("PAIRED CONTROL: with no rejection event, logger + exit stay silent", () => {
    const log = makeFakeLogger()
    const exitSpy = mock((_code?: number) => undefined as never)
    const realExit = process.exit
    // biome-ignore lint/suspicious/noExplicitAny: test seam over process.exit
    ;(process as any).exit = exitSpy
    try {
      // Build the handler but NEVER invoke it (the normal path: no escaped
      // rejection). Nothing should be logged and nothing should exit.
      makeUnhandledRejectionHandler({ logger: log })
    } finally {
      process.exit = realExit
    }

    expect(log.lines).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})

describe("unhandled-rejection-defense — CRITICAL contract (b): wired EXACTLY once", () => {
  const makeFakeTarget = () => {
    const handlers: Array<(reason: unknown) => void> = []
    const target: RejectionListenerTarget = {
      on: (_event, handler) => {
        handlers.push(handler)
        return target
      },
      listenerCount: () => handlers.length,
    }
    return { target, handlers }
  }

  test("install registers the handler on the target exactly once", () => {
    const { target, handlers } = makeFakeTarget()
    const log = makeFakeLogger()

    installUnhandledRejectionDefense(target, { logger: log })

    expect(handlers).toHaveLength(1)
    expect(target.listenerCount?.("unhandledRejection")).toBe(1)
  })

  test("repeated install is idempotent — NO duplicate registration", () => {
    const { target, handlers } = makeFakeTarget()
    const log = makeFakeLogger()

    installUnhandledRejectionDefense(target, { logger: log })
    installUnhandledRejectionDefense(target, { logger: log })
    installUnhandledRejectionDefense(target, { logger: log })

    expect(handlers).toHaveLength(1)
    expect(target.listenerCount?.("unhandledRejection")).toBe(1)
  })

  test("the registered handler observes real effects: one line, still no exit", () => {
    const { target, handlers } = makeFakeTarget()
    const log = makeFakeLogger()
    const exitSpy = mock((_code?: number) => undefined as never)
    const realExit = process.exit
    // biome-ignore lint/suspicious/noExplicitAny: test seam over process.exit
    ;(process as any).exit = exitSpy
    try {
      installUnhandledRejectionDefense(target, { logger: log })
      // Drive the exact handler that was wired onto the target.
      const wired = handlers[0]
      expect(wired).toBeDefined()
      wired?.(new Error("wired-path rejection"))
    } finally {
      process.exit = realExit
    }

    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]).toContain("wired-path rejection")
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
