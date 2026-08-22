/**
 * ADR-0451 — per-subagent model / role / effort override hellgate.
 *
 * Proves the spawn-path wiring threads `req.model` / `req.role` / `req.effort`
 * into the child {@link AgentConfig} the runner forks, reusing the EXISTING
 * id→port swap (`modelCandidates`) + RoleModelResolver (ADR-0256) + sessionEffort
 * (effortToTokenBudget) mechanisms — never reinventing a model registry.
 *
 * Invariants locked here:
 *   - HELL-SMO-01  explicit model ⇒ child.llm === that candidate's port
 *   - HELL-SMO-02  role ⇒ resolved via RoleModelResolver then swapped
 *   - HELL-SMO-03  explicit model BEATS role (precedence)
 *   - HELL-SMO-04  effort named tier ⇒ child.sessionEffort returns it
 *   - HELL-SMO-05  ABSENT all three ⇒ child.llm === parent.llm (byte-identical,
 *                  no sessionEffort wired) — the default-OFF regression
 *   - HELL-SMO-06  unknown explicit model id ⇒ fail-closed (throws
 *                  UnknownSubagentModelError; runner surfaces non-ok, no swap)
 *   - HELL-SMO-07  role resolving to an unknown candidate ⇒ fail-closed
 *   - HELL-SMO-08  role resolving back to the PARENT model ⇒ no swap, no throw
 *   - HELL-SMO-09  role set but no roleModelResolver wired ⇒ no swap (parent.llm)
 *   - HELL-SMO-10  unrecognised effort string ⇒ no sessionEffort (defers)
 *   - HELL-SMO-11  empty-string model / role ⇒ treated as absent (parent.llm)
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { runAgent } from "../../src/agent/loop"
import { createSubagentRunner, UnknownSubagentModelError } from "../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import type { LLMPort, Message, ModelCandidate } from "../../src/llm"
import { defaultRoleModelResolver } from "../../src/llm/role-model-override"
import { createAgentTool, type SubagentRunner } from "../../src/subagent"
import type { SubagentRequest } from "../../src/subagent/types"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"

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

/** A distinct, identity-comparable LLM port stub carrying a model id. */
const port = (model: string): LLMPort =>
  ({
    model,
    // biome-ignore lint/suspicious/noExplicitAny: inert stream stub
    stream: async function* () {} as any,
  }) as LLMPort

const candidate = (id: string): ModelCandidate => ({ id, port: port(id) })

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: port("parent-model"),
    registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ] satisfies Message[],
})

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

/** Capture the child config the runner forks into `runAgent`. */
const capturing = (): { run: typeof runAgent; seen: AgentConfig[] } => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome()
  }) as typeof runAgent
  return { run, seen }
}

const childOf = (seen: AgentConfig[]): AgentConfig => {
  const c = seen[0]
  if (c === undefined) throw new Error("runner never forked a child")
  return c
}

describe("ADR-0451 — explicit model override", () => {
  test("HELL-SMO-01 explicit model ⇒ child.llm is that candidate's exact port", async () => {
    const fast = candidate("fast-1")
    const { run, seen } = capturing()
    const parent = parentConfig({ modelCandidates: [candidate("parent-model"), fast] })
    const runner = createSubagentRunner(parent, { run })

    const r = await runner(req({ model: "fast-1" }))

    expect(r.ok).toBe(true)
    expect(childOf(seen).llm).toBe(fast.port) // swapped by id, reference-identical
    expect(childOf(seen).llm).not.toBe(parent.llm)
  })

  test("HELL-SMO-06 unknown explicit model id ⇒ fail-closed (no silent fallback)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({ modelCandidates: [candidate("parent-model")] })
    const runner = createSubagentRunner(parent, { run })

    // The runner surfaces the typed error as a non-ok result (foreground path
    // re-throws out of the returned promise → agent-tool turns it into a deny).
    await expect(runner(req({ model: "does-not-exist" }))).rejects.toBeInstanceOf(
      UnknownSubagentModelError,
    )
    expect(seen.length).toBe(0) // child loop NEVER forked on the wrong model
  })

  test("HELL-SMO-06b no modelCandidates at all + explicit model ⇒ fail-closed", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    await expect(runner(req({ model: "fast-1" }))).rejects.toBeInstanceOf(UnknownSubagentModelError)
    expect(seen.length).toBe(0)
  })
})

describe("ADR-0451 — role override (RoleModelResolver, ADR-0256)", () => {
  test("HELL-SMO-02 role ⇒ resolved via RoleModelResolver then swapped", async () => {
    const reviewer = candidate("reviewer-model")
    const resolver = defaultRoleModelResolver()
    expect(resolver.setOverride("reviewer", "reviewer-model").ok).toBe(true)
    const { run, seen } = capturing()
    const parent = parentConfig({
      roleModelResolver: resolver,
      modelCandidates: [candidate("parent-model"), reviewer],
    })
    const runner = createSubagentRunner(parent, { run })

    await runner(req({ role: "reviewer" }))

    expect(childOf(seen).llm).toBe(reviewer.port)
  })

  test("HELL-SMO-03 explicit model BEATS role (precedence)", async () => {
    const fast = candidate("fast-1")
    const reviewer = candidate("reviewer-model")
    const resolver = defaultRoleModelResolver({ reviewer: "reviewer-model" })
    const { run, seen } = capturing()
    const parent = parentConfig({
      roleModelResolver: resolver,
      modelCandidates: [candidate("parent-model"), fast, reviewer],
    })
    const runner = createSubagentRunner(parent, { run })

    await runner(req({ model: "fast-1", role: "reviewer" }))

    expect(childOf(seen).llm).toBe(fast.port) // explicit wins
    expect(childOf(seen).llm).not.toBe(reviewer.port)
  })

  test("HELL-SMO-07 role resolving to a NON-candidate ⇒ fail-closed", async () => {
    const resolver = defaultRoleModelResolver({ reviewer: "ghost-model" })
    const { run, seen } = capturing()
    const parent = parentConfig({
      roleModelResolver: resolver,
      modelCandidates: [candidate("parent-model")],
    })
    const runner = createSubagentRunner(parent, { run })

    await expect(runner(req({ role: "reviewer" }))).rejects.toBeInstanceOf(
      UnknownSubagentModelError,
    )
    expect(seen.length).toBe(0)
  })

  test("HELL-SMO-08 role resolving BACK to the parent model ⇒ no swap, no throw", async () => {
    // No override set for the role ⇒ resolver falls through to the default
    // (parent model). That must NOT trigger a candidate lookup or a throw.
    const resolver = defaultRoleModelResolver()
    const { run, seen } = capturing()
    const parent = parentConfig({
      roleModelResolver: resolver,
      // intentionally NO candidate matching parent-model — proves no lookup happens
      modelCandidates: [candidate("other-model")],
    })
    const runner = createSubagentRunner(parent, { run })

    const r = await runner(req({ role: "explorer" }))

    expect(r.ok).toBe(true)
    expect(childOf(seen).llm).toBe(parent.llm) // byte-identical, no swap
  })

  test("HELL-SMO-09 role set but NO roleModelResolver ⇒ no swap (parent.llm)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({ modelCandidates: [candidate("parent-model")] })
    const runner = createSubagentRunner(parent, { run })

    const r = await runner(req({ role: "reviewer" }))

    expect(r.ok).toBe(true)
    expect(childOf(seen).llm).toBe(parent.llm)
  })
})

describe("ADR-0451 — effort override (sessionEffort / effortToTokenBudget)", () => {
  test("HELL-SMO-04 named effort tier ⇒ child.sessionEffort returns it", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })

    await runner(req({ effort: "high" }))

    const child = childOf(seen)
    expect(typeof child.sessionEffort).toBe("function")
    expect(child.sessionEffort?.()).toBe("high")
  })

  test("HELL-SMO-10 unrecognised effort string ⇒ no sessionEffort (defers)", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })

    await runner(req({ effort: "turbo-nonsense" }))

    expect(childOf(seen).sessionEffort).toBeUndefined()
  })

  test("effort composes with an explicit model (both applied to child)", async () => {
    const fast = candidate("fast-1")
    const { run, seen } = capturing()
    const parent = parentConfig({ modelCandidates: [candidate("parent-model"), fast] })
    const runner = createSubagentRunner(parent, { run })

    await runner(req({ model: "fast-1", effort: "max" }))

    const child = childOf(seen)
    expect(child.llm).toBe(fast.port)
    expect(child.sessionEffort?.()).toBe("max")
  })
})

describe("ADR-0451 — agent tool input schema threads model/role/effort", () => {
  const ctx = (): ToolContext =>
    ({ cwd: "/tmp", signal: new AbortController().signal }) as ToolContext

  const captureReq = async (input: Record<string, unknown>): Promise<SubagentRequest> => {
    let seen: SubagentRequest | undefined
    const runner: SubagentRunner = async (r) => {
      seen = r
      return { ok: true, finalText: "ok", turns: 1 }
    }
    const tool = createAgentTool({ runner })
    for await (const _ of tool.execute(input as never, ctx())) {
      // drain
    }
    if (seen === undefined) throw new Error("runner never invoked")
    return seen
  }

  test("model/role/effort on the tool input reach the SubagentRequest", async () => {
    const r = await captureReq({
      prompt: "task",
      model: "fast-1",
      role: "reviewer",
      effort: "high",
    })
    expect(r.model).toBe("fast-1")
    expect(r.role).toBe("reviewer")
    expect(r.effort).toBe("high")
  })

  test("absent on the tool input ⇒ omitted from the request (no undefined keys)", async () => {
    const r = await captureReq({ prompt: "task" })
    expect("model" in r).toBe(false)
    expect("role" in r).toBe(false)
    expect("effort" in r).toBe(false)
  })

  test("invalid effort enum value is rejected by the input schema", async () => {
    const tool = createAgentTool({ runner: async () => ({ ok: true, finalText: "", turns: 1 }) })
    const parsed = tool.inputSchema.safeParse({ prompt: "task", effort: "turbo-nonsense" })
    expect(parsed.success).toBe(false)
  })
})

describe("ADR-0451 — default-OFF byte-identical regression", () => {
  test("HELL-SMO-05 absent model/role/effort ⇒ child.llm === parent.llm, no sessionEffort", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({
      modelCandidates: [candidate("parent-model"), candidate("fast-1")],
    })
    const runner = createSubagentRunner(parent, { run })

    const r = await runner(req())

    expect(r.ok).toBe(true)
    const child = childOf(seen)
    expect(child.llm).toBe(parent.llm) // reference-identical — no swap path taken
    expect(child.sessionEffort).toBeUndefined() // no effort thunk wired
  })

  test("HELL-SMO-11 empty-string model / role ⇒ treated as absent (parent.llm)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({
      roleModelResolver: defaultRoleModelResolver(),
      modelCandidates: [candidate("parent-model")],
    })
    const runner = createSubagentRunner(parent, { run })

    const r = await runner(req({ model: "", role: "" }))

    expect(r.ok).toBe(true)
    expect(childOf(seen).llm).toBe(parent.llm)
  })
})
