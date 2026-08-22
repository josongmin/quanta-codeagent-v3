/**
 * Hellgate — `reflect` self-correction tool (gap-other-agent GAP 11).
 *
 * Cursor's reflect tool: an EXPENSIVE, used-sparingly mid-turn self-correction —
 * "Always include the next_steps field". quanta had none. This is the essential
 * tool: REQUIRES both `situation` and `next_steps`, routes to a host `ReflectPort`,
 * and enforces a per-session call QUOTA (it's expensive). NO-THROW.
 *
 * Invariants:
 *   1. Missing/empty next_steps OR situation ⇒ ok:false BEFORE the port (the
 *      forcing function — you must commit a plan to reflect).
 *   2. A port analysis ⇒ ok:true with the analysis rendered.
 *   3. Quota: after `maxCalls` successful calls, further calls ⇒ ok:false
 *      ("quota") WITHOUT reaching the port.
 *   4. A thrown port ⇒ graceful ok:false (no-throw past the loop).
 *   5. Tool contract: read-only, hitlTier none.
 */
import { describe, expect, test } from "bun:test"
import { buildDefaultTools } from "@/tool"
import type { ReflectInput, ReflectPort, ReflectResult } from "@/tool/reflect"
import { reflectTool } from "@/tool/reflect"
import type { ToolContext, ToolEvent } from "@/tool/types"

const ctx = (): ToolContext => ({ signal: new AbortController().signal }) as unknown as ToolContext
const resultOf = async (it: AsyncIterable<ToolEvent>) => {
  for await (const e of it) if (e.type === "result") return e.result
  throw new Error("no result")
}
const portReturning = (res: ReflectResult, calls?: { n: number }): ReflectPort => ({
  reflect: async () => {
    if (calls) calls.n++
    return res
  },
})
const ok: ReflectResult = {
  ok: true,
  analysis: "try a different anchor",
  recommendNewApproach: true,
}
const good = {
  situation: "edits keep failing the same way",
  next_steps: "switch to AST-based edit",
}

describe("reflect — forcing function (both fields required)", () => {
  test("missing next_steps ⇒ ok:false before the port", async () => {
    const calls = { n: 0 }
    const r = await resultOf(
      reflectTool(portReturning(ok, calls)).execute(
        { situation: "x" } as unknown as ReflectInput,
        ctx(),
      ),
    )
    expect(r.ok).toBe(false)
    expect(calls.n).toBe(0)
  })
  test("empty situation ⇒ ok:false", async () => {
    const r = await resultOf(
      reflectTool(portReturning(ok)).execute({ situation: "", next_steps: "y" }, ctx()),
    )
    expect(r.ok).toBe(false)
  })
})

describe("reflect — happy path", () => {
  test("both fields ⇒ ok:true with analysis", async () => {
    const r = await resultOf(reflectTool(portReturning(ok)).execute(good, ctx()))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("different anchor")
  })
})

describe("reflect — expensive: per-session quota", () => {
  test("exceeding maxCalls ⇒ ok:false (quota), port not reached", async () => {
    const calls = { n: 0 }
    const tool = reflectTool(portReturning(ok, calls), { maxCalls: 2 })
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(true)
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(true)
    const third = await resultOf(tool.execute(good, ctx()))
    expect(third.ok).toBe(false)
    expect(third.output).toContain("quota")
    expect(calls.n).toBe(2) // port reached exactly twice
  })
})

describe("reflect — default-OFF registration (R4 audit)", () => {
  const names = (env?: { reflect: ReflectPort }) =>
    buildDefaultTools(env ?? undefined).map((t) => t.name)
  test("absent port ⇒ reflect NOT in buildDefaultTools (byte-identical)", () => {
    expect(names()).not.toContain("reflect")
  })
  test("present port ⇒ reflect registered", () => {
    expect(names({ reflect: portReturning(ok) })).toContain("reflect")
  })
})

describe("reflect — no-throw + contract", () => {
  test("a thrown port ⇒ graceful ok:false", async () => {
    const tool = reflectTool({
      reflect: async () => {
        throw new Error("boom")
      },
    })
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(false)
  })
  test("R1: a THROWING port does NOT consume quota (infra failure ≠ reflection)", async () => {
    let n = 0
    const flaky: ReflectPort = {
      reflect: async () => {
        n++
        if (n <= 2) throw new Error("backend down")
        return ok
      },
    }
    const tool = reflectTool(flaky, { maxCalls: 2 })
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(false) // throw 1 — no quota spent
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(false) // throw 2 — no quota spent
    expect((await resultOf(tool.execute(good, ctx()))).ok).toBe(true) // recovers — quota intact
  })
  test("read-only, hitlTier none, name reflect", () => {
    const tool = reflectTool(portReturning(ok))
    expect(tool.isReadOnly?.()).toBe(true)
    expect(tool.hitlTier?.(good)).toBe("none")
    expect(tool.name).toBe("reflect")
  })
})
