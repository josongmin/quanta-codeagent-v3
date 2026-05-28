/**
 * ADR-0393 hellgate — SYNCHRONOUS delegation tool (`delegate`).
 *
 * Adversarial seal for the synchronous boomerang tool + its caller wire. Two
 * dimensions:
 *
 *   A. WIRE (structural) — mirror of `subagent-background-wire-hellgate`:
 *      (1) tier1 barrel re-exports `buildDelegateBlock`.
 *      (2) `AgentConfig.delegation` slot accepts `{ delegator }`.
 *      (3) `FeaturesConfig` Pick union includes `"delegation"`.
 *      (4) slot ABSENT ⇒ `delegate` NOT in extraTools (default-OFF byte-identical).
 *      (5) slot WIRED ⇒ `delegate` lands in extraTools.
 *      (6) the wired tool is bound to the SAME delegator instance.
 *
 *   B. BEHAVIOUR (tool surface) — the `delegate` tool itself:
 *      - happy path: calls port.delegate + renders BoomerangResult.
 *      - port NO-THROW operational failure ⇒ ok:false with typed errorKind.
 *      - port THROWS (programmer-bug path) ⇒ graceful ok:false, never bubbles.
 *      - unknown mode ⇒ rejected at the schema boundary (port never reached).
 *      - already-aborted signal ⇒ ok:false "aborted before start".
 *      - parent signal threads into the request (cancellation propagation).
 *      - mode mirror set equals the producer `AGENT_MODES` (no drift).
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { AGENT_MODES, type DelegationPort } from "@/agent/subagent-typed"
import { buildDelegateBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, type ToolContext, ToolRegistry } from "@/tool"
import { DELEGATE_MODES, delegateTool } from "@/tool/delegate"

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

/** A stub delegator capturing the last request + returning a canned result. */
const stubDelegator = (
  result: Awaited<ReturnType<DelegationPort["delegate"]>>,
): DelegationPort & { last?: Parameters<DelegationPort["delegate"]>[0] } => {
  const port: DelegationPort & { last?: Parameters<DelegationPort["delegate"]>[0] } = {
    delegate: async (req) => {
      port.last = req
      return result
    },
    listModes: () => AGENT_MODES,
    describeMode: () => null,
  }
  return port
}

const ctx = (signal: AbortSignal): ToolContext => ({ cwd: "/tmp", signal })

const drain = async (
  tool: ReturnType<typeof delegateTool>,
  input: unknown,
  c: ToolContext,
): Promise<{ ok: boolean; output: string }> => {
  let last: { ok: boolean; output: string } | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  if (last === undefined) throw new Error("tool yielded no terminal result")
  return last
}

describe("delegate tool — wire hellgate (ADR-0393)", () => {
  test("(1) tier1 barrel re-exports buildDelegateBlock", () => {
    expect(typeof buildDelegateBlock).toBe("function")
  })

  test("(2) AgentConfig.delegation slot accepts {delegator}", () => {
    const delegator = stubDelegator({
      ok: true,
      summary: "s",
      mode: "explore",
      turns: 1,
      durationMs: 1,
    })
    const cfg = baseCfg({ delegation: { delegator } })
    expect(cfg.delegation?.delegator).toBe(delegator)
  })

  test("(3) FeaturesConfig Pick union includes 'delegation'", () => {
    const delegator = stubDelegator({
      ok: true,
      summary: "s",
      mode: "explore",
      turns: 1,
      durationMs: 1,
    })
    const fc: FeaturesConfig = baseCfg({ delegation: { delegator } })
    expect(fc.delegation?.delegator).toBe(delegator)
  })

  test("(4) slot absent ⇒ delegate NOT in extraTools (default-OFF)", async () => {
    const features = await buildSessionFeatures(baseCfg())
    expect(features.extraTools.map((t) => t.name)).not.toContain("delegate")
  })

  test("(5) slot wired ⇒ delegate lands in extraTools", async () => {
    const delegator = stubDelegator({
      ok: true,
      summary: "s",
      mode: "explore",
      turns: 1,
      durationMs: 1,
    })
    const features = await buildSessionFeatures(baseCfg({ delegation: { delegator } }))
    expect(features.extraTools.map((t) => t.name)).toContain("delegate")
  })

  test("(6) builder binds to the SAME delegator (call routes through it)", async () => {
    const delegator = stubDelegator({
      ok: true,
      summary: "routed",
      mode: "architect",
      turns: 2,
      durationMs: 5,
    })
    const tools = buildDelegateBlock(baseCfg({ delegation: { delegator } }))
    const tool = tools.find((t) => t.name === "delegate")
    expect(tool).toBeDefined()
    const out = await drain(
      tool as ReturnType<typeof delegateTool>,
      { mode: "architect", task: "design X" },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(true)
    expect(delegator.last?.prompt).toBe("design X")
    expect(delegator.last?.mode).toBe("architect")
    expect(out.output).toContain("routed")
  })
})

describe("delegate tool — behaviour hellgate (ADR-0393)", () => {
  test("happy path: renders BoomerangResult ok + summary + artifacts", async () => {
    const port = stubDelegator({
      ok: true,
      summary: "done the thing",
      mode: "tdd",
      turns: 3,
      durationMs: 42,
      artifacts: { "plan.md": "step 1\nstep 2" },
    })
    const out = await drain(
      delegateTool(port),
      { mode: "tdd", task: "write tests" },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(true)
    expect(out.output).toContain("mode=tdd")
    expect(out.output).toContain("done the thing")
    expect(out.output).toContain("plan.md")
    expect(out.output).toContain("step 1")
  })

  test("port NO-THROW operational failure ⇒ ok:false with typed errorKind in output", async () => {
    const port = stubDelegator({
      ok: false,
      summary: "",
      mode: "editor",
      turns: 0,
      durationMs: 1,
      errorKind: "budget-overflow",
      errorMessage: "maxTurns 99 exceeds mode cap",
    })
    const out = await drain(
      delegateTool(port),
      { mode: "editor", task: "edit", maxTurns: 99 },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(false)
    expect(out.output).toContain("budget-overflow")
    expect(out.output).toContain("maxTurns 99 exceeds mode cap")
  })

  test("port THROWS (programmer-bug path) ⇒ graceful ok:false, never bubbles", async () => {
    const port: DelegationPort = {
      delegate: async () => {
        throw new Error("boom")
      },
      listModes: () => AGENT_MODES,
      describeMode: () => null,
    }
    const out = await drain(
      delegateTool(port),
      { mode: "debug", task: "x" },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(false)
    expect(out.output).toContain("boom")
  })

  test("unknown mode ⇒ rejected at schema boundary, port NEVER reached", async () => {
    let reached = false
    const port: DelegationPort = {
      delegate: async () => {
        reached = true
        return { ok: true, summary: "", mode: "explore", turns: 0, durationMs: 0 }
      },
      listModes: () => AGENT_MODES,
      describeMode: () => null,
    }
    const out = await drain(
      delegateTool(port),
      { mode: "wizard", task: "x" },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(false)
    expect(out.output).toContain("invalid input")
    expect(reached).toBe(false)
  })

  test("already-aborted signal ⇒ ok:false 'aborted before start', port NEVER reached", async () => {
    let reached = false
    const port: DelegationPort = {
      delegate: async () => {
        reached = true
        return { ok: true, summary: "", mode: "explore", turns: 0, durationMs: 0 }
      },
      listModes: () => AGENT_MODES,
      describeMode: () => null,
    }
    const ac = new AbortController()
    ac.abort()
    const out = await drain(delegateTool(port), { mode: "explore", task: "x" }, ctx(ac.signal))
    expect(out.ok).toBe(false)
    expect(out.output).toContain("aborted before start")
    expect(reached).toBe(false)
  })

  test("parent signal threads into the delegation request (cancellation propagation)", async () => {
    const port = stubDelegator({
      ok: true,
      summary: "s",
      mode: "explore",
      turns: 1,
      durationMs: 1,
    })
    const ac = new AbortController()
    await drain(delegateTool(port), { mode: "explore", task: "x" }, ctx(ac.signal))
    expect(port.last?.parentSignal).toBe(ac.signal)
  })

  test("explore is a MODE VALUE, not a port method — reached via mode:'explore'", async () => {
    // Guards the spec note: there is no `explore` method. The only way to an
    // explore-mode child is passing mode:"explore" to delegate.
    const port = stubDelegator({
      ok: true,
      summary: "explored",
      mode: "explore",
      turns: 1,
      durationMs: 1,
    })
    expect("explore" in port).toBe(false)
    const out = await drain(
      delegateTool(port),
      { mode: "explore", task: "investigate" },
      ctx(new AbortController().signal),
    )
    expect(out.ok).toBe(true)
    expect(port.last?.mode).toBe("explore")
  })

  test("mode mirror set equals producer AGENT_MODES (no drift)", () => {
    expect([...DELEGATE_MODES].sort()).toEqual([...AGENT_MODES].sort())
  })
})
