/**
 * ADR-0239 §B hellgate — automation-engine tick wire (loop-helpers
 * `startAutomationEngineTicker` + per-session timer arm/disarm).
 *
 * 12 closed cases pinning:
 *
 *   §B1 absent slot ⇒ helper returns undefined (default-OFF byte-identical).
 *   §B2 absent handler ⇒ helper returns undefined (wire-incomplete short-circuit).
 *   §B3 tickIntervalMs absent / 0 / negative / NaN ⇒ no timer armed.
 *   §B4 wire complete (engine + handler + tickIntervalMs>0) ⇒ setInterval armed.
 *   §B5 tick interval cadence — fake setInterval invoked with the configured ms.
 *   §B6 onTick observer fires AFTER tickScheduler outcome on each tick.
 *   §B7 due automation handler invoked at tick — `fired` outcome.
 *   §B8 no-due idle — `idle` outcome reported to onTick (no handler call).
 *   §B9 handler throw ⇒ `errored` outcome surfaces; timer KEEPS ticking.
 *   §B10 stop() clears the interval idempotently (second stop a no-op).
 *   §B11 observer throw is swallowed — timer keeps ticking.
 *   §B12 OFF parity — minimum-viable AgentConfig without automationEngine
 *        is a legal type (slot is optional).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import {
  type AutomationEnginePort,
  inMemoryAutomationEngine,
  type TickOutcome,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"
import { nth } from "../_helpers/expect-present"

/** Build a minimal AgentConfig with ONLY the automationEngine slot wired.
 *  Other AgentConfig fields are stubbed via `as` because the helper reads
 *  ONLY `cfg.automationEngine` — TypeScript's structural typing makes a
 *  Partial-cast acceptable for unit-level integration. */
const cfgWithEngine = (
  block: NonNullable<AgentConfig["automationEngine"]> | undefined,
): AgentConfig =>
  ({
    automationEngine: block,
  }) as unknown as AgentConfig

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

/** Inject a fake setInterval that records `(cb, ms)` arms. */
const fakeIntervalDeps = () => {
  const arms: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
  return {
    arms,
    deps: {
      setInterval: (cb: () => void, ms: number): unknown => {
        const arm = { cb, ms, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (handle: unknown): void => {
        const arm = handle as { cleared: boolean }
        arm.cleared = true
      },
    },
  }
}

describe("ADR-0239 §B — automation-engine tick wire", () => {
  // ── §B1 ── absent slot ⇒ undefined ───────────────────────────────────────
  test("B1: cfg without automationEngine ⇒ helper returns undefined", () => {
    const handle = startAutomationEngineTicker(cfgWithEngine(undefined))
    expect(handle).toBeUndefined()
  })

  // ── §B2 ── handler absent ⇒ undefined (wire-incomplete) ──────────────────
  test("B2: automationEngine present but handler absent ⇒ undefined", () => {
    const engine = inMemoryAutomationEngine()
    const handle = startAutomationEngineTicker(cfgWithEngine({ engine, tickIntervalMs: 50 }))
    expect(handle).toBeUndefined()
  })

  // ── §B3 ── tickIntervalMs absent / 0 / negative / NaN ⇒ no timer ─────────
  test("B3: tickIntervalMs invalid (0 / -1 / NaN / absent) ⇒ no timer armed", () => {
    const engine = inMemoryAutomationEngine()
    const handler = async (): Promise<void> => {}

    expect(startAutomationEngineTicker(cfgWithEngine({ engine, handler }))).toBeUndefined()
    expect(
      startAutomationEngineTicker(cfgWithEngine({ engine, handler, tickIntervalMs: 0 })),
    ).toBeUndefined()
    expect(
      startAutomationEngineTicker(cfgWithEngine({ engine, handler, tickIntervalMs: -1 })),
    ).toBeUndefined()
    expect(
      startAutomationEngineTicker(cfgWithEngine({ engine, handler, tickIntervalMs: Number.NaN })),
    ).toBeUndefined()
  })

  // ── §B4 ── wire complete ⇒ setInterval armed ─────────────────────────────
  test("B4: engine + handler + tickIntervalMs>0 ⇒ helper returns a handle", () => {
    const engine = inMemoryAutomationEngine()
    const { arms, deps } = fakeIntervalDeps()
    const handle = startAutomationEngineTicker(
      cfgWithEngine({ engine, handler: async () => {}, tickIntervalMs: 100 }),
      deps,
    )
    expect(handle).toBeDefined()
    expect(arms.length).toBe(1)
    expect(nth(arms, 0, "arms").ms).toBe(100)
  })

  // ── §B5 ── tickIntervalMs forwarded verbatim ─────────────────────────────
  test("B5: tickIntervalMs knob is forwarded to setInterval verbatim", () => {
    const engine = inMemoryAutomationEngine()
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(
      cfgWithEngine({ engine, handler: async () => {}, tickIntervalMs: 250 }),
      deps,
    )
    expect(nth(arms, 0, "arms").ms).toBe(250)
  })

  // ── §B6 ── onTick observer fires with TickOutcome ────────────────────────
  test("B6: onTick observer is consulted after each tick fires", async () => {
    const engine = inMemoryAutomationEngine()
    const observed: TickOutcome[] = []
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(
      cfgWithEngine({
        engine,
        handler: async () => {},
        tickIntervalMs: 10,
        onTick: (o) => observed.push(o),
        now: () => 0,
      }),
      deps,
    )
    // Manually fire the timer body once and let the promise resolve.
    nth(arms, 0, "arms").cb()
    await Promise.resolve() // micro-tick for the inner .then()
    await Promise.resolve()
    expect(observed.length).toBe(1)
    expect(nth(observed, 0, "observed").kind).toBe("idle") // empty engine ⇒ no due rows
  })

  // ── §B7 ── due automation handler invoked on tick ────────────────────────
  test("B7: a scheduled, due automation fires the handler via the tick", async () => {
    const engine: AutomationEnginePort = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-B7",
      title: "test",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do",
      nextRunAt: 1_000,
      createdAt: 0,
    })

    const handlerCalls: Array<string> = []
    const observed: TickOutcome[] = []
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(
      cfgWithEngine({
        engine,
        handler: async (a) => {
          handlerCalls.push(a.id)
        },
        tickIntervalMs: 10,
        onTick: (o) => observed.push(o),
        now: () => 2_000, // past the row's nextRunAt
      }),
      deps,
    )
    nth(arms, 0, "arms").cb()
    // Wait for async tickScheduler chain to settle.
    await new Promise((r) => setTimeout(r, 5))
    expect(handlerCalls).toContain("auto-B7")
    expect(observed.length).toBeGreaterThan(0)
    expect(nth(observed, 0, "observed").kind).toBe("fired")
  })

  // ── §B8 ── idle tick when nothing is due ────────────────────────────────
  test("B8: idle outcome reported when no rows due (handler NOT called)", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "far-future",
      title: "test",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do",
      nextRunAt: 1_000_000_000_000,
      createdAt: 0,
    })

    const handlerCalls: Array<string> = []
    const observed: TickOutcome[] = []
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(
      cfgWithEngine({
        engine,
        handler: async (a) => {
          handlerCalls.push(a.id)
        },
        tickIntervalMs: 10,
        onTick: (o) => observed.push(o),
        now: () => 0,
      }),
      deps,
    )
    nth(arms, 0, "arms").cb()
    await new Promise((r) => setTimeout(r, 5))
    expect(handlerCalls.length).toBe(0)
    expect(nth(observed, 0, "observed").kind).toBe("idle")
  })

  // ── §B9 ── handler throw ⇒ errored outcome, timer keeps running ──────────
  test("B9: handler throwing surfaces as errored outcome; timer NOT torn down", async () => {
    const engine = inMemoryAutomationEngine()
    await engine.schedule({
      id: "throws",
      title: "test",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do",
      nextRunAt: 1_000,
      createdAt: 0,
    })

    const observed: TickOutcome[] = []
    const { arms, deps } = fakeIntervalDeps()
    const handle = startAutomationEngineTicker(
      cfgWithEngine({
        engine,
        handler: () => {
          throw new Error("handler bug")
        },
        tickIntervalMs: 10,
        onTick: (o) => observed.push(o),
        now: () => 2_000,
      }),
      deps,
    )
    nth(arms, 0, "arms").cb()
    await new Promise((r) => setTimeout(r, 5))
    expect(nth(observed, 0, "observed").kind).toBe("errored")
    // Timer NOT cleared by the throw — the handle is still active.
    expect(nth(arms, 0, "arms").cleared).toBe(false)
    handle?.stop()
    expect(nth(arms, 0, "arms").cleared).toBe(true)
  })

  // ── §B10 ── stop() idempotent ───────────────────────────────────────────
  test("B10: stop() clears the interval once; second stop is no-op", () => {
    const engine = inMemoryAutomationEngine()
    const { arms, deps } = fakeIntervalDeps()
    const handle = startAutomationEngineTicker(
      cfgWithEngine({ engine, handler: async () => {}, tickIntervalMs: 50 }),
      deps,
    )
    expect(handle).toBeDefined()
    expect(nth(arms, 0, "arms").cleared).toBe(false)
    handle?.stop()
    expect(nth(arms, 0, "arms").cleared).toBe(true)
    // Track that a second stop doesn't crash AND doesn't re-clear (the
    // internal handle is nulled so the clearInterval would receive null;
    // the guard inside stop() short-circuits before that).
    expect(() => handle?.stop()).not.toThrow()
  })

  // ── §B11 ── observer throw absorbed — timer keeps ticking ────────────────
  test("B11: a throwing onTick observer does NOT tear down the timer", async () => {
    const engine = inMemoryAutomationEngine()
    const { arms, deps } = fakeIntervalDeps()
    startAutomationEngineTicker(
      cfgWithEngine({
        engine,
        handler: async () => {},
        tickIntervalMs: 10,
        onTick: () => {
          throw new Error("observer bug")
        },
        now: () => 0,
      }),
      deps,
    )
    nth(arms, 0, "arms").cb()
    await new Promise((r) => setTimeout(r, 5))
    // Second tick must also fire without error.
    expect(() => nth(arms, 0, "arms").cb()).not.toThrow()
    await new Promise((r) => setTimeout(r, 5))
    // Timer not cleared by either tick.
    expect(nth(arms, 0, "arms").cleared).toBe(false)
  })

  // ── §B12 ── OFF parity — slot is optional on AgentConfig ─────────────────
  test("B12: AgentConfig.automationEngine slot is OPTIONAL (typecheck shape pin)", () => {
    // Compile-time witness — if `automationEngine` ever became required this
    // line would fail typecheck.
    const minimal: Pick<AgentConfig, "automationEngine"> = {}
    expect(minimal.automationEngine).toBeUndefined()
  })
})
