/**
 * A3-S1 hellgate — the panel's turn count and model label stop depending on
 * the legacy feed.
 *
 * Two contract changes ahead of the feed's removal:
 *   1. TURN COUNTING moves to `noteTurn()`, called by the dashboard sink
 *      BEFORE its `if (!metrics) return` guard — today a metrics-less session
 *      never counts a turn, because counting was a side effect of the metrics
 *      fold. A turn is a UI fact, not a metrics fact.
 *   2. The MODEL LABEL comes from the authority's newest record — the model
 *      that actually streamed — instead of the boot label the tee used to
 *      maintain. `/model` mid-session finally shows on the status line.
 */
import { describe, expect, test } from "bun:test"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import { createCostPanel } from "@/apps/cli/cost-panel"
import { composeTurnSinks, createSurfaceState } from "@/apps/cli/repl/surface-compose/turn-sinks"
import type { StreamEvent } from "@/llm"
import { createUsageAccounting } from "@/observability/usage-accounting"
import { makeFakeSessionSetup } from "./_cli-fakes"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const surfaceState = () =>
  createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] })

const emitInto = (accounting: ReturnType<typeof createUsageAccounting>, ev: Partial<UsageEv>) => {
  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "s",
    usageAccounting: accounting,
  } as unknown as AgentConfig
  emitUsage(
    config,
    {
      type: "usage",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000,
      outputTokens: 0,
      ...ev,
    } as UsageEv,
    undefined,
    undefined,
    undefined,
  )
}

describe("A3-S1 — turns are a UI fact, counted without metrics", () => {
  test("a metrics-less session still counts its turns", () => {
    const accounting = createUsageAccounting()
    const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting })
    const setup = makeFakeSessionSetup({ costPanel: panel, metrics: undefined })
    const sinks = composeTurnSinks(setup, surfaceState())
    sinks.renderTurnDashboard()
    sinks.renderTurnDashboard()
    expect(panel.snapshot().turns).toBe(2)
  })

  test("CONTROL: with metrics wired a turn is counted exactly ONCE per dashboard render", () => {
    // Guards the migration itself: while noteTurn and the legacy fold briefly
    // coexist, a turn must not double-count.
    const accounting = createUsageAccounting()
    const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting })
    const setup = makeFakeSessionSetup({ costPanel: panel })
    const sinks = composeTurnSinks(setup, surfaceState())
    sinks.renderTurnDashboard()
    expect(panel.snapshot().turns).toBe(1)
  })
})

describe("A3-S1 — the model label follows what actually streamed", () => {
  test("after a /model switch the status line names the NEW model", () => {
    const accounting = createUsageAccounting()
    const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting })
    emitInto(accounting, { model: "claude-sonnet-4-6" })
    emitInto(accounting, { model: "gpt-5.4" })
    expect(panel.render()).toContain("gpt-5.4")
    expect(panel.snapshot().model).toBe("gpt-5.4")
  })

  test("a hostile newest-record model id is sanitized at the label", () => {
    const ESC = String.fromCharCode(27)
    const accounting = createUsageAccounting()
    const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting })
    emitInto(accounting, { model: `evil${ESC}[31mM` })
    expect(panel.render()).not.toContain(ESC)
  })

  test("CONTROL: with no records the boot label stands", () => {
    const accounting = createUsageAccounting()
    const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting })
    expect(panel.render()).toContain("claude-sonnet-4-6")
  })
})
