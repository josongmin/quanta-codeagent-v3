/**
 * ADR-0429 hellgate — ADVISOR tool (`advisor`).
 *
 * Agent-callable "consult a STRONGER/DIFFERENT model for a second opinion"
 * tool. Claude cc-cli ships `advisor_20260301{model}`. quanta today has
 * model-swap-on-retry (ADR-0066, failure-driven), role-model-override
 * (ADR-0256, a RESOLVER not a tool) and delegate (ADR-0393, picks a MODE not a
 * MODEL) — none is an agent-callable consult-stronger-model tool. This seals
 * the new one.
 *
 * Two dimensions:
 *
 *   A. WIRE (structural) — mirror of `delegate-tool-hellgate`:
 *      (1) tier1 barrel re-exports `buildAdvisorBlock`.
 *      (2) `AgentConfig.advisor` slot accepts `{ consult, models }`.
 *      (3) `FeaturesConfig` Pick union includes `"advisor"`.
 *      (4) slot ABSENT ⇒ `advisor` NOT in extraTools (default-OFF byte-identical).
 *      (5) slot WIRED ⇒ `advisor` lands in extraTools.
 *      (6) the wired tool is bound to the SAME advisor port instance.
 *
 *   B. BEHAVIOUR (tool surface) — the `advisor` tool itself:
 *      - happy path: advisor returns analysis ⇒ surfaced verbatim in result.
 *      - requested `model` NOT in allowlist ⇒ typed ok:false ToolFailure
 *        (mode:"rejected"), port NEVER reached (no crash).
 *      - advisor port returns NO-THROW operational failure ⇒ ok:false with
 *        typed errorKind (loop survives).
 *      - advisor port THROWS / times out ⇒ graceful ok:false, never bubbles.
 *      - already-aborted signal ⇒ ok:false "aborted before start".
 *      - the parent signal threads into the consult request.
 *      - PURE CONSULT: the advisor's surface carries NO write/edit/bash tool —
 *        it cannot mutate files or call other tools.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { buildAdvisorBlock } from "@/agent/tier1"
import type { AgentConfig, FeaturesConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, type ToolContext, ToolRegistry, type ToolResult } from "@/tool"
import {
  type AdvisorConsultRequest,
  type AdvisorConsultResult,
  type AdvisorPort,
  advisorTool,
} from "@/tool/advisor"

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

/** A stub advisor capturing the last request + returning a canned result.
 *  `models` is the allowlist the tool validates an explicit `model` against. */
const stubAdvisor = (
  result: AdvisorConsultResult,
  models: readonly string[] = ["o3", "claude-opus-4-8"],
): AdvisorPort & { last?: AdvisorConsultRequest } => {
  const port: AdvisorPort & { last?: AdvisorConsultRequest } = {
    consult: async (req) => {
      port.last = req
      return result
    },
    listModels: () => models,
  }
  return port
}

/** Drive a tool to its single terminal `result`. */
const runTool = async (
  tool: ReturnType<typeof advisorTool>,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("tool produced no result event")
  return last
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
})

const okResult = (analysis: string, modelUsed = "o3"): AdvisorConsultResult => ({
  ok: true,
  analysis,
  modelUsed,
})

// ─── A. WIRE ────────────────────────────────────────────────────────────────

describe("advisor wire (structural)", () => {
  test("tier1 barrel re-exports buildAdvisorBlock", () => {
    expect(typeof buildAdvisorBlock).toBe("function")
  })

  test("AgentConfig.advisor slot ABSENT ⇒ advisor NOT registered (default-OFF)", async () => {
    const features = await buildSessionFeatures(baseCfg())
    expect(features.extraTools.some((t) => t.name === "advisor")).toBe(false)
  })

  test("AgentConfig.advisor slot WIRED ⇒ advisor lands in extraTools", async () => {
    const port = stubAdvisor(okResult("use a queue"))
    const features = await buildSessionFeatures(
      baseCfg({ advisor: { consult: port.consult, models: port.listModels() } }),
    )
    expect(features.extraTools.some((t) => t.name === "advisor")).toBe(true)
  })

  test("(3) FeaturesConfig Pick union includes 'advisor'", () => {
    const port = stubAdvisor(okResult("x"))
    // Type-level seal: if `"advisor"` were dropped from the Pick union this
    // assignment would be a compile error (the slot would not exist on the
    // narrowed type), and `buildSessionFeatures` could not see it.
    const fc: FeaturesConfig = baseCfg({
      advisor: { consult: port.consult, models: port.listModels() },
    })
    expect(fc.advisor).toBeDefined()
  })

  test("buildAdvisorBlock empty when slot absent; one tool when wired", () => {
    expect(buildAdvisorBlock(baseCfg())).toHaveLength(0)
    const port = stubAdvisor(okResult("x"))
    const built = buildAdvisorBlock(
      baseCfg({ advisor: { consult: port.consult, models: port.listModels() } }),
    )
    expect(built).toHaveLength(1)
    expect(built[0]?.name).toBe("advisor")
  })
})

// ─── B. BEHAVIOUR ─────────────────────────────────────────────────────────────

describe("advisor behaviour (tool surface)", () => {
  test("declares the pure-consult contract: read-only, hitl none, concurrency-safe", () => {
    const tool = advisorTool(stubAdvisor(okResult("x")))
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe({} as never)).toBe(true)
    expect(tool.hitlTier?.({} as never)).toBe("none")
  })

  test("happy path: advisor analysis is surfaced in the tool result", async () => {
    const port = stubAdvisor(okResult("Prefer a bounded work queue with backpressure."))
    const tool = advisorTool(port)
    const r = await runTool(tool, { question: "How do I avoid unbounded fan-out?" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Prefer a bounded work queue with backpressure.")
    expect(port.last?.question).toBe("How do I avoid unbounded fan-out?")
  })

  test("optional context is threaded to the advisor", async () => {
    const port = stubAdvisor(okResult("ok"))
    await runTool(
      advisorTool(port),
      { question: "review this", context: "function f() { return 1 }" },
      ctx(),
    )
    expect(port.last?.context).toBe("function f() { return 1 }")
  })

  test("requested model NOT in allowlist ⇒ typed ok:false rejected, port NEVER reached", async () => {
    const port = stubAdvisor(okResult("should never see this"), ["o3"])
    const r = await runTool(
      advisorTool(port),
      { question: "q", model: "gpt-definitely-not-allowed" },
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
    // The port was never consulted — the allowlist rejection short-circuits.
    expect(port.last).toBeUndefined()
  })

  test("requested model IN allowlist ⇒ threaded to the consult request", async () => {
    const port = stubAdvisor(okResult("ok", "claude-opus-4-8"), ["o3", "claude-opus-4-8"])
    const r = await runTool(advisorTool(port), { question: "q", model: "claude-opus-4-8" }, ctx())
    expect(r.ok).toBe(true)
    expect(port.last?.model).toBe("claude-opus-4-8")
  })

  test("advisor NO-THROW operational failure ⇒ ok:false with typed errorKind", async () => {
    const port = stubAdvisor({
      ok: false,
      errorKind: "advisor-error",
      errorMessage: "upstream 500",
    })
    const r = await runTool(advisorTool(port), { question: "q" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toContain("advisor-error")
    expect(r.failure?.mode).toBe("error")
  })

  test("advisor timeout errorKind ⇒ typed timeout failure", async () => {
    const port = stubAdvisor({ ok: false, errorKind: "timeout", errorMessage: "deadline" })
    const r = await runTool(advisorTool(port), { question: "q" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("timeout")
  })

  test("advisor port THROWS (programmer-bug path) ⇒ graceful ok:false, never bubbles", async () => {
    const tool = advisorTool({
      consult: async () => {
        throw new Error("boom: provider client exploded")
      },
      listModels: () => ["o3"],
    })
    const r = await runTool(tool, { question: "q" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).toContain("boom")
    expect(r.failure?.mode).toBe("error")
  })

  test("already-aborted signal ⇒ ok:false aborted before start, port never reached", async () => {
    const port = stubAdvisor(okResult("x"))
    const ac = new AbortController()
    ac.abort()
    const r = await runTool(advisorTool(port), { question: "q" }, ctx({ signal: ac.signal }))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("aborted")
    expect(port.last).toBeUndefined()
  })

  test("parent signal threads into the consult request (cancellation propagation)", async () => {
    const port = stubAdvisor(okResult("x"))
    const ac = new AbortController()
    await runTool(advisorTool(port), { question: "q" }, ctx({ signal: ac.signal }))
    expect(port.last?.signal).toBe(ac.signal)
  })

  test("empty question ⇒ rejected at schema boundary (port never reached)", async () => {
    const port = stubAdvisor(okResult("x"))
    const r = await runTool(advisorTool(port), { question: "" }, ctx())
    expect(r.ok).toBe(false)
    expect(port.last).toBeUndefined()
  })

  test("PURE CONSULT: advisor cannot mutate — no write/edit/bash on its surface", () => {
    // The tool exposes ONLY a read-only consult: it has no shell-command
    // extractor and declares itself read-only, so the permission gate can never
    // route it through a mutation/HARD_DENY path.
    const tool = advisorTool(stubAdvisor(okResult("x")))
    expect(tool.name).toBe("advisor")
    expect(tool.isReadOnly()).toBe(true)
    // No shell surface — a sibling shell tool exposes extractShellCommand; the
    // advisor must NOT, so it can never be gated as a shell-class call.
    expect(tool.extractShellCommand).toBeUndefined()
    // It is not one of the mutating tool names.
    expect(["write", "edit", "bash", "apply_patch"]).not.toContain(tool.name)
  })
})
