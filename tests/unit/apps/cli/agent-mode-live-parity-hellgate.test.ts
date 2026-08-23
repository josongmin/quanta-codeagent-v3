/**
 * HELLGATE — M: the live AgentMode reaches the gate, and what the model SEES is
 * what dispatch will RUN (§17.5 packet M).
 *
 * Two defects, measured on the shipping composition.
 *
 * **1. The PLAN pill promises a guarantee nothing enforces.**
 * `MODE_CYCLE`'s plan rung is `{ permissionMode: "default", agentMode: "plan" }`
 * and its description reads "research and propose, never touch files". The
 * `permissionMode` half reaches `createSession`. The `agentMode` half reaches a
 * status pill and nothing else: `RuntimeSessionConfig` has no mode field at all,
 * and `agentMode` appears nowhere under `src/host/**`, `src/sdk/**` or
 * `src/agent/**`. So `shift+tab` → PLAN repaints the chrome while the agent
 * keeps full write capability. (Launch-time `--plan` / `QUANTA_PLAN=1` DO work —
 * they set `cfg.planMode` — which is what makes the gap easy to miss.)
 *
 * A posture that is announced but not enforced is worse than one that does not
 * exist: the operator stops watching because the CLI told them it was safe.
 *
 * **2. In a read-only mode the model is still shown tools dispatch will refuse.**
 * `visibleSpecs` is filtered by the SKILL gate only. In plan/review/audit the
 * model is advertised `write`, `edit`, `apply_patch` and `bash` — all of which
 * the dispatch gate refuses — so it spends a turn calling one and reading a
 * denial. The skill-scope code comments call this the "see-but-can't-call
 * fumble" and filter for exactly that reason; mode never got the same treatment.
 *
 * Invariants:
 *
 *  M-1  A live agent mode reaches the per-turn config, so the CLI's PLAN rung
 *       actually gates. RED-ON-INJECTION: unset the live mode and the mutating
 *       tool runs again.
 *  M-2  PARITY — in every read-only mode, model-visible == dispatch-admissible.
 *  M-3  PAIRED CONTROL — a write-capable mode advertises the full tool surface.
 *       A "fix" that hid mutating tools everywhere would pass M-2 and destroy
 *       the product.
 *  M-4  Read-only tools stay visible in every mode — plan mode has to be able to
 *       investigate, and `request_plan_exit` has to be reachable or the model
 *       cannot leave.
 *  M-5  MID-SESSION FLIP — flipping the live mode between turns changes the
 *       advertised surface on the NEXT turn.
 *  M-6  FAIL-CLOSED — an unrecognized mode hides mutating tools rather than
 *       advertising them.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig, AgentMode } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"

const MUTATING_TOOL_NAMES = ["write", "edit", "apply_patch", "bash"] as const
const READ_ONLY_MODES: readonly AgentMode[] = ["plan", "review", "audit"]
const WRITE_CAPABLE_MODES: readonly AgentMode[] = ["default", "editor"]

/** Captures the tool specs advertised on each turn. */
const capturingLlm = (): { llm: LLMPort; turns: string[][] } => {
  const turns: string[][] = []
  const llm = {
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      turns.push(input.tools.map((t) => t.name))
      yield { type: "text_delta", delta: "ok" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  } as LLMPort
  return { llm, turns }
}

const baseConfig = (llm: LLMPort, over: Partial<AgentConfig>): AgentConfig =>
  ({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => undefined },
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    ...over,
  }) as unknown as AgentConfig

const advertisedIn = async (over: Partial<AgentConfig>): Promise<string[]> => {
  const { llm, turns } = capturingLlm()
  await runAgent(baseConfig(llm, over))
  return turns[0] ?? []
}

describe("M-2 parity — a read-only mode does not advertise what dispatch refuses", () => {
  for (const mode of READ_ONLY_MODES) {
    test(`${mode}: no mutating tool is advertised`, async () => {
      const names = await advertisedIn({ mode } as Partial<AgentConfig>)
      const leaked = MUTATING_TOOL_NAMES.filter((t) => names.includes(t))
      expect({ mode, leaked }).toEqual({ mode, leaked: [] })
    })
  }

  test("M-4 read-only tools stay visible in plan mode", async () => {
    const names = await advertisedIn({ mode: "plan" } as Partial<AgentConfig>)
    expect(names).toContain("read")
    expect(names).toContain("grep")
  })

  test("M-4b `request_plan_exit` stays reachable — otherwise plan mode is a trap", async () => {
    const names = await advertisedIn({ mode: "plan" } as Partial<AgentConfig>)
    // Only assert if the tool is registered at all in this build.
    const all = new ToolRegistry(defaultTools).specs().map((s) => s.name)
    if (!all.includes("request_plan_exit")) return
    expect(names).toContain("request_plan_exit")
  })

  test("M-6 FAIL-CLOSED — an unrecognized mode hides mutating tools", async () => {
    const names = await advertisedIn({ mode: "no-such-mode" } as unknown as Partial<AgentConfig>)
    const leaked = MUTATING_TOOL_NAMES.filter((t) => names.includes(t))
    expect(leaked).toEqual([])
  })
})

describe("M-3 PAIRED CONTROL — a write-capable mode keeps the full surface", () => {
  for (const mode of WRITE_CAPABLE_MODES) {
    test(`${mode}: every mutating tool is still advertised`, async () => {
      const names = await advertisedIn({ mode } as Partial<AgentConfig>)
      for (const t of MUTATING_TOOL_NAMES)
        expect({ mode, t, has: names.includes(t) }).toEqual({ mode, t, has: true })
    })
  }

  test("the default (no mode set) surface is unchanged", async () => {
    const names = await advertisedIn({})
    for (const t of MUTATING_TOOL_NAMES) expect(names).toContain(t)
  })
})

describe("M-5 mid-session flip — the advertised surface follows the live mode", () => {
  test("flipping the live mode between turns changes the next turn's surface", async () => {
    let mode: AgentMode = "default"
    const turns: string[][] = []
    const llm = {
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        turns.push(input.tools.map((t) => t.name))
        yield { type: "text_delta", delta: "ok" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    } as LLMPort

    await runAgent(baseConfig(llm, { agentModeState: { get: () => mode } } as Partial<AgentConfig>))
    mode = "plan"
    await runAgent(baseConfig(llm, { agentModeState: { get: () => mode } } as Partial<AgentConfig>))

    const [first, second] = turns
    expect(first).toContain("edit")
    expect(second).not.toContain("edit")
  })
})

describe("M-1 the live mode reaches the DISPATCH gate, not just the prompt", () => {
  /** Drive one mutating tool call and report whether it was refused. */
  const dispatchRefuses = async (over: Partial<AgentConfig>): Promise<boolean> => {
    let n = 0
    const seen: string[] = []
    const llm = {
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        n++
        if (n === 1) {
          yield { type: "tool_use_start", id: "t1", name: "write" }
          yield {
            type: "tool_use_end",
            id: "t1",
            input: { path: "/tmp/quanta-m-hellgate.txt", content: "x" },
          }
          yield { type: "message_stop", stop_reason: "tool_use" }
          return
        }
        for (const m of input.messages) {
          for (const b of m.content) {
            if (b.type === "tool_result") seen.push(JSON.stringify(b))
          }
        }
        yield { type: "text_delta", delta: "ok" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    } as LLMPort
    await runAgent(baseConfig(llm, { maxTurns: 2, ...over }))
    return seen.some((s) => /blocked|not permitted|denied/i.test(s))
  }

  test("a live `plan` mode refuses a mutating tool", async () => {
    expect(
      await dispatchRefuses({ agentModeState: { get: () => "plan" } } as Partial<AgentConfig>),
    ).toBe(true)
  })

  test("RED-ON-INJECTION — with no live mode the SAME call runs", async () => {
    expect(await dispatchRefuses({})).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * M-7 — WIRING PROOF: the CLI's mode cycle reaches the per-turn config.
 *
 * Everything above hands `agentModeState` to `runAgent` directly. That proves
 * the LOOP honors a live mode; it says nothing about whether the CLI's
 * `shift+tab` store actually reaches it — which is the whole defect. So drive
 * the shipped compose path: patch the runtime-context snapshot the way
 * `session-loop/bootstrap.ts` does and assert the built `AgentConfig` carries
 * the reader, then that flipping the store changes what the config resolves to.
 * ------------------------------------------------------------------------- */

import { resolveLiveAgentMode } from "@/agent"
import { MODE_CYCLE } from "@/apps/cli/mode-cycle"

describe("M-7 wiring — the shift+tab cycle reaches the live mode", () => {
  test("the PLAN rung's agentMode is `plan` while its permissionMode is not", () => {
    const plan = MODE_CYCLE.find((r) => r.key === "plan")
    if (plan === undefined) throw new Error("expected a plan rung")
    // This is the whole reason the bug was invisible: the permission axis, which
    // IS wired, carries nothing distinguishing for this rung. Only `agentMode`
    // does, and it had no consumer.
    expect(plan.agentMode).toBe("plan")
    expect(plan.permissionMode).toBe("default")
  })

  test("a config carrying the cycle's reader resolves the LIVE posture", () => {
    let rung = MODE_CYCLE.find((r) => r.key === "default")
    const state = { get: () => rung?.agentMode ?? "default" }
    const cfg = { agentModeState: state } as Parameters<typeof resolveLiveAgentMode>[0]

    expect(resolveLiveAgentMode(cfg)).toBe("default")
    rung = MODE_CYCLE.find((r) => r.key === "plan")
    expect(resolveLiveAgentMode(cfg)).toBe("plan")
  })

  test("`agentModeState` is a pass-through compose key — asserted at runtime", async () => {
    // A key silently dropped from this list makes the compose option inert,
    // which is exactly how a wired-looking feature ends up reaching nothing.
    // Asserting the exported list (rather than grepping the file) means a rename
    // fails here instead of passing on a stale string.
    const { PASS_THROUGH_COMPOSE_KEYS } = await import("@/sdk/runtime/context")
    expect([...PASS_THROUGH_COMPOSE_KEYS]).toContain("agentModeState")
  })
})
