/**
 * WS-G item 1 (UUX-1-18) — TeeStream degrade + indicator-port double-swallow
 * must produce ONE operator signal (latched — never per-write spam).
 *
 * Before this fix: a faulty teed port was swallowed + tracked by TeeStream
 * (`degraded()` snapshot NOBODY read on the CLI surface), and the indicator
 * port's own `catch {}` swallowed indicator failures so even the TeeStream
 * tracker never saw them — double-swallow, zero operator signal.
 *
 * Red-on-injection: force the failure, assert exactly one notice reached the
 * bus sink (and that the recorder leg kept every event — degrade must not
 * become starvation).
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import type { CliFeatureConfig } from "../../../src/apps/cli/repl/cli-feature-config"
import { buildIndicatorPort } from "../../../src/apps/cli/repl/factories/indicator-stream-port"
import { buildTurnIndicatorAndStream } from "../../../src/apps/cli/repl/factories/turn-indicator"
import { installStatusBar } from "../../../src/apps/cli/status-bar"
import type { TurnIndicator } from "../../../src/apps/cli/turn-indicator"

const textEvent = (delta: string): AgentEvent => ({ type: "assistant_text", delta })

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
})

describe("TeeStream onFirstDegrade latch", () => {
  test("fires ONCE on the first degrade, not per write", () => {
    const seen: unknown[] = []
    const broken: StreamPort = {
      emit: () => {
        throw new Error("sink broke")
      },
    }
    const okEvents: AgentEvent[] = []
    const ok: StreamPort = { emit: (e) => okEvents.push(e) }
    const tee = new TeeStream([ok, broken], {
      onFirstDegrade: (record) => seen.push(record),
    })
    tee.emit(textEvent("a"))
    tee.emit(textEvent("b"))
    tee.emit(textEvent("c"))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ component: "TeeStream", reason: "sink broke" })
    // Degrade is isolation, not starvation — the healthy leg saw every event.
    expect(okEvents).toHaveLength(3)
  })

  test("latch holds across DIFFERENT failure reasons (no reason-keyed spam)", () => {
    let n = 0
    const flaky: StreamPort = {
      emit: () => {
        n++
        throw new Error(`variant-${n}`)
      },
    }
    const seen: unknown[] = []
    const tee = new TeeStream([flaky], { onFirstDegrade: () => seen.push(1) })
    tee.emit(textEvent("a"))
    tee.emit(textEvent("b"))
    expect(seen).toHaveLength(1)
  })

  test("a throwing onFirstDegrade callback never breaks the emit path", () => {
    const broken: StreamPort = {
      emit: () => {
        throw new Error("x")
      },
    }
    const okEvents: AgentEvent[] = []
    const ok: StreamPort = { emit: (e) => okEvents.push(e) }
    const tee = new TeeStream([broken, ok], {
      onFirstDegrade: () => {
        throw new Error("notice sink broke too")
      },
    })
    expect(() => tee.emit(textEvent("a"))).not.toThrow()
    expect(okEvents).toHaveLength(1)
  })

  test("strict mode rethrows BEFORE any degrade callback (eval posture unchanged)", () => {
    const seen: unknown[] = []
    const broken: StreamPort = {
      emit: () => {
        throw new Error("x")
      },
    }
    const tee = new TeeStream([broken], { strict: true, onFirstDegrade: () => seen.push(1) })
    expect(() => tee.emit(textEvent("a"))).toThrow("x")
    expect(seen).toHaveLength(0)
  })
})

describe("REPL wiring — degrade reaches the operator-notice bus", () => {
  const featureCfg = {
    turnIndicator: { enabled: true, intervalMs: 80 },
  } as unknown as CliFeatureConfig

  test("recorder-leg degrade (upstream port throws) reaches the bus as one warn", () => {
    const notices: OperatorNotice[] = []
    installOperatorNoticeSink((n) => notices.push(n))
    const statusBar = installStatusBar("", { stderrIsTTY: false })
    // The upstream port IS the recorder/stdout leg — the exact UUX-1-18
    // degrade class ("TeeStream degrade"). Inject a throwing recorder.
    const upstream: StreamPort = {
      emit: () => {
        throw new Error("recorder died")
      },
    }
    const { turnStream } = buildTurnIndicatorAndStream(featureCfg, statusBar, upstream)
    // Sanity: the factory MUST have teed (indicator enabled) — otherwise this
    // test would vacuously exercise the raw upstream.
    expect(turnStream).not.toBe(upstream)
    expect(() => {
      turnStream.emit(textEvent("a"))
      turnStream.emit(textEvent("b"))
    }).not.toThrow()
    const streamNotices = notices.filter((n) => n.source === "stream")
    expect(streamNotices).toHaveLength(1)
    expect(streamNotices[0]?.severity).toBe("warn")
    expect(streamNotices[0]?.message).toContain("recorder died")
  })

  test("indicator port double-swallow: first internal failure emits ONE warn notice", () => {
    const notices: OperatorNotice[] = []
    installOperatorNoticeSink((n) => notices.push(n))
    const throwingIndicator = {
      markFirstChunk: () => {
        throw new Error("render exploded")
      },
      updateUsage: () => {
        throw new Error("render exploded")
      },
    } as unknown as TurnIndicator
    const port = buildIndicatorPort(throwingIndicator)
    // Multiple failing events ⇒ exactly one notice (latched), no throw.
    expect(() => {
      port.emit(textEvent("a"))
      port.emit({ type: "usage", inputTokens: 1, outputTokens: 2 } as AgentEvent)
      port.emit(textEvent("b"))
    }).not.toThrow()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.severity).toBe("warn")
    expect(notices[0]?.source).toBe("turn-indicator")
  })
})
