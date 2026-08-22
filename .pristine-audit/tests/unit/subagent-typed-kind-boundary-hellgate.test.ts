/**
 * §4.4 e2e HELLGATE — typed agent-kind boundary validation through the REAL
 * `agent` tool seam (createAgentTool → execute → SubagentRequest).
 *
 * Drives the live spawn boundary end-to-end:
 *   1. DEFAULT-OFF byte-identity: with `enforceTypedAgentKind` absent, an
 *      UNKNOWN agent_type still spawns and flows verbatim onto the request.
 *   2. ENFORCED: a well-known kind is canonicalised (case/space normalised)
 *      onto the request the runner sees + the background registry record.
 *   3. ENFORCED: an unregistered custom type is REJECTED with a recoverable
 *      ok:false deny (NO-THROW), and the runner is NEVER invoked.
 *   4. ENFORCED: a registered custom name (via knownAgentTypes) spawns, raw
 *      preserved.
 */

import { describe, expect, test } from "bun:test"
import {
  createAgentTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
} from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"

const ctxAt = (depth = 0): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal, depth }) as ToolContext

const result = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...r,
})

const run = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

/** Captures the SubagentRequest the runner observed (single-shot) + a call
 *  counter so a denied spawn can assert the runner was NOT invoked. */
const capturingRunner = (): {
  runner: SubagentRunner
  seen: () => SubagentRequest | undefined
  calls: () => number
} => {
  let captured: SubagentRequest | undefined
  let n = 0
  const runner: SubagentRunner = async (req) => {
    n += 1
    captured = req
    return result()
  }
  return { runner, seen: () => captured, calls: () => n }
}

describe("§4.4 typed-kind boundary — DEFAULT-OFF byte-identity", () => {
  test("enforcement absent ⇒ UNKNOWN agent_type still spawns, value verbatim", async () => {
    const { runner, seen, calls } = capturingRunner()
    const tool = createAgentTool({ runner })
    const ev = await run(tool, { prompt: "go", agent_type: "ZZ-not-a-kind" }, ctxAt(0))
    expect(ev.type).toBe("result")
    expect((ev as { result: { ok: boolean } }).result.ok).toBe(true)
    expect(calls()).toBe(1)
    expect(seen()?.agentType).toBe("ZZ-not-a-kind") // untouched, not canonicalised
  })

  test("enforcement absent ⇒ a well-known kind is NOT canonicalised (raw 'Plan')", async () => {
    const { runner, seen } = capturingRunner()
    const tool = createAgentTool({ runner })
    await run(tool, { prompt: "go", agent_type: "Plan" }, ctxAt(0))
    expect(seen()?.agentType).toBe("Plan") // byte-identical legacy path
  })
})

describe("§4.4 typed-kind boundary — ENFORCED", () => {
  test("well-known kind ⇒ CANONICALISED onto the request ('  PLAN ' → 'plan')", async () => {
    const { runner, seen } = capturingRunner()
    const tool = createAgentTool({ runner, enforceTypedAgentKind: true })
    await run(tool, { prompt: "go", agent_type: "  PLAN " }, ctxAt(0))
    expect(seen()?.agentType).toBe("plan")
  })

  test("unregistered custom type ⇒ recoverable deny, runner NEVER invoked", async () => {
    const { runner, calls } = capturingRunner()
    const tool = createAgentTool({ runner, enforceTypedAgentKind: true })
    const ev = await run(tool, { prompt: "go", agent_type: "ghost" }, ctxAt(0))
    expect(ev.type).toBe("result")
    const r = (ev as { result: { ok: boolean; output: string } }).result
    expect(r.ok).toBe(false)
    expect(r.output).toContain("ghost")
    expect(calls()).toBe(0) // no spawn happened
  })

  test("REGISTERED custom name ⇒ spawns, raw preserved", async () => {
    const { runner, seen } = capturingRunner()
    const tool = createAgentTool({
      runner,
      enforceTypedAgentKind: true,
      knownAgentTypes: () => ["MyReviewer"],
    })
    await run(tool, { prompt: "go", agent_type: "MyReviewer" }, ctxAt(0))
    expect(seen()?.agentType).toBe("MyReviewer")
  })

  test("absent agent_type ⇒ spawns the general fork (no agentType on request)", async () => {
    const { runner, seen } = capturingRunner()
    const tool = createAgentTool({ runner, enforceTypedAgentKind: true })
    await run(tool, { prompt: "go" }, ctxAt(0))
    const r = seen()
    expect(r).toBeDefined()
    expect("agentType" in (r as object)).toBe(false)
  })

  test("background spawn under enforcement ⇒ canonicalised type reaches the registry record", async () => {
    const { runner } = capturingRunner()
    const tool = createAgentTool({ runner, enforceTypedAgentKind: true })
    await run(tool, { prompt: "go", agent_type: "Review", background: true }, ctxAt(0))
    // The registry record stamps the launching agent_type; under enforcement it
    // is the canonicalised spelling.
    const snaps = tool.registry.list()
    expect(snaps.length).toBe(1)
    expect(snaps[0]?.agentType).toBe("review")
  })

  test("NO-THROW under enforcement with hostile input", async () => {
    const { runner } = capturingRunner()
    const tool = createAgentTool({ runner, enforceTypedAgentKind: true })
    let threw = false
    try {
      await run(tool, { prompt: "go", agent_type: "\uD800" }, ctxAt(0))
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})
