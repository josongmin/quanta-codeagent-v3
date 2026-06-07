/**
 * Hellgate — `ask_user` generalized elicitation tool (ADR-0494).
 *
 * Generalizes the binary `onConfirm` (allow/deny) into a STRUCTURED host
 * question the agent (or an MCP server, via the host bridge) can ask mid-task:
 * free text, yes/no, single-select, multi-select, number, integer. Routed to a
 * host `AskUserPort`; absent/headless ⇒ a typed `denied` result (never blocks).
 *
 * Invariants proven (red-on-injection):
 *   1. Tool NEVER throws past the loop — bad input / port throw ⇒ ok:false.
 *   2. A port answer surfaces ok:true with the typed value rendered.
 *   3. A typed port refusal (headless-denied / cancelled / validation-error)
 *      surfaces ok:false with the reason, not an exception.
 *   4. select/multiselect REQUIRE a non-empty options list (else ok:false
 *      BEFORE the port is reached).
 *   5. The tool is read-only, hitlTier "none", concurrency-safe.
 */
import { describe, expect, test } from "bun:test"
import type { AskUserInput, AskUserPort, AskUserRequest, AskUserResult } from "@/tool/ask-user"
import { askUserTool } from "@/tool/ask-user"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as unknown as ToolContext

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const resultOf = async (it: AsyncIterable<ToolEvent>) => {
  const evs = await drain(it)
  const r = evs.find((e) => e.type === "result")
  if (!r || r.type !== "result") throw new Error("no result event")
  return r.result
}

const portReturning = (res: AskUserResult): AskUserPort => ({
  ask: async (_req: AskUserRequest) => res,
})
const portThrowing = (): AskUserPort => ({
  ask: async () => {
    throw new Error("boom")
  },
})

describe("ask_user — happy path routing", () => {
  test("string answer ⇒ ok:true with value", async () => {
    const tool = askUserTool(portReturning({ ok: true, value: "blue" }))
    const r = await resultOf(tool.execute({ kind: "string", prompt: "fav color?" }, ctx()))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("blue")
  })

  test("boolean + select route to the same port", async () => {
    const yes = askUserTool(portReturning({ ok: true, value: true }))
    expect((await resultOf(yes.execute({ kind: "boolean", prompt: "ok?" }, ctx()))).ok).toBe(true)
    const pick = askUserTool(portReturning({ ok: true, value: "b" }))
    const r = await resultOf(
      pick.execute({ kind: "select", prompt: "pick", options: ["a", "b"] }, ctx()),
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain("b")
  })
})

describe("ask_user — typed refusals never throw", () => {
  test("headless-denied ⇒ ok:false with reason", async () => {
    const tool = askUserTool(portReturning({ ok: false, reason: "headless-denied" }))
    const r = await resultOf(tool.execute({ kind: "string", prompt: "?" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("headless-denied")
  })

  test("a port that throws is caught ⇒ graceful ok:false", async () => {
    const tool = askUserTool(portThrowing())
    const r = await resultOf(tool.execute({ kind: "string", prompt: "?" }, ctx()))
    expect(r.ok).toBe(false)
  })
})

describe("ask_user — adversarial input", () => {
  test("invalid input shape ⇒ ok:false (no throw)", async () => {
    const tool = askUserTool(portReturning({ ok: true, value: "x" }))
    const r = await resultOf(tool.execute({ kind: "nonsense" } as unknown as AskUserInput, ctx()))
    expect(r.ok).toBe(false)
  })

  test("R2 F4: Infinity number min/max ⇒ ok:false (would serialize to null over JSON)", async () => {
    const tool = askUserTool(portReturning({ ok: true, value: 5 }))
    const r = await resultOf(
      tool.execute({ kind: "number", prompt: "n?", max: Number.POSITIVE_INFINITY }, ctx()),
    )
    expect(r.ok).toBe(false)
  })

  test("R2 F5: minSelected > options.length ⇒ ok:false (unsatisfiable, before port)", async () => {
    let reached = false
    const spy: AskUserPort = {
      ask: async () => {
        reached = true
        return { ok: true, value: ["a"] }
      },
    }
    const tool = askUserTool(spy)
    const r = await resultOf(
      tool.execute({ kind: "multiselect", prompt: "p", options: ["a", "b"], minSelected: 3 }, ctx()),
    )
    expect(r.ok).toBe(false)
    expect(reached).toBe(false)
  })

  test("R2 F5: number min > max ⇒ ok:false", async () => {
    const tool = askUserTool(portReturning({ ok: true, value: 1 }))
    const r = await resultOf(tool.execute({ kind: "number", prompt: "n?", min: 10, max: 1 }, ctx()))
    expect(r.ok).toBe(false)
  })

  test("select with empty options ⇒ ok:false BEFORE the port", async () => {
    let reached = false
    const spy: AskUserPort = {
      ask: async () => {
        reached = true
        return { ok: true, value: "x" }
      },
    }
    const tool = askUserTool(spy)
    const r = await resultOf(tool.execute({ kind: "select", prompt: "p", options: [] }, ctx()))
    expect(r.ok).toBe(false)
    expect(reached).toBe(false)
  })

  test("aborted signal ⇒ ok:false before start", async () => {
    const ac = new AbortController()
    ac.abort()
    const tool = askUserTool(portReturning({ ok: true, value: "x" }))
    const c = { signal: ac.signal } as unknown as ToolContext
    const r = await resultOf(tool.execute({ kind: "string", prompt: "?" }, c))
    expect(r.ok).toBe(false)
  })
})

describe("ask_user — tool contract", () => {
  test("read-only, none HITL, concurrency-safe", () => {
    const tool = askUserTool(portReturning({ ok: true, value: "x" }))
    const probe: AskUserInput = { kind: "string", prompt: "?" }
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.hitlTier?.(probe)).toBe("none")
    expect(tool.isConcurrencySafe?.(probe)).toBe(true)
    expect(tool.name).toBe("ask_user")
  })
})
