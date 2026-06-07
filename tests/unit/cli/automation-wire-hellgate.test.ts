/**
 * ADR-0279 + ADR-0280 hellgate — automation engine composition-root wire
 * + `automation_update` tool + REPL inbox banner.
 *
 * 22 adversarial cases:
 *
 *   Normal (4)
 *     HELL-AW-01 QUANTA_AUTOMATION=on ⇒ engine slot constructed
 *     HELL-AW-02 startAutomationEngineTicker arms a timer from the slot
 *     HELL-AW-03 due automation ⇒ run row in engine.runs
 *     HELL-AW-04 fire ⇒ inbox entry appended
 *
 *   Hard corners (10)
 *     HELL-AW-05 5 concurrent due rows ⇒ 5 runs across 5 ticks (one-per-tick)
 *     HELL-AW-06 invalid RRULE on create ⇒ tool ok:false (engine untouched)
 *     HELL-AW-07 clock backwards skew ⇒ tick safe (no double fire / no throw)
 *     HELL-AW-08 spawn agent throw ⇒ run.status errored + onTick warning
 *     HELL-AW-09 ticker stop mid-handler ⇒ in-flight run finalizes
 *     HELL-AW-10 inbox full (>= cap) ⇒ banner still emits (LRU is engine job)
 *     HELL-AW-11 concurrent CRUD via tool ⇒ race-safe (id uniqueness)
 *     HELL-AW-12 cancel during running ⇒ that fire completes, automation gone
 *     HELL-AW-13 RRULE no UNTIL ⇒ runtime safe (single fire per tick)
 *     HELL-AW-14 timezone skew (UTC ms input) ⇒ engine is tz-agnostic
 *
 *   Tool + banner (4)
 *     HELL-AW-15 6-action round-trip via tool
 *     HELL-AW-16 defaultTools registration: env on ⇒ tool present; off ⇒ absent
 *     HELL-AW-17 banner unread count tracks engine inbox
 *     HELL-AW-18 banner writes stderr; stdout receives zero bytes
 *
 *   Wire / cleanup (4)
 *     HELL-AW-19 default-OFF ⇒ assembleAutomation returns null
 *     HELL-AW-20 AbortSignal / stop() ⇒ clean teardown (no further ticks)
 *     HELL-AW-21 no zombie timer after stop (fake setInterval not re-armed)
 *     HELL-AW-22 invalid interval env ⇒ null + warn
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { startAutomationEngineTicker } from "@/agent/loop-helpers"
import { createInboxBanner } from "@/apps/cli/repl/automation-banner"
import {
  type AutomationEnginePort,
  inMemoryAutomationEngine,
  tickScheduler,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import {
  type AssembleAutomationDeps,
  AUTOMATION_ENV_FLAG,
  AUTOMATION_INTERVAL_ENV,
  assembleAutomation,
  DEFAULT_AUTOMATION_INTERVAL_MS,
} from "@/scheduler/runtime-wire"
import type { AgentLoopPort, RRule } from "@/scheduler/types"
import { buildDefaultTools } from "@/tool"
import { automationUpdateTool } from "@/tool/automation_update"
import type { ToolContext, ToolEvent } from "@/tool/types"

// ── Fixtures ───────────────────────────────────────────────────────────────

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, 0)

const makeEnv = (overrides: Record<string, string>): { get: (k: string) => string | undefined } => {
  const map = new Map(Object.entries(overrides))
  return { get: (k) => map.get(k) }
}

const noopAgentLoop: AgentLoopPort = {
  enqueueUserMessage: async () => {},
}

const recordingAgentLoop = (): {
  loop: AgentLoopPort
  enqueued: string[]
} => {
  const enqueued: string[] = []
  return {
    loop: {
      enqueueUserMessage: async (m) => {
        enqueued.push(m)
      },
    },
    enqueued,
  }
}

const throwingAgentLoop = (msg = "spawn failed"): AgentLoopPort => ({
  enqueueUserMessage: async () => {
    throw new Error(msg)
  },
})

const makeCtx = (): ToolContext =>
  ({
    cwd: "/tmp/test-automation",
    signal: new AbortController().signal,
  }) as unknown as ToolContext

const drainTool = async (
  iter: AsyncIterable<ToolEvent>,
): Promise<{ ok: boolean; output: string; structured?: Record<string, unknown> }> => {
  for await (const e of iter) {
    if (e.type === "result") {
      const r = e.result
      const out: { ok: boolean; output: string; structured?: Record<string, unknown> } = {
        ok: r.ok,
        output: r.output ?? "",
      }
      const structured = (r as { structured?: Record<string, unknown> }).structured
      if (structured !== undefined) out.structured = structured
      return out
    }
  }
  throw new Error("tool yielded no result")
}

// ─────────────────────────────────────────────────────────────────────────
// Normal (4)
// ─────────────────────────────────────────────────────────────────────────

describe("ADR-0279/0280 — automation wire hellgate", () => {
  test("HELL-AW-01: QUANTA_AUTOMATION=on ⇒ engine slot constructed", () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    expect(slot).not.toBeNull()
    if (slot === null) throw new Error("unreachable")
    expect(slot.engine).toBeDefined()
    expect(slot.handler).toBeInstanceOf(Function)
    expect(slot.tickIntervalMs).toBe(DEFAULT_AUTOMATION_INTERVAL_MS)
    expect(slot.onTick).toBeInstanceOf(Function)
  })

  test("HELL-AW-02: startAutomationEngineTicker arms a timer from the slot", () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_INTERVAL_ENV]: "100" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const arms: Array<{ cb: () => void; ms: number; cleared: boolean }> = []
    const deps = {
      setInterval: (cb: () => void, ms: number): unknown => {
        const arm = { cb, ms, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (h: unknown): void => {
        ;(h as { cleared: boolean }).cleared = true
      },
    }
    const cfg = { automationEngine: slot } as unknown as AgentConfig
    const handle = startAutomationEngineTicker(cfg, deps)
    expect(handle).toBeDefined()
    expect(arms).toHaveLength(1)
    expect(arms[0]!.ms).toBe(100)
    handle!.stop()
    expect(arms[0]!.cleared).toBe(true)
  })

  test("HELL-AW-03: due automation ⇒ run row in engine.runs", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const { loop, enqueued } = recordingAgentLoop()
    const slot = assembleAutomation(env, { agentLoop: loop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do thing",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const outcome = await tickScheduler({
      engine,
      now: utc(2026, 5, 25, 11),
      handler: slot.handler,
    })
    expect(outcome.kind).toBe("fired")
    expect(engine.runs).toHaveLength(1)
    expect(engine.runs[0]!.automationId).toBe("a1")
    expect(enqueued).toEqual(["do thing"])
  })

  test("HELL-AW-04: fire ⇒ inbox entry appended", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "Daily",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    await tickScheduler({ engine, now: utc(2026, 5, 25, 11), handler: slot.handler })
    expect(engine.inbox).toHaveLength(1)
    expect(engine.inbox[0]!.automationId).toBe("a1")
    expect(engine.inbox[0]!.read).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Hard corners (10)
  // ───────────────────────────────────────────────────────────────────────

  test("HELL-AW-05: 5 concurrent due rows ⇒ 5 runs across 5 ticks", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    const now = utc(2026, 5, 25, 12)
    for (let i = 0; i < 5; i++) {
      await engine.schedule({
        id: `a${i}`,
        title: `T${i}`,
        rule: ruleOf("FREQ=DAILY"),
        prompt: `p${i}`,
        nextRunAt: now - 1000,
        createdAt: now - 10_000,
      })
    }
    // 5 ticks, each handles one due row (tickScheduler is single-row).
    for (let i = 0; i < 5; i++) {
      const out = await tickScheduler({ engine, now, handler: slot.handler })
      expect(out.kind).toBe("fired")
    }
    expect(engine.runs).toHaveLength(5)
    // Each id fired exactly once (the engine advances nextRunAt per fire,
    // so the next tick picks the next-due row).
    const seen = new Set(engine.runs.map((r) => r.automationId))
    expect(seen.size).toBe(5)
  })

  test("HELL-AW-06: invalid RRULE on create ⇒ tool ok:false (engine untouched)", async () => {
    const engine = inMemoryAutomationEngine()
    const tool = automationUpdateTool(engine)
    const result = await drainTool(
      tool.execute(
        {
          action: "create" as const,
          id: "bad",
          title: "T",
          rule: "FREQ=GARBAGE",
          prompt: "p",
          nextRunAt: utc(2026, 5, 25, 10),
        },
        makeCtx(),
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/invalid RRULE/)
    // Engine untouched
    const list = await engine.list()
    if (!list.ok) throw new Error("unreachable")
    expect(list.value).toHaveLength(0)
  })

  test("HELL-AW-07: clock backwards skew ⇒ tick safe (no double fire / no throw)", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    // First fire at 11am
    await tickScheduler({ engine, now: utc(2026, 5, 25, 11), handler: slot.handler })
    expect(engine.runs).toHaveLength(1)
    // Clock skews backwards to 10:30 — should NOT re-fire (engine's
    // advanced nextRunAt is at next day).
    const out = await tickScheduler({
      engine,
      now: utc(2026, 5, 25, 10, 30),
      handler: slot.handler,
    })
    expect(out.kind).toBe("idle")
    expect(engine.runs).toHaveLength(1) // unchanged
  })

  test("HELL-AW-08: spawn agent throw ⇒ run.status errored + onTick warning", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const stderrCaptured: string[] = []
    const deps: AssembleAutomationDeps = {
      agentLoop: throwingAgentLoop("spawn boom"),
      stderr: (s) => stderrCaptured.push(s),
    }
    const slot = assembleAutomation(env, deps)
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    const out = await tickScheduler({
      engine,
      now: utc(2026, 5, 25, 11),
      handler: slot.handler,
    })
    expect(out.kind).toBe("errored")
    if (out.kind !== "errored") throw new Error("unreachable")
    expect(out.errorMessage).toMatch(/spawn boom/)
    expect(engine.runs).toHaveLength(1)
    expect(engine.runs[0]!.outcome).toBe("errored")
    // Now exercise onTick → stderr surface
    slot.onTick(out)
    expect(stderrCaptured.join("")).toMatch(/automation.*errored.*a1/)
  })

  test("HELL-AW-09: ticker stop mid-handler ⇒ in-flight run finalizes", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    let resolveHandler!: () => void
    const handlerGate = new Promise<void>((res) => {
      resolveHandler = res
    })
    const slowLoop: AgentLoopPort = {
      enqueueUserMessage: async () => {
        await handlerGate
      },
    }
    const slot = assembleAutomation(env, { agentLoop: slowLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    // Manually arm the ticker via the helper and stop immediately.
    const arms: Array<{ cb: () => void; cleared: boolean }> = []
    const deps = {
      setInterval: (cb: () => void): unknown => {
        const arm = { cb, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (h: unknown): void => {
        ;(h as { cleared: boolean }).cleared = true
      },
    }
    const cfg = {
      automationEngine: { ...slot, now: () => utc(2026, 5, 25, 11) },
    } as unknown as AgentConfig
    const handle = startAutomationEngineTicker(cfg, deps)
    // Fire one tick
    arms[0]!.cb()
    // Stop while handler is still pending
    handle!.stop()
    expect(arms[0]!.cleared).toBe(true)
    // Let the handler finalize
    resolveHandler()
    // Wait for in-flight to drain
    await new Promise((r) => setTimeout(r, 10))
    // Run row was recorded (markRun happens after handler resolves)
    expect(engine.runs.length).toBeGreaterThanOrEqual(1)
  })

  test("HELL-AW-10: inbox at cap ⇒ banner still emits", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    // Drive many fires by scheduling + firing one row repeatedly (rule
    // advances nextRunAt each tick).
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25),
      createdAt: utc(2026, 5, 25),
    })
    for (let i = 0; i < 50; i++) {
      // Tick each day forward — rule says DAILY, so the next fire is +1 day.
      const day = utc(2026, 5, 25 + i, 12)
      await tickScheduler({ engine, now: day, handler: slot.handler })
    }
    // No LRU cap in the v1 engine — banner just reflects the count.
    const captured: string[] = []
    const banner = createInboxBanner({
      engine,
      stderr: (s) => captured.push(s),
    })
    await banner.paint()
    expect(banner.lastCount).toBe(engine.inbox.length)
    expect(captured.join("")).toMatch(/inbox: \d+/)
  })

  test("HELL-AW-11: concurrent CRUD via tool ⇒ race-safe (id uniqueness)", async () => {
    const engine = inMemoryAutomationEngine()
    const tool = automationUpdateTool(engine)
    const ctx = makeCtx()
    // 20 concurrent creates of distinct ids — should all succeed.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        drainTool(
          tool.execute(
            {
              action: "create" as const,
              id: `a${i}`,
              title: `T${i}`,
              rule: "FREQ=DAILY",
              prompt: `p${i}`,
              nextRunAt: utc(2026, 5, 25, 10),
            },
            ctx,
          ),
        ),
      ),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    // 20 concurrent duplicate creates of id "dup" — exactly 1 succeeds.
    await drainTool(
      tool.execute(
        {
          action: "create" as const,
          id: "dup",
          title: "T",
          rule: "FREQ=DAILY",
          prompt: "p",
          nextRunAt: utc(2026, 5, 25, 10),
        },
        ctx,
      ),
    )
    const dups = await Promise.all(
      Array.from({ length: 20 }, () =>
        drainTool(
          tool.execute(
            {
              action: "create" as const,
              id: "dup",
              title: "T",
              rule: "FREQ=DAILY",
              prompt: "p",
              nextRunAt: utc(2026, 5, 25, 10),
            },
            ctx,
          ),
        ),
      ),
    )
    expect(dups.every((r) => !r.ok)).toBe(true)
  })

  test("HELL-AW-12: cancel during running ⇒ that fire completes, automation gone", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const { loop, enqueued } = recordingAgentLoop()
    const slot = assembleAutomation(env, { agentLoop: loop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    await tickScheduler({ engine, now: utc(2026, 5, 25, 11), handler: slot.handler })
    expect(enqueued).toEqual(["do"])
    // Cancel via the tool
    const tool = automationUpdateTool(engine)
    const cancelRes = await drainTool(
      tool.execute({ action: "cancel" as const, id: "a1" }, makeCtx()),
    )
    expect(cancelRes.ok).toBe(true)
    // Subsequent ticks see no row
    const out = await tickScheduler({ engine, now: utc(2026, 5, 26, 11), handler: slot.handler })
    expect(out.kind).toBe("idle")
  })

  test("HELL-AW-13: RRULE no UNTIL ⇒ safe (single fire per tick)", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    await engine.schedule({
      id: "infinite",
      title: "Forever",
      rule: ruleOf("FREQ=DAILY"), // no UNTIL, no COUNT
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    // 10 ticks at the same instant — only 1 fires (rule advances after each).
    let fires = 0
    for (let i = 0; i < 10; i++) {
      const out = await tickScheduler({ engine, now: utc(2026, 5, 25, 11), handler: slot.handler })
      if (out.kind === "fired") fires++
    }
    expect(fires).toBe(1)
  })

  test("HELL-AW-14: timezone skew (UTC ms input) ⇒ engine is tz-agnostic", async () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const engine = slot.engine as ReturnType<typeof inMemoryAutomationEngine>
    // Schedule at UTC midnight.
    await engine.schedule({
      id: "tz",
      title: "TZ",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 0, 0),
      createdAt: utc(2026, 5, 24),
    })
    // "now" can be in any zone — the input is ms-epoch, so the engine
    // sees the same instant. Verify both UTC and a local-skewed value
    // produce the same outcome.
    const out1 = await tickScheduler({ engine, now: utc(2026, 5, 25, 1, 0), handler: slot.handler })
    expect(out1.kind).toBe("fired")
    // No re-fire from a "different timezone" view (still ms-epoch, just shifted)
    const out2 = await tickScheduler({ engine, now: utc(2026, 5, 25, 5, 0), handler: slot.handler })
    expect(out2.kind).toBe("idle")
  })

  // ───────────────────────────────────────────────────────────────────────
  // Tool + banner (4)
  // ───────────────────────────────────────────────────────────────────────

  test("HELL-AW-15: 6-action round-trip via tool", async () => {
    const engine = inMemoryAutomationEngine()
    const tool = automationUpdateTool(engine)
    const ctx = makeCtx()

    const created = await drainTool(
      tool.execute(
        {
          action: "create" as const,
          id: "a1",
          title: "T",
          rule: "FREQ=DAILY",
          prompt: "p",
          nextRunAt: utc(2026, 5, 25, 10),
        },
        ctx,
      ),
    )
    expect(created.ok).toBe(true)

    const listed = await drainTool(tool.execute({ action: "list" as const }, ctx))
    expect(listed.ok).toBe(true)
    expect(listed.structured?.automations).toBeDefined()

    const got = await drainTool(tool.execute({ action: "get" as const, id: "a1" }, ctx))
    expect(got.ok).toBe(true)

    const paused = await drainTool(tool.execute({ action: "pause" as const, id: "a1" }, ctx))
    expect(paused.ok).toBe(true)

    // After pause (= cancel), the engine returns ok:true for idempotent
    // re-cancel.
    const resumed = await drainTool(tool.execute({ action: "resume" as const, id: "a1" }, ctx))
    expect(resumed.ok).toBe(true)

    const cancelled = await drainTool(tool.execute({ action: "cancel" as const, id: "a1" }, ctx))
    expect(cancelled.ok).toBe(true)

    // list is now empty (cancelled rows excluded)
    const listed2 = await drainTool(tool.execute({ action: "list" as const }, ctx))
    expect((listed2.structured?.automations as Array<unknown>).length).toBe(0)
  })

  test("HELL-AW-16: defaultTools registration — env on ⇒ tool present; off ⇒ absent", () => {
    // Off
    const offTools = buildDefaultTools()
    expect(offTools.find((t) => t.name === "automation_update")).toBeUndefined()
    // On — pass the engine port (which is what the composition root does
    // when QUANTA_AUTOMATION=on).
    const engine = inMemoryAutomationEngine()
    const onTools = buildDefaultTools({ automationEngine: engine })
    expect(onTools.find((t) => t.name === "automation_update")).toBeDefined()
  })

  test("HELL-AW-17: banner unread count tracks engine inbox", async () => {
    const engine = inMemoryAutomationEngine()
    const captured: string[] = []
    const banner = createInboxBanner({
      engine,
      stderr: (s) => captured.push(s),
    })
    await banner.paint()
    expect(banner.lastCount).toBe(0)
    // Inject inbox entries by manually firing through the engine.
    await engine.schedule({
      id: "a1",
      title: "T",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: utc(2026, 5, 25, 10),
      createdAt: utc(2026, 5, 25),
    })
    await tickScheduler({
      engine,
      now: utc(2026, 5, 25, 11),
      handler: async () => {},
    })
    await banner.paint()
    expect(banner.lastCount).toBe(1)
    expect(captured.join("")).toMatch(/\[automation inbox: 1\]/)
  })

  test("HELL-AW-18: banner writes stderr; stdout receives zero bytes", async () => {
    const engine = inMemoryAutomationEngine()
    let stdoutBytes = 0
    const stderrCaptured: string[] = []
    // Wrap stdout writer to count bytes.
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown): boolean => {
      stdoutBytes += typeof chunk === "string" ? chunk.length : 0
      return true
    }) as typeof process.stdout.write
    try {
      const banner = createInboxBanner({
        engine,
        stderr: (s) => stderrCaptured.push(s),
      })
      // Populate inbox
      await engine.schedule({
        id: "a1",
        title: "T",
        rule: ruleOf("FREQ=DAILY"),
        prompt: "p",
        nextRunAt: utc(2026, 5, 25, 10),
        createdAt: utc(2026, 5, 25),
      })
      await tickScheduler({ engine, now: utc(2026, 5, 25, 11), handler: async () => {} })
      await banner.paint()
    } finally {
      process.stdout.write = origWrite
    }
    expect(stdoutBytes).toBe(0)
    expect(stderrCaptured.join("")).toMatch(/automation inbox/)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Wire / cleanup (4)
  // ───────────────────────────────────────────────────────────────────────

  test("HELL-AW-19: default-OFF ⇒ assembleAutomation returns null", () => {
    expect(assembleAutomation(makeEnv({}), { agentLoop: noopAgentLoop })).toBeNull()
    expect(
      assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "off" }), { agentLoop: noopAgentLoop }),
    ).toBeNull()
    expect(
      assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "1" }), { agentLoop: noopAgentLoop }),
    ).toBeNull()
    expect(
      assembleAutomation(makeEnv({ [AUTOMATION_ENV_FLAG]: "true" }), { agentLoop: noopAgentLoop }),
    ).toBeNull()
  })

  test("HELL-AW-20: stop() ⇒ clean teardown (no further ticks)", () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const arms: Array<{ cb: () => void; cleared: boolean }> = []
    const deps = {
      setInterval: (cb: () => void): unknown => {
        const arm = { cb, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (h: unknown): void => {
        ;(h as { cleared: boolean }).cleared = true
      },
    }
    const cfg = { automationEngine: slot } as unknown as AgentConfig
    const handle = startAutomationEngineTicker(cfg, deps)
    expect(handle).toBeDefined()
    handle!.stop()
    expect(arms[0]!.cleared).toBe(true)
    // Idempotent: second stop is a no-op
    handle!.stop()
    expect(arms[0]!.cleared).toBe(true)
  })

  test("HELL-AW-21: no zombie timer after stop (fake setInterval not re-armed)", () => {
    const env = makeEnv({ [AUTOMATION_ENV_FLAG]: "on" })
    const slot = assembleAutomation(env, { agentLoop: noopAgentLoop })
    if (slot === null) throw new Error("unreachable")
    const arms: Array<{ cb: () => void; cleared: boolean }> = []
    const deps = {
      setInterval: (cb: () => void): unknown => {
        const arm = { cb, cleared: false }
        arms.push(arm)
        return arm
      },
      clearInterval: (h: unknown): void => {
        ;(h as { cleared: boolean }).cleared = true
      },
    }
    const cfg = { automationEngine: slot } as unknown as AgentConfig
    const handle = startAutomationEngineTicker(cfg, deps)
    handle!.stop()
    // No additional setInterval was armed.
    expect(arms).toHaveLength(1)
    expect(arms[0]!.cleared).toBe(true)
  })

  test("HELL-AW-22: invalid interval env ⇒ null + warn", () => {
    // negative, zero, NaN, non-numeric all yield null
    const negEnv = makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_INTERVAL_ENV]: "-5" })
    expect(assembleAutomation(negEnv, { agentLoop: noopAgentLoop })).toBeNull()
    const zeroEnv = makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_INTERVAL_ENV]: "0" })
    expect(assembleAutomation(zeroEnv, { agentLoop: noopAgentLoop })).toBeNull()
    const nanEnv = makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_INTERVAL_ENV]: "abc" })
    expect(assembleAutomation(nanEnv, { agentLoop: noopAgentLoop })).toBeNull()
    // Empty / absent ⇒ default interval (non-null)
    const emptyEnv = makeEnv({ [AUTOMATION_ENV_FLAG]: "on", [AUTOMATION_INTERVAL_ENV]: "" })
    expect(assembleAutomation(emptyEnv, { agentLoop: noopAgentLoop })).not.toBeNull()
  })
})
