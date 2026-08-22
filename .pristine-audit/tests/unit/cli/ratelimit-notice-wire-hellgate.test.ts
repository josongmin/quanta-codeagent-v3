import { describe, expect, test } from "bun:test"
import { readCliFeatureConfig } from "../../../src/apps/cli/repl/cli-feature-config"
import { buildTurnIndicatorAndStream } from "../../../src/apps/cli/repl/factories/turn-indicator"
import type { StatusBar } from "../../../src/apps/cli/status-bar"
import type { AgentEvent, StreamPort } from "../../../src/stream"

/**
 * P27 hellgate — REPL tee wiring for the rate-limit notice.
 *
 * Pins:
 *   - knob OFF + indicator OFF ⇒ `turnStream === stream` VERBATIM (no tee
 *     allocated) — byte-identical default-OFF contract.
 *   - knob ON ⇒ a tee is allocated; the upstream `stream` STILL sees every
 *     event (recorder leg is never starved), AND a reached `ratelimit_snapshot`
 *     reaches the status bar.
 *   - the notice + indicator gates are INDEPENDENT (notice ON while indicator
 *     OFF still tees the notice port).
 */

const recordingBar = (): { bar: StatusBar; calls: string[] } => {
  const calls: string[] = []
  const bar: StatusBar = {
    setDefault: () => undefined,
    transient: (text: string) => {
      calls.push(text)
    },
    clearTransient: () => undefined,
    teardown: () => undefined,
  }
  return { bar, calls }
}

const recordingStream = (): { stream: StreamPort; events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  return { stream: { emit: (e) => events.push(e) }, events }
}

const reachedSnap: Extract<AgentEvent, { type: "ratelimit_snapshot" }> = {
  type: "ratelimit_snapshot",
  tokensRemaining: 0,
  tokensResetMs: 3 * 3600_000,
  observedAt: 1,
}

describe("P27 buildTurnIndicatorAndStream — default-OFF byte identity", () => {
  test("indicator OFF + notice OFF ⇒ turnStream === stream (no tee)", () => {
    // Non-TTY ⇒ indicator OFF; no QUANTA_RATELIMIT_NOTICE ⇒ notice OFF.
    const cfg = readCliFeatureConfig({}, false, false)
    expect(cfg.ratelimitNotice.enabled).toBe(false)
    const { bar } = recordingBar()
    const { stream } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, bar, stream)
    expect(turnStream).toBe(stream)
  })

  test("notice OFF ⇒ a reached snapshot never reaches the status bar", () => {
    const cfg = readCliFeatureConfig({}, false, false)
    const { bar, calls } = recordingBar()
    const { stream } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, bar, stream)
    turnStream.emit(reachedSnap)
    expect(calls.length).toBe(0)
  })
})

describe("P27 buildTurnIndicatorAndStream — notice ON wiring", () => {
  test("notice ON (indicator OFF) ⇒ tee allocated, notice painted, upstream still fed", () => {
    const cfg = readCliFeatureConfig({ QUANTA_RATELIMIT_NOTICE: "1" }, false, false)
    expect(cfg.ratelimitNotice.enabled).toBe(true)
    expect(cfg.turnIndicator.enabled).toBe(false) // non-TTY ⇒ indicator OFF
    const { bar, calls } = recordingBar()
    const { stream, events } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, bar, stream)
    // A tee was allocated (independent of the indicator gate).
    expect(turnStream).not.toBe(stream)
    turnStream.emit(reachedSnap)
    // Notice painted to the status bar.
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain("토큰 한도")
    // AND the upstream recorder/stdout leg still saw the event (never starved).
    expect(events).toEqual([reachedSnap])
  })

  test("notice ON but snapshot has HEADROOM ⇒ no paint, upstream still fed", () => {
    const cfg = readCliFeatureConfig({ QUANTA_RATELIMIT_NOTICE: "on" }, false, false)
    const { bar, calls } = recordingBar()
    const { stream, events } = recordingStream()
    const { turnStream } = buildTurnIndicatorAndStream(cfg, bar, stream)
    const headroom: AgentEvent = {
      type: "ratelimit_snapshot",
      tokensRemaining: 100,
      observedAt: 1,
    }
    turnStream.emit(headroom)
    expect(calls.length).toBe(0)
    expect(events).toEqual([headroom])
  })

  test("a config WITHOUT a ratelimitNotice block is treated as OFF (no throw)", () => {
    // Defensive optional-chain: a pre-P27 / partial stub config has no block.
    const cfg = readCliFeatureConfig({}, false, false)
    // biome-ignore lint/suspicious/noExplicitAny: simulate a pre-P27 config.
    const partial = { ...cfg, ratelimitNotice: undefined } as any
    const { bar } = recordingBar()
    const { stream } = recordingStream()
    expect(() => buildTurnIndicatorAndStream(partial, bar, stream)).not.toThrow()
    const { turnStream } = buildTurnIndicatorAndStream(partial, bar, stream)
    expect(turnStream).toBe(stream)
  })
})
