/**
 * ALBB-20 #6 (half-wired timeout fail-loud) + #5 (watchdog degrade caller emit).
 *
 * #6 red-on-injection: an AND-gate USED to silently fall through to un-wrapped
 * `src` when EXACTLY ONE of streamWatchdog/streamTimeoutPolicy was set — a
 * misconfigured timeout that never fires, invisible. Assert a warn + stream
 * error fire on the half-wire; both-set wraps; neither passes through.
 *
 * #5 red-on-injection: the watchdog's graceful degrade ends the stream with NO
 * event (plane-clean slice). Assert the CALLER re-derives the degrade from the
 * policy thresholds and emits a non-fatal notice.
 */

import { describe, expect, spyOn, test } from "bun:test"
import { inferDegradeNotice, resolveGuardedStream } from "@/agent/loop/stream-consume"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { logger } from "@/shared"
import type { AgentEvent } from "@/stream"
import { ToolRegistry } from "@/tool"

type Policy = AgentConfig["streamTimeoutPolicy"]

const baseConfig = (over: Record<string, unknown>): AgentConfig =>
  ({
    llm: { stream: async function* () {} },
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...over,
  }) as unknown as AgentConfig

async function* emptySrc(): AsyncIterable<StreamEvent> {}

const idleDegradePolicy = (): Policy => ({ action: "degrade", idleMs: 1000 }) as Policy
const passthroughWatchdog = (): AgentConfig["streamWatchdog"] =>
  ({ wrap: (src: AsyncIterable<StreamEvent>) => src }) as AgentConfig["streamWatchdog"]

describe("stream-consume #6 half-wired timeout fail-loud", () => {
  test("watchdog set but policy absent ⇒ warn + stream error, falls through to src", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const emitted: AgentEvent[] = []
    const src = emptySrc()
    const cfg = baseConfig({
      streamWatchdog: passthroughWatchdog(),
      stream: { emit: (e: AgentEvent) => emitted.push(e) },
    })
    const out = resolveGuardedStream(cfg, src)
    expect(out).toBe(src) // fell through (un-wrapped)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("HALF-WIRED")
    expect(
      emitted.some((e) => e.type === "error" && e.message.includes("HALF-WIRED")),
    ).toBe(true)
    warn.mockRestore()
  })

  test("policy set but watchdog absent ⇒ warn (half-wire other direction)", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const src = emptySrc()
    const cfg = baseConfig({ streamTimeoutPolicy: idleDegradePolicy() })
    expect(resolveGuardedStream(cfg, src)).toBe(src)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test("both absent ⇒ pass-through, NO warn (byte-identical)", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    const src = emptySrc()
    expect(resolveGuardedStream(baseConfig({}), src)).toBe(src)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test("both set ⇒ wraps (watchdog.wrap invoked)", () => {
    let wrapped = false
    const cfg = baseConfig({
      streamTimeoutPolicy: idleDegradePolicy(),
      streamWatchdog: {
        wrap: (src: AsyncIterable<StreamEvent>) => {
          wrapped = true
          return src
        },
      } as AgentConfig["streamWatchdog"],
    })
    resolveGuardedStream(cfg, emptySrc())
    expect(wrapped).toBe(true)
  })
})

describe("stream-consume #5 watchdog degrade caller notice", () => {
  test("idle degrade (action=degrade, gap ≥ idleMs, sawEvent) ⇒ notice", () => {
    const cfg = baseConfig({
      streamWatchdog: passthroughWatchdog(),
      streamTimeoutPolicy: idleDegradePolicy(),
    })
    // lastEventAt at t=0, now=2000 (gap 2000 ≥ idleMs 1000).
    const notice = inferDegradeNotice(cfg, true, 0, 0, 2000)
    expect(notice).toBeDefined()
    expect(notice).toContain("idle-degraded")
  })

  test("no degrade when gap < idleMs (byte-identical, no notice)", () => {
    const cfg = baseConfig({
      streamWatchdog: passthroughWatchdog(),
      streamTimeoutPolicy: idleDegradePolicy(),
    })
    expect(inferDegradeNotice(cfg, true, 0, 0, 500)).toBeUndefined()
  })

  test("no degrade when action != degrade (abort policy rethrows, not silent)", () => {
    const cfg = baseConfig({
      streamWatchdog: passthroughWatchdog(),
      streamTimeoutPolicy: { action: "abort", idleMs: 1000 } as Policy,
    })
    expect(inferDegradeNotice(cfg, true, 0, 0, 5000)).toBeUndefined()
  })

  test("no degrade when zero events seen (a truly empty stream is a different failure)", () => {
    const cfg = baseConfig({
      streamWatchdog: passthroughWatchdog(),
      streamTimeoutPolicy: idleDegradePolicy(),
    })
    expect(inferDegradeNotice(cfg, false, 0, 0, 5000)).toBeUndefined()
  })
})
