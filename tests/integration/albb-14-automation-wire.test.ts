/**
 * ALBB-14 §Automation — the automation ticker must be armed by the SHARED
 * session lifecycle (session-bootstrap), not only by the CLI REPL. Non-CLI
 * surfaces (web-daemon / headless) reach the AgentConfig base via
 * `createRuntimeFromAgentConfigBase` and today never start a ticker, so a
 * scheduled fire is either never ticked or hits the composition-root stub and
 * is silently dropped.
 *
 * These cases pin:
 *   §A1 a non-CLI-shaped assembled config (automationEngine slot + real handler
 *       + fake interval deps) delivers a due fire to the handler via
 *       `maybeStartAutomationTicker` (the shared-lifecycle arm).
 *   §A2 absent slot ⇒ no ticker armed (default-OFF byte-identical).
 *   §A3 the composition-root stub handler is FAIL-LOUD: invoking it increments
 *       the `automation.fires_dropped_no_handler` counter (posture b), so the
 *       web-daemon delivery gap surfaces in metrics instead of a silent drop.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { createRunAgentContext, maybeStartAutomationTicker } from "@/agent/loop/session-bootstrap"
import {
  __resolveAutomationForTest,
  AUTOMATION_FIRES_DROPPED_COUNTER,
} from "@/host/runtime/agent-arg-builder"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { metrics } from "@/observability"
import {
  type AutomationEnginePort,
  type EngineAutomation,
  inMemoryAutomationEngine,
} from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import type { RRule } from "@/scheduler/types"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error(`bad rule: ${s}`)
  const { ok: _ok, ...rest } = r
  return rest
}

/** Fake setInterval that records `(cb, ms)` arms so a test can fire the timer
 *  body deterministically. */
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
        ;(handle as { cleared: boolean }).cleared = true
      },
    },
  }
}

const cfgWithEngine = (
  block: NonNullable<AgentConfig["automationEngine"]> | undefined,
): AgentConfig => ({ automationEngine: block }) as unknown as AgentConfig

describe("ALBB-14 §Automation — shared-lifecycle ticker delivery", () => {
  // ── §A1 ── non-CLI config with a real handler delivers a due fire ────────
  test("A1: maybeStartAutomationTicker on a non-CLI config delivers a due fire", async () => {
    const engine: AutomationEnginePort = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-A1",
      title: "test",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "do the thing",
      nextRunAt: 1_000,
      createdAt: 0,
    })
    const delivered: string[] = []
    const { arms, deps } = fakeIntervalDeps()
    const handle = maybeStartAutomationTicker(
      cfgWithEngine({
        engine,
        handler: async (a) => {
          delivered.push(a.id)
        },
        tickIntervalMs: 10,
        now: () => 2_000, // past the row's nextRunAt
      }),
      deps,
    )
    expect(handle).toBeDefined()
    expect(arms.length).toBe(1)
    // Fire the timer body once; let the async tick chain settle.
    arms[0]!.cb()
    await new Promise((r) => setTimeout(r, 5))
    expect(delivered).toContain("auto-A1")
    handle?.stop()
    expect(arms[0]!.cleared).toBe(true)
  })

  // ── §A2 ── absent slot ⇒ no ticker (default-OFF byte-identical) ──────────
  test("A2: no automationEngine slot ⇒ no ticker armed", () => {
    const { arms, deps } = fakeIntervalDeps()
    const handle = maybeStartAutomationTicker(cfgWithEngine(undefined), deps)
    expect(handle).toBeUndefined()
    expect(arms.length).toBe(0)
  })

  // ── §A4 ── BOOTSTRAP WIRE (end-to-end): createRunAgentContext itself arms
  //          the ticker (real setInterval) so a non-CLI surface delivers a due
  //          fire — WITHOUT the CLI. Mutation guard: removing the
  //          `maybeStartAutomationTicker(cfg)` arm from createRunAgentContext
  //          makes this RED (no timer ⇒ handler never called).
  test("A4: createRunAgentContext arms the shared-lifecycle ticker and delivers a fire", async () => {
    const inertLLM: LLMPort = {
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        throw new Error("unexpected stream() call")
      },
    }
    const fakeTool = (name: string): Tool => ({
      name,
      description: name,
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute(): AsyncIterable<ToolEvent> {
        yield { type: "result", result: { ok: true, output: "" } }
      },
    })
    const engine: AutomationEnginePort = inMemoryAutomationEngine()
    await engine.schedule({
      id: "auto-A4",
      title: "test",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "bootstrap fire",
      nextRunAt: 1_000,
      createdAt: 0,
    })
    const delivered: string[] = []
    const cfg = {
      llm: inertLLM,
      registry: new ToolRegistry([fakeTool("read")]),
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: "SYS",
      cwd: "/repo",
      maxTurns: 2,
      signal: new AbortController().signal,
      automationEngine: {
        engine,
        handler: async (a: EngineAutomation) => {
          delivered.push(a.id)
        },
        tickIntervalMs: 15, // short real interval — fires within the wait window
        now: () => 2_000, // past nextRunAt
      },
    } as unknown as AgentConfig

    const ctx = await createRunAgentContext(cfg)
    try {
      // Let the REAL setInterval armed by createRunAgentContext tick at least once.
      await new Promise((r) => setTimeout(r, 60))
      expect(delivered).toContain("auto-A4")
    } finally {
      // Teardown stops the ticker (guaranteed on both finish + throw paths).
      await ctx.disposeResources()
    }
  })
})

describe("ALBB-14 §Automation — composition-root stub is fail-loud (posture b)", () => {
  // ── §A3 ── the stub handler increments the drop counter ──────────────────
  test("A3: invoking the composition-root stub handler increments the drop counter", async () => {
    process.env.QUANTA_AUTOMATION = "on"
    process.env.QUANTA_AUTOMATION_INTERVAL_MS = "1000"
    const slot = __resolveAutomationForTest(process.env) as NonNullable<
      AgentConfig["automationEngine"]
    > | null
    expect(slot).not.toBeNull()
    const counterName = AUTOMATION_FIRES_DROPPED_COUNTER
    const before = metrics.snapshot().counters[counterName] ?? 0
    // Directly exercise the stub handler the base composition-root installed.
    await slot!.handler!({
      id: "drop-A3",
      title: "t",
      rule: ruleOf("FREQ=DAILY"),
      prompt: "p",
      nextRunAt: 0,
      createdAt: 0,
      status: "scheduled",
      fireCount: 0,
    })
    const after = metrics.snapshot().counters[counterName] ?? 0
    expect(after).toBe(before + 1)
  })
})
